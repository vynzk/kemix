import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DownloadService, MatchCandidate, ReviewItem } from '@kemix/core'
import { api } from '../lib/api'
import { useDownloadProviders, useFeatureLookup, useGetSongBpm, useKeyNotation } from '../lib/hooks'
import { LOSSY_NOTE, SERVICE_LABEL, cx, duration, isLossy, qualityLabel, qualityTone } from '../lib/format'
import { Button, Cover, Empty, ErrorText, Input, PageHeader, Select, ServiceDot } from '../components/ui'
import { PlayButton, candidateKey, usePlayer } from '../components/Player'
import { FeaturesInline, GetSongBpmCredit, LookedUpFeatures } from '../components/Features'

export function ReviewPage() {
	const qc = useQueryClient()
	const review = useQuery({ queryKey: ['review'], queryFn: api.review })
	const providers = useDownloadProviders()
	const getSongBpm = useGetSongBpm()
	const items = review.data ?? []
	const notFound = items.filter((i) => i.notFound)
	const bulk = useMutation({
		mutationFn: () => api.downloadFromYouTube(notFound.map((i) => i.trackId)),
		onSettled: () => {
			qc.invalidateQueries({ queryKey: ['review'] })
			qc.invalidateQueries({ queryKey: ['library'] })
		}
	})
	return (
		<div>
			<PageHeader
				title="Revisión"
				actions={
					notFound.length > 0 && (
						<div className="flex flex-col items-end gap-1">
							<Button onClick={() => bulk.mutate()} disabled={bulk.isPending}>
								{bulk.isPending ? 'Buscando en YouTube…' : `Bajar no encontrados desde YouTube (${notFound.length})`}
							</Button>
							<span className="text-[11px] text-amber-300/80">{LOSSY_NOTE.youtube}</span>
						</div>
					)
				}
			>
				Temas que no encontré con seguridad. Escucha las opciones (▶), elige la versión correcta, busca a mano en el
				proveedor que quieras y decide desde dónde bajarla, u omítelos. El BPM de una opción sale en amarillo si no
				coincide con el del tema original: puede ser otra versión.
				{getSongBpm && <GetSongBpmCredit className="ml-1" />}
				{bulk.data && (
					<span className="ml-1 text-zinc-300">
						{bulk.data.queued} en cola desde YouTube
						{bulk.data.notFound > 0 && ` · ${bulk.data.notFound} sin un video fiable`}.
					</span>
				)}
			</PageHeader>
			<ErrorText error={review.error ?? bulk.error} />
			{!review.isLoading && items.length === 0 ? (
				<Empty title="Todo en orden">No hay coincidencias dudosas pendientes.</Empty>
			) : (
				<ul className="divide-y divide-line">
					{items.map((item) => (
						<ReviewRow key={item.trackId} item={item} providers={providers} />
					))}
				</ul>
			)}
		</div>
	)
}

function providerOption(s: DownloadService, prefix = '') {
	return (
		<option key={s} value={s}>
			{prefix}
			{SERVICE_LABEL[s]}
			{isLossy(s) ? ' (con pérdida)' : ''}
		</option>
	)
}

function ReviewRow({ item, providers }: { item: ReviewItem; providers: DownloadService[] }) {
	const qc = useQueryClient()
	const player = usePlayer()
	const [query, setQuery] = useState('')
	/** '' = every connected service, in the priority set in Ajustes. */
	const [searchIn, setSearchIn] = useState<DownloadService | ''>('')
	/** '' = each candidate from its own service. */
	const [downloadFrom, setDownloadFrom] = useState<DownloadService | ''>('')
	const [results, setResults] = useState<{ from: DownloadService | ''; list: MatchCandidate[] } | null>(null)
	/** Candidate waiting for the user to confirm a lossy (YouTube/SoundCloud) download. */
	const [confirming, setConfirming] = useState<string | null>(null)
	// A provider disconnected since it was picked falls back to automatic.
	const searchFrom = searchIn && providers.includes(searchIn) ? searchIn : ''
	const from = downloadFrom && providers.includes(downloadFrom) ? downloadFrom : ''

	const done = () => {
		qc.invalidateQueries({ queryKey: ['review'] })
		qc.invalidateQueries({ queryKey: ['library'] })
	}
	const accept = useMutation({ mutationFn: (c: MatchCandidate) => api.accept(item.trackId, c, from || null), onSuccess: done })
	const skip = useMutation({ mutationFn: () => api.skip(item.trackId), onSuccess: done })
	const search = useMutation({
		mutationFn: () => api.searchCandidates(item.trackId, query, searchFrom || null),
		onSuccess: (list) => {
			setResults({ from: searchFrom, list })
			setConfirming(null)
		}
	})
	const candidates = results?.list ?? item.candidates
	const busy = accept.isPending || skip.isPending
	const notation = useKeyNotation()
	// Key and BPM of the options, to compare with the track's: a different tempo is likely another version.
	const lookupItems = useMemo(
		() =>
			candidates.map((c) => ({
				service: c.service,
				track: { sourceId: c.id, title: c.title, artists: c.artists, durationMs: c.durationMs, isrc: c.isrc }
			})),
		[candidates]
	)
	const lookingUp = useFeatureLookup(`review:${item.trackId}`, lookupItems)
	/** Where a candidate would actually be downloaded from. */
	const downloadService = (c: MatchCandidate) => from || c.service
	/** Lossy services the shown options would download from, to warn about their quality. */
	const lossyShown = [...new Set(candidates.map(downloadService))].filter(isLossy)

	return (
		// minmax(0, …) and min-w-0 on both columns: long titles truncate instead of widening the page.
		<li className="grid grid-cols-1 gap-x-8 gap-y-4 px-8 py-6 md:grid-cols-[minmax(200px,1fr)_minmax(0,2fr)]">
			<div className="min-w-0 space-y-1">
				<ServiceDot service={item.source} withLabel />
				<div className="flex items-start gap-2">
					<PlayButton
						active={player.playing?.trackId === item.trackId}
						onClick={() => player.playTrack({ trackId: item.trackId, title: item.title, artists: item.artists })}
					/>
					<p className="min-w-0 font-medium break-words">{item.title}</p>
				</div>
				<p className="text-sm break-words text-muted">{item.artists.join(', ')}</p>
				<p className="text-xs break-words text-zinc-500">
					{item.album && `${item.album} · `}
					{duration(item.durationMs)}
				</p>
				<FeaturesInline features={item.features} notation={notation} pending={false} />
				<p className="pt-1 text-xs break-words text-zinc-600">En: {item.playlists.join(', ')}</p>
				{item.notFound && (
					<p className="pt-1 text-xs text-amber-300/80">No se encontró una coincidencia fiable en Qobuz/Deezer.</p>
				)}
				<div className="space-y-1 pt-3">
					<label className="block text-xs text-muted" htmlFor={`from-${item.trackId}`}>
						Bajar desde
					</label>
					<div className="flex flex-wrap items-center gap-2">
						<Select
							id={`from-${item.trackId}`}
							value={from}
							onChange={(e) => {
								setDownloadFrom(e.target.value as DownloadService | '')
								setConfirming(null)
							}}
						>
							<option value="">El servicio de cada opción</option>
							{providers.map((s) => providerOption(s))}
						</Select>
						<Button variant="ghost" onClick={() => skip.mutate()} disabled={busy}>
							Omitir
						</Button>
					</div>
					{from && (
						<p className="text-[11px] text-zinc-500">
							Si eliges una opción de otro servicio, busco ese mismo tema en {SERVICE_LABEL[from]} y lo bajo desde ahí.
						</p>
					)}
				</div>
			</div>

			<div className="min-w-0 space-y-3">
				<form
					className="flex flex-wrap gap-2"
					onSubmit={(e) => {
						e.preventDefault()
						search.mutate()
					}}
				>
					<div className="min-w-48 flex-1">
						<Input
							placeholder={`Buscar a mano (por defecto: ${item.artists[0] ?? ''} ${item.title})`}
							value={query}
							onChange={(e) => setQuery(e.target.value)}
						/>
					</div>
					<Select
						value={searchFrom}
						onChange={(e) => setSearchIn(e.target.value as DownloadService | '')}
						title="Dónde buscar"
					>
						<option value="">En todos (prioridad)</option>
						{providers.map((s) => providerOption(s, 'En '))}
					</Select>
					<Button type="submit" disabled={search.isPending}>
						{search.isPending ? 'Buscando…' : 'Buscar'}
					</Button>
				</form>
				<ErrorText error={search.error ?? accept.error ?? skip.error} />
				{(results || lossyShown.length > 0) && (
					<p className="text-xs text-muted">
						{results && (results.from ? `Resultados en ${SERVICE_LABEL[results.from]}` : 'Resultados')}
						{lossyShown.map((s, i) => (
							<span key={s} className="text-amber-300/80">
								{(results || i > 0) && ' · '}
								{SERVICE_LABEL[s]}: {LOSSY_NOTE[s]}
							</span>
						))}
					</p>
				)}
				{candidates.length === 0 ? (
					<p className="text-sm text-muted">
						{results?.from ? `Nada en ${SERVICE_LABEL[results.from]} para esa búsqueda.` : 'Sin opciones.'} Prueba con
						otra búsqueda u otro proveedor.
					</p>
				) : (
					<ul className="space-y-1">
						{candidates.map((c) => {
							const key = candidateKey(c)
							const service = downloadService(c)
							return (
								<CandidateRow
									key={key}
									c={c}
									active={player.playing?.key === key}
									onPlay={() => player.playCandidate(c)}
									features={
										<LookedUpFeatures
											service={c.service}
											sourceId={c.id}
											notation={notation}
											pending={lookingUp}
											compareBpm={item.features?.bpm}
										/>
									}
								>
									{confirming === key ? (
										<>
											<Button variant="primary" onClick={() => accept.mutate(c)} disabled={busy}>
												Bajar igualmente
											</Button>
											<Button variant="ghost" onClick={() => setConfirming(null)}>
												Cancelar
											</Button>
										</>
									) : (
										<Button
											variant={isLossy(service) ? 'default' : 'primary'}
											onClick={() => (isLossy(service) ? setConfirming(key) : accept.mutate(c))}
											disabled={busy}
											title={
												service === c.service
													? `Bajar esta versión desde ${SERVICE_LABEL[service]}`
													: `Buscar esta misma versión en ${SERVICE_LABEL[service]} y bajarla desde ahí`
											}
										>
											{accept.isPending && accept.variables === c ? 'Encolando…' : 'Usar'}
										</Button>
									)}
								</CandidateRow>
							)
						})}
					</ul>
				)}
			</div>
		</li>
	)
}

/** One option for a review item. Everything but the title wraps or truncates, so long titles never widen the page. */
function CandidateRow({
	c,
	active,
	onPlay,
	features,
	children
}: {
	c: MatchCandidate
	active: boolean
	onPlay: () => void
	/** BPM and key of this option. */
	features: ReactNode
	children: ReactNode
}) {
	return (
		<li
			className={cx(
				'flex items-center gap-3 rounded-md border px-3 py-2 hover:bg-panel',
				active ? 'border-accent/40 bg-panel' : 'border-line'
			)}
		>
			<div className="relative shrink-0">
				<Cover url={c.coverUrl} size={40} />
				<span className="absolute inset-0 flex items-center justify-center">
					<PlayButton active={active} onClick={onPlay} />
				</span>
			</div>
			<div className="min-w-0 flex-1">
				<p className={cx('truncate text-sm', active && 'text-accent')} title={c.title}>
					{c.title}
				</p>
				<p className="truncate text-xs text-muted">
					{c.artists.join(', ')}
					{c.album && ` · ${c.album}`}
				</p>
				<p className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted">
					<span>{SERVICE_LABEL[c.service]}</span>
					<span>· {duration(c.durationMs)}</span>
					{c.maxQuality && (
						<span className={qualityTone(c.maxQuality)} title="Máxima calidad disponible">
							· {qualityLabel(c.maxQuality)}
						</span>
					)}
				</p>
				<div className="mt-1">{features}</div>
			</div>
			<span
				title="Parecido con el tema original"
				className={cx(
					'w-10 shrink-0 text-right text-xs font-medium',
					c.score >= 0.85 ? 'text-emerald-300' : c.score >= 0.6 ? 'text-amber-300' : 'text-red-300'
				)}
			>
				{Math.round(c.score * 100)}%
			</span>
			<div className="flex shrink-0 flex-col items-stretch gap-1">{children}</div>
		</li>
	)
}
