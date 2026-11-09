import { describe, expect, it } from 'vitest'
import { resolveTrack } from '../src/match/resolve'
import { sourceVideo } from '../src/sources/youtube'
import type { Downloader } from '../src/download/lucida-adapter'
import type { DownloadService, SourceService, SourceTrack, TargetTrack } from '../src/types'

/** A download service whose search only answers the exact queries in `answers`. */
function fake(
	service: DownloadService,
	answers: Record<string, TargetTrack[]>,
	opts: { byIsrc?: Record<string, TargetTrack>; fails?: boolean } = {}
) {
	const queries: string[] = []
	const d: Downloader = {
		service,
		isrcLookup: async (isrc) => opts.byIsrc?.[isrc] ?? null,
		search: async (q) => {
			queries.push(q)
			if (opts.fails) throw new Error('sesión expirada')
			return answers[q] ?? []
		},
		getTrack: async () => {
			throw new Error('not used')
		},
		accountInfo: async () => ({}),
		accountQuality: async () => ({ codec: 'flac', lossless: true })
	}
	return { d, queries }
}

const track = (t: Partial<SourceTrack> = {}): SourceTrack & { source: SourceService } => ({
	source: 'spotify',
	sourceId: 's1',
	title: '¿Qué Hay De Malo?',
	artists: ['Kevin Kaarl'],
	durationMs: 200_000,
	...t
})

const onQobuz: TargetTrack = {
	service: 'qobuz',
	id: 'q1',
	url: 'https://play.qobuz.com/track/q1',
	title: 'Qué Hay De Malo',
	artists: ['Kevin Kaarl'],
	durationMs: 200_500,
	isrc: 'MX1234567890'
}

describe('resolveTrack', () => {
	it('tries broader searches when the first one finds nothing', async () => {
		const qobuz = fake('qobuz', { 'kevin kaarl que hay de malo': [onQobuz] })
		const res = await resolveTrack(track(), [qobuz.d], 0.9)
		expect(res.status).toBe('auto')
		expect(res.target?.id).toBe('q1')
		// Stops as soon as it has a match.
		expect(qobuz.queries).toEqual(['Kevin Kaarl ¿Qué Hay De Malo?', 'kevin kaarl que hay de malo'])
	})

	it('takes the first service in priority order that has the song', async () => {
		const onDeezer = { ...onQobuz, service: 'deezer' as const, id: 'd1', url: 'https://www.deezer.com/track/d1' }
		const qobuz = fake('qobuz', { 'Kevin Kaarl ¿Qué Hay De Malo?': [onQobuz] })
		const deezer = fake('deezer', { 'Kevin Kaarl ¿Qué Hay De Malo?': [onDeezer] })
		const res = await resolveTrack(track(), [qobuz.d, deezer.d], 0.9)
		expect(res.target?.service).toBe('qobuz')
		expect(deezer.queries).toEqual([])
	})

	it('fails instead of saying "not found" when a service could not be searched', async () => {
		const qobuz = fake('qobuz', {}, { fails: true })
		await expect(resolveTrack(track(), [qobuz.d], 0.9)).rejects.toThrow(/Qobuz: sesión expirada/)
	})

	it('still uses the services that answered when another one fails', async () => {
		const qobuz = fake('qobuz', {}, { fails: true })
		const deezer = fake('deezer', { 'Kevin Kaarl ¿Qué Hay De Malo?': [{ ...onQobuz, service: 'deezer', id: 'd1' }] })
		const res = await resolveTrack(track(), [qobuz.d, deezer.d], 0.9)
		expect(res.status).toBe('auto')
		expect(res.target?.service).toBe('deezer')
	})

	it('finds the ISRC elsewhere when text search misses and the source has none', async () => {
		const qobuz = fake('qobuz', {}, { byIsrc: { [onQobuz.isrc!]: { ...onQobuz, title: 'Que Hay De Malo (Versión Única)' } } })
		const res = await resolveTrack(track(), [qobuz.d], 0.9, {
			findIsrc: async () => ({ isrc: onQobuz.isrc!, score: 0.97 })
		})
		expect(res.status).toBe('auto')
		expect(res.target?.id).toBe('q1')
		expect(res.target?.score).toBe(0.97)
	})

	it("takes a YouTube Music track's own video on YouTube, even when YouTube can't be searched", async () => {
		const youtube = fake('youtube', {}, { fails: true })
		const fromYtMusic = { source: 'ytmusic' as const, sourceId: 'trpsQAD6ZdA', title: 'ROCK', artists: ['Moura Dj'], durationMs: 119_000 }
		const res = await resolveTrack(fromYtMusic, [{ ...youtube.d, exact: sourceVideo }], 0.9)
		expect(res.status).toBe('auto')
		expect(res.target).toMatchObject({ service: 'youtube', id: 'trpsQAD6ZdA', score: 1 })
		// Only one query: the exact video already settles it.
		expect(youtube.queries).toEqual(['Moura Dj ROCK'])
	})

	it('counts weak candidates as not found, but keeps them for review', async () => {
		const other: TargetTrack = { ...onQobuz, id: 'q9', title: 'Vámonos A Marte', durationMs: 180_000 }
		const qobuz = fake('qobuz', { 'Kevin Kaarl ¿Qué Hay De Malo?': [other] })
		const res = await resolveTrack(track(), [qobuz.d], 0.9, { findIsrc: async () => null })
		expect(res.status).toBe('notfound')
		expect(res.candidates.map((c) => c.id)).toEqual(['q9'])
	})
})
