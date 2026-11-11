import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Db } from './db'
import type { RawDecoder } from './download/ffmpeg'
import { readFileDetails } from './download/quality'
import { fft, hann, yieldToLoop } from './features/dsp'
import type { AudioQuality, SpectrumAnalysis, SpectrumLevel, SpectrumVerdict } from './types'

/**
 * Espectro de un archivo de audio, para saber si su calidad es la que dice. Un códec con pérdida tira los agudos que
 * menos se oyen con un filtro brusco (un MP3 de 128 kbps no tiene nada sobre unos 16–17 kHz; uno de 320, sobre
 * 20 kHz), y convertirlo después a WAV o FLAC no los devuelve: el corte queda a la vista. Lo mismo con un archivo de
 * 96 kHz hecho desde uno de 44,1 kHz (nada sobre 22 kHz) o uno de 24 bits hecho desde uno de 16 (los 8 bits de abajo
 * en cero).
 */

/** Muestras por análisis: a 44,1 kHz, columnas de 93 ms y bandas de 10,8 Hz. */
const FFT_SIZE = 4096
const BINS = FFT_SIZE / 2
/** Filas del espectrograma, de 0 Hz a la mitad de la frecuencia de muestreo. */
export const SPECTRUM_ROWS = 512
const BINS_PER_ROW = BINS / SPECTRUM_ROWS
/** Al llegar a tantas columnas se juntan de a dos: quedan entre la mitad y esto. */
const MAX_COLUMNS = 1024
/** Análisis por tema como mucho: en los largos se salta audio entre uno y otro (sin cambiar el promedio). */
const MAX_FFTS = 8192
const MIN_DB = -140
const MAX_DB = 0
/** Con la ventana de Hann, un seno a fondo de escala da 0 dB. */
const NORM = (FFT_SIZE / 4) ** 2
/** Hace falta al menos ~1 s de audio para medir algo. */
const MIN_FRAMES = 10
/** Una caída de al menos tanto en ~1 kHz, que después sigue abajo, es un filtro y no la música bajando. */
const CLIFF_DB = 15
/** Por debajo de esto (por banda) ya es el ruido de fondo de un CD, no audio. */
const NOISE_DB = -115
/** Sin nada por encima de esto en los graves y medios, es silencio. */
const SILENCE_DB = -120
/** Mayor a esto: un archivo que pesa más es otra cosa. */
const MAX_UPLOAD_BYTES = 4 * 1024 ** 3

export interface SpectrumMeasure {
	sampleRateHz: number
	channels: number
	durationMs: number
	spectrogram: SpectrumAnalysis['spectrogram']
	average: number[]
	cutoff: Cutoff | null
	usedBits: number | null
	/**
	 * Archivos de más de 48 kHz: cuántos dB más bajo está lo que hay sobre 24,5 kHz que los agudos de 10 a 20 kHz.
	 * Mucho más bajo: no hay nada arriba, como en uno hecho desde 44,1 o 48 kHz. Null en los demás.
	 */
	ultrasonicGapDb: number | null
}

export interface Cutoff {
	hz: number
	/** Se corta de golpe (un filtro) en vez de bajar de a poco. */
	sharp: boolean
	/** Cuánto cae en el corte, en dB (0 si no hay corte). */
	dropDb: number
}

/**
 * Va juntando el audio a medida que se decodifica: el espectrograma (columnas promediadas), el espectro medio de todo
 * el tema y qué bits usan las muestras. La memoria no crece con la duración.
 */
export class SpectrumBuilder {
	readonly #window = hann(FFT_SIZE)
	readonly #re = new Float64Array(FFT_SIZE)
	readonly #im = new Float64Array(FFT_SIZE)
	readonly #frame = new Float64Array(FFT_SIZE)
	readonly #stride: number
	#fill = 0
	#frameIndex = 0
	#take = true
	#samples = 0
	#bits = 0
	readonly #total = new Float64Array(BINS)
	#analyzed = 0
	#columns: Float64Array[] = []
	#column = new Float64Array(SPECTRUM_ROWS)
	#columnFrames = 0
	#framesPerColumn = 1

	/** `expectedSamples`: muestras por canal, si se saben, para repartir los análisis por todo el tema. */
	constructor(
		readonly sampleRate: number,
		readonly channels: number,
		expectedSamples?: number | null
	) {
		this.#stride = expectedSamples ? Math.max(1, Math.ceil(expectedSamples / FFT_SIZE / MAX_FFTS)) : 1
	}

	/** Muestras enteras de 32 bits intercaladas por canal, en cuadros completos. */
	push(chunk: Int32Array) {
		let bits = this.#bits
		for (let i = 0; i < chunk.length; i++) bits |= chunk[i]!
		this.#bits = bits
		const ch = this.channels
		const scale = 1 / (ch * 2 ** 31)
		const frames = Math.floor(chunk.length / ch)
		let s = 0
		while (s < frames) {
			const n = Math.min(FFT_SIZE - this.#fill, frames - s)
			if (this.#take) {
				const frame = this.#frame
				for (let j = 0; j < n; j++) {
					const base = (s + j) * ch
					let sum = 0
					for (let c = 0; c < ch; c++) sum += chunk[base + c]!
					frame[this.#fill + j] = sum * scale
				}
			}
			this.#fill += n
			s += n
			if (this.#fill === FFT_SIZE) {
				if (this.#take) this.#analyze()
				this.#fill = 0
				this.#frameIndex++
				this.#take = this.#frameIndex % this.#stride === 0
			}
		}
		this.#samples += frames
	}

	#analyze() {
		const re = this.#re
		const im = this.#im
		for (let i = 0; i < FFT_SIZE; i++) re[i] = this.#frame[i]! * this.#window[i]!
		im.fill(0)
		fft(re, im)
		const total = this.#total
		const column = this.#column
		for (let r = 0; r < SPECTRUM_ROWS; r++) {
			let sum = 0
			for (let b = 0; b < BINS_PER_ROW; b++) {
				const k = r * BINS_PER_ROW + b
				const p = (re[k]! * re[k]! + im[k]! * im[k]!) / NORM
				total[k]! += p
				sum += p
			}
			column[r]! += sum / BINS_PER_ROW
		}
		this.#analyzed++
		if (++this.#columnFrames === this.#framesPerColumn) this.#closeColumn()
	}

	#closeColumn() {
		const n = this.#columnFrames
		this.#columns.push(this.#column.map((p) => p / n))
		this.#column = new Float64Array(SPECTRUM_ROWS)
		this.#columnFrames = 0
		if (this.#columns.length < MAX_COLUMNS) return
		const merged: Float64Array[] = []
		for (let i = 0; i < this.#columns.length; i += 2) {
			const a = this.#columns[i]!
			const b = this.#columns[i + 1]!
			merged.push(a.map((p, r) => (p + b[r]!) / 2))
		}
		this.#columns = merged
		this.#framesPerColumn *= 2
	}

	finish(): SpectrumMeasure {
		if (this.#columnFrames > 0) this.#closeColumn()
		const columns = this.#columns
		const data = new Uint8Array(columns.length * SPECTRUM_ROWS)
		columns.forEach((col, c) => {
			for (let r = 0; r < SPECTRUM_ROWS; r++) data[c * SPECTRUM_ROWS + r] = quantize(toDb(col[r]!))
		})
		const n = Math.max(1, this.#analyzed)
		const average: number[] = []
		for (let r = 0; r < SPECTRUM_ROWS; r++) {
			let sum = 0
			for (let b = 0; b < BINS_PER_ROW; b++) sum += this.#total[r * BINS_PER_ROW + b]!
			average.push(Math.round(Math.max(MIN_DB, toDb(sum / BINS_PER_ROW / n)) * 10) / 10)
		}
		const binHz = this.sampleRate / FFT_SIZE
		const levels = smoothDb(this.#total, n, Math.max(1, Math.round(100 / binHz)))
		const bits = this.#bits
		return {
			sampleRateHz: this.sampleRate,
			channels: this.channels,
			durationMs: Math.round((this.#samples / this.sampleRate) * 1000),
			spectrogram: {
				columns: columns.length,
				rows: SPECTRUM_ROWS,
				minDb: MIN_DB,
				maxDb: MAX_DB,
				data: Buffer.from(data.buffer).toString('base64')
			},
			average,
			cutoff: this.#analyzed >= MIN_FRAMES ? findCutoff(levels, binHz) : null,
			// Los bits de abajo que ninguna muestra usa: con 16 bits de verdad, quedan 16 en cero.
			usedBits: bits === 0 ? null : 32 - (31 - Math.clz32(bits & -bits)),
			ultrasonicGapDb: this.sampleRate > 48_000 && this.#analyzed >= MIN_FRAMES ? ultrasonicGap(levels, binHz) : null
		}
	}
}

/** Cuántos dB más bajo está lo que hay entre 24,5 y 40 kHz que los agudos de 10 a 20 kHz. */
export function ultrasonicGap(levels: Float64Array, binHz: number): number | null {
	const bin = (hz: number) => Math.round(hz / binHz)
	const from = bin(24_500)
	const to = Math.min(levels.length - 1 - bin(1000), bin(40_000))
	if (to - from < bin(1000)) return null
	return Math.round(mean(levels, bin(10_000), bin(20_000)) - mean(levels, from, to))
}

const toDb = (p: number) => 10 * Math.log10(p + 1e-30)
const quantize = (db: number) => Math.round(((Math.min(MAX_DB, Math.max(MIN_DB, db)) - MIN_DB) / (MAX_DB - MIN_DB)) * 255)

/** Espectro medio en dB por banda, suavizado ±`half` bandas (en potencia). */
function smoothDb(total: Float64Array, frames: number, half: number): Float64Array {
	const out = new Float64Array(total.length)
	for (let k = 0; k < total.length; k++) {
		const from = Math.max(0, k - half)
		const to = Math.min(total.length - 1, k + half)
		let sum = 0
		for (let j = from; j <= to; j++) sum += total[j]!
		out[k] = toDb(sum / (to - from + 1) / frames)
	}
	return out
}

const mean = (a: Float64Array, from: number, to: number) => {
	let sum = 0
	for (let k = from; k <= to; k++) sum += a[k]!
	return sum / (to - from + 1)
}

/**
 * Hasta qué frecuencia llega el audio, con el espectro medio en dB por banda (`binHz` cada una). Busca la caída brusca
 * más aguda (la marca de un filtro: el de un códec con pérdida o el de un remuestreo); sin una, hasta dónde se
 * distingue la música del ruido de fondo. Null: no hay música que medir.
 */
export function findCutoff(levels: Float64Array, binHz: number): Cutoff | null {
	const bin = (hz: number) => Math.round(hz / binHz)
	const n = levels.length
	const nyquist = n * binHz
	let peak = Number.NEGATIVE_INFINITY
	for (let k = bin(100); k < Math.min(bin(5000), n); k++) peak = Math.max(peak, levels[k]!)
	if (peak < SILENCE_DB) return null
	// El piso: lo más bajo sobre 1 kHz (sin los extremos sueltos).
	const lo = bin(1000)
	const sorted = Array.from(levels.subarray(lo)).sort((a, b) => a - b)
	const floor = sorted[Math.floor(sorted.length * 0.02)]!

	// Caídas bruscas: el promedio de ~1 kHz abajo contra el de ~1 kHz arriba, dejando un margen para la transición.
	const gap = Math.max(1, bin(150))
	const span = Math.max(gap + 2, bin(1000))
	const stay = bin(3000)
	let best = -1
	let bestDrop = 0
	let last = Number.NEGATIVE_INFINITY
	for (let k = Math.max(span, bin(4000)); k + gap + 2 < n; k++) {
		const below = mean(levels, k - span, k - gap)
		// Lo de abajo tiene que ser audio, no el ruido de fondo.
		if (below < floor + CLIFF_DB) continue
		const drop = below - mean(levels, k + gap, Math.min(n - 1, k + span))
		if (drop < CLIFF_DB) continue
		// Y tiene que seguir abajo un buen trecho: si no, es un hueco y no un corte.
		if (mean(levels, k + gap, Math.min(n - 1, k + stay)) > below - CLIFF_DB * 0.75) continue
		// Se queda con la caída más aguda y, dentro de ella, con el punto donde cae más.
		if (k - last > 2 || drop > bestDrop) {
			best = k
			bestDrop = drop
		}
		last = k
	}
	if (best >= 0) return { hz: Math.round(best * binHz), sharp: true, dropDb: Math.round(bestDrop) }
	// Sin un corte: hasta dónde hay algo sobre el ruido de fondo de un CD.
	let top = lo
	for (let k = n - 1; k >= lo; k--) {
		if (levels[k]! > NOISE_DB) {
			top = k
			break
		}
	}
	return { hz: Math.round(Math.min(nyquist, (top + 1) * binHz)), sharp: false, dropDb: 0 }
}

// ---------- veredicto ----------

const kHz = (hz: number) => `${(Math.round(hz / 100) / 10).toString().replace('.', ',')} kHz`

/** A qué códec y bitrate se parece un corte en `hz` (los filtros de LAME, y los de AAC y Opus). */
export function lossyLookalike(hz: number): string | null {
	if (hz < 15_500) return 'un MP3 de menos de 128 kbps'
	if (hz < 16_600) return 'un MP3 de 128 kbps o el AAC de YouTube'
	if (hz < 17_800) return 'un MP3 de 128 a 160 kbps'
	if (hz < 19_000) return 'un MP3 de 192 kbps'
	if (hz < 19_900) return 'un MP3 de 224 a 256 kbps'
	if (hz < 21_000) return 'un MP3 de 320 kbps, un AAC o un Opus'
	return null
}

/** El corte que, como mínimo, tiene un MP3 de `kbps` (el filtro de LAME, con margen). */
function expectedLossyCutoff(codec: AudioQuality['codec'], kbps: number): number | null {
	if (codec === 'mp3') {
		if (kbps >= 300) return 19_500
		if (kbps >= 240) return 18_800
		if (kbps >= 180) return 17_800
		return null
	}
	// AAC, Opus y Vorbis varían más según el codificador: solo los bitrates altos.
	if (kbps >= 240) return 18_000
	return null
}

const LOSSLESS_TOP = 21_000
/** Una caída menor que esto se parece a la de un MP3, pero puede ser un máster filtrado: queda en duda. */
const CLEAR_DROP_DB = 18
/** Lo de arriba de 24,5 kHz tantos dB más bajo que los agudos: no hay alta resolución de verdad. */
const EMPTY_ULTRASONIC_DB = 50

/**
 * Qué dice el espectro de la calidad que declara el archivo. Lo que se puede medir: un corte de agudos que no
 * corresponde (un sin pérdida que se corta como un MP3, un MP3 de 320 que se corta como uno de 128), un archivo de
 * alta frecuencia de muestreo sin nada sobre 22–24 kHz, y uno de 24 bits que solo usa 16.
 */
export function judgeSpectrum(
	declared: AudioQuality | null,
	m: Pick<SpectrumMeasure, 'sampleRateHz' | 'cutoff' | 'usedBits' | 'ultrasonicGapDb'>
): SpectrumVerdict {
	const cut = m.cutoff
	if (!cut) {
		return { level: 'unknown', title: 'No hay audio suficiente para medir', details: ['Es silencio o dura muy poco.'] }
	}
	const findings: { level: SpectrumLevel; title: string; detail: string }[] = []
	const nyquist = m.sampleRateHz / 2
	const fullBand = Math.min(LOSSLESS_TOP, nyquist * 0.95)
	const lossy = declared ? !declared.lossless : false
	const look = lossyLookalike(cut.hz)
	const clear = cut.dropDb >= CLEAR_DROP_DB

	if (lossy && declared) {
		const kbps = declared.bitrateKbps
		const min = kbps ? expectedLossyCutoff(declared.codec, kbps) : null
		if (min && cut.sharp && cut.hz < min - 300) {
			findings.push({
				level: clear ? 'fake' : 'doubt',
				title: clear ? 'Probablemente viene de uno de menos calidad' : 'Puede venir de uno de menos calidad',
				detail:
					`Dice ${kbps} kbps, pero se corta en ${kHz(cut.hz)}, como ${look ?? 'uno de menos bitrate'}: ` +
					'lo más probable es que lo hayan convertido desde uno peor.'
			})
		} else {
			findings.push({
				level: 'ok',
				title: 'Coincide con lo que dice',
				detail:
					`Hay audio hasta ${kHz(cut.hz)}, lo esperable en un archivo con pérdida${kbps ? ` de ${kbps} kbps` : ''}. ` +
					'Es un formato con pérdida, pero no parece inflado desde uno peor.'
			})
		}
	} else if (cut.hz < fullBand) {
		const what = declared ? 'Un archivo sin pérdida de verdad' : 'Un archivo sin pérdida'
		if (cut.sharp && cut.hz < 19_900 && clear) {
			findings.push({
				level: 'fake',
				title: 'Probablemente viene de un MP3',
				detail:
					`Se corta de golpe en ${kHz(cut.hz)}, como ${look}. ${what} tiene agudos hasta casi ` +
					`${kHz(Math.min(nyquist, 22_000))}: este lo convirtieron desde un formato con pérdida.`
			})
		} else if (cut.sharp && cut.hz < 19_900) {
			findings.push({
				level: 'doubt',
				title: 'Puede venir de un MP3',
				detail:
					`Se corta en ${kHz(cut.hz)}, como ${look}, aunque la caída es menos marcada que la de un MP3 ` +
					'convertido: puede ser un máster hecho desde un MP3, o filtrado a propósito.'
			})
		} else if (cut.sharp) {
			findings.push({
				level: 'doubt',
				title: 'Puede venir de un MP3 de 320, un AAC o un Opus',
				detail:
					`Se corta de golpe en ${kHz(cut.hz)}, como ${look ?? 'un formato con pérdida'}. Algunos másters también se ` +
					'cortan ahí: si puedes, compáralo con otra copia.'
			})
		} else {
			findings.push({
				level: 'doubt',
				title: 'Tiene pocos agudos',
				detail:
					`Casi no hay audio sobre ${kHz(cut.hz)}, pero baja de a poco y no de golpe como en un MP3: puede ser ` +
					'la grabación o el máster. Si puedes, compáralo con otra copia.'
			})
		}
	} else {
		findings.push({
			level: 'ok',
			title: declared ? 'Parece sin pérdida de verdad' : 'Tiene todos los agudos',
			detail: `Hay audio hasta ${kHz(cut.hz)}, como en un archivo sin pérdida.`
		})
	}

	// Alta frecuencia de muestreo sin nada arriba: hecho desde uno de 44,1 o 48 kHz.
	if (!lossy && m.sampleRateHz > 48_000) {
		const rate = kHz(m.sampleRateHz)
		const empty = m.ultrasonicGapDb !== null && m.ultrasonicGapDb >= EMPTY_ULTRASONIC_DB
		if (cut.hz < fullBand) {
			findings.push({
				level: 'ok',
				title: '',
				detail: `Además dice ${rate}, pero con ese corte la alta resolución no aporta nada.`
			})
		} else if ((cut.sharp && cut.hz < 24_500) || empty) {
			// Un corte justo en 22 o 24 kHz dice de dónde viene; sin él, solo que arriba no hay nada.
			const exact = cut.sharp && cut.hz < 24_500
			const from = !exact ? '44,1 o 48 kHz' : cut.hz < 22_600 ? '44,1 kHz' : '48 kHz'
			findings.push({
				level: exact ? 'fake' : 'doubt',
				title: exact ? `Es de ${from} remuestreado` : 'Puede ser de 44,1 o 48 kHz remuestreado',
				detail:
					`Dice ${rate}, pero casi no hay nada sobre ${exact ? kHz(cut.hz) : 'los 22–24 kHz'}: ` +
					`${exact ? 'lo hicieron' : 'parece hecho'} desde un archivo de ${from}, así que no tiene más que un CD.`
			})
		} else {
			findings.push({
				level: 'ok',
				title: 'Alta resolución de verdad',
				detail: `Hay audio sobre los 22 kHz del CD, hasta ${kHz(cut.hz)}.`
			})
		}
	}

	// 24 bits con los 8 de abajo vacíos: un archivo de 16 bits con relleno.
	const bitDepth = declared?.lossless ? declared.bitDepth : undefined
	if (bitDepth && bitDepth > 16 && m.usedBits !== null && m.usedBits <= 16) {
		findings.push({
			level: 'fake',
			title: 'Es de 16 bits con relleno',
			detail: `Dice ${bitDepth} bits, pero solo usa ${m.usedBits}: el resto son ceros. Es la resolución de un CD.`
		})
	} else if (bitDepth && bitDepth > 16 && m.usedBits !== null && m.usedBits > 16) {
		findings.push({ level: 'ok', title: '', detail: `Usa ${Math.min(m.usedBits, bitDepth)} bits de verdad.` })
	}

	const rank: Record<SpectrumLevel, number> = { unknown: 0, ok: 1, doubt: 2, fake: 3 }
	const worst = findings.reduce((w, f) => (rank[f.level] > rank[w.level] ? f : w))
	return { level: worst.level, title: worst.title, details: findings.map((f) => f.detail) }
}

// ---------- análisis de archivos ----------

/** Analiza archivos de audio: los que bajó Kemix y los que el usuario sube desde su equipo. */
export class SpectrumAnalyzer {
	#running?: AbortController

	constructor(
		private db: Db,
		private decoder: RawDecoder
	) {}

	/** Analiza un archivo. Uno nuevo detiene el anterior: hay una sola pantalla que los pide. */
	async analyzeFile(file: string, name = path.basename(file)): Promise<SpectrumAnalysis> {
		this.#running?.abort()
		const abort = new AbortController()
		this.#running = abort
		try {
			const info = readFileDetails(file)
			const audio = await this.decoder.decodeRaw(file, { signal: abort.signal })
			const expected = info?.durationMs ? (info.durationMs / 1000) * audio.sampleRate : null
			const builder = new SpectrumBuilder(audio.sampleRate, audio.channels, expected)
			let slice = performance.now()
			for await (const chunk of audio.chunks) {
				builder.push(chunk)
				// Corre en el proceso principal de la app: cada tanto, que atienda lo demás.
				if (performance.now() - slice > 12) {
					await yieldToLoop()
					abort.signal.throwIfAborted()
					slice = performance.now()
				}
			}
			const m = builder.finish()
			return {
				name,
				declared: info?.quality ?? null,
				sampleRateHz: m.sampleRateHz,
				channels: m.channels,
				durationMs: m.durationMs,
				spectrogram: m.spectrogram,
				average: m.average,
				cutoffHz: m.cutoff?.hz ?? null,
				sharpCutoff: m.cutoff?.sharp ?? false,
				usedBits: info?.quality.lossless === false ? null : m.usedBits,
				verdict: judgeSpectrum(info?.quality ?? null, m)
			}
		} catch (err) {
			if (abort.signal.aborted) throw new Error('Se empezó a analizar otro archivo')
			throw err
		} finally {
			if (this.#running === abort) this.#running = undefined
		}
	}

	/** El archivo de una descarga terminada. */
	async analyzeDownload(downloadId: number): Promise<SpectrumAnalysis> {
		const row = this.db.prepare(`SELECT path FROM downloads WHERE id = ? AND status = 'done'`).get(downloadId) as
			| { path: string | null }
			| undefined
		if (!row?.path || !fs.existsSync(row.path)) throw new Error('El archivo de esta descarga ya no está en el disco')
		return this.analyzeFile(row.path)
	}

	/**
	 * Un archivo que llega por HTTP (`body`): se guarda en una carpeta temporal con su extensión (de ella se deduce el
	 * formato), se analiza y se borra.
	 */
	async analyzeUpload(body: Readable, name: string): Promise<SpectrumAnalysis> {
		const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6)
		const file = path.join(os.tmpdir(), `kemix-espectro-${crypto.randomUUID()}${ext}`)
		try {
			let size = 0
			await pipeline(
				body,
				async function* (chunks: AsyncIterable<Buffer>) {
					for await (const chunk of chunks) {
						size += chunk.length
						if (size > MAX_UPLOAD_BYTES) throw new Error('El archivo es demasiado grande')
						yield chunk
					}
				},
				fs.createWriteStream(file)
			)
			if (size === 0) throw new Error('El archivo está vacío')
			return await this.analyzeFile(file, path.basename(name))
		} finally {
			fs.rmSync(file, { force: true })
		}
	}

	stop() {
		this.#running?.abort()
	}
}
