import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Kemix, passphraseCipher, type QualityLevel, type SourceService, type SourceTrack, type TargetTrack } from '../src/index'
import type { Downloader } from '../src/download/lucida-adapter'
import type { SourceConnector } from '../src/sources/types'

/** Wait until no download is queued/matching/downloading. */
async function settle(k: Kemix, timeout = 5000) {
	const start = Date.now()
	while (Date.now() - start < timeout) {
		const active = k.db
			.prepare(`SELECT COUNT(*) AS n FROM downloads WHERE status IN ('queued','matching','downloading')`)
			.get() as { n: number }
		if (active.n === 0) return k.queue.flush()
		await new Promise((r) => setTimeout(r, 20))
	}
	throw new Error('queue did not settle')
}

/** Poll until `check` gives something truthy, and return it. */
async function waitFor<T>(check: () => T | undefined | null | false | 0, timeout = 5000): Promise<T> {
	const start = Date.now()
	while (Date.now() - start < timeout) {
		const value = check()
		if (value) return value
		await new Promise((r) => setTimeout(r, 20))
	}
	throw new Error('condition not met in time')
}

const catalog: TargetTrack[] = [
	{ service: 'qobuz', id: 'q1', url: 'https://play.qobuz.com/track/q1', title: 'One', artists: ['Alpha'], durationMs: 200_000, isrc: 'ISRC1' },
	{ service: 'qobuz', id: 'q2', url: 'https://play.qobuz.com/track/q2', title: 'Two', artists: ['Beta'], durationMs: 180_000 },
	{ service: 'qobuz', id: 'q3', url: 'https://play.qobuz.com/track/q3', title: 'Three (Live)', artists: ['Gamma'], durationMs: 300_000 }
]

class FakeDownloader implements Downloader {
	readonly service = 'qobuz' as const
	downloads = 0
	/** Quality level each download asked for, in order. */
	levels: QualityLevel[] = []
	/** What the "service" sends. */
	mimeType = 'audio/mpeg'
	async isrcLookup(isrc: string) {
		return catalog.find((t) => t.isrc === isrc) ?? null
	}
	async search(query: string) {
		const q = query.toLowerCase()
		return catalog.filter((t) => q.includes(t.artists[0]!.toLowerCase()))
	}
	async getTrack(url: string) {
		const meta = catalog.find((t) => t.url === url)!
		return {
			meta,
			open: async (level: QualityLevel) => {
				this.downloads++
				this.levels.push(level)
				return { stream: Readable.from([Buffer.from('fake-audio-'), Buffer.from(meta.id)]), mimeType: this.mimeType, sizeBytes: 13 }
			}
		}
	}
	async accountInfo() {
		return {}
	}
	async accountQuality() {
		return { codec: 'flac' as const, lossless: true, bitDepth: 24, sampleRateHz: 96000 }
	}
}

const sourceTracks: SourceTrack[] = [
	// ISRC match → auto
	{ sourceId: 's1', title: 'One', artists: ['Alpha'], durationMs: 200_500, isrc: 'ISRC1' },
	// Text match with high score → auto
	{ sourceId: 's2', title: 'Two', artists: ['Beta'], durationMs: 180_000 },
	// Only a live version exists → needs review
	{ sourceId: 's3', title: 'Three', artists: ['Gamma'], durationMs: 240_000 },
	// Nothing found → needs review (notfound)
	{ sourceId: 's4', title: 'Four', artists: ['Nobody'], durationMs: 100_000 }
]

class FakeSource implements SourceConnector {
	readonly service = 'spotify' as const
	created: { sourceId: string; name: string; trackIds: string[] }[] = []
	async identity() {
		return { name: 'Test', email: 'test@example.com' }
	}
	async listPlaylists() {
		return [
			{ sourceId: 'p1', name: 'Mi Playlist: Favoritas?', trackCount: sourceTracks.length, snapshot: 'v1' },
			...this.created.map((p) => ({ sourceId: p.sourceId, name: p.name, trackCount: p.trackIds.length, snapshot: 'v1' }))
		]
	}
	async getPlaylistTracks(playlistId: string) {
		const created = this.created.find((p) => p.sourceId === playlistId)
		return created ? sourceTracks.filter((t) => created.trackIds.includes(t.sourceId)) : sourceTracks
	}
	async search(query: string, limit: number) {
		return sourceTracks.filter((t) => t.title.toLowerCase().includes(query.toLowerCase())).slice(0, limit)
	}
	async createPlaylist(name: string, trackIds: string[]) {
		const sourceId = `new${this.created.length + 1}`
		this.created.push({ sourceId, name, trackIds })
		return sourceId
	}
}

/** Stands in for ffmpeg: writes a marker plus the input, and records each conversion. */
class FakeConverter {
	/** MP3 conversions. */
	calls: { input: string; lossless: boolean }[] = []
	/** AIFF/WAV conversions. */
	pcm: { input: string; format: string; bitDepth: number }[] = []
	/** Makes every conversion fail. */
	fail = false
	async toMp3(input: string, output: string, opts: { lossless: boolean }) {
		this.calls.push({ input: path.basename(input), lossless: opts.lossless })
		if (this.fail) throw new Error('No se pudo convertir a MP3: prueba')
		fs.writeFileSync(output, Buffer.concat([Buffer.from('mp3:'), fs.readFileSync(input)]))
	}
	async toPcm(input: string, output: string, opts: { format: string; bitDepth: number }) {
		this.pcm.push({ input: path.basename(input), format: opts.format, bitDepth: opts.bitDepth })
		if (this.fail) throw new Error(`No se pudo convertir a ${opts.format.toUpperCase()}: prueba`)
		fs.writeFileSync(output, Buffer.concat([Buffer.from(`${opts.format}:`), fs.readFileSync(input)]))
	}
}

let dir: string
let kemix: Kemix
let downloader: FakeDownloader
let converter: FakeConverter

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kemix-test-'))
	converter = new FakeConverter()
	kemix = new Kemix({ dataDir: path.join(dir, 'data'), cipher: passphraseCipher('test'), converter })
	kemix.settings.update({ downloadDir: path.join(dir, 'music') })
	// Key and BPM analysis after each download has its own tests (features-analyzer.test.ts).
	Object.assign(kemix.features, { trackDownloaded: () => {} })
	downloader = new FakeDownloader()
	const source = new FakeSource()
	Object.assign(kemix.accounts, {
		isConnected: (s: SourceService) => s === 'spotify' || s === 'qobuz',
		source: () => source,
		downloader: async () => downloader,
		downloaders: async () => [downloader],
		// No network in tests: the ISRC fallback finds nothing.
		findIsrc: async () => null
	})
	kemix.start()
})

afterEach(() => {
	kemix.close()
	fs.rmSync(dir, { recursive: true, force: true })
})

describe('library + download queue', () => {
	it('syncs, matches, downloads, and leaves uncertain tracks for review', async () => {
		await kemix.library.syncAll()
		const [playlist] = kemix.library.listPlaylists()
		expect(playlist!.name).toBe('Mi Playlist: Favoritas?')

		await kemix.queue.enqueuePlaylist(playlist!.id)
		await settle(kemix)

		const detail = await kemix.library.getPlaylist(playlist!.id)
		expect(detail.tracks.map((t) => t.download?.status)).toEqual(['done', 'done', 'needs_review', 'needs_review'])
		expect(detail.tracks[0]!.match?.status).toBe('auto')

		const folder = path.join(dir, 'music', 'Mi Playlist_ Favoritas_')
		const files = fs.readdirSync(folder).sort()
		expect(files).toContain('01 - Alpha - One.mp3')
		expect(files).toContain('02 - Beta - Two.mp3')
		const m3u = fs.readFileSync(path.join(folder, 'Mi Playlist_ Favoritas_.m3u8'), 'utf8')
		expect(m3u).toContain('01 - Alpha - One.mp3')

		const review = kemix.library.listReview()
		expect(review.map((r) => r.title).sort()).toEqual(['Four', 'Three'])
		const three = review.find((r) => r.title === 'Three')!
		expect(three.candidates[0]!.title).toBe('Three (Live)')

		// Accepting the live version downloads it; skipping the other marks it skipped.
		kemix.queue.acceptCandidate(three.trackId, three.candidates[0]!)
		kemix.queue.skipTrack(review.find((r) => r.title === 'Four')!.trackId)
		await settle(kemix)

		const after = await kemix.library.getPlaylist(playlist!.id)
		expect(after.tracks.map((t) => t.download?.status)).toEqual(['done', 'done', 'done', 'skipped'])
		expect(kemix.library.listReview()).toEqual([])
		expect(fs.readdirSync(folder)).toContain('03 - Gamma - Three (Live).mp3')
		expect(downloader.downloads).toBe(3)
	})

	it('retries tracks that did not download with another provider, chosen later', async () => {
		// A second service that does have "Four".
		const four: TargetTrack = { service: 'deezer', id: 'd4', url: 'https://www.deezer.com/track/d4', title: 'Four', artists: ['Nobody'], durationMs: 100_000 }
		let deezerDownloads = 0
		const deezer: Downloader = {
			service: 'deezer',
			isrcLookup: async () => null,
			search: async (q) => (q.toLowerCase().includes('nobody') ? [four] : []),
			getTrack: async () => ({
				meta: four,
				open: async () => {
					deezerDownloads++
					return { stream: Readable.from([Buffer.from('fake-audio-d4')]), mimeType: 'audio/mpeg', sizeBytes: 13 }
				}
			}),
			accountInfo: async () => ({}),
			accountQuality: async () => ({ codec: 'flac' as const, lossless: true })
		}
		Object.assign(kemix.accounts, {
			isConnected: (s: SourceService) => s === 'spotify' || s === 'qobuz' || s === 'deezer',
			downloader: async (s: string) => (s === 'deezer' ? deezer : downloader)
		})

		await kemix.library.syncAll()
		const [playlist] = kemix.library.listPlaylists()
		await kemix.queue.enqueuePlaylist(playlist!.id, undefined, 'qobuz')
		await settle(kemix)
		let detail = await kemix.library.getPlaylist(playlist!.id)
		expect(detail.tracks.map((t) => t.download?.status)).toEqual(['done', 'done', 'needs_review', 'needs_review'])

		// Only the missing one, with Deezer: it's found and downloaded there; the rest is untouched.
		await kemix.queue.enqueuePlaylist(playlist!.id, [3], 'deezer')
		await settle(kemix)
		detail = await kemix.library.getPlaylist(playlist!.id)
		expect(detail.tracks.map((t) => t.download?.status)).toEqual(['done', 'done', 'needs_review', 'done'])
		expect(detail.tracks[3]!.download?.service).toBe('deezer')
		expect(deezerDownloads).toBe(1)
		expect(downloader.downloads).toBe(2)

		// A provider that isn't connected is refused up front.
		Object.assign(kemix.accounts, { isConnected: (s: SourceService) => s === 'spotify' || s === 'qobuz' })
		await expect(kemix.queue.enqueuePlaylist(playlist!.id, [2], 'deezer')).rejects.toThrow(/Deezer no está conectado/)
	})

	it('searches review options on the picked provider and downloads a pick from another one', async () => {
		const deezerThree: TargetTrack = {
			service: 'deezer',
			id: 'd3',
			url: 'https://www.deezer.com/track/d3',
			title: 'Three (Live)',
			artists: ['Gamma'],
			durationMs: 300_000,
			isrc: 'ISRC3'
		}
		const deezer: Downloader = {
			service: 'deezer',
			isrcLookup: async () => null,
			search: async (q) => (q.toLowerCase().includes('gamma') ? [deezerThree] : []),
			getTrack: async () => {
				throw new Error('should be downloaded from Qobuz')
			},
			accountInfo: async () => ({}),
			accountQuality: async () => ({ codec: 'flac' as const, lossless: true })
		}
		// Qobuz has the live version under the same ISRC.
		const lookup = downloader.isrcLookup.bind(downloader)
		downloader.isrcLookup = async (isrc) => (isrc === 'ISRC3' ? catalog[2]! : lookup(isrc))
		Object.assign(kemix.accounts, {
			isConnected: (s: SourceService) => s === 'spotify' || s === 'qobuz' || s === 'deezer',
			downloader: async (s: string) => (s === 'deezer' ? deezer : downloader)
		})

		await kemix.library.syncAll()
		const [playlist] = kemix.library.listPlaylists()
		await kemix.queue.enqueuePlaylist(playlist!.id)
		await settle(kemix)
		const three = kemix.library.listReview().find((r) => r.title === 'Three')!

		// Only the picked provider is searched.
		const found = await kemix.queue.searchCandidates(three.trackId, undefined, 'deezer')
		expect(found.map((c) => `${c.service}:${c.id}`)).toEqual(['deezer:d3'])

		// Picked on Deezer, downloaded from Qobuz: that same recording, found there by its ISRC.
		await kemix.queue.acceptCandidateFrom(three.trackId, found[0]!, 'qobuz')
		await settle(kemix)
		const after = await kemix.library.getPlaylist(playlist!.id)
		expect(after.tracks[2]!.match?.targetService).toBe('qobuz')
		expect(after.tracks[2]!.download).toMatchObject({ status: 'done', service: 'qobuz' })

		// Nothing close enough on the other service: refused, and the track stays in review.
		const four = kemix.library.listReview().find((r) => r.title === 'Four')!
		const decoy = { ...deezerThree, id: 'd9', title: 'Something Else', artists: ['Nobody'], isrc: undefined, score: 0.4 }
		await expect(kemix.queue.acceptCandidateFrom(four.trackId, decoy, 'qobuz')).rejects.toThrow(
			/No encontré ese mismo tema en Qobuz/
		)
		expect(kemix.library.listReview().map((r) => r.title)).toEqual(['Four'])

		// A provider that isn't connected is refused up front.
		Object.assign(kemix.accounts, { isConnected: (s: SourceService) => s === 'spotify' || s === 'qobuz' })
		await expect(kemix.queue.searchCandidates(four.trackId, undefined, 'deezer')).rejects.toThrow(/Deezer no está conectado/)
	})

	it("offers a YouTube Music track's own video in review and for YouTube downloads", async () => {
		await kemix.library.syncAll()
		const [playlist] = kemix.library.listPlaylists()
		await kemix.queue.enqueuePlaylist(playlist!.id)
		await settle(kemix)
		// "Four" (not on Qobuz) came from YouTube Music: its source ID is the video.
		kemix.db.prepare(`UPDATE tracks SET source = 'ytmusic', source_id = 'trpsQAD6ZdA' WHERE title = 'Four'`).run()
		// No network: YouTube's search finds nothing.
		Object.assign(kemix.accounts.youtube, { search: async () => [] })

		const four = kemix.library.listReview().find((r) => r.title === 'Four')!
		expect(four.notFound).toBe(true)
		expect(four.candidates[0]).toMatchObject({ service: 'youtube', id: 'trpsQAD6ZdA', title: 'Four', score: 1 })
		// What "Bajar desde YouTube" picks from.
		const videos = await kemix.queue.youtubeCandidates(four.trackId)
		expect(videos[0]).toMatchObject({ id: 'trpsQAD6ZdA', url: 'https://www.youtube.com/watch?v=trpsQAD6ZdA', score: 1 })
		// Tracks from elsewhere get no such video.
		const three = kemix.library.listReview().find((r) => r.title === 'Three')!
		expect(three.candidates.some((c) => c.service === 'youtube')).toBe(false)
	})

	it('scans quality before downloading, without downloading, and the download reuses the scan', async () => {
		const hires = { codec: 'flac' as const, lossless: true, bitDepth: 24, sampleRateHz: 96000 }
		// Search results without quality (like a match straight from the playlist's service): the scan asks for it.
		let searches = 0
		const search = downloader.search.bind(downloader)
		downloader.search = async (q: string) => {
			searches++
			return search(q)
		}
		const getTrack = downloader.getTrack.bind(downloader)
		downloader.getTrack = async (url: string) => {
			const t = await getTrack(url)
			return { ...t, meta: { ...t.meta, maxQuality: hires } }
		}
		await kemix.library.syncAll()
		const [playlist] = kemix.library.listPlaylists()

		const started = await kemix.queue.scanPlaylist(playlist!.id)
		expect(started).toMatchObject({ running: true, total: 4, done: 0 })
		const scan = await waitFor(() => {
			const s = kemix.queue.scanState(playlist!.id)
			return s && !s.running && s
		})
		expect(scan).toMatchObject({ done: 4, total: 4, failed: 0 })
		expect(downloader.downloads).toBe(0)
		expect(kemix.db.prepare('SELECT COUNT(*) AS n FROM downloads').get()).toEqual({ n: 0 })

		const detail = await kemix.library.getPlaylist(playlist!.id)
		expect(detail.tracks.map((t) => t.match?.status)).toEqual(['auto', 'auto', 'notfound', 'notfound'])
		expect(detail.tracks[0]!.match?.maxQuality).toEqual(hires)
		expect(detail.tracks[1]!.match?.maxQuality).toEqual(hires)
		expect(detail.tracks.every((t) => !t.download)).toBe(true)

		// Downloading afterwards uses the matches found: no new searches for the tracks already matched.
		const before = searches
		await kemix.queue.enqueuePlaylist(playlist!.id, [0, 1])
		await settle(kemix)
		expect(searches).toBe(before)
		expect(downloader.downloads).toBe(2)

		// A second scan only looks up what's still unresolved (and not what was downloaded).
		await kemix.queue.scanPlaylist(playlist!.id)
		const again = await waitFor(() => {
			const s = kemix.queue.scanState(playlist!.id)
			return s && !s.running && s
		})
		expect(again.total).toBe(2)
	})

	it('reuses already-downloaded files instead of downloading again', async () => {
		await kemix.library.syncAll()
		const [playlist] = kemix.library.listPlaylists()
		await kemix.queue.enqueuePlaylist(playlist!.id)
		await settle(kemix)
		expect(downloader.downloads).toBe(2)

		// Re-enqueue: done rows stay done, nothing new is downloaded.
		await kemix.queue.enqueuePlaylist(playlist!.id)
		await settle(kemix)
		expect(downloader.downloads).toBe(2)

		// A file deleted from disk is downloaded again on the next enqueue.
		const done = (await kemix.library.getPlaylist(playlist!.id)).tracks[0]!.download!.path!
		fs.rmSync(done)
		await kemix.queue.enqueuePlaylist(playlist!.id)
		await settle(kemix)
		expect(fs.existsSync(done)).toBe(true)
		expect(downloader.downloads).toBe(3)
	})

	it('downloads in the quality from settings, or the one picked for the download', async () => {
		kemix.settings.update({ downloadQuality: 'cd' })
		await kemix.library.syncAll()
		const [playlist] = kemix.library.listPlaylists()
		await kemix.queue.enqueuePlaylist(playlist!.id, [0])
		await settle(kemix)
		expect(downloader.levels).toEqual(['cd'])

		await kemix.queue.enqueuePlaylist(playlist!.id, [1], null, 'mp3_320')
		await settle(kemix)
		expect(downloader.levels).toEqual(['cd', 'mp3_320'])
	})

	it('only reuses a file downloaded in the same quality', async () => {
		await kemix.library.syncAll()
		const [playlist] = kemix.library.listPlaylists()
		await kemix.queue.enqueuePlaylist(playlist!.id, [0], null, 'max')
		await settle(kemix)
		expect(downloader.downloads).toBe(1)

		// Same track in other playlists: reused at the same level, downloaded again at a lower one.
		const same = await kemix.library.createPlaylist('spotify', 'Misma calidad', ['s1'])
		await kemix.queue.enqueuePlaylist(same.playlistId!, undefined, null, 'max')
		await settle(kemix)
		expect(downloader.downloads).toBe(1)

		const mp3 = await kemix.library.createPlaylist('spotify', 'En MP3', ['s1'])
		await kemix.queue.enqueuePlaylist(mp3.playlistId!, undefined, null, 'mp3_320')
		await settle(kemix)
		expect(downloader.levels).toEqual(['max', 'mp3_320'])

		// Qobuz has nothing below MP3 320, so asking for MP3 128 reuses that file.
		const mp3Low = await kemix.library.createPlaylist('spotify', 'En MP3 128', ['s1'])
		await kemix.queue.enqueuePlaylist(mp3Low.playlistId!, undefined, null, 'mp3_128')
		await settle(kemix)
		expect(downloader.downloads).toBe(2)
		const tracks = (await kemix.library.getPlaylist(mp3Low.playlistId!)).tracks
		expect(tracks[0]!.download?.status).toBe('done')
	})

	it('converts to MP3 only what does not arrive as MP3 when "MP3 compatible" is picked', async () => {
		await kemix.library.syncAll()
		const [playlist] = kemix.library.listPlaylists()
		// Qobuz's own MP3 is already compatible: asked as MP3 320, kept as it came.
		await kemix.queue.enqueuePlaylist(playlist!.id, [0], null, 'mp3_compat')
		await settle(kemix)
		expect(downloader.levels).toEqual(['mp3_compat'])
		expect(converter.calls).toEqual([])

		// A FLAC (or YouTube's AAC) is converted: an .mp3 is left, and nothing of the original.
		Object.assign(downloader, {
			getTrack: async (url: string) => ({
				meta: catalog.find((t) => t.url === url)!,
				open: async () => ({ stream: Readable.from([Buffer.from('flac-audio')]), mimeType: 'audio/flac' })
			})
		})
		await kemix.queue.enqueuePlaylist(playlist!.id, [1], null, 'mp3_compat')
		await settle(kemix)
		expect(converter.calls).toEqual([{ input: '02 - Beta - Two.mp3.download.flac', lossless: true }])
		const folder = path.join(dir, 'music', 'Mi Playlist_ Favoritas_')
		const files = fs.readdirSync(folder).filter((f) => !f.endsWith('.m3u8')).sort()
		expect(files).toEqual(['01 - Alpha - One.mp3', '02 - Beta - Two.mp3'])
		expect(fs.readFileSync(path.join(folder, '02 - Beta - Two.mp3'), 'utf8')).toBe('mp3:flac-audio')

		// Other qualities are left as they come.
		const flac = await kemix.library.createPlaylist('spotify', 'En FLAC', ['s1'])
		await kemix.queue.enqueuePlaylist(flac.playlistId!, undefined, null, 'max')
		await settle(kemix)
		expect((await kemix.library.getPlaylist(flac.playlistId!)).tracks[0]!.download?.path).toMatch(/\.flac$/)
		expect(converter.calls).toHaveLength(1)

		// The MP3 already there is reused for "MP3 compatible", not the FLAC.
		const again = await kemix.library.createPlaylist('spotify', 'Compatible', ['s1'])
		await kemix.queue.enqueuePlaylist(again.playlistId!, undefined, null, 'mp3_compat')
		await settle(kemix)
		expect((await kemix.library.getPlaylist(again.playlistId!)).tracks[0]!.download?.path).toMatch(/\.mp3$/)
		expect(converter.calls).toHaveLength(1)
	})

	it('converts downloads to AIFF/WAV, and reuses or converts files it already has', async () => {
		downloader.mimeType = 'audio/flac'
		await kemix.library.syncAll()
		const [playlist] = kemix.library.listPlaylists()
		await kemix.queue.enqueuePlaylist(playlist!.id, [0], null, 'max', 'aiff')
		await settle(kemix)
		const folder = path.join(dir, 'music', 'Mi Playlist_ Favoritas_')
		// Only the converted file is left: neither the FLAC it came from nor temporary files.
		expect(fs.readdirSync(folder).filter((f) => !f.endsWith('.m3u8'))).toEqual(['01 - Alpha - One.aiff'])
		expect(fs.readFileSync(path.join(folder, '01 - Alpha - One.aiff'), 'utf8')).toBe('aiff:fake-audio-q1')
		// Its quality couldn't be read (it isn't real audio): 24-bit, so nothing is lost.
		expect(converter.pcm).toEqual([{ input: '01 - Alpha - One.aiff.download.flac', format: 'aiff', bitDepth: 24 }])
		expect(fs.readFileSync(path.join(folder, 'Mi Playlist_ Favoritas_.m3u8'), 'utf8')).toContain('01 - Alpha - One.aiff')

		// Same track and format elsewhere: reused as is.
		const again = await kemix.library.createPlaylist('spotify', 'Otra vez AIFF', ['s1'])
		await kemix.queue.enqueuePlaylist(again.playlistId!, undefined, null, 'max', 'aiff')
		await settle(kemix)
		expect(downloader.downloads).toBe(1)
		expect(converter.pcm).toHaveLength(1)

		// Without converting it's downloaded again (the AIFF isn't the FLAC)…
		const flac = await kemix.library.createPlaylist('spotify', 'En FLAC', ['s1'])
		await kemix.queue.enqueuePlaylist(flac.playlistId!, undefined, null, 'max', 'original')
		await settle(kemix)
		expect(downloader.downloads).toBe(2)
		const flacPath = (await kemix.library.getPlaylist(flac.playlistId!)).tracks[0]!.download!.path!
		expect(flacPath).toMatch(/One\.flac$/)

		// …and that FLAC is converted to WAV for the next playlist, without downloading again.
		const wav = await kemix.library.createPlaylist('spotify', 'En WAV', ['s1'])
		await kemix.queue.enqueuePlaylist(wav.playlistId!, undefined, null, 'max', 'wav')
		await settle(kemix)
		expect(downloader.downloads).toBe(2)
		expect(converter.pcm.map((c) => `${c.input}>${c.format}`)).toEqual([
			'01 - Alpha - One.aiff.download.flac>aiff',
			`${path.basename(flacPath)}>wav`
		])
		const wavPath = (await kemix.library.getPlaylist(wav.playlistId!)).tracks[0]!.download!.path!
		expect(fs.readFileSync(wavPath, 'utf8')).toBe('wav:fake-audio-q1')

		// The format from settings applies when none is picked.
		kemix.settings.update({ outputFormat: 'wav' })
		const fromSettings = await kemix.library.createPlaylist('spotify', 'Por defecto', ['s2'])
		await kemix.queue.enqueuePlaylist(fromSettings.playlistId!)
		await settle(kemix)
		expect((await kemix.library.getPlaylist(fromSettings.playlistId!)).tracks[0]!.download?.path).toMatch(/Two\.wav$/)
		expect(converter.calls).toEqual([])
	})

	it('fails a download whose conversion fails, leaving nothing behind', async () => {
		converter.fail = true
		downloader.mimeType = 'audio/flac'
		await kemix.library.syncAll()
		const [playlist] = kemix.library.listPlaylists()
		await kemix.queue.enqueuePlaylist(playlist!.id, [0], null, null, 'aiff')
		await settle(kemix)
		const row = (await kemix.library.getPlaylist(playlist!.id)).tracks[0]!.download!
		expect(row).toMatchObject({ status: 'error', error: 'No se pudo convertir a AIFF: prueba' })
		expect(fs.readdirSync(path.join(dir, 'music', 'Mi Playlist_ Favoritas_'))).toEqual([])
	})

	it('marks tracks as not downloaded when their file was deleted from disk', async () => {
		await kemix.library.syncAll()
		const [playlist] = kemix.library.listPlaylists()
		await kemix.queue.enqueuePlaylist(playlist!.id)
		await settle(kemix)

		const before = await kemix.library.getPlaylist(playlist!.id)
		fs.rmSync(before.tracks[0]!.download!.path!)

		await kemix.library.syncAll()
		const after = await kemix.library.getPlaylist(playlist!.id)
		expect(after.tracks.map((t) => t.download?.status)).toEqual([undefined, 'done', 'needs_review', 'needs_review'])
		expect(after.downloads.done).toBe(1)
	})

	it('deletes a finished download with its file, keeping copies in other playlists', async () => {
		await kemix.library.syncAll()
		const [playlist] = kemix.library.listPlaylists()
		await kemix.queue.enqueuePlaylist(playlist!.id)
		await settle(kemix)
		const other = await kemix.library.createPlaylist('spotify', 'Otra', ['s1'])
		await kemix.queue.enqueuePlaylist(other.playlistId!)
		await settle(kemix)

		const file = (await kemix.library.getPlaylist(playlist!.id)).tracks[0]!.download!.path!
		const row = kemix.queue.list().find((r) => r.playlistId === playlist!.id && r.title === 'One')!
		await kemix.queue.remove(row.id)
		await kemix.queue.flush()

		expect(fs.existsSync(file)).toBe(false)
		const detail = await kemix.library.getPlaylist(playlist!.id)
		expect(detail.tracks.map((t) => t.download?.status)).toEqual([undefined, 'done', 'needs_review', 'needs_review'])
		const m3u = fs.readFileSync(path.join(path.dirname(file), 'Mi Playlist_ Favoritas_.m3u8'), 'utf8')
		expect(m3u).not.toContain('One.mp3')
		expect(m3u).toContain('02 - Beta - Two.mp3')
		// The other playlist has its own file, which stays.
		expect((await kemix.library.getPlaylist(other.playlistId!)).tracks[0]!.download?.status).toBe('done')
	})

	it('stops a download deleted while running and leaves no file behind', async () => {
		const stream = new PassThrough()
		Object.assign(downloader, {
			getTrack: async (url: string) => ({
				meta: catalog.find((t) => t.url === url)!,
				// Never ends on its own: only stopping the download finishes it.
				open: async () => {
					stream.write('partial-audio')
					return { stream, mimeType: 'audio/mpeg', sizeBytes: 1000 }
				}
			})
		})
		await kemix.library.syncAll()
		const [playlist] = kemix.library.listPlaylists()
		await kemix.queue.enqueuePlaylist(playlist!.id, [0])
		const row = await waitFor(() => kemix.queue.list().find((r) => r.status === 'downloading' && r.bytes))

		await kemix.queue.remove(row.id)
		expect(kemix.queue.list()).toEqual([])
		const folder = path.join(dir, 'music', 'Mi Playlist_ Favoritas_')
		await waitFor(() => stream.destroyed && fs.readdirSync(folder).length === 0)
	})

	it('searches a connected service and creates a playlist there that shows up in the library', async () => {
		expect((await kemix.library.search('spotify', 'two')).map((t) => t.sourceId)).toEqual(['s2'])
		await expect(kemix.library.search('deezer', 'two')).rejects.toThrow(/no está conectado/)
		await expect(kemix.library.createPlaylist('spotify', '  ', ['s1'])).rejects.toThrow(/nombre/)

		const { playlistId } = await kemix.library.createPlaylist('spotify', 'Nueva', ['s2', 's1'])
		expect(playlistId).not.toBeNull()
		const detail = await kemix.library.getPlaylist(playlistId!)
		expect(detail.name).toBe('Nueva')
		expect(detail.tracks.map((t) => t.title).sort()).toEqual(['One', 'Two'])
	})

	it('creates a playlist on another service with tracks found there, leaving out the ones it lacks', async () => {
		const source = kemix.accounts.source('spotify') as unknown as FakeSource
		// What the other service (SoundCloud) gave: noisy titles; "Nada" isn't on Spotify.
		const fromSoundCloud: SourceTrack[] = [
			{ sourceId: 'sc2', title: 'Beta - Two (Original Mix)', artists: ['Beta Official'], durationMs: 181_000 },
			{ sourceId: 'sc1', title: 'One', artists: ['Alpha'], durationMs: 200_000 },
			{ sourceId: 'sc9', title: 'Nada', artists: ['Nadie'], durationMs: 100_000 }
		]
		Object.assign(source, {
			search: async (q: string) => sourceTracks.filter((t) => q.toLowerCase().includes(t.artists[0]!.toLowerCase()))
		})
		const res = await kemix.library.copyPlaylist('spotify', 'Desde SoundCloud', fromSoundCloud)
		expect(source.created.at(-1)).toMatchObject({ name: 'Desde SoundCloud', trackIds: ['s2', 's1'] })
		expect(res.added).toBe(2)
		expect(res.missing.map((t) => t.sourceId)).toEqual(['sc9'])
		expect(res.playlistId).not.toBeNull()

		await expect(kemix.library.copyPlaylist('spotify', 'Vacía', [fromSoundCloud[2]!])).rejects.toThrow(/Ninguno/)
	})

	it('organizes playlists into folders and keeps them when a folder is deleted', async () => {
		await kemix.library.syncAll()
		const [playlist] = kemix.library.listPlaylists()
		const parent = kemix.library.createFolder('Rock', null)
		const child = kemix.library.createFolder('Clásico', parent.id)
		kemix.library.movePlaylist(playlist!.id, child.id)
		expect(kemix.library.listPlaylists()[0]!.folderId).toBe(child.id)

		expect(() => kemix.library.updateFolder(parent.id, { parentId: child.id })).toThrow()

		kemix.library.deleteFolder(child.id)
		expect(kemix.library.listPlaylists()[0]!.folderId).toBe(parent.id)
		expect(kemix.library.listFolders().map((f) => f.name)).toEqual(['Rock'])
	})

	it('encrypts secrets at rest', () => {
		kemix.secrets.set('deezer', { arl: 'super-secret-arl' })
		const raw = kemix.db.prepare(`SELECT value FROM secrets WHERE key = 'deezer'`).get() as { value: string }
		expect(raw.value).not.toContain('super-secret-arl')
		expect(kemix.secrets.get<{ arl: string }>('deezer')!.arl).toBe('super-secret-arl')
	})
})

describe('temas sueltos (playlists de Kemix)', () => {
	const fromSpotify = (t: SourceTrack) => ({ ...t, source: 'spotify' as const })

	it('baja temas de una búsqueda a «Temas sueltos», como cualquier playlist', async () => {
		const [one, two] = sourceTracks
		const { playlistId } = await kemix.queue.enqueueLoose('buscar', [fromSpotify(one!), fromSpotify(two!)], null, 'mp3_320')
		await settle(kemix)
		const detail = await kemix.library.getPlaylist(playlistId)
		expect(detail).toMatchObject({ source: 'local', sourceId: 'buscar', name: 'Temas sueltos' })
		expect(detail.tracks.map((t) => t.download?.status)).toEqual(['done', 'done'])
		expect(downloader.levels).toEqual(['mp3_320', 'mp3_320'])
		expect(fs.readdirSync(path.join(dir, 'music', 'Temas sueltos'))).toContain('01 - Alpha - One.mp3')
	})

	it('no repite temas, reutiliza el de otra playlist y la sincronización no la toca', async () => {
		await kemix.library.syncAll()
		const [synced] = kemix.library.listPlaylists()
		const syncedTrack = (await kemix.library.getPlaylist(synced!.id)).tracks[0]!
		const once = kemix.library.addToLocalPlaylist('buscar', [fromSpotify(sourceTracks[0]!)])
		const twice = kemix.library.addToLocalPlaylist('buscar', [fromSpotify(sourceTracks[0]!), fromSpotify(sourceTracks[1]!)])
		expect(twice.positions).toEqual([once.positions[0], 1])
		const local = await kemix.library.getPlaylist(once.playlistId)
		expect(local.tracks[0]!.trackId).toBe(syncedTrack.trackId)
		await kemix.library.syncAll()
		await kemix.library.syncPlaylistTracks(once.playlistId, true)
		expect(kemix.library.listPlaylists().find((p) => p.id === once.playlistId)).toMatchObject({ removed: false, trackCount: 2 })
	})

	it('si el proveedor elegido no está conectado, no agrega nada', async () => {
		await expect(kemix.queue.enqueueLoose('buscar', [fromSpotify(sourceTracks[0]!)], 'deezer')).rejects.toThrow(
			'Deezer no está conectado'
		)
		expect(kemix.library.listPlaylists()).toEqual([])
	})
})
