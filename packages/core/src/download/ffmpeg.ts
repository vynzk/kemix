import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import type { AudioQuality } from '../types'
import { errorMessage } from '../util'

/**
 * Static ffmpeg builds from ffmpeg-static's GitHub releases: one gzipped binary per platform, so there's nothing to
 * unpack but the gzip. Pinned with the checksums GitHub publishes for each asset; MP3 encoding doesn't need updates.
 */
const RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1'
const ASSETS: Record<string, string> = {
	'win32-x64': '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
	'linux-x64': 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
	'linux-arm64': '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0',
	'linux-arm': '64b115a12f0ab77c277e3c418aae8b40ef881e75e746a0e2d066a206b9bc5172',
	'linux-ia32': '169b27c078a8ecedb814cac67afccf15a9868d63e9d74ef86088adefaa500d00',
	'darwin-x64': '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
	'darwin-arm64': '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa'
}

/** The ffmpeg build for a platform and its SHA-256. Null: none published. */
export function ffmpegAsset(
	platform: string = process.platform,
	arch: string = process.arch
): { url: string; sha256: string } | null {
	// Windows on ARM runs the x64 build.
	const key = platform === 'win32' && arch === 'arm64' ? 'win32-x64' : `${platform}-${arch}`
	const sha256 = ASSETS[key]
	return sha256 ? { url: `${RELEASE}/ffmpeg-${key}.gz`, sha256 } : null
}

/** Kemix's own copy of ffmpeg, downloaded the first time a file has to be converted. */
export class ManagedFfmpeg {
	#ready?: Promise<string>

	constructor(
		private dir: string,
		private asset = ffmpegAsset()
	) {}

	get file() {
		return path.join(this.dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
	}

	/** Path to ffmpeg, downloading it first if needed. Concurrent callers share one download. */
	path(): Promise<string> {
		this.#ready ??= this.#sync().catch((err) => {
			this.#ready = undefined
			throw err
		})
		return this.#ready
	}

	async #sync(): Promise<string> {
		// The file only gets its final name once its checksum matched.
		if (fs.existsSync(this.file)) return this.file
		const asset = this.asset
		if (!asset) throw new Error(`no hay una versión de ffmpeg para ${process.platform}-${process.arch}`)
		fs.mkdirSync(this.dir, { recursive: true })
		const tmp = `${this.file}.${process.pid}.download`
		try {
			const res = await fetch(asset.url)
			if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText} al bajar ${asset.url}`)
			const hash = crypto.createHash('sha256')
			await pipeline(
				Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
				async function* (chunks: AsyncIterable<Buffer>) {
					for await (const chunk of chunks) {
						hash.update(chunk)
						yield chunk
					}
				},
				zlib.createGunzip(),
				fs.createWriteStream(tmp, { mode: 0o755 })
			)
			if (hash.digest('hex') !== asset.sha256) throw new Error('la descarga no coincide con el checksum publicado')
			fs.renameSync(tmp, this.file)
			return this.file
		} catch (err) {
			throw new Error(`No se pudo descargar ffmpeg: ${errorMessage(err)}`)
		} finally {
			fs.rmSync(tmp, { force: true })
		}
	}
}

/** Turns a downloaded file into an MP3 that any player, car stereo or phone can play. */
export interface Mp3Converter {
	/** Write `input` as an MP3 to `output`. `lossless`: the source is lossless, so it's worth the top bitrate. */
	toMp3(input: string, output: string, opts: { lossless: boolean; signal?: AbortSignal }): Promise<void>
}

/** Uncompressed formats, for DJ software and producers. */
export type PcmFormat = 'aiff' | 'wav'

/** Converts downloads: to an MP3 for any player, or to AIFF/WAV. */
export interface AudioConverter extends Mp3Converter {
	/** Write `input` as AIFF or WAV to `output`, keeping its sample rate, at `bitDepth`. */
	toPcm(input: string, output: string, opts: { format: PcmFormat; bitDepth: 16 | 24; signal?: AbortSignal }): Promise<void>
}

/**
 * Bit depth of the AIFF/WAV made from audio of quality `q`: 24-bit only when there are more than 16 bits to keep
 * (lossy audio decodes to 16). Unknown: 24, so nothing is lost.
 */
export function pcmBitDepth(q: AudioQuality | null | undefined): 16 | 24 {
	if (!q) return 24
	return q.lossless && (q.bitDepth ?? 16) > 16 ? 24 : 16
}

/**
 * Arguments for AIFF (big-endian PCM) or WAV (little-endian PCM) at `bitDepth`, keeping the sample rate and channels.
 * Audio only and no metadata: tags and cover art are written afterwards, as for every download.
 */
export function pcmArgs(input: string, output: string, format: PcmFormat, bitDepth: 16 | 24): string[] {
	return [
		'-hide_banner',
		'-nostdin',
		'-loglevel', 'error',
		'-y',
		'-i', input,
		'-map', '0:a:0',
		'-vn',
		'-map_metadata', '-1',
		'-c:a', `pcm_s${bitDepth}${format === 'aiff' ? 'be' : 'le'}`,
		'-f', format,
		output
	]
}

/**
 * Arguments for the most widely playable MP3: constant bitrate (some old players can't seek or time VBR files),
 * 44.1 kHz stereo at most, audio only (cover art goes back in as a tag afterwards), no metadata (rewritten after).
 */
export function mp3Args(input: string, output: string, lossless: boolean): string[] {
	return [
		'-hide_banner',
		'-nostdin',
		'-loglevel', 'error',
		'-y',
		'-i', input,
		'-map', '0:a:0',
		'-vn',
		'-map_metadata', '-1',
		'-c:a', 'libmp3lame',
		'-b:a', lossless ? '320k' : '192k',
		'-ar', '44100',
		'-ac', '2',
		'-f', 'mp3',
		output
	]
}

/** Decodes audio for analysis (key and BPM). */
export interface AudioDecoder {
	/**
	 * The audio of `input` (a file path, or a whole file's bytes) as mono 32-bit float samples at `sampleRate`, at most
	 * the first `maxSeconds`.
	 */
	decodePcm(input: string | Buffer, opts: { sampleRate: number; maxSeconds?: number; signal?: AbortSignal }): Promise<Float32Array>
}

/**
 * Arguments to decode `input` (a path, or 'pipe:0' for bytes on stdin) to raw mono float samples on stdout, resampled
 * to `sampleRate`.
 */
export function pcmDecodeArgs(input: string, sampleRate: number, maxSeconds?: number): string[] {
	return [
		'-hide_banner',
		// Reading the input from stdin needs stdin.
		...(input === 'pipe:0' ? [] : ['-nostdin']),
		'-loglevel', 'error',
		'-i', input,
		'-map', '0:a:0',
		'-vn',
		...(maxSeconds ? ['-t', String(maxSeconds)] : []),
		'-ac', '1',
		'-ar', String(sampleRate),
		'-f', 'f32le',
		'pipe:1'
	]
}

/** ffmpeg: Kemix's own copy (downloaded on first use), else one on the PATH. */
export class Ffmpeg implements AudioConverter, AudioDecoder {
	#bin?: Promise<string>

	constructor(private managed?: ManagedFfmpeg) {}

	async #resolve(): Promise<string> {
		let managedError = ''
		if (this.managed) {
			try {
				const bin = await this.managed.path()
				if (await runs(bin)) return bin
				managedError = `No se pudo ejecutar ${bin}. `
			} catch (err) {
				managedError = `${errorMessage(err)}. `
			}
		}
		if (await runs('ffmpeg')) return 'ffmpeg'
		throw new Error(
			`${managedError}Para convertir a MP3, AIFF o WAV, y para analizar la clave y el BPM, Kemix baja ffmpeg la ` +
				'primera vez (hace falta conexión a ' +
				'internet). Si no puede, instala ffmpeg en el sistema (https://ffmpeg.org).'
		)
	}

	bin(): Promise<string> {
		this.#bin ??= this.#resolve().catch((err) => {
			this.#bin = undefined
			throw err
		})
		return this.#bin
	}

	toMp3(input: string, output: string, opts: { lossless: boolean; signal?: AbortSignal }) {
		return this.#run(mp3Args(input, output, opts.lossless), 'MP3', opts.signal)
	}

	toPcm(input: string, output: string, opts: { format: PcmFormat; bitDepth: 16 | 24; signal?: AbortSignal }) {
		return this.#run(pcmArgs(input, output, opts.format, opts.bitDepth), opts.format.toUpperCase(), opts.signal)
	}

	async decodePcm(
		input: string | Buffer,
		opts: { sampleRate: number; maxSeconds?: number; signal?: AbortSignal }
	): Promise<Float32Array> {
		const bin = await this.bin()
		opts.signal?.throwIfAborted()
		const fromStdin = typeof input !== 'string'
		const args = pcmDecodeArgs(fromStdin ? 'pipe:0' : input, opts.sampleRate, opts.maxSeconds)
		const bytes = await new Promise<Buffer>((resolve, reject) => {
			const child = spawn(bin, args, { windowsHide: true, signal: opts.signal })
			const chunks: Buffer[] = []
			let stderr = ''
			child.stdout.on('data', (d: Buffer) => chunks.push(d))
			child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
			child.on('error', reject)
			child.on('close', (code) => {
				if (code === 0) resolve(Buffer.concat(chunks))
				else reject(new Error(`No se pudo leer el audio: ${stderr.trim().split('\n').pop() || `código ${code}`}`))
			})
			if (fromStdin) {
				// ffmpeg may stop reading early (e.g. at maxSeconds): that's not an error.
				child.stdin.on('error', () => {})
				child.stdin.end(input)
			}
		})
		// Copy into an aligned buffer: Buffer.concat may hand back a slice of a shared pool at any offset.
		const samples = new Float32Array(Math.floor(bytes.length / 4))
		new Uint8Array(samples.buffer).set(bytes.subarray(0, samples.length * 4))
		return samples
	}

	async #run(args: string[], target: string, signal?: AbortSignal) {
		const bin = await this.bin()
		signal?.throwIfAborted()
		await new Promise<void>((resolve, reject) => {
			const child = spawn(bin, args, { windowsHide: true, signal })
			let stderr = ''
			child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
			child.on('error', reject)
			child.on('close', (code) => {
				if (code === 0) resolve()
				else reject(new Error(`No se pudo convertir a ${target}: ${stderr.trim().split('\n').pop() || `código ${code}`}`))
			})
		})
	}
}

function runs(bin: string): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn(bin, ['-version'], { windowsHide: true })
		child.on('error', () => resolve(false))
		child.on('close', (code) => resolve(code === 0))
	})
}
