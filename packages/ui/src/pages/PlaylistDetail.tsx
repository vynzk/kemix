import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AudioQuality, DownloadService, PlaylistTrackRow, ScanState } from '@kemix/core'
import { api } from '../lib/api'
import { useDownloadProviders, useDownloadQualities } from '../lib/hooks'
import {
	SERVICE_LABEL,
	TARGET_LABEL,
	belowTarget,
	belowTargetShort,
	conversionTarget,
	cx,
	duration,
	expectedQuality,
	findPreset,
	fitPreset,
	groupPresets,
	isLossy,
	outputQuality,
	presetKey,
	presetOptions,
	qualityDetail,
	qualityLabel,
	qualityTier,
	qualityTone,
	type ConversionTarget,
	type DownloadPreset,
	type QualityTier
} from '../lib/format'
import { Button, Cover, ErrorText, MatchLabel, RemoveDownloadButton, ServiceDot, StatusPill } from '../components/ui'
import { PlayButton, usePlayer } from '../components/Player'

export function PlaylistDetailView({ id, onBack }: { id: number; onBack: () => void }) {
	const qc = useQueryClient()
	const player = usePlayer()
	const playlist = useQuery({ queryKey: ['playlist', id], queryFn: () => api.playlist(id) })
	const invalidate = () => {
		qc.invalidateQueries({ queryKey: ['playlist', id] })
		qc.invalidateQueries({ queryKey: ['library'] })
		qc.invalidateQueries({ queryKey: ['review'] })
	}
	const state = useQuery({ queryKey: ['state'], queryFn: api.state })
	const providers = useDownloadProviders()
	const accountQualities = useDownloadQualities().data
	const [selected, setSelected] = useState<Set<number>>(new Set())
	/** '' = automatic, following the priority set in Ajustes. */
	const [provider, setProvider] = useState<DownloadService | ''>('')
	/** null = not touched: the quality and format set in Ajustes. */
	const [presetPick, setPresetPick] = useState<DownloadPreset | null>(null)
	const settings = state.data?.settings
	const wanted = presetPick ?? findPreset(settings?.downloadQuality ?? 'max', settings?.outputFormat ?? 'original')
	/** With a provider picked, only what it (and the account on it) can give; the choice is kept for "Automático". */
	const presetFor = (s: DownloadService) => fitPreset(s, wanted, accountQualities?.[s])
	const preset = provider ? presetFor(provider) : wanted
	const options = presetOptions(provider || undefined, provider ? accountQualities?.[provider] : undefined)
	const target = conversionTarget(preset.level, preset.format)
	const download = useMutation({
		mutationFn: (positions?: number[]) =>
			api.downloadPlaylist(id, { positions, provider: provider || null, quality: preset.level, format: preset.format }),
		onSuccess: () => setSelected(new Set()),
		onSettled: invalidate
	})
	const scanState = useQuery({ queryKey: ['scan', id], queryFn: () => api.scanState(id) })
	const scan = useMutation({
		mutationFn: (positions?: number[]) => api.scanPlaylist(id, positions, provider || null),
		onSuccess: (res) => qc.setQueryData(['scan', id], res)
	})
	const scanRun = scanState.data?.scan?.running ? scanState.data.scan : null
	const scanning = scan.isPending || !!scanRun
	/** What each track would be downloaded in, given the provider and quality picked (null: not looked up yet). */
	const expected = (t: PlaylistTrackRow): AudioQuality | null => {
		const max = t.match?.maxQuality
		const service = t.match?.targetService
		if (!max || !service) return null
		return expectedQuality(max, service, preset.level, accountQualities?.[service])
	}
	/** Not downloaded yet, and what there is to download falls short of the conversion picked. */
	const warned = (t: PlaylistTrackRow) => {
		const q = t.download?.status === 'done' ? null : expected(t)
		return !!q && belowTarget(target, q)
	}
	const resync = useMutation({ mutationFn: () => api.resyncPlaylist(id), onSettled: invalidate })
	const remove = useMutation({
		mutationFn: api.removeDownload,
		onSettled: () => {
			invalidate()
			qc.invalidateQueries({ queryKey: ['downloads'] })
		}
	})
	const retryWith = useMutation({
		mutationFn: (v: { positions: number[]; provider: DownloadService }) => {
			const p = presetFor(v.provider)
			return api.downloadPlaylist(id, { positions: v.positions, provider: v.provider, quality: p.level, format: p.format })
		},
		onSettled: invalidate
	})

	const p = playlist.data
	const d = p?.downloads
	const tracks = p?.tracks ?? []

	const missing = useMemo(() => tracks.filter((t) => t.download?.status !== 'done').map((t) => t.position), [tracks])
	/** Tracks that were tried and didn't download: not found / doubtful match, failed, or skipped. */
	const failed = useMemo(
		() => tracks.filter((t) => ['needs_review', 'error', 'skipped'].includes(t.download?.status ?? '')),
		[tracks]
	)

	const toggle = (position: number) =>
		setSelected((s) => {
			const next = new Set(s)
			if (next.has(position)) next.delete(position)
			else next.add(position)
			return next
		})
	const allSelected = tracks.length > 0 && selected.size === tracks.length

	return (
		<div>
			<div className="px-8 pt-6">
				<button className="text-sm text-muted hover:text-zinc-100" onClick={onBack}>
					← Biblioteca
				</button>
			</div>
			{playlist.isLoading && <p className="px-8 py-10 text-sm text-muted">Cargando temas…</p>}
			<div className="px-8">
				<ErrorText
					error={playlist.error ?? download.error ?? scan.error ?? resync.error ?? retryWith.error ?? remove.error}
				/>
			</div>
			{p && (
				<>
					<header className="flex flex-wrap items-end gap-6 border-b border-line px-8 pt-4 pb-6">
						<Cover url={p.coverUrl} size={132} className="rounded-lg" />
						<div className="min-w-0 flex-1 space-y-2">
							<ServiceDot service={p.source} withLabel />
							<h1 className="text-3xl font-semibold tracking-tight">{p.name}</h1>
							<p className="text-sm text-muted">
								{p.owner && `${p.owner} · `}
								{p.tracks.length} temas
								{d && d.total > 0 && (
									<>
										{' · '}
										<span className="text-zinc-200">{d.done} descargados</span>
										{d.active > 0 && ` · ${d.active} en curso`}
										{d.review > 0 && <span className="text-amber-300"> · {d.review} por revisar</span>}
										{d.error > 0 && <span className="text-red-300"> · {d.error} con error</span>}
									</>
								)}
							</p>
						</div>
						<div className="flex flex-wrap items-end gap-2">
							<Button onClick={() => resync.mutate()} disabled={resync.isPending}>
								{resync.isPending ? 'Actualizando…' : 'Volver a leer'}
							</Button>
							<Control label="Descargar desde">
								<select
									value={provider}
									onChange={(e) => setProvider(e.target.value as DownloadService | '')}
									className="rounded-md border border-line bg-ink px-2 py-1.5 text-sm"
									title="Servicio del que se bajan los temas. Automático: el primero que lo tenga, en el orden de Ajustes."
								>
									<option value="">Automático</option>
									{providers.map((s) => (
										<option key={s} value={s}>
											{SERVICE_LABEL[s]}
											{isLossy(s) ? ' (con pérdida)' : ''}
										</option>
									))}
								</select>
							</Control>
							<Control label="Calidad y formato">
								<select
									value={presetKey(preset)}
									onChange={(e) => setPresetPick(options.find((o) => presetKey(o) === e.target.value) ?? null)}
									className="rounded-md border border-line bg-ink px-2 py-1.5 text-sm"
									title={`${provider ? `Lo que da ${SERVICE_LABEL[provider]}${!isLossy(provider) && accountQualities?.[provider] ? ' con tu cuenta' : ''}. ` : ''}Calidad máxima a bajar y formato del archivo. Si un tema no llega a esa calidad, se baja en la mejor que tenga. AIFF, WAV y MP3 se convierten al terminar de bajar, con tags y carátula. No cambia los temas ya descargados.`}
								>
									{groupPresets(options).map(([group, list]) => (
										<optgroup key={group} label={group}>
											{list.map((o) => (
												<option key={presetKey(o)} value={presetKey(o)}>
													{o.label}
												</option>
											))}
										</optgroup>
									))}
								</select>
							</Control>
							<Button
								onClick={() => scan.mutate(selected.size > 0 ? [...selected] : undefined)}
								disabled={scanning}
								title="Busca los temas en el proveedor elegido y muestra en qué calidad se descargaría cada uno, sin descargar nada. Los temas ya descargados no se vuelven a buscar."
							>
								{scanning
									? `Escaneando…${scanRun ? ` ${scanRun.done}/${scanRun.total}` : ''}`
									: selected.size > 0
										? `Escanear calidad (${selected.size})`
										: 'Escanear calidad'}
							</Button>
							{selected.size > 0 ? (
								<Button variant="primary" onClick={() => download.mutate([...selected])} disabled={download.isPending}>
									{download.isPending ? 'Encolando…' : `Descargar selección (${selected.size})`}
								</Button>
							) : (
								<Button variant="primary" onClick={() => download.mutate(undefined)} disabled={download.isPending}>
									{download.isPending ? 'Encolando…' : d && d.total > 0 ? 'Descargar faltantes' : 'Descargar todo'}
								</Button>
							)}
						</div>
					</header>

					{scanState.data?.scan && (
						<ScanSummary
							scan={scanState.data.scan}
							tracks={tracks}
							expected={expected}
							target={target}
							warned={warned}
							onSelect={(positions) => setSelected(new Set(positions))}
						/>
					)}

					{failed.length > 0 && (
						<RetryWithProvider
							count={failed.length}
							providers={providers}
							pending={retryWith.isPending ? retryWith.variables?.provider : undefined}
							onRetry={(p) => retryWith.mutate({ positions: failed.map((t) => t.position), provider: p })}
						/>
					)}

					<div className="flex items-center gap-3 px-8 pt-3 text-xs text-muted">
						<span>{selected.size > 0 ? `${selected.size} seleccionados` : 'Marca temas para descargar solo esos'}</span>
						<button className="hover:text-zinc-100" onClick={() => setSelected(new Set(missing))} disabled={!missing.length}>
							Seleccionar no descargados
						</button>
						{selected.size > 0 && (
							<button className="hover:text-zinc-100" onClick={() => setSelected(new Set())}>
								Quitar selección
							</button>
						)}
					</div>

					<table className="w-full text-sm">
						<thead>
							<tr className="text-left text-xs tracking-wide text-muted uppercase">
								<th className="w-10 py-3 pl-8">
									<input
										type="checkbox"
										aria-label="Seleccionar todos"
										className="accent-[var(--color-accent)]"
										checked={allSelected}
										onChange={() => setSelected(allSelected ? new Set() : new Set(tracks.map((t) => t.position)))}
									/>
								</th>
								<th className="w-20 py-3 text-center font-medium">#</th>
								<th className="py-3 font-medium">Tema</th>
								{/* Hidden on narrow windows so the fixed-width columns never push the table past the edge. */}
								<th className="hidden py-3 font-medium xl:table-cell">Álbum</th>
								<th className="py-3 font-medium">Fuente</th>
								<th className="py-3 font-medium">Calidad</th>
								<th className="py-3 font-medium">Estado</th>
								<th className="py-3 pr-4 text-right font-medium">Dur.</th>
								<th className="w-32 py-3 pr-8">
									<span className="sr-only">Eliminar descarga</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{tracks.map((t) => {
								const isPlaying = player.playing?.trackId === t.trackId
								return (
									<tr
										key={t.position}
										className={cx(
											'group border-t border-line/60 hover:bg-panel',
											selected.has(t.position) && 'bg-panel',
											warned(t) && 'bg-amber-950/25'
										)}
									>
										<td className="py-2 pl-8">
											<input
												type="checkbox"
												aria-label={`Seleccionar ${t.title}`}
												className="accent-[var(--color-accent)]"
												checked={selected.has(t.position)}
												onChange={() => toggle(t.position)}
											/>
										</td>
										<td className="w-20 py-2 text-center text-muted">
											<div className="flex items-center justify-center gap-1">
												<span className={cx(isPlaying ? 'hidden' : 'group-hover:hidden')}>{t.position + 1}</span>
												<span className={cx(isPlaying ? 'inline' : 'hidden group-hover:inline')}>
													<PlayButton
														active={isPlaying}
														onClick={() => player.playTrack({ trackId: t.trackId, title: t.title, artists: t.artists })}
													/>
												</span>
											</div>
										</td>
										<td className="max-w-0 py-2 pr-4">
											<p className={cx('truncate', isPlaying && 'text-accent')}>{t.title}</p>
											<p className="truncate text-xs text-muted">
												{t.artists.join(', ')}
												{t.album && <span className="xl:hidden"> · {t.album}</span>}
											</p>
										</td>
										<td className="hidden max-w-0 truncate py-2 pr-4 text-muted xl:table-cell">{t.album}</td>
										<td className="py-2 pr-4 whitespace-nowrap">
											{t.match?.targetService ? (
												<span className="text-xs">
													{SERVICE_LABEL[t.match.targetService]}{' '}
													<MatchLabel status={t.match.status} confidence={t.match.confidence} />
												</span>
											) : t.match ? (
												<MatchLabel status={t.match.status} confidence={null} />
											) : (
												<span className="text-xs text-zinc-600">–</span>
											)}
										</td>
										<td className="py-2 pr-4 whitespace-nowrap">
											<QualityCell track={t} expected={expected(t)} format={preset.format} target={target} />
										</td>
										<td className="py-2 pr-4">
											{t.download && (
												<StatusPill status={t.download.status} title={t.download.error ?? t.download.path ?? undefined} />
											)}
										</td>
										<td className="py-2 pr-4 text-right text-muted">{duration(t.durationMs)}</td>
										<td className="w-32 py-2 pr-8 text-right">
											{t.download && (
												<RemoveDownloadButton
													onHover
													status={t.download.status}
													pending={remove.isPending && remove.variables === t.download.id}
													onRemove={() => remove.mutate(t.download!.id)}
												/>
											)}
										</td>
									</tr>
								)
							})}
						</tbody>
					</table>
				</>
			)}
		</div>
	)
}

/**
 * Downloaded quality and the provider it came from when there's a file. Otherwise the best the matched service
 * offers, what the download would come out in when the quality picked or the account caps it, the format it's
 * converted to, and a short warning when what there is falls short of that conversion.
 */
function QualityCell(props: {
	track: PlaylistTrackRow
	expected: AudioQuality | null
	format: DownloadPreset['format']
	target: ConversionTarget | null
}) {
	const { track, expected, format, target } = props
	const done = track.download?.status === 'done' ? track.download : null
	if (done && (done.quality || done.service)) {
		return (
			<span
				className={cx('text-xs font-medium', qualityTone(done.quality))}
				title={`Descargado${done.service ? ` desde ${SERVICE_LABEL[done.service]}` : ''}${done.quality ? ` en ${qualityDetail(done.quality)}` : ''}`}
			>
				{qualityLabel(done.quality)}
				{done.service && (
					<span className="font-normal text-zinc-500">
						{done.quality ? ' · ' : ''}
						{SERVICE_LABEL[done.service]}
					</span>
				)}
			</span>
		)
	}
	const max = track.match?.maxQuality
	if (!max) return <span className="text-xs text-zinc-600">–</span>
	const capped = expected && qualityLabel(expected) !== qualityLabel(max) ? expected : null
	const output = outputQuality(format, expected ?? max)
	const warn = !!expected && !!target && belowTarget(target, expected)
	return (
		<div className="text-xs text-muted">
			{capped ? (
				<span
					title={`El tema está hasta en ${qualityLabel(max)}; con la calidad elegida y tu cuenta se bajaría en ${qualityLabel(capped)}`}
				>
					<span className={qualityTone(capped)}>{qualityLabel(capped)}</span>
					<span className="text-zinc-500"> (máx. {qualityLabel(max)})</span>
				</span>
			) : (
				<span title="Máxima calidad disponible para descargar">
					máx. <span className={qualityTone(max)}>{qualityLabel(max)}</span>
				</span>
			)}
			{format !== 'original' && (
				<span className="text-zinc-500" title={qualityDetail(output)}>
					{' → '}
					<span className={qualityTone(output)}>{TARGET_LABEL[format]}</span>
				</span>
			)}
			{warn && target && (
				<p className="font-medium text-amber-300" title={`Convertirlo a ${TARGET_LABEL[target]} no mejora la calidad de la fuente`}>
					⚠ {belowTargetShort(target)}
				</p>
			)}
		</div>
	)
}

/** A caption over a header control, so it's clear what each selector is for. */
function Control({ label, children }: { label: string; children: ReactNode }) {
	return (
		<label className="flex flex-col gap-1">
			<span className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</span>
			{children}
		</label>
	)
}

type ScanGroup = 'below' | QualityTier | 'pending' | 'notfound' | 'unknown' | 'done'

const SCAN_GROUPS: { key: ScanGroup; label: string; cls: string }[] = [
	{ key: 'below', label: '⚠ Con aviso', cls: 'font-medium text-amber-300' },
	{ key: 'hires', label: 'Hi-Res', cls: 'text-sky-300' },
	{ key: 'cd', label: 'Calidad CD', cls: 'text-emerald-300' },
	{ key: 'lossy', label: 'Con pérdida', cls: 'text-amber-300' },
	{ key: 'pending', label: 'Dudosos (a revisar)', cls: 'text-amber-300' },
	{ key: 'notfound', label: 'No encontrados', cls: 'text-red-300' },
	{ key: 'unknown', label: 'Sin escanear', cls: 'text-muted' },
	{ key: 'done', label: 'Ya descargados', cls: 'text-muted' }
]

function scanGroup(t: PlaylistTrackRow, expected: AudioQuality | null, warned: boolean): ScanGroup {
	if (t.download?.status === 'done') return 'done'
	if (warned) return 'below'
	if (expected) return qualityTier(expected)
	if (t.match?.status === 'pending') return 'pending'
	if (t.match?.status === 'notfound') return 'notfound'
	return 'unknown'
}

/**
 * Scan progress and, per quality, how many tracks would come out in it; each count selects those tracks. Tracks
 * whose audio falls short of the conversion picked get their own group, and can be left out of the selection.
 */
function ScanSummary(props: {
	scan: ScanState
	tracks: PlaylistTrackRow[]
	expected: (t: PlaylistTrackRow) => AudioQuality | null
	target: ConversionTarget | null
	warned: (t: PlaylistTrackRow) => boolean
	onSelect: (positions: number[]) => void
}) {
	const { scan, target } = props
	const groups = new Map<ScanGroup, number[]>()
	for (const t of props.tracks) {
		const g = scanGroup(t, props.expected(t), props.warned(t))
		groups.set(g, [...(groups.get(g) ?? []), t.position])
	}
	const ready = (['hires', 'cd', 'lossy'] as const).flatMap((g) => groups.get(g) ?? [])
	const warnedCount = groups.get('below')?.length ?? 0
	return (
		<div className="mx-8 mt-4 space-y-2 rounded-md border border-line bg-panel px-4 py-2.5 text-sm">
			<p className="text-muted">
				{scan.running
					? `Escaneando calidad… ${scan.done} de ${scan.total} temas`
					: scan.total === 0
						? 'Escaneo de calidad: no había temas nuevos que buscar.'
						: `Escaneo de calidad terminado: ${scan.total} ${scan.total === 1 ? 'tema buscado' : 'temas buscados'}.`}
				{scan.failed > 0 && (
					<span className="text-red-300">
						{' '}
						{scan.failed} no se pudieron buscar{scan.error ? ` (${scan.error})` : ''}.
					</span>
				)}
				{!scan.running && ' En qué calidad se descargarían (clic para seleccionarlos):'}
			</p>
			{scan.running && (
				<div className="h-1 overflow-hidden rounded bg-line">
					<div
						className="h-full bg-[var(--color-accent)] transition-all"
						style={{ width: `${scan.total ? (scan.done / scan.total) * 100 : 100}%` }}
					/>
				</div>
			)}
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
				{SCAN_GROUPS.filter((g) => groups.get(g.key)?.length).map((g) =>
					g.key === 'done' ? (
						<span key={g.key} className={g.cls}>
							{g.label}: {groups.get(g.key)!.length}
						</span>
					) : (
						<button
							key={g.key}
							className={cx(g.cls, 'hover:underline')}
							title={
								g.key === 'below' && target
									? `Lo que hay para bajar es de menor calidad que ${TARGET_LABEL[target]}. Clic para seleccionarlos.`
									: 'Seleccionar estos temas'
							}
							onClick={() => props.onSelect(groups.get(g.key)!)}
						>
							{g.key === 'below' && target ? `⚠ ${belowTargetShort(target)}` : g.label}: {groups.get(g.key)!.length}
						</button>
					)
				)}
				{warnedCount > 0 && ready.length > 0 && (
					<button className="text-zinc-300 underline-offset-2 hover:underline" onClick={() => props.onSelect(ready)}>
						Seleccionar sin los con aviso ({ready.length})
					</button>
				)}
			</div>
		</div>
	)
}

/** Tracks that didn't download can be tried again with any other provider, now or later. */
function RetryWithProvider(props: {
	count: number
	providers: DownloadService[]
	pending?: DownloadService
	onRetry: (provider: DownloadService) => void
}) {
	return (
		<div className="mx-8 mt-4 flex flex-wrap items-center gap-3 rounded-md border border-line bg-panel px-4 py-2.5 text-sm">
			<p className="min-w-0 flex-1 text-muted">
				{props.count === 1 ? '1 tema no se descargó' : `${props.count} temas no se descargaron`} (no encontrados, dudosos,
				con error u omitidos). Puedes intentarlo con otro proveedor:
				{props.providers.some(isLossy) && (
					<span className="ml-1 text-xs text-amber-300/80">
						{props.providers.filter(isLossy).map((s) => SERVICE_LABEL[s]).join(' y ')}{' '}
						{props.providers.filter(isLossy).length > 1 ? 'no son' : 'no es'} calidad máxima (con pérdida).
					</span>
				)}
			</p>
			<div className="flex flex-wrap gap-2">
				{props.providers.map((s) => (
					<Button key={s} onClick={() => props.onRetry(s)} disabled={!!props.pending}>
						{props.pending === s ? 'Encolando…' : `Reintentar con ${SERVICE_LABEL[s]}`}
					</Button>
				))}
			</div>
		</div>
	)
}
