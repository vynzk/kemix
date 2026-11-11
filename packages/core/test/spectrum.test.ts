import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Kemix, passphraseCipher } from '../src/index'
import { readWavStream, type RawDecoder } from '../src/download/ffmpeg'
import { SPECTRUM_ROWS, SpectrumBuilder, judgeSpectrum, lossyLookalike, type SpectrumMeasure } from '../src/spectrum'

/** Números al azar repetibles. */
function random(seed: number) {
	let s = seed >>> 0
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0
		return s / 2 ** 32
	}
}

/**
 * «Música» sintética: cientos de senos de fase al azar hasta `topHz`, cada vez más bajos hacia los agudos, y un ruido
 * de fondo muy bajo (como el que deja un MP3). Muestras de 32 bits con la resolución de `bits`, intercaladas.
 */
function synth(o: { rate: number; seconds: number; topHz: number; bits?: 16 | 24; channels?: number; floorDb?: number }) {
	const n = Math.round(o.rate * o.seconds)
	const mono = new Float64Array(n)
	const rnd = random(7)
	for (let f = 40; f < o.topHz; f += 30 + rnd() * 20) {
		const amp = 0.02 / Math.sqrt(f / 200)
		const w = (2 * Math.PI * f) / o.rate
		const cw = Math.cos(w)
		const sw = Math.sin(w)
		const phase = rnd() * 2 * Math.PI
		let c = Math.cos(phase) * amp
		let s = Math.sin(phase) * amp
		for (let i = 0; i < n; i++) {
			mono[i]! += s
			const c2 = c * cw - s * sw
			s = s * cw + c * sw
			c = c2
		}
	}
	let peak = 0
	for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mono[i]!))
	const floor = 10 ** ((o.floorDb ?? -95) / 20)
	const step = 2 ** (32 - (o.bits ?? 16))
	const ch = o.channels ?? 2
	const out = new Int32Array(n * ch)
	for (let i = 0; i < n; i++) {
		const x = (mono[i]! / peak) * 0.8 + (rnd() * 2 - 1) * floor
		const q = Math.round((x * 2 ** 31) / step) * step
		for (let c = 0; c < ch; c++) out[i * ch + c] = Math.max(-(2 ** 31), Math.min(2 ** 31 - step, q))
	}
	return out
}

function measure(samples: Int32Array, rate: number, channels = 2): SpectrumMeasure {
	const b = new SpectrumBuilder(rate, channels)
	// En partes de tamaños raros, como llegan de ffmpeg.
	for (let at = 0; at < samples.length; at += 3001 * channels) b.push(samples.subarray(at, at + 3001 * channels))
	return b.finish()
}

const wav16 = { codec: 'wav', lossless: true, bitDepth: 16, sampleRateHz: 44_100 } as const

describe('readWavStream', () => {
	it('lee el formato y las muestras de un WAV que llega por partes', async () => {
		const fmt = Buffer.alloc(40)
		fmt.writeUInt16LE(0xfffe, 0)
		fmt.writeUInt16LE(2, 2)
		fmt.writeUInt32LE(96_000, 4)
		fmt.writeUInt32LE(96_000 * 8, 8)
		fmt.writeUInt16LE(8, 12)
		fmt.writeUInt16LE(32, 14)
		const chunk = (id: string, body: Buffer, size = body.length) => {
			const head = Buffer.alloc(8)
			head.write(id, 0, 'latin1')
			head.writeUInt32LE(size, 4)
			return Buffer.concat([head, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)])
		}
		const samples = Int32Array.from([1, -2, 3, -4, 2 ** 30, -(2 ** 31), 7, 8])
		const riff = Buffer.alloc(12)
		riff.write('RIFF', 0, 'latin1')
		riff.writeUInt32LE(0xffffffff, 4)
		riff.write('WAVE', 8, 'latin1')
		const bytes = Buffer.concat([
			riff,
			chunk('fmt ', fmt),
			// Un bloque de tamaño impar (lleva un byte de relleno) antes de los datos.
			chunk('LIST', Buffer.from('INFOISFT Lavf61.1.100\0x', 'latin1')),
			chunk('data', Buffer.from(samples.buffer), 0xffffffff).subarray(0, 8),
			Buffer.from(samples.buffer)
		])
		async function* parts() {
			for (let at = 0; at < bytes.length; at += 7) yield bytes.subarray(at, at + 7)
		}
		const audio = await readWavStream(parts())
		expect(audio).toMatchObject({ sampleRate: 96_000, channels: 2 })
		const got: number[] = []
		for await (const c of audio.chunks) {
			// Siempre cuadros completos: los dos canales.
			expect(c.length % 2).toBe(0)
			got.push(...c)
		}
		expect(got).toEqual([...samples])
	})

	it('falla si no hay audio', async () => {
		async function* empty() {}
		await expect(readWavStream(empty())).rejects.toThrow('No se pudo leer el audio')
	})
})

describe('espectro', () => {
	it('un archivo sin pérdida de verdad tiene agudos hasta arriba', () => {
		const m = measure(synth({ rate: 44_100, seconds: 3, topHz: 21_800 }), 44_100)
		expect(m.cutoff!.hz).toBeGreaterThan(21_000)
		expect(m.usedBits).toBe(16)
		expect(m.spectrogram).toMatchObject({ rows: SPECTRUM_ROWS, minDb: -140, maxDb: 0 })
		expect(Buffer.from(m.spectrogram.data, 'base64')).toHaveLength(m.spectrogram.columns * SPECTRUM_ROWS)
		expect(m.average).toHaveLength(SPECTRUM_ROWS)
		expect(m.durationMs).toBe(3000)
		expect(judgeSpectrum(wav16, m)).toMatchObject({ level: 'ok', title: 'Parece sin pérdida de verdad' })
	})

	it('un WAV hecho desde un MP3 de 128 se corta de golpe en 16 kHz', () => {
		const m = measure(synth({ rate: 44_100, seconds: 3, topHz: 16_000 }), 44_100)
		expect(m.cutoff!.sharp).toBe(true)
		expect(Math.abs(m.cutoff!.hz - 16_000)).toBeLessThan(400)
		const v = judgeSpectrum(wav16, m)
		expect(v).toMatchObject({ level: 'fake', title: 'Probablemente viene de un MP3' })
		expect(v.details[0]).toMatch(/Se corta de golpe en 16(,\d)? kHz, como un MP3 de 128 kbps/)
	})

	it('un MP3 que dice 320 pero se corta como uno de 128', () => {
		const m = measure(synth({ rate: 44_100, seconds: 3, topHz: 16_000 }), 44_100)
		const mp3 = { codec: 'mp3', lossless: false, sampleRateHz: 44_100, bitrateKbps: 320 } as const
		expect(judgeSpectrum(mp3, m)).toMatchObject({ level: 'fake', title: 'Probablemente viene de uno de menos calidad' })
		// Uno de 128 que se corta ahí está bien.
		expect(judgeSpectrum({ ...mp3, bitrateKbps: 128 }, m).level).toBe('ok')
	})

	it('un 24 bits/96 kHz hecho desde un CD: nada sobre 22 kHz', () => {
		const m = measure(synth({ rate: 96_000, seconds: 2, topHz: 21_600, bits: 24, floorDb: -130 }), 96_000)
		expect(m.usedBits).toBe(24)
		const v = judgeSpectrum({ codec: 'flac', lossless: true, bitDepth: 24, sampleRateHz: 96_000 }, m)
		expect(v).toMatchObject({ level: 'fake', title: 'Es de 44,1 kHz remuestreado' })
	})

	it('alta resolución de verdad', () => {
		const m = measure(synth({ rate: 96_000, seconds: 2, topHz: 40_000, bits: 24, floorDb: -130 }), 96_000)
		const v = judgeSpectrum({ codec: 'flac', lossless: true, bitDepth: 24, sampleRateHz: 96_000 }, m)
		expect(v.level).toBe('ok')
		expect(v.details).toContain('Usa 24 bits de verdad.')
		expect(v.details.join(' ')).toMatch(/Hay audio sobre los 22 kHz del CD/)
	})

	it('un 24 bits que solo usa 16', () => {
		const m = measure(synth({ rate: 44_100, seconds: 2, topHz: 21_800, bits: 16 }), 44_100)
		const v = judgeSpectrum({ codec: 'flac', lossless: true, bitDepth: 24, sampleRateHz: 44_100 }, m)
		expect(v).toMatchObject({ level: 'fake', title: 'Es de 16 bits con relleno' })
	})

	it('pocos agudos que bajan de a poco quedan en duda, no como falsos', () => {
		const verdict = judgeSpectrum(wav16, {
			sampleRateHz: 44_100,
			cutoff: { hz: 15_000, sharp: false, dropDb: 0 },
			usedBits: 16,
			ultrasonicGapDb: null
		})
		expect(verdict).toMatchObject({ level: 'doubt', title: 'Tiene pocos agudos' })
		// Un corte leve también.
		const soft = judgeSpectrum(wav16, {
			sampleRateHz: 44_100,
			cutoff: { hz: 16_300, sharp: true, dropDb: 15 },
			usedBits: 16,
			ultrasonicGapDb: null
		})
		expect(soft).toMatchObject({ level: 'doubt', title: 'Puede venir de un MP3' })
	})

	it('silencio: no hay nada que medir', () => {
		const m = measure(new Int32Array(44_100 * 2 * 2), 44_100)
		expect(m.cutoff).toBeNull()
		expect(m.usedBits).toBeNull()
		expect(judgeSpectrum(wav16, m).level).toBe('unknown')
	})

	it('nombra el MP3 al que se parece cada corte', () => {
		expect(lossyLookalike(16_000)).toBe('un MP3 de 128 kbps o el AAC de YouTube')
		expect(lossyLookalike(18_600)).toBe('un MP3 de 192 kbps')
		expect(lossyLookalike(20_400)).toBe('un MP3 de 320 kbps, un AAC o un Opus')
		expect(lossyLookalike(21_500)).toBeNull()
	})

	it('en temas largos junta columnas: nunca pasa de 1024', () => {
		const b = new SpectrumBuilder(8_000, 1)
		// 20 minutos a 8 kHz: casi 2400 análisis.
		const chunk = new Int32Array(8_000 * 60).map((_, i) => Math.round(Math.sin(i / 3) * 2 ** 28))
		for (let i = 0; i < 20; i++) b.push(chunk)
		const m = b.finish()
		expect(m.spectrogram.columns).toBeGreaterThanOrEqual(512)
		expect(m.spectrogram.columns).toBeLessThanOrEqual(1024)
		expect(m.durationMs).toBe(20 * 60_000)
	})
})

/** Un WAV de 16 bits con `samples` (de 32 bits) adentro, para que se pueda leer lo que dice el archivo. */
function wavFile(samples: Int32Array, rate: number, channels = 2): Buffer {
	const data = Buffer.alloc(samples.length * 2)
	for (let i = 0; i < samples.length; i++) data.writeInt16LE(samples[i]! >> 16, i * 2)
	const b = Buffer.alloc(44)
	b.write('RIFF', 0)
	b.writeUInt32LE(36 + data.length, 4)
	b.write('WAVE', 8)
	b.write('fmt ', 12)
	b.writeUInt32LE(16, 16)
	b.writeUInt16LE(1, 20)
	b.writeUInt16LE(channels, 22)
	b.writeUInt32LE(rate, 24)
	b.writeUInt32LE(rate * channels * 2, 28)
	b.writeUInt16LE(channels * 2, 32)
	b.writeUInt16LE(16, 34)
	b.write('data', 36)
	b.writeUInt32LE(data.length, 40)
	return Buffer.concat([b, data])
}

describe('SpectrumAnalyzer', () => {
	let dir: string
	let kemix: Kemix
	const samples = synth({ rate: 44_100, seconds: 2, topHz: 16_000 })
	const decoded: string[] = []
	const decoder: RawDecoder = {
		async decodeRaw(input) {
			decoded.push(input)
			async function* chunks() {
				yield samples
			}
			return { sampleRate: 44_100, channels: 2, chunks: chunks() }
		}
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kemix-spectrum-'))
		kemix = new Kemix({ dataDir: path.join(dir, 'data'), cipher: passphraseCipher('test'), rawDecoder: decoder })
		decoded.length = 0
	})
	afterEach(() => {
		kemix.close()
		fs.rmSync(dir, { recursive: true, force: true })
	})

	it('analiza un archivo subido y lo borra después', async () => {
		const a = await kemix.spectrum.analyzeUpload(Readable.from([wavFile(samples, 44_100)]), 'C:\\bajadas\\tema raro.wav')
		expect(a).toMatchObject({
			name: 'tema raro.wav',
			declared: { codec: 'wav', lossless: true, bitDepth: 16, sampleRateHz: 44_100 },
			sampleRateHz: 44_100,
			channels: 2,
			sharpCutoff: true,
			usedBits: 16,
			verdict: { level: 'fake' }
		})
		expect(decoded).toHaveLength(1)
		expect(path.extname(decoded[0]!)).toBe('.wav')
		expect(fs.existsSync(decoded[0]!)).toBe(false)
		await expect(kemix.spectrum.analyzeUpload(Readable.from([]), 'vacío.wav')).rejects.toThrow('vacío')
	})

	it('analiza el archivo de una descarga terminada', async () => {
		const file = path.join(dir, 'tema.wav')
		fs.writeFileSync(file, wavFile(samples, 44_100))
		const { playlistId, positions } = kemix.library.addToLocalPlaylist('buscar', [
			{ source: 'spotify', sourceId: 's1', title: 'Tema', artists: ['Alguien'] }
		])
		const trackId = (
			kemix.db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? AND position = ?').get(playlistId, positions[0]!) as {
				track_id: number
			}
		).track_id
		const insert = kemix.db.prepare(
			'INSERT INTO downloads (playlist_id, position, track_id, status, path, updated_at) VALUES (?, ?, ?, ?, ?, 0)'
		)
		const done = Number(insert.run(playlistId, positions[0]!, trackId, 'done', file).lastInsertRowid)
		const a = await kemix.spectrum.analyzeDownload(done)
		expect(a).toMatchObject({ name: 'tema.wav', verdict: { level: 'fake' } })
		expect(decoded).toEqual([file])
		fs.rmSync(file)
		await expect(kemix.spectrum.analyzeDownload(done)).rejects.toThrow('ya no está')
		await expect(kemix.spectrum.analyzeDownload(9999)).rejects.toThrow('ya no está')
	})
})
