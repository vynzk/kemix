import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SourceService, SourceTrack } from '@kemix/core'
import { api } from '../lib/api'
import { SERVICE_COLOR, SERVICE_LABEL, cx, duration } from '../lib/format'
import { Button, Cover, Empty, ErrorText, FreeDownloadLink, Input, PageHeader } from '../components/ui'
import { PlayButton, usePlayer } from '../components/Player'
import { GetSongBpmCredit, LookedUpFeatures } from '../components/Features'
import { useFeatureLookup, useGetSongBpm, useKeyNotation } from '../lib/hooks'

type Drafts = Partial<Record<SourceService, SourceTrack[]>>

export function SearchPage({ onOpenPlaylist, onGoToAccounts }: { onOpenPlaylist: (id: number) => void; onGoToAccounts: () => void }) {
	const qc = useQueryClient()
	const player = usePlayer()
	const state = useQuery({ queryKey: ['state'], queryFn: api.state })
	// Catalogs to search and create playlists in: Soundeo and Soulseek only download, they have no playlists (Soulseek
	// has its own search page).
	const services = (state.data?.accounts ?? [])
		.filter((a) => a.status === 'connected')
		.map((a) => a.service)
		.filter((s): s is SourceService => s !== 'soundeo' && s !== 'soulseek')

	const [picked, setPicked] = useState<SourceService | null>(null)
	const service = picked && services.includes(picked) ? picked : (services[0] ?? null)
	const [text, setText] = useState('')
	const [query, setQuery] = useState('')
	// Track ids only make sense inside their own service, so each service keeps its own draft.
	const [drafts, setDrafts] = useState<Drafts>({})
	const [name, setName] = useState('')
	const draft = (service && drafts[service]) || []
	// SoundCloud doesn't let other apps create playlists: its tracks go into a playlist on another connected service,
	// looked up there one by one.
	const copying = service === 'soundcloud'
	const targets: SourceService[] = services.filter((s) => s !== 'soundcloud')
	const [copyTo, setCopyTo] = useState<SourceService | null>(null)
	const createIn = copying ? (copyTo && targets.includes(copyTo) ? copyTo : (targets[0] ?? null)) : service

	const results = useQuery({
		queryKey: ['search', service, query],
		queryFn: () => api.search(service!, query),
		enabled: !!service && !!query,
		staleTime: 5 * 60_000
	})

	// Key and BPM of the results, filled in as they're found.
	const lookupItems = useMemo(
		() =>
			service
				? results.data?.map((t) => ({
						service,
						track: { sourceId: t.sourceId, title: t.title, artists: t.artists, durationMs: t.durationMs, isrc: t.isrc }
					}))
				: undefined,
		[service, results.data]
	)
	const lookingUp = useFeatureLookup('search', lookupItems)
	const notation = useKeyNotation()
	const getSongBpm = useGetSongBpm()

	const create = useMutation({
		mutationFn: async () => {
			if (!createIn) throw new Error('Conecta Spotify, YouTube Music, Qobuz o Deezer para guardar ahí estos temas')
			if (copying) return { to: createIn, ...(await api.copyPlaylist(createIn, name, draft)) }
			const res = await api.createPlaylist(createIn, name, draft.map((t) => t.sourceId))
			return { to: createIn, ...res, added: draft.length, missing: [] as SourceTrack[] }
		},
		onSuccess: () => {
			setDrafts((d) => ({ ...d, [service!]: [] }))
			setName('')
			qc.invalidateQueries({ queryKey: ['library'] })
		}
	})

	if (state.data && !services.length) {
		return (
			<div>
				<PageHeader title="Buscar" />
				<Empty title="No hay cuentas conectadas">
					Conecta Spotify, YouTube Music, Qobuz, Deezer o SoundCloud para buscar temas y crear playlists.
					<div className="mt-4">
						<Button onClick={onGoToAccounts}>Ir a Cuentas</Button>
					</div>
				</Empty>
			</div>
		)
	}
	if (!service) return null

	const inDraft = new Set(draft.map((t) => t.sourceId))
	const setDraft = (next: SourceTrack[]) => setDrafts((d) => ({ ...d, [service]: next }))
	const toggle = (t: SourceTrack) =>
		setDraft(inDraft.has(t.sourceId) ? draft.filter((x) => x.sourceId !== t.sourceId) : [...draft, t])
	const move = (i: number, by: number) => {
		const next = [...draft]
		const [t] = next.splice(i, 1)
		next.splice(i + by, 0, t!)
		setDraft(next)
	}

	return (
		<div>
			<PageHeader title="Buscar">Busca temas en un servicio y arma una playlist nueva en tu cuenta de ese servicio.</PageHeader>
			<div className="flex flex-col gap-6 p-8 lg:flex-row lg:items-start">
				<section className="min-w-0 flex-1 space-y-4">
					<div className="flex flex-wrap gap-2">
						{services.map((s) => (
							<button
								key={s}
								type="button"
								onClick={() => {
									setPicked(s)
									create.reset()
								}}
								className={cx(
									'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm',
									s === service ? 'border-accent/60 bg-zinc-800 text-zinc-50' : 'border-line text-muted hover:text-zinc-100'
								)}
							>
								<span className="h-2 w-2 rounded-full" style={{ background: SERVICE_COLOR[s] }} />
								{SERVICE_LABEL[s]}
								{!!drafts[s]?.length && <span className="text-xs text-accent">{drafts[s]!.length}</span>}
							</button>
						))}
					</div>
					<form
						className="flex gap-2"
						onSubmit={(e) => {
							e.preventDefault()
							setQuery(text.trim())
						}}
					>
						<Input
							autoFocus
							value={text}
							onChange={(e) => setText(e.target.value)}
							placeholder={`Buscar en ${SERVICE_LABEL[service]}: tema, artista, álbum…`}
						/>
						<Button variant="primary" type="submit" disabled={!text.trim() || results.isFetching}>
							{results.isFetching ? 'Buscando…' : 'Buscar'}
						</Button>
					</form>
					<ErrorText error={results.error} />
					{query && results.data?.length === 0 && <p className="text-sm text-muted">Sin resultados para “{query}”.</p>}
					{!!results.data?.length && (
						<ul className="divide-y divide-line/60">
							{results.data.map((t) => {
								const added = inDraft.has(t.sourceId)
								const active = player.playing?.key === `${service}:${t.sourceId}`
								return (
									<li key={t.sourceId} className="group flex items-center gap-3 py-2">
										<div className="relative shrink-0">
											<Cover url={t.coverUrl} size={40} />
											<span className={cx('absolute inset-0 items-center justify-center', active ? 'flex' : 'hidden group-hover:flex')}>
												<PlayButton active={active} onClick={() => player.playSourceTrack(service, t)} />
											</span>
										</div>
										<div className="min-w-0 flex-1">
											<p className="truncate text-sm">{t.title}</p>
											<p className="truncate text-xs text-muted">
												{t.artists.join(', ')}
												{t.album && ` · ${t.album}`}
											</p>
											{t.freeDownload && <FreeDownloadLink fd={t.freeDownload} className="mt-0.5" />}
										</div>
										<LookedUpFeatures
											service={service}
											sourceId={t.sourceId}
											notation={notation}
											pending={lookingUp}
											className="hidden w-40 shrink-0 justify-end sm:inline-flex"
										/>
										<span className="w-12 shrink-0 text-right text-xs text-muted">{duration(t.durationMs ?? null)}</span>
										<Button
											variant={added ? 'ghost' : 'default'}
											onClick={() => toggle(t)}
											title={added ? 'Quitar de la playlist' : 'Agregar a la playlist'}
											className="w-24 shrink-0"
										>
											{added ? '✓ Agregado' : '+ Agregar'}
										</Button>
									</li>
								)
							})}
						</ul>
					)}
					{!!results.data?.length && getSongBpm && <GetSongBpmCredit />}
				</section>

				<aside className="w-full shrink-0 space-y-3 rounded-lg border border-line bg-panel p-4 lg:sticky lg:top-4 lg:w-80">
					<h2 className="flex items-center gap-2 font-semibold">
						<span className="h-2 w-2 rounded-full" style={{ background: SERVICE_COLOR[createIn ?? service] }} />
						{copying ? 'Nueva playlist con estos temas' : `Nueva playlist en ${SERVICE_LABEL[service]}`}
					</h2>
					{copying &&
						(targets.length ? (
							<div className="space-y-1.5">
								<label className="flex items-center gap-2 text-sm">
									<span className="shrink-0 text-muted">Crear en</span>
									<select
										value={createIn ?? ''}
										onChange={(e) => {
											setCopyTo(e.target.value as SourceService)
											create.reset()
										}}
										className="w-full rounded-md border border-line bg-ink px-2 py-1.5 text-sm"
									>
										{targets.map((s) => (
											<option key={s} value={s}>
												{SERVICE_LABEL[s]}
											</option>
										))}
									</select>
								</label>
								<p className="text-[11px] text-muted">
									SoundCloud no permite crear playlists desde otras apps. Kemix busca cada tema en{' '}
									{createIn && SERVICE_LABEL[createIn]} y crea la playlist ahí; los que no encuentre se omiten y te los
									muestra.
								</p>
							</div>
						) : (
							<p className="text-xs text-amber-300/90">
								SoundCloud no permite crear playlists desde otras apps. Conecta Spotify, YouTube Music, Qobuz o Deezer y
								Kemix guarda ahí estos temas.
							</p>
						))}
					<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre de la playlist" />
					{draft.length === 0 ? (
						<p className="text-xs text-muted">Agrega temas desde los resultados con “+ Agregar”.</p>
					) : (
						<ol className="max-h-96 space-y-1 overflow-y-auto">
							{draft.map((t, i) => (
								<li key={t.sourceId} className="flex items-center gap-2 text-sm">
									<span className="w-5 shrink-0 text-right text-xs text-muted">{i + 1}</span>
									<div className="min-w-0 flex-1">
										<p className="truncate">{t.title}</p>
										<p className="truncate text-xs text-muted">{t.artists.join(', ')}</p>
									</div>
									<div className="flex shrink-0 text-xs text-muted">
										<button type="button" className="px-1 hover:text-zinc-100 disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} title="Subir">
											↑
										</button>
										<button
											type="button"
											className="px-1 hover:text-zinc-100 disabled:opacity-30"
											disabled={i === draft.length - 1}
											onClick={() => move(i, 1)}
											title="Bajar"
										>
											↓
										</button>
										<button type="button" className="px-1 hover:text-red-300" onClick={() => toggle(t)} title="Quitar">
											✕
										</button>
									</div>
								</li>
							))}
						</ol>
					)}
					<ErrorText error={create.error} />
					<Button
						variant="primary"
						className="w-full"
						disabled={!name.trim() || !draft.length || !createIn || create.isPending}
						onClick={() => create.mutate()}
					>
						{create.isPending
							? copying && createIn
								? `Buscando los temas en ${SERVICE_LABEL[createIn]}…`
								: 'Creando…'
							: `Crear en ${SERVICE_LABEL[createIn ?? service]}${draft.length ? ` (${draft.length})` : ''}`}
					</Button>
					{create.isSuccess && (
						<div className="space-y-2 text-xs text-emerald-300">
							<p>
								Playlist creada en tu cuenta de {SERVICE_LABEL[create.data.to]}
								{create.data.missing.length ? ` con ${create.data.added} temas` : ''}.
							</p>
							{!!create.data.missing.length && (
								<div className="rounded-md bg-amber-950/30 px-2 py-1.5 text-amber-200">
									<p>
										{create.data.missing.length === 1
											? `1 tema no está en ${SERVICE_LABEL[create.data.to]} y se omitió:`
											: `${create.data.missing.length} temas no están en ${SERVICE_LABEL[create.data.to]} y se omitieron:`}
									</p>
									<ul className="mt-1 list-disc space-y-0.5 pl-4">
										{create.data.missing.map((t) => (
											<li key={t.sourceId}>
												{t.title}
												{t.artists.length ? ` · ${t.artists.join(', ')}` : ''}
											</li>
										))}
									</ul>
								</div>
							)}
							{create.data.playlistId !== null ? (
								<Button onClick={() => onOpenPlaylist(create.data.playlistId!)}>Abrir en la Biblioteca</Button>
							) : (
								<p className="text-muted">Aparecerá en la Biblioteca en la próxima sincronización.</p>
							)}
						</div>
					)}
					<p className="text-[11px] text-zinc-500">Se crea como privada.</p>
				</aside>
			</div>
		</div>
	)
}
