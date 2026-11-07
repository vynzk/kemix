import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MatchCandidate, ReviewItem } from '@kemix/core'
import { api } from '../lib/api'
import { SERVICE_LABEL, cx, duration, qualityLabel, qualityTone } from '../lib/format'
import { Button, Cover, Empty, ErrorText, Input, PageHeader, ServiceDot } from '../components/ui'
import { PlayButton, usePlayer } from '../components/Player'

const YOUTUBE_NOTE = 'No es calidad máxima: AAC ~128 kbps, con pérdida.'

export function ReviewPage() {
	const qc = useQueryClient()
	const review = useQuery({ queryKey: ['review'], queryFn: api.review })
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
							<span className="text-[11px] text-amber-300/80">{YOUTUBE_NOTE}</span>
						</div>
					)
				}
			>
				Temas que no encontré con seguridad en Qobuz/Deezer. Elige la versión correcta, busca a mano, bájalos desde
				YouTube u omítelos.
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
						<ReviewRow key={item.trackId} item={item} />
					))}
				</ul>
			)}
		</div>
	)
}

function ReviewRow({ item }: { item: ReviewItem }) {
	const qc = useQueryClient()
	const player = usePlayer()
	const [query, setQuery] = useState('')
	const [results, setResults] = useState<MatchCandidate[] | null>(null)
	const [ytResults, setYtResults] = useState<MatchCandidate[] | null>(null)
	/** YouTube candidate waiting for the user to confirm the lower quality. */
	const [confirming, setConfirming] = useState<string | null>(null)
	const done = () => {
		qc.invalidateQueries({ queryKey: ['review'] })
		qc.invalidateQueries({ queryKey: ['library'] })
	}
	const accept = useMutation({ mutationFn: (c: MatchCandidate) => api.accept(item.trackId, c), onSuccess: done })
	const skip = useMutation({ mutationFn: () => api.skip(item.trackId), onSuccess: done })
	const search = useMutation({
		mutationFn: () => api.searchCandidates(item.trackId, query),
		onSuccess: setResults
	})
	const ytSearch = useMutation({
		mutationFn: () => api.youtubeCandidates(item.trackId, query),
		onSuccess: setYtResults
	})
	const candidates = results ?? item.candidates
	const busy = accept.isPending || skip.isPending

	return (
		<li className="grid grid-cols-[minmax(220px,1fr)_2fr] gap-8 px-8 py-6">
			<div className="space-y-1">
				<ServiceDot service={item.source} withLabel />
				<div className="flex items-center gap-2">
					<PlayButton
						active={player.playing?.trackId === item.trackId}
						onClick={() => player.playTrack({ trackId: item.trackId, title: item.title, artists: item.artists })}
					/>
					<p className="font-medium">{item.title}</p>
				</div>
				<p className="text-sm text-muted">{item.artists.join(', ')}</p>
				<p className="text-xs text-zinc-500">
					{item.album && `${item.album} · `}
					{duration(item.durationMs)}
				</p>
				<p className="pt-1 text-xs text-zinc-600">En: {item.playlists.join(', ')}</p>
				{item.notFound && <p className="pt-1 text-xs text-amber-300/80">No está en Qobuz ni Deezer.</p>}
				<div className="flex gap-2 pt-3">
					<Button variant="ghost" onClick={() => skip.mutate()} disabled={busy}>
						Omitir
					</Button>
				</div>
			</div>
			<div className="space-y-3">
				<form
					className="flex gap-2"
					onSubmit={(e) => {
						e.preventDefault()
						search.mutate()
					}}
				>
					<Input
						placeholder={`Buscar a mano (por defecto: ${item.artists[0] ?? ''} ${item.title})`}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
					<Button type="submit" disabled={search.isPending}>
						{search.isPending ? 'Buscando…' : 'Buscar'}
					</Button>
					<Button
						type="button"
						variant={item.notFound ? 'default' : 'ghost'}
						onClick={() => ytSearch.mutate()}
						disabled={ytSearch.isPending}
						title="Buscar en YouTube (calidad menor)"
					>
						{ytSearch.isPending ? 'Buscando…' : 'YouTube'}
					</Button>
				</form>
				<ErrorText error={search.error ?? accept.error ?? skip.error ?? ytSearch.error} />
				{candidates.length === 0 ? (
					<p className="text-sm text-muted">
						Sin candidatos en Qobuz/Deezer. Prueba con otra búsqueda{item.notFound ? ' o búscalo en YouTube' : ''}.
					</p>
				) : (
					<ul className="space-y-1">
						{candidates.map((c) => (
							<CandidateRow key={`${c.service}:${c.id}`} c={c}>
								<Button variant="primary" onClick={() => accept.mutate(c)} disabled={busy}>
									Usar
								</Button>
							</CandidateRow>
						))}
					</ul>
				)}
				{ytResults && (
					<div className="space-y-1 pt-2">
						<p className="text-xs text-muted">
							YouTube <span className="text-amber-300/80">· {YOUTUBE_NOTE}</span>
						</p>
						{ytResults.length === 0 ? (
							<p className="text-sm text-muted">Nada en YouTube para esa búsqueda.</p>
						) : (
							<ul className="space-y-1">
								{ytResults.slice(0, 5).map((c) => (
									<CandidateRow
										key={c.id}
										c={c}
										onPlay={() => player.playVideo({ videoId: c.id, title: c.title, artists: c.artists })}
									>
										{confirming === c.id ? (
											<>
												<Button variant="primary" onClick={() => accept.mutate(c)} disabled={busy}>
													Bajar igualmente
												</Button>
												<Button variant="ghost" onClick={() => setConfirming(null)}>
													Cancelar
												</Button>
											</>
										) : (
											<Button onClick={() => setConfirming(c.id)} disabled={busy}>
												Usar
											</Button>
										)}
									</CandidateRow>
								))}
							</ul>
						)}
					</div>
				)}
			</div>
		</li>
	)
}

function CandidateRow({ c, onPlay, children }: { c: MatchCandidate; onPlay?: () => void; children: ReactNode }) {
	return (
		<li className="flex items-center gap-3 rounded-md border border-line px-3 py-2 hover:bg-panel">
			{onPlay ? (
				<div className="relative shrink-0">
					<Cover url={c.coverUrl} size={36} />
					<span className="absolute inset-0 flex items-center justify-center">
						<PlayButton onClick={onPlay} />
					</span>
				</div>
			) : (
				<Cover url={c.coverUrl} size={36} />
			)}
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm">{c.title}</p>
				<p className="truncate text-xs text-muted">
					{c.artists.join(', ')}
					{c.album && ` · ${c.album}`}
				</p>
			</div>
			<span className="text-xs text-muted">{duration(c.durationMs)}</span>
			<span className={cx('w-28 text-right text-xs', qualityTone(c.maxQuality))} title="Máxima calidad disponible">
				{qualityLabel(c.maxQuality)}
			</span>
			<span className="w-16 text-xs text-muted">{SERVICE_LABEL[c.service]}</span>
			<span
				className={cx(
					'w-10 text-right text-xs font-medium',
					c.score >= 0.85 ? 'text-emerald-300' : c.score >= 0.6 ? 'text-amber-300' : 'text-red-300'
				)}
			>
				{Math.round(c.score * 100)}%
			</span>
			{children}
		</li>
	)
}
