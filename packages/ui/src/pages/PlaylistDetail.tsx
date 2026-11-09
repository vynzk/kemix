import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DownloadService, PlaylistTrackRow, QualityLevel } from '@kemix/core'
import { api } from '../lib/api'
import { useDownloadProviders, useDownloadQualities } from '../lib/hooks'
import {
	QUALITY_LEVEL_OPTIONS,
	SERVICE_LABEL,
	cx,
	duration,
	fitQualityLevel,
	providerQualityOptions,
	qualityLabel,
	qualityTone
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
	/** null = not touched: the quality set in Ajustes. */
	const [level, setLevel] = useState<QualityLevel | null>(null)
	const wanted = level ?? state.data?.settings.downloadQuality ?? 'max'
	/** With a provider picked, only what it (and the account on it) can give; the choice is kept for "Automático". */
	const qualityFor = (s: DownloadService) => fitQualityLevel(s, wanted, accountQualities?.[s])
	const quality = provider ? qualityFor(provider) : wanted
	const qualityOptions: { value: QualityLevel; label: string }[] = provider
		? providerQualityOptions(provider, accountQualities?.[provider]) : QUALITY_LEVEL_OPTIONS
	const download = useMutation({
		mutationFn: (positions?: number[]) => api.downloadPlaylist(id, positions, provider || null, quality),
		onSuccess: () => setSelected(new Set()),
		onSettled: invalidate
	})
	const resync = useMutation({ mutationFn: () => api.resyncPlaylist(id), onSettled: invalidate })
	const remove = useMutation({
		mutationFn: api.removeDownload,
		onSettled: () => {
			invalidate()
			qc.invalidateQueries({ queryKey: ['downloads'] })
		}
	})
	const retryWith = useMutation({
		mutationFn: (v: { positions: number[]; provider: DownloadService }) =>
			api.downloadPlaylist(id, v.positions, v.provider, qualityFor(v.provider)),
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
				<ErrorText error={playlist.error ?? download.error ?? resync.error ?? retryWith.error ?? remove.error} />
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
						<div className="flex flex-wrap gap-2">
							<Button onClick={() => resync.mutate()} disabled={resync.isPending}>
								{resync.isPending ? 'Actualizando…' : 'Volver a leer'}
							</Button>
							<select
								value={provider}
								onChange={(e) => setProvider(e.target.value as DownloadService | '')}
								className="rounded-md border border-line bg-ink px-2 py-1.5 text-sm"
								title="Proveedor desde el que descargar"
							>
								<option value="">Automático (prioridad)</option>
								{providers.map((s) => (
									<option key={s} value={s}>
										{SERVICE_LABEL[s]}
										{s === 'youtube' ? ' (con pérdida)' : ''}
									</option>
								))}
							</select>
							<select
								value={quality}
								onChange={(e) => setLevel(e.target.value as QualityLevel)}
								disabled={qualityOptions.length < 2}
								className="rounded-md border border-line bg-ink px-2 py-1.5 text-sm disabled:opacity-60"
								title={`${provider ? `Calidades que ofrece ${SERVICE_LABEL[provider]}${provider !== 'youtube' && accountQualities?.[provider] ? ' con tu cuenta' : ''}. ` : ''}Si un tema no existe en esa calidad, se baja en la mejor que tenga por debajo. No cambia los temas ya descargados.`}
							>
								{qualityOptions.map((o) => (
									<option key={o.value} value={o.value}>
										{o.label}
									</option>
								))}
							</select>
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
										className={cx('group border-t border-line/60 hover:bg-panel', selected.has(t.position) && 'bg-panel')}
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
											<QualityCell track={t} />
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

/** Downloaded quality and the provider it came from when there's a file; otherwise the best the matched service offers. */
function QualityCell({ track }: { track: PlaylistTrackRow }) {
	const done = track.download?.status === 'done' ? track.download : null
	if (done && (done.quality || done.service)) {
		return (
			<span
				className={cx('text-xs font-medium', qualityTone(done.quality))}
				title={`Descargado${done.service ? ` desde ${SERVICE_LABEL[done.service]}` : ''}${done.quality ? ` en ${qualityLabel(done.quality)}` : ''}`}
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
	if (max) {
		return (
			<span className="text-xs text-muted" title="Máxima calidad disponible para descargar">
				máx. <span className={qualityTone(max)}>{qualityLabel(max)}</span>
			</span>
		)
	}
	return <span className="text-xs text-zinc-600">–</span>
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
				{props.providers.includes('youtube') && (
					<span className="ml-1 text-xs text-amber-300/80">YouTube no es calidad máxima (AAC ~128 kbps, con pérdida).</span>
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
