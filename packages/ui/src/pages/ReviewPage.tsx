import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MatchCandidate, ReviewItem } from '@kemix/core'
import { api } from '../lib/api'
import { SERVICE_LABEL, cx, duration } from '../lib/format'
import { Button, Cover, Empty, ErrorText, Input, PageHeader, ServiceDot } from '../components/ui'

export function ReviewPage() {
	const review = useQuery({ queryKey: ['review'], queryFn: api.review })
	const items = review.data ?? []
	return (
		<div>
			<PageHeader title="Revisión">
				Temas que no encontré con seguridad en Qobuz/Deezer. Elige la versión correcta, busca a mano u omítelos.
			</PageHeader>
			<ErrorText error={review.error} />
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
	const [query, setQuery] = useState('')
	const [results, setResults] = useState<MatchCandidate[] | null>(null)
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
	const candidates = results ?? item.candidates
	const busy = accept.isPending || skip.isPending

	return (
		<li className="grid grid-cols-[minmax(220px,1fr)_2fr] gap-8 px-8 py-6">
			<div className="space-y-1">
				<ServiceDot service={item.source} withLabel />
				<p className="font-medium">{item.title}</p>
				<p className="text-sm text-muted">{item.artists.join(', ')}</p>
				<p className="text-xs text-zinc-500">
					{item.album && `${item.album} · `}
					{duration(item.durationMs)}
				</p>
				<p className="pt-1 text-xs text-zinc-600">En: {item.playlists.join(', ')}</p>
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
				</form>
				<ErrorText error={search.error ?? accept.error ?? skip.error} />
				{candidates.length === 0 ? (
					<p className="text-sm text-muted">Sin candidatos. Prueba con otra búsqueda.</p>
				) : (
					<ul className="space-y-1">
						{candidates.map((c) => (
							<li
								key={`${c.service}:${c.id}`}
								className="flex items-center gap-3 rounded-md border border-line px-3 py-2 hover:bg-panel"
							>
								<Cover url={c.coverUrl} size={36} />
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm">{c.title}</p>
									<p className="truncate text-xs text-muted">
										{c.artists.join(', ')}
										{c.album && ` · ${c.album}`}
									</p>
								</div>
								<span className="text-xs text-muted">{duration(c.durationMs)}</span>
								<span className="w-16 text-xs text-muted">{SERVICE_LABEL[c.service]}</span>
								<span
									className={cx(
										'w-10 text-right text-xs font-medium',
										c.score >= 0.85 ? 'text-emerald-300' : c.score >= 0.6 ? 'text-amber-300' : 'text-red-300'
									)}
								>
									{Math.round(c.score * 100)}%
								</span>
								<Button variant="primary" onClick={() => accept.mutate(c)} disabled={busy}>
									Usar
								</Button>
							</li>
						))}
					</ul>
				)}
			</div>
		</li>
	)
}
