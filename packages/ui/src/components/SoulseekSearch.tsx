import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { SlskFile } from '@kemix/core'
import { api } from '../lib/api'
import { bytes, cx, duration, qualityLabel, qualityTone } from '../lib/format'
import { Button, ErrorText, Input } from './ui'
import { DownloadPicker, useDownloadChoice } from './DownloadPicker'

/** Los archivos de una misma carpeta de un mismo usuario (casi siempre, un álbum). */
interface FolderGroup {
	key: string
	username: string
	folder: string
	files: SlskFile[]
	slotFree: boolean
	speed: number
	queueLength: number
}

/** Agrupa por usuario y carpeta, en el orden en que llegan (el mejor archivo primero). */
function groupByFolder(files: SlskFile[]): FolderGroup[] {
	const groups = new Map<string, FolderGroup>()
	for (const f of files) {
		const folder = f.path.replace(/[\\/][^\\/]*$/, '')
		const key = `${f.username}\n${folder}`
		let g = groups.get(key)
		if (!g) {
			g = { key, username: f.username, folder, files: [], slotFree: f.slotFree, speed: f.speed, queueLength: f.queueLength }
			groups.set(key, g)
		}
		g.files.push(f)
	}
	return [...groups.values()]
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path

const LAST_SEARCH = 'kemix:soulseek-search'
const LAST_QUERY = 'kemix:soulseek-query'

function speedLabel(bytesPerSecond: number): string {
	if (!bytesPerSecond) return 'velocidad desconocida'
	if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
	return `${Math.round(bytesPerSecond / 1024)} KB/s`
}

/** La pestaña Soulseek de Buscar: búsqueda libre en la red, con los resultados llegando en vivo. */
export function SoulseekSearch({ onOpenPlaylist }: { onOpenPlaylist: (id: number) => void }) {
	const choice = useDownloadChoice('soulseek')
	// La última búsqueda sigue ahí al volver de otra pantalla (el servidor la guarda un rato).
	const [text, setText] = useState(() => sessionStorage.getItem(LAST_QUERY) ?? '')
	const [searchId, setSearchId] = useState<string | null>(() => sessionStorage.getItem(LAST_SEARCH))
	const [losslessOnly, setLosslessOnly] = useState(false)
	const [freeOnly, setFreeOnly] = useState(false)
	/** Archivos ya puestos en la cola desde esta pantalla. */
	const [queued, setQueued] = useState<Set<string>>(() => new Set())
	const [playlistId, setPlaylistId] = useState<number | null>(null)

	const start = useMutation({
		mutationFn: (query: string) => api.startSoulseekSearch(query),
		onSuccess: (s, query) => {
			setSearchId(s.id)
			sessionStorage.setItem(LAST_SEARCH, s.id)
			sessionStorage.setItem(LAST_QUERY, query)
		}
	})
	const search = useQuery({
		queryKey: ['slsk-search', searchId],
		queryFn: () => api.soulseekSearch(searchId!),
		enabled: !!searchId,
		// Los eventos la refrescan según llegan resultados; esto es por si se pierde alguno.
		refetchInterval: (q) => (q.state.data?.running ? 3000 : false)
	})
	const stop = useMutation({ mutationFn: (id: string) => api.stopSoulseekSearch(id) })
	const download = useMutation({
		mutationFn: (f: SlskFile) =>
			api.soulseekDownload(searchId!, f.username, f.path, { quality: choice.preset.level, format: choice.preset.format }),
		onSuccess: (res, f) => {
			setQueued((q) => new Set(q).add(f.url))
			setPlaylistId(res.playlistId)
		}
	})

	const results = useMemo(() => search.data?.results ?? [], [search.data])
	const shown = useMemo(
		() => results.filter((f) => (!losslessOnly || f.quality?.lossless) && (!freeOnly || f.slotFree)),
		[results, losslessOnly, freeOnly]
	)
	const folders = useMemo(() => groupByFolder(shown), [shown])

	const running = !!search.data?.running
	return (
		<div>
			<div className="space-y-4">
				<p className="text-sm text-muted">
					Busca en la red Soulseek archivos que comparten otros usuarios. Los que bajas van a la playlist «Soulseek» de
					tu biblioteca; el progreso se ve en Descargas.
				</p>
				<form
					className="flex gap-2"
					onSubmit={(e) => {
						e.preventDefault()
						if (text.trim()) start.mutate(text.trim())
					}}
				>
					<Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Artista, tema, álbum…" />
					<Button variant="primary" type="submit" disabled={!text.trim() || start.isPending}>
						{start.isPending ? 'Buscando…' : 'Buscar'}
					</Button>
					{running && searchId && (
						<Button type="button" variant="ghost" onClick={() => stop.mutate(searchId)}>
							Detener
						</Button>
					)}
				</form>
				<div className="flex flex-wrap items-end gap-2">
					<DownloadPicker choice={choice} />
				</div>
				<ErrorText error={start.error ?? search.error ?? download.error} />
				{search.data?.error && <p className="text-sm text-red-300">{search.data.error}</p>}
				{search.data && (
					<div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
						<span>
							{running ? `Buscando… ${results.length} archivos de audio hasta ahora` : `${results.length} archivos de audio`}
							{shown.length !== results.length && ` · ${shown.length} con los filtros`}
						</span>
						<label className="flex items-center gap-1.5">
							<input
								type="checkbox"
								className="accent-[var(--color-accent)]"
								checked={losslessOnly}
								onChange={(e) => setLosslessOnly(e.target.checked)}
							/>
							Solo sin pérdida
						</label>
						<label className="flex items-center gap-1.5">
							<input
								type="checkbox"
								className="accent-[var(--color-accent)]"
								checked={freeOnly}
								onChange={(e) => setFreeOnly(e.target.checked)}
							/>
							Solo quien puede enviarlo ya
						</label>
						{playlistId !== null && (
							<button type="button" className="underline hover:text-zinc-100" onClick={() => onOpenPlaylist(playlistId)}>
								Ver la playlist Soulseek
							</button>
						)}
					</div>
				)}
				{search.data && !running && !results.length && !search.data.error && (
					<p className="text-sm text-muted">
						Nadie respondió con archivos de audio para “{search.data.query}”. Prueba con menos palabras o sin el nombre del
						álbum.
					</p>
				)}
				{folders.map((g) => (
					<section key={g.key} className="rounded-lg border border-line bg-panel">
						<header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/60 px-4 py-2 text-xs">
							<span className="font-medium text-zinc-200">{g.username}</span>
							<span className="min-w-0 flex-1 truncate text-muted" title={g.folder}>
								{g.folder}
							</span>
							<span className={g.slotFree ? 'text-emerald-300' : 'text-amber-300'}>
								{g.slotFree ? 'Puede enviarlo ya' : `${g.queueLength} en su cola`}
							</span>
							<span className="text-muted">{speedLabel(g.speed)}</span>
						</header>
						<ul className="divide-y divide-line/40">
							{g.files.map((f) => {
								const inQueue = queued.has(f.url)
								const pending = download.isPending && download.variables?.url === f.url
								return (
									<li key={f.url} className="flex items-center gap-3 px-4 py-1.5 text-sm">
										<div className="min-w-0 flex-1">
											<p className="truncate" title={f.path}>
												{fileName(f.path)}
											</p>
											<p className="truncate text-xs text-muted">{[f.artists.join(', '), f.title].filter(Boolean).join(' – ')}</p>
										</div>
										<span className={cx('hidden w-36 shrink-0 text-right text-xs sm:inline', qualityTone(f.quality))}>
											{qualityLabel(f.quality)}
										</span>
										<span className="w-12 shrink-0 text-right text-xs text-muted">{duration(f.durationMs)}</span>
										<span className="hidden w-16 shrink-0 text-right text-xs text-muted sm:inline">{bytes(f.size)}</span>
										<Button
											variant={inQueue ? 'ghost' : 'default'}
											className="w-28 shrink-0"
											disabled={inQueue || pending}
											onClick={() => download.mutate(f)}
										>
											{inQueue ? '✓ En la cola' : pending ? 'Agregando…' : 'Descargar'}
										</Button>
									</li>
								)
							})}
						</ul>
					</section>
				))}
			</div>
		</div>
	)
}
