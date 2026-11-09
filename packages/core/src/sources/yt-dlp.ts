import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
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
