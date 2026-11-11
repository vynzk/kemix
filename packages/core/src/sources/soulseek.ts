// Soulseek como servicio de descarga: busca archivos que comparten otros usuarios, deduce artista y título de su ruta,
// elige el mejor (calidad, hueco libre, cola, velocidad) y, si un usuario no lo envía, prueba con otro que tenga el
// mismo archivo.
import type { AudioQuality, QualityLevel, SlskFile, SourceTrack, TargetTrack } from '../types'
import type { AudioStream, Downloader } from '../download/lucida-adapter'
import { scoreSoulseek, tokenSimilarity } from '../match/score'
import { errorMessage } from '../util'
import type { SoulseekNetwork } from './soulseek-client'
import type { FileAttributes, SearchResponse } from './soulseek-protocol'

const MIME: Record<string, string> = {
	flac: 'audio/flac',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	aif: 'audio/aiff',
	aiff: 'audio/aiff',
	m4a: 'audio/mp4',
	ogg: 'audio/ogg'
}

/** Solo se ofrecen archivos de audio que Kemix sabe guardar y etiquetar. */
export const AUDIO_EXTENSIONS = Object.keys(MIME)

/** Lo más que se espera de una cuenta: la calidad depende de cada archivo, no del plan. */
const BEST: AudioQuality = { codec: 'flac', lossless: true, bitDepth: 24, sampleRateHz: 192000 }
/** Usuarios que se prueban para un mismo archivo antes de darlo por fallido. */
const MAX_SOURCES = 3
const SEARCH_CACHE_MS = 10 * 60_000
const MAX_CACHED_SEARCHES = 50
const MAX_KNOWN_FILES = 5000

// ---------- rutas y URLs ----------

/**
 * `slsk://usuario/carpeta/archivo.flac`, como los enlaces de Nicotine+. Las rutas de Soulseek van con `\`: cada tramo
 * se codifica por separado, así una `/` que fuera parte de un nombre sobrevive a la ida y vuelta.
 */
export function slskUrl(username: string, path: string): string {
	return `slsk://${encodeURIComponent(username)}/${path.split('\\').map(encodeURIComponent).join('/')}`
}

export function parseSlskUrl(url: string): { username: string; path: string } | null {
	const m = /^slsk:\/\/([^/]+)\/(.+)$/.exec(url)
	if (!m) return null
	try {
		return { username: decodeURIComponent(m[1]!), path: m[2]!.split('/').map(decodeURIComponent).join('\\') }
	} catch {
		return null
	}
}

const extensionOf = (path: string) => /\.([a-z0-9]{2,5})$/i.exec(path)?.[1]?.toLowerCase() ?? ''

function segments(path: string): string[] {
	return path.split(/[\\/]/).filter(Boolean)
}

/** Carpetas que no dicen nada del artista. */
const GENERIC_FOLDER =
	/^(?:[a-z]:|music|musica|música|mp3s?|flacs?|lossless|downloads?|descargas|complete|completed|shared?|compartid[oa]s?|albums?|singles?|various|va|soulseek)$/i

/** "Daft Punk - Discovery (2001) [FLAC 24-96]" → sin el año ni las etiquetas de formato. */
function cleanFolder(name: string): string {
	return name
		.replace(/\[[^\]]*\]|\{[^}]*\}|\(\s*(?:\d{4}|flac|mp3|wav|web|cd|vinyl|\d+\s*kbps)[^)]*\)/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

/** Quita el número de pista: "01 - ", "01. ", "1-01 ", "A1. " o "01 " delante del nombre. */
function stripTrackNumber(name: string): { rest: string; trackNumber?: number } {
	const m = /^\s*(?:\d-)?(\d{1,3})\s*[-._)]\s*(?=\S)|^\s*(\d{2})\s+(?=\S)|^\s*[A-D](\d{1,2})\s*[-.]\s*(?=\S)/i.exec(name)
	if (!m) return { rest: name.trim() }
	return { rest: name.slice(m[0].length).trim(), trackNumber: Number(m[1] ?? m[2] ?? m[3]) }
}

export interface ParsedPath {
	artists: string[]
	title: string
	album?: string
	trackNumber?: number
}

/**
 * Artista, título y álbum a partir de la ruta de un archivo, según cómo se suelen ordenar las colecciones:
 * "Artista - Álbum (Año)\01 - Título.flac", "Artista\Álbum\01. Título.flac", "Sueltos\Artista - Título.mp3" o
 * "Artista - Álbum - 01 - Título.flac".
 */
export function parseSlskPath(path: string): ParsedPath {
	const parts = segments(path)
	const file = parts.at(-1) ?? path
	const base = file.replace(/\.[a-z0-9]{2,5}$/i, '')
	const folder = cleanFolder(parts.at(-2) ?? '')
	const grandparent = cleanFolder(parts.at(-3) ?? '')

	let folderArtist: string | undefined
	let album: string | undefined
	const folderParts = folder.split(/\s[-–]\s/).filter((p) => !/^\d{4}$/.test(p.trim()))
	if (folderParts.length >= 2) {
		folderArtist = folderParts[0]!.trim()
		album = folderParts.slice(1).join(' - ').trim()
	} else if (folder && !GENERIC_FOLDER.test(folder)) {
		album = folder
		if (grandparent && !GENERIC_FOLDER.test(grandparent)) folderArtist = grandparent
	}

	const { rest, trackNumber } = stripTrackNumber(base)
	const nameParts = rest.split(/\s[-–]\s/).map((p) => p.trim())
	// "Artista - Álbum - 01 - Título": lo que sigue al número es el título.
	const numberAt = nameParts.findIndex((p, i) => i > 0 && /^\d{1,3}$/.test(p))
	if (numberAt > 0 && numberAt < nameParts.length - 1) {
		return {
			artists: [nameParts[0]!],
			title: nameParts.slice(numberAt + 1).join(' - '),
			album: nameParts.slice(1, numberAt).join(' - ') || album,
			trackNumber: Number(nameParts[numberAt]) || trackNumber
		}
	}
	if (nameParts.length >= 2) {
		return { artists: [nameParts[0]!], title: nameParts.slice(1).join(' - '), album, trackNumber }
	}
	return { artists: folderArtist ? [folderArtist] : [], title: rest, album, trackNumber }
}

// ---------- calidad y orden ----------

/** La calidad de un archivo según su extensión y lo que dice de él quien lo comparte. */
export function slskQuality(ext: string, a: FileAttributes): AudioQuality | null {
	const lossless = (codec: AudioQuality['codec']): AudioQuality => ({
		codec,
		lossless: true,
		bitDepth: a.bitDepth ?? 16,
		sampleRateHz: a.sampleRateHz ?? 44100
	})
	switch (ext) {
		case 'flac':
			return lossless('flac')
		case 'wav':
			return lossless('wav')
		case 'aif':
		case 'aiff':
			return lossless('aiff')
		// Un m4a con profundidad de bits es ALAC; si no, AAC.
		case 'm4a':
			return a.bitDepth ? lossless('alac') : { codec: 'aac', lossless: false, bitrateKbps: a.bitrateKbps }
		case 'mp3':
			return { codec: 'mp3', lossless: false, bitrateKbps: a.bitrateKbps }
		case 'ogg':
			return { codec: 'vorbis', lossless: false, bitrateKbps: a.bitrateKbps }
		default:
			return null
	}
}

/** Los archivos de audio de unas respuestas de búsqueda, con lo que se deduce de cada uno. */
export function toSlskFiles(responses: SearchResponse[]): SlskFile[] {
	const out: SlskFile[] = []
	for (const res of responses) {
		for (const f of res.files) {
			const ext = (f.ext || extensionOf(f.path)).toLowerCase()
			if (!AUDIO_EXTENSIONS.includes(ext)) continue
			const parsed = parseSlskPath(f.path)
			out.push({
				username: res.username,
				path: f.path,
				url: slskUrl(res.username, f.path),
				size: f.size,
				title: parsed.title,
				artists: parsed.artists,
				album: parsed.album,
				durationMs: f.attrs.durationSec ? f.attrs.durationSec * 1000 : undefined,
				quality: slskQuality(ext, f.attrs),
				slotFree: res.slotFree,
				speed: res.avgSpeed,
				queueLength: res.queueLength
			})
		}
	}
	return out
}

/** Con una calidad MP3 en Ajustes se prefieren archivos MP3; con cualquier otra, sin pérdida. */
export const prefersLossless = (level: QualityLevel) => !level.startsWith('mp3')

/** Cuánto vale la calidad de un archivo: sin pérdida primero, salvo que se quiera MP3 (entonces MP3 320 primero). */
function qualityRank(q: AudioQuality | null, preferLossless: boolean): number {
	if (!q) return 0
	if (q.lossless) return preferLossless ? 2000 + (q.bitDepth ?? 16) * 10 + (q.sampleRateHz ?? 44100) / 1000 : 1500
	const kbps = Math.min(q.bitrateKbps ?? 0, 320)
	if (!preferLossless && q.codec === 'mp3' && kbps >= 320) return 2000
	return kbps
}

/** Mejor primero: calidad, luego quien puede enviarlo ya, con la cola más corta y más rápido. */
export function rankFiles(files: SlskFile[], preferLossless: boolean): SlskFile[] {
	return [...files].sort(
		(a, b) =>
			qualityRank(b.quality, preferLossless) - qualityRank(a.quality, preferLossless) ||
			Number(b.slotFree) - Number(a.slotFree) ||
			a.queueLength - b.queueLength ||
			b.speed - a.speed
	)
}

const fileName = (path: string) => (segments(path).at(-1) ?? path).toLowerCase()
/** El mismo archivo en varios usuarios: mismo nombre y mismo tamaño. */
const sameFile = (a: SlskFile, b: SlskFile) => a.size === b.size && fileName(a.path) === fileName(b.path)

/**
 * Los que mejor responden a `query` (los resultados de Soulseek traen otras versiones y otros temas que comparten
 * palabras) y, entre igual de parecidos, el mejor archivo. Cada archivo una vez, del usuario que mejor lo envía.
 */
export function pickForQuery(files: SlskFile[], query: string, preferLossless: boolean): SlskFile[] {
	const relevance = new Map(
		files.map((f) => [f, Math.round(tokenSimilarity(query, `${f.artists.join(' ')} ${f.title}`) * 10)])
	)
	const ranked = rankFiles(files, preferLossless).sort((a, b) => relevance.get(b)! - relevance.get(a)!)
	const out: SlskFile[] = []
	for (const f of ranked) if (!out.some((o) => sameFile(o, f))) out.push(f)
	return out
}

/** Una búsqueda que Soulseek entiende: sin puntuación (un "-" delante de una palabra la excluye). */
export function slskQuery(query: string): string {
	return query
		.replace(/[^\p{L}\p{N}\s]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

export function slskTarget(f: SlskFile): TargetTrack {
	return {
		service: 'soulseek',
		id: f.url,
		url: f.url,
		title: f.title,
		artists: f.artists,
		album: f.album,
		durationMs: f.durationMs,
		maxQuality: f.quality ?? undefined
	}
}

/** Un archivo del que solo se sabe la URL (p. ej. de un match guardado en una sesión anterior). */
function fileFromUrl(url: string): SlskFile | null {
	const ref = parseSlskUrl(url)
	if (!ref) return null
	const parsed = parseSlskPath(ref.path)
	return {
		...ref,
		url,
		size: 0,
		title: parsed.title,
		artists: parsed.artists,
		album: parsed.album,
		quality: slskQuality(extensionOf(ref.path), {}),
		slotFree: false,
		speed: 0,
		queueLength: 0
	}
}

// ---------- el downloader ----------

export class SoulseekDownloader implements Downloader {
	readonly service = 'soulseek' as const
	#searches = new Map<string, { at: number; files: SlskFile[] }>()
	/** Archivos vistos en búsquedas recientes, por URL: para describirlos y para buscar otras fuentes. */
	#known = new Map<string, SlskFile>()

	constructor(
		/** La sesión actual (cambia si se reconecta la cuenta). */
		private network: () => SoulseekNetwork,
		/** Si se quiere sin pérdida (según la calidad por defecto de Ajustes) o MP3. */
		private preferLossless: () => boolean = () => true
	) {}

	/** Soulseek no tiene ISRCs. */
	async isrcLookup(): Promise<TargetTrack | null> {
		return null
	}

	async search(query: string, limit: number): Promise<TargetTrack[]> {
		const files = await this.find(query)
		return pickForQuery(files, query, this.preferLossless()).slice(0, limit).map(slskTarget)
	}

	/** Todos los archivos de audio que responden a `query` (búsquedas recientes, desde la caché). */
	async find(query: string): Promise<SlskFile[]> {
		const q = slskQuery(query)
		if (!q) return []
		const cached = this.#searches.get(q.toLowerCase())
		if (cached && Date.now() - cached.at < SEARCH_CACHE_MS) return cached.files
		const files = toSlskFiles(await this.network().search(q))
		this.#searches.set(q.toLowerCase(), { at: Date.now(), files })
		if (this.#searches.size > MAX_CACHED_SEARCHES) this.#searches.delete(this.#searches.keys().next().value!)
		this.remember(files)
		return files
	}

	/** Guarda archivos vistos (también los de la pantalla de búsqueda), para describirlos y buscarles otra fuente. */
	remember(files: SlskFile[]) {
		for (const f of files) {
			this.#known.delete(f.url)
			this.#known.set(f.url, f)
		}
		while (this.#known.size > MAX_KNOWN_FILES) this.#known.delete(this.#known.keys().next().value!)
	}

	async getTrack(url: string) {
		const file = this.#known.get(url) ?? fileFromUrl(url)
		if (!file) throw new Error(`La URL no es un archivo de Soulseek: ${url}`)
		return {
			meta: slskTarget(file),
			open: (_level: unknown, _format?: unknown, signal?: AbortSignal) => this.#open(file, signal)
		}
	}

	/** Pide el archivo a su usuario; si no lo envía, a otros que tengan el mismo archivo (o el mismo tema). */
	async #open(file: SlskFile, signal?: AbortSignal): Promise<AudioStream> {
		const tried = new Set<string>()
		const errors: string[] = []
		let alternates: SlskFile[] | null = null
		let next: SlskFile | undefined = file
		while (next && tried.size < MAX_SOURCES) {
			tried.add(next.url)
			try {
				const { stream, size } = await this.network().download(next.username, next.path, { signal })
				return { stream, mimeType: MIME[extensionOf(next.path)] ?? 'application/octet-stream', sizeBytes: size }
			} catch (err) {
				if (signal?.aborted) throw err
				errors.push(errorMessage(err))
			}
			alternates ??= await this.alternates(file).catch(() => [])
			next = alternates.find((f) => !tried.has(f.url))
		}
		if (errors.length === 1) throw new Error(errors[0])
		throw new Error(`No se pudo bajar de ninguno de ${errors.length} usuarios. El último: ${errors.at(-1)}`)
	}

	/**
	 * Otras fuentes para un archivo: el mismo archivo (nombre y tamaño) en otros usuarios y, buscando de nuevo, el
	 * mismo tema con la misma clase de calidad y la misma duración. Mejor fuente primero.
	 */
	async alternates(file: SlskFile): Promise<SlskFile[]> {
		const found = new Map<string, SlskFile>()
		for (const f of this.#known.values()) if (f.url !== file.url && sameFile(f, file)) found.set(f.url, f)
		if (found.size < MAX_SOURCES - 1) {
			const asSource: SourceTrack = {
				sourceId: file.url,
				title: file.title,
				artists: file.artists,
				durationMs: file.durationMs
			}
			for (const f of await this.find(`${file.artists[0] ?? ''} ${file.title}`)) {
				if (f.url === file.url || found.has(f.url)) continue
				const sameTrack =
					f.quality?.lossless === file.quality?.lossless &&
					(!file.durationMs || !f.durationMs || Math.abs(file.durationMs - f.durationMs) <= 2000) &&
					scoreSoulseek(asSource, slskTarget(f)) >= 0.9
				if (sameFile(f, file) || sameTrack) found.set(f.url, f)
			}
		}
		return rankFiles([...found.values()], this.preferLossless())
	}

	async accountInfo() {
		return {}
	}

	async accountQuality(): Promise<AudioQuality> {
		return BEST
	}
}
