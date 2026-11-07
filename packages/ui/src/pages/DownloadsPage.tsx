import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { bytes, cx, qualityLabel, qualityTone } from '../lib/format'
import { Button, Empty, ErrorText, PageHeader, StatusPill } from '../components/ui'

export function DownloadsPage() {
	const qc = useQueryClient()
	const downloads = useQuery({ queryKey: ['downloads'], queryFn: api.downloads })
	const refresh = () => {
		qc.invalidateQueries({ queryKey: ['downloads'] })
		qc.invalidateQueries({ queryKey: ['library'] })
	}
	const retry = useMutation({ mutationFn: api.retryFailed, onSettled: refresh })
	const clear = useMutation({ mutationFn: api.clearFinished, onSettled: refresh })
	const rows = downloads.data ?? []
	const errors = rows.filter((r) => r.status === 'error').length
	const active = rows.filter((r) => ['queued', 'matching', 'downloading'].includes(r.status)).length

	return (
		<div>
			<PageHeader
				title="Descargas"
				actions={
					<>
						<Button onClick={() => retry.mutate()} disabled={!errors}>
							Reintentar fallidas{errors ? ` (${errors})` : ''}
						</Button>
						<Button variant="ghost" onClick={() => clear.mutate()}>
							Limpiar terminadas
						</Button>
					</>
				}
			>
				{active ? `${active} en curso o en cola` : 'Nada en curso'}
			</PageHeader>
			<ErrorText error={downloads.error ?? retry.error ?? clear.error} />
			{!downloads.isLoading && rows.length === 0 ? (
				<Empty title="Sin descargas">Abre una playlist en la Biblioteca y pulsa Descargar.</Empty>
			) : (
				<table className="w-full text-sm">
					<tbody>
						{rows.map((r) => {
							const pct = r.totalBytes && r.bytes ? Math.min(100, Math.round((r.bytes / r.totalBytes) * 100)) : null
							return (
								<tr key={r.id} className="border-b border-line/60">
									<td className="max-w-0 py-2.5 pr-4 pl-8">
										<p className="truncate">{r.title}</p>
										<p className="truncate text-xs text-muted">
											{r.artists.join(', ')} · {r.playlistName}
										</p>
										{r.error && <p className="truncate text-xs text-red-300" title={r.error}>{r.error}</p>}
									</td>
									<td className="w-56 py-2.5 pr-4">
										{r.status === 'downloading' && (
											<div className="space-y-1">
												<div className="h-1 overflow-hidden rounded bg-zinc-800">
													<div className="h-full bg-accent transition-all" style={{ width: `${pct ?? 5}%` }} />
												</div>
												<p className="text-[11px] text-muted">
													{bytes(r.bytes)}
													{r.totalBytes ? ` / ${bytes(r.totalBytes)}` : ''}
												</p>
											</div>
										)}
									</td>
									<td className="w-44 py-2.5 pr-4 text-right whitespace-nowrap">
										{r.status === 'done' && r.quality && (
											<span className={cx('text-xs', qualityTone(r.quality))}>
												{qualityLabel(r.quality)}
												{r.service === 'youtube' && <span className="text-zinc-500"> · YouTube</span>}
											</span>
										)}
									</td>
									<td className="w-28 py-2.5 pr-8 text-right">
										<StatusPill status={r.status} />
									</td>
								</tr>
							)
						})}
					</tbody>
				</table>
			)}
		</div>
	)
}
