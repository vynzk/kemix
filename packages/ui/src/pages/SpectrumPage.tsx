import { useRef, useState, type DragEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SpectrumAnalysis } from '@kemix/core'
import { api } from '../lib/api'
import { cx, duration, qualityLabel } from '../lib/format'
import { VERDICT_STYLE, khz } from '../lib/spectrum'
import { Spectrogram } from '../components/Spectrogram'
import { Button, ErrorText, PageHeader } from '../components/ui'

/** Qué se está mirando: un archivo del equipo o el de una descarga de Kemix. */
export type SpectrumSource = { kind: 'file'; file: File } | { kind: 'download'; id: number; title: string }

const ACCEPT = 'audio/*,.flac,.wav,.aif,.aiff,.m4a,.mp3,.ogg,.opus,.wma,.ape,.wv'

/**
 * Espectro: el espectrograma de un archivo y si su calidad es la que dice. Sirve para pillar un WAV o FLAC hecho desde
 * un MP3, un «96 kHz» remuestreado desde un CD o un «24 bits» con relleno.
 */
export function SpectrumPage({ source, onSource }: { source: SpectrumSource | null; onSource: (s: SpectrumSource) => void }) {
	const input = useRef<HTMLInputElement>(null)
	const [dragging, setDragging] = useState(false)
	const analysis = useQuery({
		queryKey:
			source?.kind === 'file'
				? ['spectrum', 'file', source.file.name, source.file.size, source.file.lastModified]
				: ['spectrum', 'download', source?.id],
		queryFn: () => (source!.kind === 'file' ? api.spectrumOfFile(source!.file) : api.spectrumOfDownload(source!.id)),
		enabled: !!source,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 30 * 60_000,
		retry: false
	})
	const pick = (files: FileList | null) => {
		const file = files?.[0]
		if (file) onSource({ kind: 'file', file })
	}
	const drop = {
		onDragOver: (e: DragEvent) => {
			if (!e.dataTransfer.types.includes('Files')) return
			e.preventDefault()
			setDragging(true)
		},
		onDragLeave: (e: DragEvent) => {
			if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
		},
		onDrop: (e: DragEvent) => {
			e.preventDefault()
			setDragging(false)
			pick(e.dataTransfer.files)
		}
	}
	const name = source?.kind === 'file' ? source.file.name : source?.title
	const a = analysis.data

	return (
		<div {...drop} className="min-h-full">
			<PageHeader title="Espectro">
				Mira el espectro de un tema para saber si su calidad es la que dice: un WAV o FLAC hecho desde un MP3, un «96 kHz»
				remuestreado desde un CD o un «24 bits» con relleno se delatan aquí.
			</PageHeader>
			<div className="space-y-6 p-8">
				<div
					className={cx(
						'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-dashed px-5 py-4 transition-colors',
						dragging ? 'border-accent bg-lime-950/30' : 'border-line bg-panel/60'
					)}
				>
					<Button variant={a ? 'default' : 'primary'} onClick={() => input.current?.click()}>
						{a ? 'Analizar otro archivo' : 'Elegir archivo'}
					</Button>
					<p className="min-w-0 flex-1 text-sm text-muted">
						O arrastra aquí un archivo de audio (WAV, FLAC, AIFF, ALAC, MP3, AAC, Opus…). Para uno que bajó Kemix, pulsa
						«Espectro» en su fila de la playlist o de Descargas. El archivo no sale de tu equipo.
					</p>
					<input
						ref={input}
						type="file"
						accept={ACCEPT}
						className="hidden"
						onChange={(e) => {
							pick(e.target.files)
							e.target.value = ''
						}}
					/>
				</div>

				{analysis.isFetching && (
					<p className="text-sm text-accent">
						Analizando «{name}»… <span className="text-muted">(la primera vez, Kemix baja ffmpeg)</span>
					</p>
				)}
				{!analysis.isFetching && <ErrorText error={analysis.error} />}
				{a && !analysis.isFetching && <Result a={a} title={source?.kind === 'download' ? source.title : null} />}
				<HowToRead />
			</div>
		</div>
	)
}

function Result({ a, title }: { a: SpectrumAnalysis; title: string | null }) {
	const v = VERDICT_STYLE[a.verdict.level]
	const declared = a.declared
	const bitDepth = declared?.lossless ? declared.bitDepth : undefined
	return (
		<section className="space-y-6">
			<div>
				<h2 className="truncate text-lg font-semibold" title={a.name}>
					{title ?? a.name}
				</h2>
				<p className="truncate text-sm text-muted">
					{title && <>{a.name} · </>}
					{declared ? `Dice ser ${qualityLabel(declared)}` : 'No se pudo leer lo que dice el archivo'}
					{' · '}
					{a.channels === 1 ? 'mono' : a.channels === 2 ? 'estéreo' : `${a.channels} canales`} · {duration(a.durationMs)}
				</p>
			</div>

			<div className={cx('flex gap-4 rounded-lg border bg-panel p-4', v.border)}>
				<span className={cx('flex h-fit shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs font-semibold whitespace-nowrap', v.cls)}>
					<span aria-hidden>{v.icon}</span>
					{v.label}
				</span>
				<div className="min-w-0 space-y-1">
					<p className="font-medium">{a.verdict.title}</p>
					{a.verdict.details.map((d) => (
						<p key={d} className="text-sm text-muted">
							{d}
						</p>
					))}
				</div>
			</div>

			<dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<Stat
					label="Audio hasta"
					value={a.cutoffHz !== null ? khz(a.cutoffHz) : '–'}
					note={a.cutoffHz === null ? null : a.sharpCutoff ? 'se corta de golpe' : 'sin un corte'}
				/>
				<Stat label="Muestreo" value={khz(a.sampleRateHz)} note={`llega hasta ${khz(a.sampleRateHz / 2)}`} />
				<Stat
					label="Bits que usa"
					value={a.usedBits !== null ? String(Math.min(a.usedBits, bitDepth ?? a.usedBits)) : '–'}
					note={a.usedBits === null ? 'con pérdida: no aplica' : bitDepth ? `de ${bitDepth} que dice` : null}
				/>
				<Stat
					label="Formato"
					value={declared ? qualityLabel(declared).split(' ')[0]! : '–'}
					note={declared ? (declared.lossless ? 'sin pérdida' : `con pérdida${declared.bitrateKbps ? `, ${declared.bitrateKbps} kbps` : ''}`) : null}
				/>
			</dl>

			<Spectrogram a={a} />
		</section>
	)
}

function Stat({ label, value, note }: { label: string; value: string; note: string | null }) {
	return (
		<div className="rounded-lg border border-line bg-panel px-4 py-3">
			<dt className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</dt>
			<dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
			{note && <dd className="text-xs text-muted">{note}</dd>}
		</div>
	)
}

function HowToRead() {
	return (
		<details className="rounded-lg border border-line bg-panel/60 px-5 py-3 text-sm text-muted">
			<summary className="cursor-pointer font-medium text-zinc-200">Cómo leerlo</summary>
			<div className="mt-3 max-w-3xl space-y-2">
				<p>
					El espectrograma muestra el tema de izquierda a derecha y sus frecuencias de abajo (graves) a arriba (agudos):
					cuanto más claro, más fuerte. Al costado está el nivel medio de cada frecuencia en todo el tema.
				</p>
				<p>
					Un formato con pérdida tira los agudos que menos se oyen con un filtro: un MP3 de 128 kbps no tiene nada sobre
					unos 16 kHz, uno de 320 sobre unos 20 kHz. Convertirlo después a WAV o FLAC no los devuelve: se ve una línea
					recta donde todo se apaga de golpe. Un sin pérdida de verdad llega hasta casi 22 kHz, y uno de alta resolución
					más arriba todavía.
				</p>
				<p>
					Es una pista, no una prueba: algunos másters se cortan antes a propósito o tienen pocos agudos, y hay formatos
					con pérdida que no cortan (algunos AAC de bitrate alto o un MP3 V0), así que esos no se distinguen mirando el
					espectro. Si dudas, compáralo con otra copia del mismo tema.
				</p>
			</div>
		</details>
	)
}
