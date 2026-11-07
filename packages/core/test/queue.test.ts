import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Kemix, passphraseCipher, type SourceService, type SourceTrack, type TargetTrack } from '../src/index'
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

const catalog: TargetTrack[] = [
	{ service: 'qobuz', id: 'q1', url: 'https://play.qobuz.com/track/q1', title: 'One', artists: ['Alpha'], durationMs: 200_000, isrc: 'ISRC1' },
	{ service: 'qobuz', id: 'q2', url: 'https://play.qobuz.com/track/q2', title: 'Two', artists: ['Beta'], durationMs: 180_000 },
	{ service: 'qobuz', id: 'q3', url: 'https://play.qobuz.com/track/q3', title: 'Three (Live)', artists: ['Gamma'], durationMs: 300_000 }
]

class FakeDownloader implements Downloader {
	readonly service = 'qobuz' as const
	downloads = 0
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
			open: async () => {
				this.downloads++
				return { stream: Readable.from([Buffer.from('fake-audio-'), Buffer.from(meta.id)]), mimeType: 'audio/mpeg', sizeBytes: 13 }
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

let dir: string
let kemix: Kemix
let downloader: FakeDownloader

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kemix-test-'))
	kemix = new Kemix({ dataDir: path.join(dir, 'data'), cipher: passphraseCipher('test') })
	kemix.settings.update({ downloadDir: path.join(dir, 'music') })
	downloader = new FakeDownloader()
	const source = new FakeSource()
	Object.assign(kemix.accounts, {
		isConnected: (s: SourceService) => s === 'spotify' || s === 'qobuz',
		source: () => source,
		downloader: async () => downloader,
		downloaders: async () => [downloader]
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
