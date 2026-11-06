import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { SERVICE_LABEL, duration } from '../lib/format'
import { Button, Cover, ErrorText, MatchLabel, ServiceDot, StatusPill } from '../components/ui'

export function PlaylistDetailView({ id, onBack }: { id: number; onBack: () => void }) {
	const qc = useQueryClient()
	const playlist = useQuery({ queryKey: ['playlist', id], queryFn: () => api.playlist(id) })
	const invalidate = () => {
		qc.invalidateQueries({ queryKey: ['playlist', id] })
		qc.invalidateQueries({ queryKey: ['library'] })
	}
	const download = useMutation({ mutationFn: () => api.downloadPlaylist(id), onSettled: invalidate })
	const resync = useMutation({ mutationFn: () => api.resyncPlaylist(id), onSettled: invalidate })

	const p = playlist.data
	const d = p?.downloads

	return (
		<div>
			<div className="px-8 pt-6">
				<button className="text-sm text-muted hover:text-zinc-100" onClick={onBack}>
					← Biblioteca
				</button>
			</div>
			{playlist.isLoading && <p className="px-8 py-10 text-sm text-muted">Cargando temas…</p>}
			<div className="px-8">
				<ErrorText error={playlist.error ?? download.error ?? resync.error} />
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
						<div className="flex gap-2">
							<Button onClick={() => resync.mutate()} disabled={resync.isPending}>
								{resync.isPending ? 'Actualizando…' : 'Volver a leer'}
							</Button>
							<Button variant="primary" onClick={() => download.mutate()} disabled={download.isPending}>
								{download.isPending ? 'Encolando…' : d && d.total > 0 ? 'Descargar faltantes' : 'Descargar'}
							</Button>
						</div>
					</header>
					<table className="w-full text-sm">
						<thead>
							<tr className="text-left text-xs tracking-wide text-muted uppercase">
								<th className="w-12 py-3 pl-8 font-medium">#</th>
								<th className="py-3 font-medium">Tema</th>
								<th className="py-3 font-medium">Álbum</th>
								<th className="py-3 font-medium">Fuente</th>
								<th className="py-3 font-medium">Estado</th>
								<th className="py-3 pr-8 text-right font-medium">Dur.</th>
							</tr>
						</thead>
						<tbody>
							{p.tracks.map((t) => (
								<tr key={t.position} className="border-t border-line/60 hover:bg-panel">
									<td className="py-2 pl-8 text-muted">{t.position + 1}</td>
									<td className="max-w-0 py-2 pr-4">
										<p className="truncate">{t.title}</p>
										<p className="truncate text-xs text-muted">{t.artists.join(', ')}</p>
									</td>
									<td className="max-w-0 truncate py-2 pr-4 text-muted">{t.album}</td>
									<td className="py-2 pr-4 whitespace-nowrap">
										{t.match?.targetService ? (
											<span className="text-xs">
												{SERVICE_LABEL[t.match.targetService]} <MatchLabel status={t.match.status} confidence={t.match.confidence} />
											</span>
										) : t.match ? (
											<MatchLabel status={t.match.status} confidence={null} />
										) : (
											<span className="text-xs text-zinc-600">–</span>
										)}
									</td>
									<td className="py-2 pr-4">
										{t.download && <StatusPill status={t.download.status} title={t.download.error ?? t.download.path ?? undefined} />}
									</td>
									<td className="py-2 pr-8 text-right text-muted">{duration(t.durationMs)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</>
			)}
		</div>
	)
}
