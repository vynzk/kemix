import { useMemo, useState } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ExploreCreated, ExploreTrack } from '@kemix/core'
import { api } from '../lib/api'
import { cx, duration } from '../lib/format'
import { Button, Cover, ErrorText, FreeDownloadLink, Input, PageHeader } from '../components/ui'
import { PlayButton, usePlayer } from '../components/Player'
import { DownloadPicker, useDownloadChoice } from '../components/DownloadPicker'

const GENRES = [
	'House',
	'Deep House',
	'Tech House',
	'Afro House',
	'Techno',
	'Melodic Techno',
	'Minimal',
	'Trance',
	'Drum & Bass',
	'Dubstep',
	'Bass',
	'Disco',
	'Hip Hop',
	'Trap',
	'R&B',
	'Reggaeton',
	'Dembow',
	'Funk',
	'Pop',
	'Indie',
	'Ambient',
	'Lo-fi'
]

const CREATED_LABEL: Record<ExploreCreated, string> = {
	last_week: 'La última semana',
	last_month: 'El último mes',
	last_year: 'El último año'
}

interface ExploreSearch {
	genre: string
	q: string
	created: ExploreCreated | ''
}

/** Explorar: temas de SoundCloud que se bajan gratis, por género o tag. No necesita cuenta. */
export function ExplorePage({ onOpenPlaylist }: { onOpenPlaylist: (id: number) => void }) {
	const qc = useQueryClient()
	const player = usePlayer()
	const choice = useDownloadChoice('soundcloud')
	const [genre, setGenre] = useState('')
	const [text, setText] = useState('')
	const [created, setCreated] = useState<ExploreCreated | ''>('')
	/** Lo que se está mostrando: se fija al elegir un género o al pulsar Buscar. */
	const [search, setSearch] = useState<ExploreSearch | null>(null)
	/** Temas ya puestos en la cola desde aquí. */
	const [queued, setQueued] = useState<Set<string>>(() => new Set())

	const results = useInfiniteQuery({
		queryKey: ['explore', search],
		queryFn: ({ pageParam }) =>
			api.explore({ genre: search!.genre, q: search!.q, created: search!.created || null, cursor: pageParam }),
		initialPageParam: null as string | null,
		getNextPageParam: (last) => last.next,
		enabled: !!search,
		staleTime: 5 * 60_000
	})
	const download = useMutation({
		mutationFn: (t: ExploreTrack) =>
			api.exploreDownload(t.sourceId, { quality: choice.preset.level, format: choice.preset.format }),
		onSuccess: (_res, t) => setQueued((q) => new Set(q).add(t.sourceId)),
		onSettled: () => qc.invalidateQueries({ queryKey: ['library'] })
	})

	const pages = results.data?.pages ?? []
	const scanned = pages.reduce((n, p) => n + p.scanned, 0)
	const tracks = useMemo(() => {
		const seen = new Set<string>()
		const out: ExploreTrack[] = []
		for (const t of (results.data?.pages ?? []).flatMap((p) => p.tracks)) {
			if (seen.has(t.sourceId)) continue
			seen.add(t.sourceId)
			out.push(t)
		}
		return out
	}, [results.data])

	const run = (next: Partial<ExploreSearch>) => {
		const s = { genre, q: text.trim(), created, ...next }
		if (!s.genre && !s.q) return
		setSearch(s)
	}

	return (
		<div>
			<PageHeader title="Explorar">
				Temas de SoundCloud que se bajan gratis, por género. Escúchalos, abre su descarga o bájalos con Kemix: los que
				SoundCloud deja descargar se bajan en el archivo que subió el artista, a la playlist «SoundCloud gratis». No
				necesita cuenta.
			</PageHeader>
			<div className="space-y-4 p-8">
				<div className="flex flex-wrap gap-2">
					{GENRES.map((g) => (
						<button
							key={g}
							type="button"
							onClick={() => {
								setGenre(g)
								run({ genre: g })
							}}
							className={cx(
								'rounded-full border px-3 py-1 text-sm',
								g === genre ? 'border-accent/60 bg-zinc-800 text-zinc-50' : 'border-line text-muted hover:text-zinc-100'
							)}
						>
							{g}
						</button>
					))}
				</div>
				<form
					className="flex flex-wrap items-end gap-2"
					onSubmit={(e) => {
						e.preventDefault()
						run({})
					}}
				>
					<label className="flex flex-col gap-1">
						<span className="text-[11px] font-medium tracking-wide text-muted uppercase">Género o tag</span>
						<Input value={genre} onChange={(e) => setGenre(e.target.value)} placeholder="p. ej. amapiano" className="w-48" />
					</label>
					<label className="flex min-w-48 flex-1 flex-col gap-1">
						<span className="text-[11px] font-medium tracking-wide text-muted uppercase">Texto (opcional)</span>
						<Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Artista, tema, remix…" />
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-[11px] font-medium tracking-wide text-muted uppercase">Publicados</span>
						<select
							value={created}
							onChange={(e) => setCreated(e.target.value as ExploreCreated | '')}
							className="rounded-md border border-line bg-ink px-2 py-1.5 text-sm"
						>
							<option value="">Cualquier fecha</option>
							{(Object.keys(CREATED_LABEL) as ExploreCreated[]).map((c) => (
								<option key={c} value={c}>
									{CREATED_LABEL[c]}
								</option>
							))}
						</select>
					</label>
					<Button variant="primary" type="submit" disabled={(!genre.trim() && !text.trim()) || results.isFetching}>
						{results.isFetching && !results.isFetchingNextPage ? 'Buscando…' : 'Buscar'}
					</Button>
				</form>
				<div className="flex flex-wrap items-end gap-3 rounded-md border border-line bg-panel/60 px-3 py-2">
					<DownloadPicker choice={choice} />
					<p className="min-w-0 flex-1 text-xs text-muted">
						«Bajar con Kemix» solo está en los temas que SoundCloud deja descargar. Los que tienen un enlace del artista
						(Hypeddit, Dropbox…) se bajan desde «Descarga gratis», en el navegador.
					</p>
				</div>
				{download.data && (
					<p className="text-xs text-emerald-300">
						Agregado a «SoundCloud gratis»; el progreso se ve en Descargas.{' '}
						<button type="button" className="underline" onClick={() => onOpenPlaylist(download.data.playlistId)}>
							Ver la playlist
						</button>
					</p>
				)}
				<ErrorText error={results.error ?? download.error} />
				{search && !results.isFetching && !tracks.length && !results.error && (
					<p className="text-sm text-muted">
						Ningún tema descargable entre los {scanned} revisados. Prueba otro género, quita el texto o «Cargar más».
					</p>
				)}
				{tracks.length > 0 && (
					<ul className="divide-y divide-line/60">
						{tracks.map((t) => {
							const active = player.playing?.key === `soundcloud:${t.sourceId}`
							const own = t.freeDownload.kind === 'soundcloud'
							const inQueue = queued.has(t.sourceId)
							return (
								<li key={t.sourceId} className="group flex items-center gap-3 py-2">
									<div className="relative shrink-0">
										<Cover url={t.coverUrl} size={40} />
										<span className={cx('absolute inset-0 items-center justify-center', active ? 'flex' : 'hidden group-hover:flex')}>
											<PlayButton active={active} onClick={() => player.playSourceTrack('soundcloud', t)} />
										</span>
									</div>
									<div className="min-w-0 flex-1">
										<p className="truncate text-sm">{t.title}</p>
										<p className="truncate text-xs text-muted">
											{t.artists.join(', ')}
											{t.genre && ` · ${t.genre}`}
										</p>
									</div>
									<span className="w-12 shrink-0 text-right text-xs text-muted">{duration(t.durationMs ?? null)}</span>
									<FreeDownloadLink fd={t.freeDownload} />
									<Button
										className="w-36 shrink-0"
										disabled={!own || inQueue || (download.isPending && download.variables?.sourceId === t.sourceId)}
										onClick={() => download.mutate(t)}
										title={
											own
												? 'Bajar el archivo que subió el artista a la playlist «SoundCloud gratis», con la calidad y el formato elegidos arriba'
												: 'Este tema se baja desde el enlace del artista (puede pedir seguirlo o un email): usa «Descarga gratis»'
										}
									>
										{inQueue ? '✓ En la cola' : 'Bajar con Kemix'}
									</Button>
								</li>
							)
						})}
					</ul>
				)}
				{search && (results.hasNextPage || scanned > 0) && (
					<div className="flex items-center gap-3 text-xs text-muted">
						<span>
							{tracks.length} descargables entre {scanned} temas revisados.
						</span>
						{results.hasNextPage && (
							<Button onClick={() => results.fetchNextPage()} disabled={results.isFetchingNextPage}>
								{results.isFetchingNextPage ? 'Buscando…' : 'Cargar más'}
							</Button>
						)}
					</div>
				)}
			</div>
		</div>
	)
}
