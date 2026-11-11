import { describe, expect, it } from 'vitest'
import {
	clock,
	decodeSpectrogram,
	displayRange,
	frequencyTicks,
	khz,
	placeLabels,
	rampColor,
	referenceCutoffs
} from '../src/lib/spectrum'

const spectrogram = (levels: number[]) => ({
	columns: levels.length,
	rows: 1,
	minDb: -140,
	maxDb: 0,
	data: Buffer.from(levels).toString('base64')
})

describe('espectro en la UI', () => {
	it('la escala va del fondo a casi blanco, siempre más clara', () => {
		expect(rampColor(0)).toEqual([13, 14, 16])
		expect(rampColor(1)).toEqual([242, 255, 205])
		expect(rampColor(-3)).toEqual(rampColor(0))
		const light = (t: number) => rampColor(t).reduce((a, b) => a + b, 0)
		for (let t = 0.05; t <= 1; t += 0.05) expect(light(t)).toBeGreaterThan(light(t - 0.05))
	})

	it('lee los niveles y muestra 100 dB bajo el más alto, sin los picos sueltos', () => {
		const s = spectrogram([...Array(999).fill(200), 255])
		const levels = decodeSpectrogram(s)
		expect(levels).toHaveLength(1000)
		// 200 de 255 entre -140 y 0 dB: -30 dB. El pico suelto (0 dB) no cuenta.
		expect(displayRange(levels, s)).toEqual({ min: -130, max: -30 })
	})

	it('marca el eje de frecuencias según hasta dónde llega', () => {
		expect(frequencyTicks(22_050)).toEqual([0, 5000, 10_000, 15_000, 20_000])
		expect(frequencyTicks(48_000)).toEqual([0, 10_000, 20_000, 30_000, 40_000])
		expect(frequencyTicks(8_000)).toEqual([0, 2000, 4000, 6000, 8000])
	})

	it('formatea frecuencias y tiempos', () => {
		expect(khz(16_494)).toBe('16,5 kHz')
		expect(khz(20_000)).toBe('20 kHz')
		expect(clock(185_400)).toBe('3:05')
	})

	it('los cortes de referencia, y el del CD solo en alta resolución', () => {
		expect(referenceCutoffs(44_100).map((r) => r.label)).toEqual(['MP3 128', 'MP3 192–256', 'MP3 320 · AAC · Opus'])
		expect(referenceCutoffs(96_000).at(-1)).toEqual({ hz: 22_050, label: 'CD' })
		expect(referenceCutoffs(32_000).map((r) => r.hz)).toEqual([])
	})

	it('no pone dos etiquetas encima: gana la primera', () => {
		const placed = placeLabels(
			[
				{ y: 100, label: 'Corte' },
				{ y: 95, label: 'MP3 320' },
				{ y: 80, label: 'MP3 192' }
			],
			13
		)
		expect(placed.map((p) => p.label)).toEqual(['Corte', 'MP3 192'])
	})
})
