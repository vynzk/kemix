import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	extractSoundCloudToken,
	findClientId,
	scriptUrls,
	SOUNDCLOUD_LIKES_ID,
	SoundCloudSource,
	toSourceTrack,
	type RawTrack
} from '../src/sources/soundcloud-api'
import { sourceUpload } from '../src/sources/soundcloud'
import { SessionExpiredError } from '../src/util'

const CLIENT_ID = 'a'.repeat(32)

const track = (id: number, extra: Partial<RawTrack> = {}): RawTrack => ({
	id,
	title: `Tema ${id}`,
	permalink_url: `https://soundcloud.com/dj/tema-${id}`,
	duration: 200_000,
	artwork_url: `https://i1.sndcdn.com/artworks-${id}-large.jpg`,
	user: { username: 'Some DJ Official' },
	...extra
})

/** Fake soundcloud.com + api-v2: answers by path, and records each API call. */
function fakeSoundCloud(routes: Record<string, (url: URL, init?: RequestInit) => unknown>) {
	const calls: URL[] = []
	vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input))
		if (url.hostname === 'soundcloud.com') {
			return new Response('<script crossorigin src="https://a-v2.sndcdn.com/assets/app.js"></script>')
		}
		if (url.hostname === 'a-v2.sndcdn.com') return new Response(`({client_id:"${CLIENT_ID}",env:"production"})`)
		calls.push(url)
		const handler = routes[url.pathname]
		if (!handler) return new Response('not found', { status: 404 })
		const body = handler(url, init)
		return body instanceof Response ? body : Response.json(body)
	})
	return calls
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('extractSoundCloudToken', () => {
	it('takes the bare token or pulls oauth_token out of a cookie export', () => {
		expect(extractSoundCloudToken('2-293840-12345-AbCdEf')).toBe('2-293840-12345-AbCdEf')
		const txt = [
			'# Netscape HTTP Cookie File',
			'.soundcloud.com\tTRUE\t/\tTRUE\t0\tsc_anonymous_id\t123',
			'.soundcloud.com\tTRUE\t/\tTRUE\t0\toauth_token\t2-293840-12345-AbCdEf'
		].join('\n')
		expect(extractSoundCloudToken(txt)).toBe('2-293840-12345-AbCdEf')
		expect(() => extractSoundCloudToken('sc_anonymous_id=1; other=2')).toThrow(/oauth_token/)
	})
})

describe('client id', () => {
	it('is read from the web player scripts', () => {
		expect(scriptUrls('<script src="https://x/1.js"></script><script async src="https://x/2.js">')).toEqual([
			'https://x/1.js',
			'https://x/2.js'
		])
		expect(findClientId(`a={client_id:"${CLIENT_ID}"}`)).toBe(CLIENT_ID)
		expect(findClientId('nothing here')).toBeNull()
	})
})

describe('toSourceTrack', () => {
	it('uses the label metadata when there is some, else the uploader, and the big artwork', () => {
		expect(toSourceTrack(track(1))).toEqual({
			sourceId: '1',
			title: 'Tema 1',
			artists: ['Some DJ'],
			album: undefined,
			durationMs: 200_000,
			isrc: undefined,
			coverUrl: 'https://i1.sndcdn.com/artworks-1-t500x500.jpg',
			url: 'https://soundcloud.com/dj/tema-1'
		})
		const label = toSourceTrack(
			track(2, { publisher_metadata: { artist: 'Real Artist', isrc: 'ISRC2', album_title: 'EP' }, full_duration: 300_000, duration: 30_000 })
		)
		expect(label).toMatchObject({ artists: ['Real Artist'], isrc: 'ISRC2', album: 'EP', durationMs: 300_000 })
		expect(toSourceTrack({ id: 3 })).toBeNull()
	})
})

describe('sourceUpload', () => {
	it('is the track itself when it comes from SoundCloud', () => {
		const t = { ...toSourceTrack(track(5))!, source: 'soundcloud' }
		expect(sourceUpload(t)).toMatchObject({ service: 'soundcloud', id: '5', url: 'https://soundcloud.com/dj/tema-5' })
		expect(sourceUpload({ ...t, source: 'spotify' })).toBeNull()
	})
})

describe('SoundCloudSource', () => {
	it('lists the likes, own playlists and liked playlists, signed in with the token', async () => {
		const calls = fakeSoundCloud({
			'/me': () => ({ id: 42, username: 'yo', full_name: 'Yo Mismo' }),
			'/users/42/playlists': () => ({
				collection: [{ id: 10, title: 'Mía', track_count: 2, last_modified: '2026-01-01', user: { username: 'yo' } }],
				next_href: null
			}),
			'/users/42/likes': (url) =>
				url.searchParams.get('offset') === '1'
					? { collection: [{ playlist: { id: 10, title: 'Mía' } }, { playlist: { id: 11, title: 'Ajena', track_count: 7 } }] }
					: { collection: [{ track: track(1) }, { track: track(2) }], next_href: 'https://api-v2.soundcloud.com/users/42/likes?offset=1' }
		})
		const src = new SoundCloudSource('tok')
		expect(await src.identity()).toEqual({ name: 'Yo Mismo' })
		const playlists = await src.listPlaylists()
		expect(playlists.map((p) => [p.sourceId, p.name, p.trackCount])).toEqual([
			[SOUNDCLOUD_LIKES_ID, 'Me gusta (SoundCloud)', 2],
			['10', 'Mía', 2],
			['11', 'Ajena', 7]
		])
		expect((await src.getPlaylistTracks(SOUNDCLOUD_LIKES_ID)).map((t) => t.sourceId)).toEqual(['1', '2'])
		expect(calls.every((u) => u.searchParams.get('client_id') === CLIENT_ID)).toBe(true)
	})

	it('fills in the playlist tracks that come as bare ids, keeping the order', async () => {
		const calls = fakeSoundCloud({
			'/playlists/10': () => ({ id: 10, tracks: [track(1), { id: 3 }, track(2), { id: 4 }] }),
			'/tracks': (url) => url.searchParams.get('ids')!.split(',').map((id) => track(Number(id)))
		})
		const tracks = await new SoundCloudSource('tok').getPlaylistTracks('10')
		expect(tracks.map((t) => t.sourceId)).toEqual(['1', '3', '2', '4'])
		expect(calls.find((u) => u.pathname === '/tracks')?.searchParams.get('ids')).toBe('3,4')
	})

	it('reports an expired session', async () => {
		fakeSoundCloud({ '/me': () => new Response('', { status: 401 }) })
		await expect(new SoundCloudSource('old').identity()).rejects.toBeInstanceOf(SessionExpiredError)
	})
})
