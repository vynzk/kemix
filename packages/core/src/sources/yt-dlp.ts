import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { AudioStream } from '../download/lucida-adapter'
import { errorMessage } from '../util'

const REPO = 'https://github.com/yt-dlp/yt-dlp/releases'
/** YouTube breaks older yt-dlp versions every few weeks: look for a new release this often. */
const CHECK_EVERY = 24 * 60 * 60_000

/** The standalone yt-dlp build for a platform (bundles Python and the JS challenge solver). Null: none published. */
export function ytDlpAsset(platform: string = process.platform, arch: string = process.arch): string | null {
	if (platform === 'win32') return arch === 'arm64' ? 'yt-dlp_arm64.exe' : arch === 'ia32' ? 'yt-dlp_x86.exe' : 'yt-dlp.exe'
	if (platform === 'linux') return arch === 'x64' ? 'yt-dlp_linux' : arch === 'arm64' ? 'yt-dlp_linux_aarch64' : null
	if (platform === 'darwin') return 'yt-dlp_macos'
	return null
}

/** `<sha256>  <file>` lines (the release's SHA2-256SUMS) → checksum by file name. */
export function parseSha256Sums(text: string): Map<string, string> {
	const sums = new Map<string, string>()
	for (const line of text.split(/\r?\n/)) {
		const m = /^([a-f0-9]{64})\s+\*?(\S+)$/i.exec(line.trim())
		if (m) sums.set(m[2]!, m[1]!.toLowerCase())
	}
	return sums
}

/**
 * Kemix's own copy of yt-dlp, so YouTube downloads work on machines that have nothing installed. Fetched from the
 * official GitHub release on first use and checked against the release's SHA2-256SUMS, then kept up to date (checked
 * at most once a day; a failed check keeps the copy that's already there).
 */
export class ManagedYtDlp {
	#ready?: Promise<string>
	#checkedAt = 0

	constructor(
		private dir: string,
		private asset: string | null = ytDlpAsset()
	) {}

	get file() {
		return path.join(this.dir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
	}

	/** Path to an up-to-date yt-dlp, downloading it first if needed. Concurrent callers share one download. */
	path(): Promise<string> {
		if (!this.#ready || Date.now() - this.#checkedAt > CHECK_EVERY) {
			this.#checkedAt = Date.now()
			this.#ready = this.#sync().catch((err) => {
				this.#ready = undefined
				throw err
			})
		}
		return this.#ready
	}

	async #sync(): Promise<string> {
		const asset = this.asset
		if (!asset) throw new Error(`yt-dlp no publica una versión para ${process.platform}-${process.arch}`)
		const have = fs.existsSync(this.file)
		try {
			const tag = await latestTag()
			const sums = parseSha256Sums(await fetchText(`${REPO}/download/${tag}/SHA2-256SUMS`))
			const expected = sums.get(asset)
			if (!expected) throw new Error(`el release ${tag} no trae ${asset}`)
			if (have && (await sha256File(this.file)) === expected) return this.file
			await this.#download(`${REPO}/download/${tag}/${asset}`, expected)
		} catch (err) {
			// Offline or GitHub down: the copy we already have is better than nothing.
			if (have) return this.file
			throw new Error(`No se pudo descargar yt-dlp: ${errorMessage(err)}`)
		}
		return this.file
	}

	async #download(url: string, expected: string) {
		fs.mkdirSync(this.dir, { recursive: true })
		const tmp = `${this.file}.${process.pid}.download`
		try {
			const res = await fetch(url)
			if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText} al bajar ${url}`)
			const hash = crypto.createHash('sha256')
			await pipeline(
				Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
				async function* (chunks: AsyncIterable<Buffer>) {
					for await (const chunk of chunks) {
						hash.update(chunk)
						yield chunk
					}
				},
				fs.createWriteStream(tmp, { mode: 0o755 })
			)
			const actual = hash.digest('hex')
			if (actual !== expected) throw new Error('la descarga no coincide con el checksum publicado')
			// Replacing fails on Windows while an older yt-dlp.exe is running: keep that one and retry on the next check.
			fs.renameSync(tmp, this.file)
		} finally {
			fs.rmSync(tmp, { force: true })
		}
	}
}

/** Tag of the latest release, read from where /releases/latest redirects, so the checksums and binary match. */
async function latestTag(): Promise<string> {
	const res = await fetch(`${REPO}/latest`, { method: 'HEAD', redirect: 'manual' })
	const tag = /\/releases\/tag\/([^/?#]+)/.exec(res.headers.get('location') ?? '')?.[1]
	if (!tag) throw new Error(`GitHub respondió ${res.status} al buscar la última versión`)
	return decodeURIComponent(tag)
}

async function fetchText(url: string): Promise<string> {
	const res = await fetch(url)
	if (!res.ok) throw new Error(`${res.status} ${res.statusText} al bajar ${url}`)
	return res.text()
}

async function sha256File(file: string): Promise<string> {
	const hash = crypto.createHash('sha256')
	for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer)
	return hash.digest('hex')
}

export const YT_DLP_HINT =
	'Kemix baja yt-dlp por su cuenta la primera vez que lo necesita (hace falta conexión a internet). ' +
	'Si no puede, instálalo aparte (https://github.com/yt-dlp/yt-dlp) e indica su ruta en Ajustes.'

/**
 * Runs yt-dlp: the one set in Settings, else Kemix's own copy (downloaded on first use), else one on the PATH.
 * Shared by every service that goes through it (YouTube, SoundCloud).
 */
export class YtDlp {
	#works = new Map<string, Promise<boolean>>()

	constructor(
		private configuredPath: () => string,
		private managed?: ManagedYtDlp
	) {}

	/** Whether the user set a path in Settings (then nothing else is tried). */
	get configured() {
		return !!this.configuredPath()
	}

	/** A yt-dlp that runs. Throws, with a hint on how to get one, when there's none. */
	async bin(): Promise<string> {
		const configured = this.configuredPath()
		if (configured) {
			if (await this.#runs(configured)) return configured
			throw new Error(`No se pudo ejecutar yt-dlp en "${configured}". ${YT_DLP_HINT}`)
		}
		let managedError = ''
		if (this.managed) {
			try {
				const bin = await this.managed.path()
				if (await this.#runs(bin)) return bin
				managedError = `No se pudo ejecutar ${bin}. `
			} catch (err) {
				managedError = `${errorMessage(err)}. `
			}
		}
		if (await this.#runs('yt-dlp')) return 'yt-dlp'
		throw new Error(`${managedError}${YT_DLP_HINT}`)
	}

	#runs(bin: string): Promise<boolean> {
		let p = this.#works.get(bin)
		if (!p) {
			p = new Promise<boolean>((resolve) => {
				const child = spawn(bin, ['--version'], { windowsHide: true })
				child.on('error', () => resolve(false))
				child.on('close', (code) => resolve(code === 0))
			})
			// A missing yt-dlp may get installed while the app runs: only cache successes.
			p.then((ok) => !ok && this.#works.delete(bin))
			this.#works.set(bin, p)
		}
		return p
	}

	/**
	 * Run yt-dlp with `-o -` among `args` and stream what it writes. The stream only ends once yt-dlp exits cleanly,
	 * so a failure halfway never looks like a complete file. Resolves once the first bytes arrive.
	 */
	async stream(bin: string, args: string[], opts: { onExit?: () => void; describe?: (stderr: string) => string } = {}) {
		const child = spawnYtDlp(bin, args)
		let stderr = ''
		child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
		const out = new PassThrough()
		child.stdout.pipe(out, { end: false })
		child.on('error', (err) => {
			opts.onExit?.()
			out.destroy(err)
		})
		child.on('close', (code) => {
			opts.onExit?.()
			if (code === 0) out.end()
			else out.destroy(new Error(opts.describe?.(stderr) ?? `yt-dlp falló: ${lastLine(stderr) || `código ${code}`}`))
		})
		return sniffAudio(out, () => child.kill())
	}

	/** Run yt-dlp and collect what it prints. Exits with errors still return their output (e.g. with --ignore-errors). */
	output(bin: string, args: string[], timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
		return new Promise((resolve, reject) => {
			const child = spawnYtDlp(bin, args)
			const out: Buffer[] = []
			let stderr = ''
			const timer = setTimeout(() => child.kill(), timeoutMs)
			child.stdout.on('data', (d: Buffer) => out.push(d))
			child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)))
			child.on('error', (err) => {
				clearTimeout(timer)
				reject(err)
			})
			child.on('close', (code) => {
				clearTimeout(timer)
				resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr })
			})
		})
	}
}

function spawnYtDlp(bin: string, args: string[]) {
	// ELECTRON_RUN_AS_NODE: so our own executable can stand in as yt-dlp's JS runtime (see YouTube).
	return spawn(bin, args, { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
}

/** The last line yt-dlp wrote to stderr: its error message. */
export function lastLine(stderr: string) {
	return stderr.trim().split('\n').pop()?.trim() ?? ''
}

/** Container of an audio stream, told from its first bytes. */
export function audioMimeType(first: Buffer): string {
	if (first.length >= 8 && first.subarray(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4'
	if (first.length >= 4 && first.readUInt32BE(0) === 0x1a45dfa3) return 'audio/webm'
	if (first.length >= 4 && first.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg'
	if (first.length >= 4 && first.subarray(0, 4).toString('latin1') === 'fLaC') return 'audio/flac'
	// Original uploads (SoundCloud lets artists offer the file they uploaded).
	if (first.length >= 12 && first.subarray(0, 4).toString('latin1') === 'RIFF' && first.subarray(8, 12).toString('latin1') === 'WAVE') {
		return 'audio/wav'
	}
	if (first.length >= 12 && first.subarray(0, 4).toString('latin1') === 'FORM' && /^AIF[FC]$/.test(first.subarray(8, 12).toString('latin1'))) {
		return 'audio/aiff'
	}
	if (first.length >= 3 && first.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg'
	// A bare MPEG audio frame: 11 sync bits set, then a valid layer.
	if (first.length >= 2 && first[0] === 0xff && (first[1]! & 0xe0) === 0xe0 && (first[1]! & 0x06) !== 0) return 'audio/mpeg'
	return 'application/octet-stream'
}

/** Wait for the first bytes (so failures surface before a file is created) and tell the container from them. */
export async function sniffAudio(stream: Readable, abort?: () => void): Promise<AudioStream> {
	// read() in paused mode, so nothing flows (and gets lost) before the caller attaches its pipeline.
	const first = await new Promise<Buffer>((resolve, reject) => {
		const cleanup = () => {
			stream.off('readable', onReadable)
			stream.off('error', onError)
			stream.off('end', onEnd)
		}
		const onReadable = () => {
			const chunk = stream.read() as Buffer | null
			if (!chunk) return
			cleanup()
			resolve(chunk)
		}
		const onError = (err: Error) => {
			cleanup()
			reject(err)
		}
		const onEnd = () => onError(new Error('No llegó audio'))
		stream.on('readable', onReadable)
		stream.once('error', onError)
		stream.once('end', onEnd)
	}).catch((err) => {
		abort?.()
		throw err
	})
	stream.unshift(first)
	return { stream, mimeType: audioMimeType(first) }
}
