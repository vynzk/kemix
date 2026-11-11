import { useEffect, useMemo, useRef, useState } from 'react'
import type { SpectrumAnalysis } from '@kemix/core'
import {
	RAMP_GRADIENT,
	clock,
	decodeSpectrogram,
	displayRange,
	frequencyTicks,
	khz,
	levelDb,
	placeLabels,
	rampColor,
	referenceCutoffs
} from '../lib/spectrum'

/** Alto del gráfico, en píxeles. */
const HEIGHT = 320
/** Ancho del panel del nivel medio. */
const CURVE_WIDTH = 168

interface Hover {
	/** Posición del puntero dentro del gráfico, de 0 a 1. */
	x: number
	y: number
}

/**
 * El espectrograma de un archivo (el tiempo de izquierda a derecha, las frecuencias de abajo arriba, más claro = más
 * fuerte) y, al costado y con el mismo eje de frecuencias, su nivel medio en todo el tema. Marca el corte medido y
 * dónde cortan los formatos con pérdida más comunes.
 */
export function Spectrogram({ a }: { a: SpectrumAnalysis }) {
	const s = a.spectrogram
	const levels = useMemo(() => decodeSpectrogram(s), [s])
	const range = useMemo(() => displayRange(levels, s), [levels, s])
	const canvas = useRef<HTMLCanvasElement>(null)
	const [hover, setHover] = useState<Hover | null>(null)
	const nyquist = a.sampleRateHz / 2

	useEffect(() => {
		const el = canvas.current
		const ctx = el?.getContext('2d')
		if (!el || !ctx || !s.columns) return
		// Un píxel por celda; el navegador lo estira al tamaño del gráfico.
		el.width = s.columns
		el.height = s.rows
		const lut = Array.from({ length: 256 }, (_, v) =>
			rampColor((levelDb(v, s) - range.min) / (range.max - range.min))
		)
		const img = ctx.createImageData(s.columns, s.rows)
		for (let c = 0; c < s.columns; c++) {
			for (let r = 0; r < s.rows; r++) {
				const [red, green, blue] = lut[levels[c * s.rows + r]!]!
				const at = ((s.rows - 1 - r) * s.columns + c) * 4
				img.data[at] = red
				img.data[at + 1] = green
				img.data[at + 2] = blue
				img.data[at + 3] = 255
			}
		}
		ctx.putImageData(img, 0, 0)
	}, [levels, range, s])

	/** Altura (0 arriba, 1 abajo) de una frecuencia. */
	const yOf = (hz: number) => 1 - hz / nyquist
	const cutoff = a.cutoffHz !== null && a.cutoffHz < nyquist * 0.995 ? a.cutoffHz : null
	const lines = [
		...(cutoff ? [{ hz: cutoff, label: `Corte · ${khz(cutoff)}`, main: true }] : []),
		...referenceCutoffs(a.sampleRateHz).map((r) => ({ ...r, main: false }))
	].map((l) => ({ ...l, y: yOf(l.hz) * HEIGHT }))
	const labels = placeLabels(lines, 13)

	// El nivel medio: de su máximo a 100 dB por debajo.
	const avgMax = Math.ceil(Math.max(...a.average) / 10) * 10
	const avgMin = avgMax - 100
	const xOfDb = (db: number) => Math.min(1, Math.max(0, (db - avgMin) / (avgMax - avgMin)))
	const curve = a.average.map((db, r) => `${(xOfDb(db) * 100).toFixed(2)},${(yOf(((r + 0.5) / a.average.length) * nyquist) * 100).toFixed(2)}`)

	const hoverHz = hover ? (1 - hover.y) * nyquist : null
	const hoverRow = hoverHz !== null ? Math.min(s.rows - 1, Math.floor((hoverHz / nyquist) * s.rows)) : null
	const hoverCol = hover ? Math.min(s.columns - 1, Math.floor(hover.x * s.columns)) : null
	const hoverDb = hoverRow !== null && hoverCol !== null ? levelDb(levels[hoverCol * s.rows + hoverRow]!, s) : null

	return (
		<figure className="space-y-3">
			<div className="flex gap-4">
				<div className="relative min-w-0 flex-1 pl-14">
					{/* Eje de frecuencias */}
					{frequencyTicks(nyquist).map((f) => (
						<span
							key={f}
							className="absolute left-0 w-12 -translate-y-1/2 text-right text-[11px] text-muted tabular-nums"
							style={{ top: yOf(f) * HEIGHT }}
						>
							{f === 0 ? '0' : `${f / 1000} kHz`}
						</span>
					))}
					<div
						className="relative cursor-crosshair overflow-hidden rounded-sm border border-line"
						style={{ height: HEIGHT }}
						onPointerMove={(e) => {
							const box = e.currentTarget.getBoundingClientRect()
							setHover({
								x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
								y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height))
							})
						}}
						onPointerLeave={() => setHover(null)}
						role="img"
						aria-label={`Espectrograma de ${a.name}${cutoff ? `: el audio llega hasta ${khz(cutoff)}` : ''}`}
					>
						<canvas ref={canvas} className="absolute inset-0 h-full w-full" />
						{lines.map((l) => (
							<div
								key={l.hz}
								className={l.main ? 'absolute inset-x-0 border-t border-zinc-100' : 'absolute inset-x-0 border-t border-dashed border-zinc-500/70'}
								style={{ top: l.y }}
							/>
						))}
						{hover && (
							<>
								<div className="pointer-events-none absolute inset-y-0 border-l border-white/40" style={{ left: `${hover.x * 100}%` }} />
								<div className="pointer-events-none absolute inset-x-0 border-t border-white/40" style={{ top: `${hover.y * 100}%` }} />
								<div
									className="pointer-events-none absolute z-10 rounded border border-line bg-ink/95 px-2 py-1 text-xs whitespace-nowrap text-zinc-100 tabular-nums shadow-lg"
									style={{
										left: `${hover.x * 100}%`,
										top: `${hover.y * 100}%`,
										transform: `translate(${hover.x > 0.7 ? 'calc(-100% - 10px)' : '10px'}, ${hover.y > 0.8 ? 'calc(-100% - 10px)' : '10px'})`
									}}
								>
									{clock(hover.x * a.durationMs)} · {khz(hoverHz!)}
									{hoverDb !== null && <span className="text-muted"> · {Math.round(hoverDb)} dB</span>}
								</div>
							</>
						)}
					</div>
					{/* Eje del tiempo */}
					<div className="relative mt-1 h-4 text-[11px] text-muted tabular-nums">
						{[0, 0.25, 0.5, 0.75, 1].map((t) => (
							<span
								key={t}
								className="absolute"
								style={{ left: `${t * 100}%`, transform: `translateX(${t === 0 ? '0' : t === 1 ? '-100%' : '-50%'})` }}
							>
								{clock(t * a.durationMs)}
							</span>
						))}
					</div>
				</div>

				{/* Nivel medio por frecuencia, con el mismo eje */}
				<div className="shrink-0" style={{ width: CURVE_WIDTH }}>
					<div className="relative rounded-sm border border-line bg-panel" style={{ height: HEIGHT }}>
						<svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
							{[0.25, 0.5, 0.75].map((t) => (
								<line key={t} x1={t * 100} x2={t * 100} y1={0} y2={100} stroke="var(--color-line)" vectorEffect="non-scaling-stroke" />
							))}
							<polyline
								points={curve.join(' ')}
								fill="none"
								stroke="var(--color-accent)"
								strokeWidth={2}
								strokeLinejoin="round"
								vectorEffect="non-scaling-stroke"
							/>
						</svg>
						{lines.map((l) => (
							<div
								key={l.hz}
								className={l.main ? 'absolute inset-x-0 border-t border-zinc-100' : 'absolute inset-x-0 border-t border-dashed border-zinc-500/70'}
								style={{ top: l.y }}
							/>
						))}
						{labels.map((l) => (
							<span
								key={l.hz}
								className={`absolute right-1 -translate-y-full pb-px text-[10px] leading-none whitespace-nowrap ${l.main ? 'font-medium text-zinc-100' : 'text-muted'}`}
								style={{ top: l.y }}
							>
								{l.label}
							</span>
						))}
						{hoverHz !== null && (
							<>
								<div className="pointer-events-none absolute inset-x-0 border-t border-white/40" style={{ top: `${hover!.y * 100}%` }} />
								<span
									className="pointer-events-none absolute left-1 rounded bg-ink/95 px-1 text-[10px] text-zinc-100 tabular-nums"
									style={{ top: `${hover!.y * 100}%`, transform: `translateY(${hover!.y > 0.9 ? '-110%' : '10%'})` }}
								>
									{Math.round(a.average[Math.min(a.average.length - 1, Math.floor((hoverHz / nyquist) * a.average.length))]!)} dB
								</span>
							</>
						)}
					</div>
					<div className="mt-1 flex justify-between text-[11px] text-muted tabular-nums">
						<span>{avgMin} dB</span>
						<span>{avgMax}</span>
					</div>
				</div>
			</div>
			<figcaption className="flex flex-wrap items-center gap-x-6 gap-y-2 pl-14 text-xs text-muted">
				<span className="flex items-center gap-2">
					Nivel
					<span className="tabular-nums">{range.min} dB</span>
					<span className="h-2.5 w-32 rounded-sm border border-line" style={{ background: RAMP_GRADIENT }} />
					<span className="tabular-nums">{range.max} dB</span>
				</span>
				<span className="flex items-center gap-2">
					<span className="w-5 border-t border-zinc-100" /> Corte medido
				</span>
				<span className="flex items-center gap-2">
					<span className="w-5 border-t border-dashed border-zinc-500" /> Dónde cortan los formatos con pérdida
				</span>
				<span className="flex items-center gap-2">
					<span className="w-5 border-t-2 border-accent" /> Nivel medio en todo el tema
				</span>
			</figcaption>
		</figure>
	)
}
