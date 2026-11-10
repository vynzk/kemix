import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiKeyError, FeatureSources, Throttle } from '../src/features/lookup'

const NO_WAIT = { deezer: 0, musicbrainz: 0, acousticbrainz: 0, getsongbpm: 0 }

/** Fake web: answers by host + path, and records each request. */
function fakeWeb(routes: Record<string, (url: URL, init?: RequestInit) => unknown>) {
	const calls: { url: URL; init?: RequestInit }[] = []
	vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input))
		calls.push({ url, init })
		const route = Object.keys(routes).find((r) => `${url.hostname}${url.pathname}`.startsWith(r))
		if (!route) return new Response('not found', { status: 404 })
		const body = routes[route]!(url, init)
		return body instanceof Response ? body : Response.json(body)
	})
	return calls
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('Deezer', () => {
	it('looks a track up by ISRC or id, with its BPM, ISRC and preview', async () => {
		const calls = fakeWeb({
			'api.deezer.com/track/isrc:GBAHS1400099': () => ({
				id: 79875064,
				isrc: 'GBAHS1400099',
				bpm: 157.8,
				preview: 'https://cdnt-preview.dzcdn.net/x.mp3'
			}),
			'api.deezer.com/track/123': () => ({ id: 123, isrc: 'USAAA0000001', bpm: 0, preview: '' }),
			'api.deezer.com/track/isrc:XX': () => ({ error: { type: 'DataException', message: 'no data', code: 800 } })
		})
		const s = new FeatureSources(NO_WAIT)
		expect(await s.deezerTrack({ isrc: 'GBAHS1400099' })).toEqual({
			id: '79875064',
			isrc: 'GBAHS1400099',
			bpm: 157.8,
			previewUrl: 'https://cdnt-preview.dzcdn.net/x.mp3'
		})
		// The id wins over the ISRC; a BPM of 0 is "unknown".
		expect(await s.deezerTrack({ id: '123', isrc: 'GBAHS1400099' })).toEqual({
			id: '123',
			isrc: 'USAAA0000001',
			bpm: null,
			previewUrl: null
		})
		expect(await s.deezerTrack({ isrc: 'XX' })).toBeNull()
		expect(await s.deezerTrack({})).toBeNull()
		expect(calls).toHaveLength(3)
	})
})

describe('AcousticBrainz', () => {
	it('maps ISRCs to recordings on MusicBrainz, then reads their BPM and key in batches', async () => {
		const isrcs = Array.from({ length: 30 }, (_, i) => `USAAA00000${String(i).padStart(2, '0')}`)
		const calls = fakeWeb({
			'musicbrainz.org/ws/2/recording': (url) => {
				const asked = [...url.searchParams.get('query')!.matchAll(/isrc:(\w+)/g)].map((m) => m[1]!)
				// Two recordings for the first ISRC (only the second was analyzed); one for the rest; none for the last.
				const recordings = asked
					.filter((i) => i !== isrcs[29])
					.flatMap((i) => (i === isrcs[0] ? [`mb-${i}-a`, `mb-${i}`] : [`mb-${i}`]).map((id) => ({ id, isrcs: [i] })))
				return { count: recordings.length, recordings }
			},
			'acousticbrainz.org/api/v1/low-level': (url) => {
				const ids = url.searchParams.get('recording_ids')!.split(';')
				expect(ids.length).toBeLessThanOrEqual(25)
				expect(url.searchParams.get('features')).toBe('rhythm.bpm;tonal.key_key;tonal.key_scale')
				const out: Record<string, unknown> = { mbid_mapping: {} }
				for (const id of ids) {
					if (id.endsWith('-a')) continue
					out[id] = { 0: { rhythm: { bpm: 128.347702026 }, tonal: { key_key: 'F#', key_scale: 'minor' } } }
				}
				return out
			}
		})
		const found = await new FeatureSources(NO_WAIT).acousticBrainz(isrcs.map((i) => i.toLowerCase()))
		expect(found.size).toBe(29)
		expect(found.get(isrcs[0]!)).toEqual({ bpm: 128.3, key: { tonic: 6, minor: true } })
		expect(found.has(isrcs[29]!)).toBe(false)
		const mb = calls.filter((c) => c.url.hostname === 'musicbrainz.org')
		// 20 ISRCs per search, and every request says who's asking.
		expect(mb).toHaveLength(2)
		expect(new Headers(mb[0]!.init?.headers).get('User-Agent')).toMatch(/^Kemix\//)
		expect(calls.filter((c) => c.url.hostname === 'acousticbrainz.org')).toHaveLength(2)
	})

	it('skips malformed ISRCs without asking', async () => {
		const calls = fakeWeb({})
		expect((await new FeatureSources(NO_WAIT).acousticBrainz(['', 'nope'])).size).toBe(0)
		expect(calls).toHaveLength(0)
	})
})

describe('GetSongBPM', () => {
	const track = { title: 'Losing It - Original Mix', artists: ['FISHER'] }

	it('takes the best-matching song', async () => {
		const calls = fakeWeb({
			'api.getsong.co/search/': () => ({
				search: [
					{ id: 'x', title: 'Losing My Religion', tempo: '125', key_of: 'Am', artist: { name: 'R.E.M.' } },
					{ id: 'y', title: 'Losing It', tempo: '125', key_of: 'A♭m', artist: { name: 'FISHER' } }
				]
			})
		})
		expect(await new FeatureSources(NO_WAIT).getSongBpm('KEY', track, 0.8)).toEqual({ bpm: 125, key: { tonic: 8, minor: true } })
		const url = calls[0]!.url
		expect(url.searchParams.get('api_key')).toBe('KEY')
		expect(url.searchParams.get('type')).toBe('both')
		expect(url.searchParams.get('lookup')).toBe('song:Losing It artist:FISHER')
	})

	it('answers nothing when no song is convincing, or there are none', async () => {
		fakeWeb({
			'api.getsong.co/search/': (url) =>
				url.searchParams.get('lookup')!.includes('Losing')
					? { search: [{ id: 'x', title: 'Something Else', tempo: '90', key_of: 'C', artist: { name: 'Other' } }] }
					: { search: { error: 'no result' } }
		})
		const s = new FeatureSources(NO_WAIT)
		expect(await s.getSongBpm('KEY', track, 0.8)).toBeNull()
		expect(await s.getSongBpm('KEY', { title: 'Nada', artists: ['Nadie'] }, 0.8)).toBeNull()
	})

	it('tells a rejected key apart from other failures', async () => {
		fakeWeb({ 'api.getsong.co/search/': () => Response.json({ error: 'Invalid API Key, or inactive.' }, { status: 401 }) })
		await expect(new FeatureSources(NO_WAIT).getSongBpm('BAD', track, 0.8)).rejects.toBeInstanceOf(ApiKeyError)
	})
})

describe('Throttle', () => {
	it('runs calls one at a time, spaced out, even after a failure', async () => {
		const t = new Throttle(40)
		const starts: number[] = []
		const call = (fail: boolean) =>
			t.run(async () => {
				starts.push(Date.now())
				if (fail) throw new Error('boom')
				return starts.length
			})
		const results = await Promise.allSettled([call(false), call(true), call(false)])
		expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
		expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(35)
		expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(35)
	})
})
