import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { File } from 'node-taglib-sharp'
import { Ffmpeg, ffmpegAsset, mp3Args, pcmArgs, pcmBitDepth } from '../src/download/ffmpeg'
import { readFileQuality } from '../src/download/quality'
import { writeTags } from '../src/download/tagger'

describe('ffmpegAsset', () => {
	it('picks the static build for each platform', () => {
		expect(ffmpegAsset('win32', 'x64')?.url).toMatch(/\/ffmpeg-win32-x64\.gz$/)
		// Windows on ARM runs the x64 build.
		expect(ffmpegAsset('win32', 'arm64')?.url).toMatch(/\/ffmpeg-win32-x64\.gz$/)
		expect(ffmpegAsset('linux', 'x64')?.url).toMatch(/\/ffmpeg-linux-x64\.gz$/)
		expect(ffmpegAsset('linux', 'arm64')?.sha256).toMatch(/^[a-f0-9]{64}$/)
		expect(ffmpegAsset('win32', 'ia32')).toBeNull()
		expect(ffmpegAsset('freebsd', 'x64')).toBeNull()
	})
})

describe('mp3Args', () => {
	it('writes a constant-bitrate 44.1 kHz stereo MP3, audio only', () => {
		const args = mp3Args('in.flac', 'out.part', true)
		expect(args.slice(-2)).toEqual(['mp3', 'out.part'])
		expect(args.join(' ')).toContain('-i in.flac')
		expect(args.join(' ')).toContain('-c:a libmp3lame -b:a 320k -ar 44100 -ac 2')
		expect(args).toContain('-vn')
		// Lossy sources don't gain anything from 320 kbps.
		expect(mp3Args('in.m4a', 'out.part', false).join(' ')).toContain('-b:a 192k')
	})
})

describe('pcmArgs', () => {
	it('writes big-endian PCM for AIFF and little-endian for WAV, at the bit depth asked', () => {
		expect(pcmArgs('in.flac', 'out.part', 'aiff', 24).join(' ')).toContain('-c:a pcm_s24be -f aiff out.part')
		expect(pcmArgs('in.flac', 'out.part', 'wav', 16).join(' ')).toContain('-c:a pcm_s16le -f wav out.part')
		// The sample rate is kept: nothing resamples.
		expect(pcmArgs('in.flac', 'out.part', 'wav', 24)).not.toContain('-ar')
	})

	it('keeps 24-bit only where there are more than 16 bits', () => {
		expect(pcmBitDepth({ codec: 'flac', lossless: true, bitDepth: 24, sampleRateHz: 96000 })).toBe(24)
		expect(pcmBitDepth({ codec: 'flac', lossless: true, bitDepth: 16, sampleRateHz: 44100 })).toBe(16)
		expect(pcmBitDepth({ codec: 'aac', lossless: false, bitrateKbps: 256 })).toBe(16)
		expect(pcmBitDepth(null)).toBe(24)
	})
})

// Runs only where ffmpeg is installed: nothing is downloaded in tests.
const hasFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-version'], { windowsHide: true }).status === 0

describe.skipIf(!hasFfmpeg)('converting with the installed ffmpeg', () => {
	let dir: string
	let flac: string
	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kemix-ffmpeg-'))
		flac = path.join(dir, 'tone.flac')
		// One second of a 24-bit/96 kHz stereo tone.
		const made = spawnSync(
			'ffmpeg',
			['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=96000:duration=1', '-ac', '2', '-c:a', 'flac', '-sample_fmt', 's32', flac],
			{ windowsHide: true }
		)
		expect(made.status).toBe(0)
	})
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

	// No managed copy: the one on the PATH.
	const ffmpeg = new Ffmpeg()
	const meta = { service: 'qobuz' as const, id: '1', url: 'u', title: 'Tono', artists: ['Kemix'], album: 'Pruebas' }
	// A 1x1 PNG, as cover art.
	const cover = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

	it('converts to AIFF and WAV keeping 24-bit/96 kHz, and takes tags and cover art', async () => {
		const source = readFileQuality(flac)
		expect(source).toMatchObject({ codec: 'flac', bitDepth: 24, sampleRateHz: 96000 })
		for (const format of ['aiff', 'wav'] as const) {
			const out = path.join(dir, `tone.${format}`)
			await ffmpeg.toPcm(flac, out, { format, bitDepth: pcmBitDepth(source) })
			expect(readFileQuality(out)).toMatchObject({ codec: format, lossless: true, bitDepth: 24, sampleRateHz: 96000 })
			writeTags(out, meta, cover)
			const file = File.createFromPath(out)
			try {
				expect(file.tag.title).toBe('Tono')
				expect(file.tag.performers).toEqual(['Kemix'])
				expect(file.tag.pictures).toHaveLength(1)
			} finally {
				file.dispose()
			}
		}
	})

	it('converts to a 320 kbps 44.1 kHz MP3', async () => {
		const out = path.join(dir, 'tone.mp3')
		await ffmpeg.toMp3(flac, out, { lossless: true })
		expect(readFileQuality(out)).toMatchObject({ codec: 'mp3', lossless: false, bitrateKbps: 320, sampleRateHz: 44100 })
	})

	it('reports a failed conversion', async () => {
		const junk = path.join(dir, 'junk.flac')
		fs.writeFileSync(junk, 'not audio')
		await expect(ffmpeg.toPcm(junk, path.join(dir, 'junk.aiff'), { format: 'aiff', bitDepth: 16 })).rejects.toThrow(
			/No se pudo convertir a AIFF/
		)
	})
})
