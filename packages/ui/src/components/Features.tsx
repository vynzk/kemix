import type { KeyNotation, TrackFeatures } from '@kemix/core'
import { FEATURE_SOURCE_LABEL, bpmLabel, camelotColor, cx, isAnalyzed, keyLabel, keyName, sameTempo } from '../lib/format'
import { useTrackFeatures } from '../lib/hooks'

/** Why a track has no BPM or key, for the tooltip. */
function missingReason(f: TrackFeatures | null | undefined, pending: boolean): string {
	if (!f) return pending ? 'Buscando…' : 'Sin buscar todavía'
	if (f.status === 'error') return `No se pudo buscar: ${f.error ?? 'error desconocido'}`
	return 'No está en ninguna fuente y no hubo audio que analizar'
}

/** Where a value came from, for tooltips. */
const sourceNote = (source: TrackFeatures['bpmSource']) => (source ? ` · de ${FEATURE_SOURCE_LABEL[source]}` : '')

function Missing({ features, pending }: { features: TrackFeatures | null | undefined; pending: boolean }) {
	return (
		<span className="text-xs text-zinc-600" title={missingReason(features, pending)}>
			{!features && pending ? '…' : '–'}
		</span>
	)
}

/**
 * BPM; what Kemix measured from a 30-second preview is marked as approximate (≈). With `compareTo` (the BPM of the
 * track being matched), a tempo that doesn't match it, not even doubled or halved, is flagged: likely another version.
 */
export function Bpm(props: {
	features: TrackFeatures | null | undefined
	pending: boolean
	suffix?: string
	compareTo?: number | null
}) {
	const { features: f, pending, suffix = '', compareTo } = props
	if (!f?.bpm) return <Missing features={f} pending={pending} />
	const rough = f.bpmSource === 'preview'
	const off = !!compareTo && !sameTempo(f.bpm, compareTo)
	return (
		<span
			className={cx('text-xs tabular-nums', off ? 'text-amber-300' : rough ? 'text-muted' : 'text-zinc-200')}
			title={`${bpmLabel(f.bpm)} BPM${sourceNote(f.bpmSource)}${isAnalyzed(f.bpmSource) ? '. Puede salir al doble o a la mitad del real.' : ''}${off ? `. Distinto del tema original (${bpmLabel(compareTo)} BPM): puede ser otra versión.` : ''}`}
		>
			{rough && '≈'}
			{bpmLabel(f.bpm)}
			{suffix}
		</span>
	)
}

/** The key in the chosen notation, coloured by its place on the Camelot wheel, with the musical name beside it. */
export function Key(props: { features: TrackFeatures | null | undefined; notation: KeyNotation; pending: boolean }) {
	const { features: f, notation, pending } = props
	if (!f?.key) return <Missing features={f} pending={pending} />
	const { main, aside } = keyLabel(f.key, notation)
	const rough = f.keySource === 'preview'
	return (
		<span
			className={cx('inline-flex items-center gap-1.5 text-xs', rough && 'opacity-60')}
			title={`${keyName(f.key)}${notation !== 'musical' ? ` (${main})` : ''}${sourceNote(f.keySource)}`}
		>
			<span
				className="min-w-[2.25rem] rounded px-1.5 py-0.5 text-center font-semibold text-white tabular-nums"
				style={{ backgroundColor: camelotColor(f.key) }}
			>
				{rough && '≈'}
				{main}
			</span>
			{aside && <span className="text-muted">{aside}</span>}
		</span>
	)
}

/** BPM and key side by side, for lists (search results, review options). */
export function FeaturesInline(props: {
	features: TrackFeatures | null | undefined
	notation: KeyNotation
	pending: boolean
	compareBpm?: number | null
	className?: string
}) {
	const { features, notation, pending } = props
	if (!features?.bpm && !features?.key) {
		return (
			<span className={props.className}>
				<Missing features={features} pending={pending} />
			</span>
		)
	}
	return (
		<span className={cx('inline-flex items-center gap-2', props.className)}>
			<Bpm features={features} pending={pending} suffix=" BPM" compareTo={props.compareBpm} />
			<Key features={features} notation={notation} pending={pending} />
		</span>
	)
}

/** `FeaturesInline` for a track outside the library, as `useFeatureLookup` finds it. */
export function LookedUpFeatures(props: {
	service: string
	sourceId: string
	notation: KeyNotation
	pending: boolean
	compareBpm?: number | null
	className?: string
}) {
	const features = useTrackFeatures(props.service, props.sourceId)
	return (
		<FeaturesInline
			features={features}
			notation={props.notation}
			pending={props.pending}
			compareBpm={props.compareBpm}
			className={props.className}
		/>
	)
}

/** GetSongBPM's terms ask for a visible link wherever its data may show. */
export function GetSongBpmCredit({ className }: { className?: string }) {
	return (
		<a className={cx('text-[11px] text-zinc-500 hover:text-zinc-100', className)} href="https://getsongbpm.com" target="_blank" rel="noreferrer">
			Clave y BPM de GetSongBPM.com
		</a>
	)
}
