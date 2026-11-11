import type { SpectrumAnalysis, SpectrumLevel } from '@kemix/core'

type Spectrogram = SpectrumAnalysis['spectrogram']

/**
 * Escala secuencial de un solo tono, el lima de Kemix: del fondo (silencio) a casi blanco (lo más fuerte). La claridad
 * sube siempre, así que se lee igual sin distinguir colores.
 */
const RAMP: [at: number, r: number, g: number, b: number][] = [
	[0, 13, 14, 16],
	[0.3, 30, 42, 12],
	[0.6, 86, 116, 22],
	[0.85, 170, 210, 48],
	[1, 242, 255, 205]
]

export function rampColor(t: number): [number, number, number] {
	const x = Math.min(1, Math.max(0, t))
	let i = 1
	while (i < RAMP.length - 1 && RAMP[i]![0] < x) i++
	const [a0, r0, g0, b0] = RAMP[i - 1]!
	const [a1, r1, g1, b1] = RAMP[i]!
	const f = (x - a0) / (a1 - a0)
	return [Math.round(r0 + (r1 - r0) * f), Math.round(g0 + (g1 - g0) * f), Math.round(b0 + (b1 - b0) * f)]
}

/** La escala como gradiente de CSS, para la leyenda. */
export const RAMP_GRADIENT = `linear-gradient(to right, ${RAMP.map(([at, r, g, b]) => `rgb(${r} ${g} ${b}) ${at * 100}%`).join(', ')})`

/** Los niveles del espectrograma (0–255 por celda, columna por columna). */
export function decodeSpectrogram(s: Spectrogram): Uint8Array {
	const bin = atob(s.data)
	const out = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
	return out
}

export const levelDb = (v: number, s: Spectrogram) => s.minDb + (v / 255) * (s.maxDb - s.minDb)

/** Cuántos dB se muestran: los 100 por debajo del nivel más alto (sin contar los picos sueltos). */
export const DISPLAY_RANGE_DB = 100

/** El rango de dB que va del fondo al color más claro: hasta el nivel más alto del tema y 100 dB por debajo. */
export function displayRange(levels: Uint8Array, s: Spectrogram): { min: number; max: number } {
	const counts = new Uint32Array(256)
	for (const v of levels) counts[v]!++
	// El percentil 99,5: unos pocos picos no apagan el resto.
	let left = Math.floor(levels.length * 0.005)
	let top = 255
	while (top > 0 && left >= counts[top]!) left -= counts[top--]!
	const max = Math.ceil(levelDb(top, s) / 10) * 10
	return { min: max - DISPLAY_RANGE_DB, max }
}

/** Marcas del eje de frecuencias, en Hz: cada 2, 5 o 10 kHz según hasta dónde llegue el archivo. */
export function frequencyTicks(nyquist: number): number[] {
	const step = nyquist > 40_000 ? 10_000 : nyquist > 16_000 ? 5_000 : 2_000
	const out: number[] = []
	for (let f = 0; f <= nyquist; f += step) out.push(f)
	return out
}

/** «16,5 kHz». */
export function khz(hz: number): string {
	return `${(Math.round(hz / 100) / 10).toString().replace('.', ',')} kHz`
}

/** «3:05». */
export function clock(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000))
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Dónde cortan los agudos los formatos con pérdida más comunes: se marcan en el espectro para comparar. */
export function referenceCutoffs(sampleRateHz: number): { hz: number; label: string }[] {
	const refs = [
		{ hz: 16_000, label: 'MP3 128' },
		{ hz: 19_000, label: 'MP3 192–256' },
		{ hz: 20_000, label: 'MP3 320 · AAC · Opus' }
	]
	// En alta resolución, también dónde termina un CD.
	if (sampleRateHz > 48_000) refs.push({ hz: 22_050, label: 'CD' })
	return refs.filter((r) => r.hz < sampleRateHz / 2)
}

/**
 * Etiquetas que no se pisan: en orden de importancia, se descarta la que queda a menos de `gap` (en las mismas
 * unidades que `y`) de una ya puesta.
 */
export function placeLabels<T extends { y: number }>(labels: T[], gap: number): T[] {
	const placed: T[] = []
	for (const l of labels) if (placed.every((p) => Math.abs(p.y - l.y) >= gap)) placed.push(l)
	return placed
}

export const VERDICT_STYLE: Record<SpectrumLevel, { icon: string; label: string; cls: string; border: string }> = {
	ok: { icon: '✓', label: 'Coincide', cls: 'bg-emerald-950 text-emerald-300', border: 'border-emerald-800/70' },
	doubt: { icon: '?', label: 'Dudoso', cls: 'bg-amber-950 text-amber-300', border: 'border-amber-800/70' },
	fake: { icon: '✕', label: 'No es lo que dice', cls: 'bg-red-950 text-red-300', border: 'border-red-800/70' },
	unknown: { icon: '–', label: 'Sin datos', cls: 'bg-zinc-800 text-zinc-300', border: 'border-line' }
}
