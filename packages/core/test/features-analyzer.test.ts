import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	FeatureSources,
	Kemix,
	passphraseCipher,
	type KemixEvent,
	type ScanState,
	type SourceService,
	type SourceTrack,
	type TargetTrack
} from '../src/index'
import type { AudioDecoder } from '../src/download/ffmpeg'
import type { Downloader } from '../src/download/lucida-adapter'
import type { SourceConnector } from '../src/sources/types'
import { readKeyBpm } from '../src/download/tagger'
import { beat, chords } from './signals'

const mix = (a: Float32Array, b: Float32Array) => a.map((v, i) => v + (b[i] ?? 0))
/** What the "Deezer preview" sounds like: 128 BPM in A minor. */
const PREVIEW_AUDIO = mix(beat(128, 24), chords([['A', 'C', 'E'], ['D', 'F', 'A'], ['E', 'G#', 'B'], ['A', 'C', 'E']], 2, 3))
/** What the downloaded files sound like: 100 BPM in C major, so it's clear which one was analyzed. */
const FILE_AUDIO = mix(beat(100, 24), chords([['C', 'E', 'G'], ['F', 'A', 'C'], ['G', 'B', 'D'], ['C', 'E', 'G']], 2, 3))

class FakeDecoder implements AudioDecoder {
	inputs: string[] = []
	async decodePcm(input: string | Buffer) {
		this.inputs.push(typeof input === 'string' ? path.basename(input) : `bytes:${input.toString()}`)
		return typeof input === 'string' ? FILE_AUDIO : PREVIEW_AUDIO
	}
}

const sourceTracks: SourceTrack[] = [
	// Deezer has its BPM; the key comes from analyzing its preview.
	{ sourceId: 's1', title: 'One', artists: ['Alpha'], durationMs: 200_000, isrc: 'USAAA0000001' },
	// Deezer has no BPM (0) but has a preview: both analyzed from it.
	{ sourceId: 's2', title: 'Two', artists: ['Beta'], durationMs: 180_000, isrc: 'USAAA0000002' },
	// Nowhere to be found.
	{ sourceId: 's3', title: 'Three', artists: ['Gamma'], durationMs: 240_000 },
	// No preview to analyze: AcousticBrainz, as a last resort.
	{ sourceId: 's4', title: 'Four', artists: ['Delta'], durationMs: 300_000, isrc: 'USAAA0000004' }
]

const catalog: TargetTrack[] = sourceTracks.map((t, i) => ({
	service: 'qobuz',
	id: `q${i + 1}`,
	url: `https://play.qobuz.com/track/q${i + 1}`,
	title: t.title,
	artists: t.artists,
	durationMs: t.durationMs,
	isrc: t.isrc
}))

/** A minimal valid WAV, so taglib can write tags into the downloaded files. */
function wavFile(frames = 4410): Buffer {
	const dataSize = frames * 4
	const b = Buffer.alloc(44 + dataSize)
	b.write('RIFF', 0)
	b.writeUInt32LE(36 + dataSize, 4)
	b.write('WAVE', 8)
	b.write('fmt ', 12)
	b.writeUInt32LE(16, 16)
	b.writeUInt16LE(1, 20)
	b.writeUInt16LE(2, 22)
	b.writeUInt32LE(44100, 24)
	b.writeUInt32LE(44100 * 4, 28)
	b.writeUInt16LE(4, 32)
	b.writeUInt16LE(16, 34)
	b.write('data', 36)
	b.writeUInt32LE(dataSize, 40)
	return b
}

const downloader: Downloader = {
	service: 'qobuz',
	isrcLookup: async (isrc) => catalog.find((t) => t.isrc === isrc) ?? null,
	search: async (q) => catalog.filter((t) => q.toLowerCase().includes(t.artists[0]!.toLowerCase())),
	getTrack: async (url) => ({
		meta: catalog.find((t) => t.url === url)!,
		open: async () => ({ stream: Readable.from([wavFile()]), mimeType: 'audio/wav' })
	}),
	accountInfo: async () => ({}),
	accountQuality: async () => ({ codec: 'flac', lossless: true, bitDepth: 16, sampleRateHz: 44100 })
}

const source: SourceConnector = {
	service: 'spotify',
	identity: async () => ({ name: 'Test' }),
	listPlaylists: async () => [{ sourceId: 'p1', name: 'Set', trackCount: sourceTracks.length, snapshot: 'v1' }],
	getPlaylistTracks: async () => sourceTracks,
	search: async () => [],
	createPlaylist: async () => 'x'
}

let release: () => void = () => {}
let held: Promise<void> = Promise.resolve()

/** Fake Deezer, MusicBrainz, AcousticBrainz and GetSongBPM, recording what was asked. */
function fakeWeb() {
	const calls: string[] = []
	vi.stubGlobal('fetch', async (input: string | URL) => {
		const url = new URL(String(input))
		const route = `${url.hostname}${url.pathname}`
		calls.push(route)
		// Deezer answers by ISRC and, once its id is known, by id.
		if (route === 'api.deezer.com/track/isrc:USAAA0000001' || route === 'api.deezer.com/track/1') {
			return Response.json({ id: 1, isrc: 'USAAA0000001', bpm: 124, preview: 'https://cdn.example/1.mp3' })
		}
		if (route === 'api.deezer.com/track/isrc:USAAA0000002' || route === 'api.deezer.com/track/2') {
			return Response.json({ id: 2, isrc: 'USAAA0000002', bpm: 0, preview: 'https://cdn.example/2.mp3' })
		}
		if (route === 'api.deezer.com/track/isrc:USAAA0000004' || route === 'api.deezer.com/track/4') {
			return Response.json({ id: 4, isrc: 'USAAA0000004', bpm: 0, preview: '' })
		}
		// Answers only once the test lets it (`release`).
		if (route === 'api.deezer.com/track/isrc:USAAA0000009') {
			await held
			return Response.json({ id: 9, isrc: 'USAAA0000009', bpm: 99, preview: '' })
		}
		if (url.hostname === 'api.deezer.com') return Response.json({ error: { code: 800 } })
		if (url.hostname === 'cdn.example') return new Response(`preview${url.pathname}`)
		if (url.hostname === 'musicbrainz.org') {
			return Response.json({ count: 1, recordings: [{ id: 'mb-4', isrcs: ['USAAA0000004'] }] })
		}
		if (url.hostname === 'acousticbrainz.org') {
			return Response.json({ 'mb-4': { 0: { rhythm: { bpm: 122.04 }, tonal: { key_key: 'D', key_scale: 'major' } } } })
		}
		if (url.hostname === 'api.getsong.co') {
			return Response.json({ search: [{ id: 'g1', title: 'One', tempo: '125', key_of: 'Em', artist: { name: 'Alpha' } }] })
		}
		return new Response('not found', { status: 404 })
	})
	return calls
}

let dir: string
let kemix: Kemix
let decoder: FakeDecoder
let calls: string[]
let events: KemixEvent[]

beforeEach(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kemix-features-'))
	calls = fakeWeb()
	decoder = new FakeDecoder()
	kemix = new Kemix({
		dataDir: path.join(dir, 'data'),
		cipher: passphraseCipher('test'),
		decoder,
		featureSources: new FeatureSources({ deezer: 0, musicbrainz: 0, acousticbrainz: 0, getsongbpm: 0 })
	})
	kemix.settings.update({ downloadDir: path.join(dir, 'music') })
	Object.assign(kemix.accounts, {
		isConnected: (s: SourceService) => s === 'spotify' || s === 'qobuz',
		source: () => source,
		downloader: async () => downloader,
		downloaders: async () => [downloader],
		findIsrc: async () => null
	})
	events = []
	kemix.events.subscribe((e) => events.push(e))
	await kemix.library.syncAll()
})

afterEach(() => {
	kemix.close()
	vi.unstubAllGlobals()
	fs.rmSync(dir, { recursive: true, force: true })
})

const playlistId = () => kemix.library.listPlaylists()[0]!.id
const features = async () => (await kemix.library.getPlaylist(playlistId())).tracks.map((t) => t.features)

async function settleDownloads() {
	for (let i = 0; i < 250; i++) {
		const active = kemix.db
			.prepare(`SELECT COUNT(*) AS n FROM downloads WHERE status IN ('queued','matching','downloading')`)
			.get() as { n: number }
		if (!active.n) return kemix.queue.flush()
		await new Promise((r) => setTimeout(r, 20))
	}
	throw new Error('downloads did not settle')
}

describe('key and BPM', () => {
	it('takes them from the catalogs, analyzes the preview for what they lack, and falls back on AcousticBrainz', async () => {
		await kemix.features.analyzePlaylist(playlistId())
		await kemix.features.idle()

		const [one, two, three, four] = await features()
		expect(one).toMatchObject({ bpm: 124, bpmSource: 'deezer', key: { tonic: 9, minor: true }, keySource: 'preview' })
		expect(two).toMatchObject({ bpmSource: 'preview', key: { tonic: 9, minor: true }, keySource: 'preview', status: 'done' })
		expect(Math.abs(two!.bpm! - 128)).toBeLessThanOrEqual(0.5)
		expect(three).toMatchObject({ bpm: null, key: null, status: 'notfound' })
		expect(four).toMatchObject({ bpm: 122, bpmSource: 'acousticbrainz', key: { tonic: 2, minor: false }, keySource: 'acousticbrainz' })
		expect(decoder.inputs).toEqual(['bytes:preview/1.mp3', 'bytes:preview/2.mp3'])
		// MusicBrainz is only asked about the track there was no audio for.
		expect(calls.filter((c) => c.startsWith('musicbrainz.org'))).toHaveLength(1)

		const scans = events.flatMap((e) => (e.type === 'features' ? [e.scan] : []))
		expect(scans.at(-1)).toEqual<ScanState>({ playlistId: playlistId(), running: false, done: 4, total: 4, failed: 0, error: null })
	})

	it('opening a playlist only looks up tracks never looked up', async () => {
		// As the server does: the playlist is read, then the lookup starts.
		await kemix.library.getPlaylist(playlistId())
		kemix.features.autoPlaylist(playlistId())
		await kemix.features.idle()
		const asked = calls.length
		expect(asked).toBeGreaterThan(0)

		// Nothing new: no job, no requests (not even for the track that wasn't found).
		kemix.features.autoPlaylist(playlistId())
		await kemix.features.idle()
		expect(calls.length).toBe(asked)

		// Asking by hand tries again what's missing, and only that.
		await kemix.features.analyzePlaylist(playlistId())
		await kemix.features.idle()
		expect(kemix.features.state(playlistId())).toMatchObject({ running: false, total: 1 })
	})

	it('prefers GetSongBPM when there is an API key, and redoes chosen tracks from scratch', async () => {
		await kemix.features.analyzePlaylist(playlistId())
		await kemix.features.idle()
		kemix.settings.update({ getSongBpmKey: 'KEY' })
		await kemix.features.analyzePlaylist(playlistId(), [0])
		await kemix.features.idle()
		expect((await features())[0]).toMatchObject({
			bpm: 125,
			bpmSource: 'getsongbpm',
			key: { tonic: 4, minor: true },
			keySource: 'getsongbpm'
		})
	})

	it('analyzes the whole file once downloaded, replacing what came from a preview, and tags it', async () => {
		await kemix.features.analyzePlaylist(playlistId())
		await kemix.features.idle()
		expect((await features())[1]).toMatchObject({ keySource: 'preview' })

		await kemix.queue.enqueuePlaylist(playlistId(), [0, 1])
		await settleDownloads()
		await kemix.features.idle()

		const [one, two] = await features()
		// Deezer's BPM is kept; what came from the preview is analyzed again from the file.
		expect(one).toMatchObject({ bpm: 124, bpmSource: 'deezer', key: { tonic: 0, minor: false }, keySource: 'analysis' })
		expect(two).toMatchObject({ bpmSource: 'analysis', key: { tonic: 0, minor: false }, keySource: 'analysis' })
		expect(Math.abs(two!.bpm! - 100)).toBeLessThanOrEqual(0.5)
		expect(decoder.inputs.filter((i) => !i.startsWith('bytes:')).sort()).toEqual(['01 - Alpha - One.wav', '02 - Beta - Two.wav'])

		const tracks = (await kemix.library.getPlaylist(playlistId())).tracks
		expect(readKeyBpm(tracks[0]!.download!.path!)).toEqual({ bpm: 124, key: 'C' })
		expect(readKeyBpm(tracks[1]!.download!.path!)).toEqual({ bpm: 100, key: 'C' })
	})

	it('looks up and analyzes a downloaded track that was never looked up, unless tags are turned off', async () => {
		kemix.settings.update({ writeKeyBpmTags: false })
		await kemix.queue.enqueuePlaylist(playlistId(), [1])
		await settleDownloads()
		await kemix.features.idle()
		const two = (await kemix.library.getPlaylist(playlistId())).tracks[1]!
		expect(two.features).toMatchObject({ bpmSource: 'analysis', keySource: 'analysis' })
		expect(readKeyBpm(two.download!.path!)).toEqual({ bpm: null, key: null })
	})
})

describe('key and BPM of tracks outside the library', () => {
	const trackEvents = () => events.flatMap((e) => (e.type === 'track-features' ? [e] : []))
	async function eventsFor(n: number) {
		for (let i = 0; i < 250 && trackEvents().length < n; i++) await new Promise((r) => setTimeout(r, 20))
		return trackEvents()
	}

	it('looks them up in the background, and answers at once once known', async () => {
		const items = [
			{ service: 'spotify', track: { sourceId: 'x1', title: 'One', artists: ['Alpha'], isrc: 'usaaa0000001' } },
			// A Deezer result: looked up by its id.
			{ service: 'deezer', track: { sourceId: '2', title: 'Two', artists: ['Beta'] } }
		]
		expect(kemix.features.lookupTracks(items, 'search')).toEqual([null, null])
		const got = await eventsFor(2)
		expect(got.find((e) => e.sourceId === 'x1')?.features).toMatchObject({ bpm: 124, bpmSource: 'deezer', keySource: 'preview' })
		expect(got.find((e) => e.sourceId === '2')?.features).toMatchObject({ bpmSource: 'preview', keySource: 'preview' })
		expect(calls).toContain('api.deezer.com/track/2')

		// Known now: no requests, no events.
		const asked = calls.length
		const again = kemix.features.lookupTracks(items, 'search')
		expect(again.map((f) => f?.status)).toEqual(['done', 'done'])
		expect(calls.length).toBe(asked)
		expect(trackEvents()).toHaveLength(2)
		// Nothing of it is stored in the library.
		expect(kemix.db.prepare('SELECT COUNT(*) AS n FROM track_features').get()).toEqual({ n: 0 })
	})

	it('answers right away for a library track with the same ISRC', async () => {
		await kemix.features.analyzePlaylist(playlistId())
		await kemix.features.idle()
		const asked = calls.length
		const [one] = kemix.features.lookupTracks(
			[{ service: 'qobuz', track: { sourceId: 'q1', title: 'One', artists: ['Alpha'], isrc: 'USAAA0000001' } }],
			'review:1'
		)
		expect(one).toMatchObject({ bpm: 124, bpmSource: 'deezer', keySource: 'preview' })
		expect(calls.length).toBe(asked)
	})

	it('a new batch from the same screen stops what is left of the last one', async () => {
		held = new Promise((r) => (release = r))
		kemix.features.lookupTracks(
			[{ service: 'spotify', track: { sourceId: 'old', title: 'Nine', artists: ['Iota'], isrc: 'USAAA0000009' } }],
			'search'
		)
		// Wait until the old lookup is stuck on Deezer.
		for (let i = 0; i < 100 && !calls.includes('api.deezer.com/track/isrc:USAAA0000009'); i++) await new Promise((r) => setTimeout(r, 10))
		kemix.features.lookupTracks(
			[{ service: 'spotify', track: { sourceId: 'new', title: 'One', artists: ['Alpha'], isrc: 'USAAA0000001' } }],
			'search'
		)
		release()
		const got = await eventsFor(1)
		await new Promise((r) => setTimeout(r, 100))
		expect(trackEvents().map((e) => e.sourceId)).toEqual(['new'])
		expect(got[0]?.features.bpm).toBe(124)
	})
})
