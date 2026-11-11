// Explorar: temas de SoundCloud que se bajan gratis, por género o tag, sin cuenta. La API no filtra por descargables,
// así que se recorren páginas de resultados y se quedan los que tienen descarga gratis.
import type { DownloadQueue } from './download/queue'
import type { ExploreCreated, ExplorePage, ExploreTrack, OutputFormat, QualityLevel } from './types'
import { fetchTracksById, freeDownloadOf, publicGet, toSourceTrack, type RawTrack } from './sources/soundcloud-api'

/** Cuántos temas descargables se juntan por tanda, y cuántas páginas se revisan como mucho para llegar a ellos. */
const TARGET = 24
const MAX_PAGES = 6
const PAGE_SIZE = 50
const API_PREFIX = 'https://api-v2.soundcloud.com/'

type Get = <T>(pathOrUrl: string, query?: Record<string, string | number>) => Promise<T>

export class SoundCloudExplore {
	constructor(
		private queue: DownloadQueue,
		/** La API pública de SoundCloud; los tests pasan una falsa. */
		private get: Get = publicGet,
		private lookup: (ids: string[]) => Promise<RawTrack[]> = fetchTracksById
	) {}

	/**
	 * Temas con descarga gratis de un género o tag (y/o un texto). `cursor`: el `next` de la tanda anterior, para seguir
	 * donde quedó.
	 */
	async explore(opts: {
		genre?: string | null
		query?: string | null
		created?: ExploreCreated | null
		cursor?: string | null
	}): Promise<ExplorePage> {
		const genre = opts.genre?.trim()
		const query = opts.query?.trim()
		if (!genre && !query) throw new Error('Elige un género o escribe qué buscar')
		// El cursor viene de la UI: solo se sigue si es una página de la API de SoundCloud.
		if (opts.cursor && !opts.cursor.startsWith(API_PREFIX)) throw new Error('Cursor de Explorar inválido')
		const first: Record<string, string | number> = { q: query || '*', limit: PAGE_SIZE }
		if (genre) first['filter.genre_or_tag'] = genre
		if (opts.created) first['filter.created_at'] = opts.created

		const tracks: ExploreTrack[] = []
		const seen = new Set<string>()
		let scanned = 0
		let next: string | null = opts.cursor || 'search/tracks'
		let params: Record<string, string | number> = opts.cursor ? {} : first
		for (let page = 0; page < MAX_PAGES && next && tracks.length < TARGET; page++) {
			const res: { collection?: RawTrack[]; next_href?: string | null } = await this.get(next, params)
			params = {}
			const items = res.collection ?? []
			scanned += items.length
			for (const raw of items) {
				const free = freeDownloadOf(raw)
				const track = free && toSourceTrack(raw)
				if (!track || !free || seen.has(track.sourceId)) continue
				seen.add(track.sourceId)
				tracks.push({ ...track, freeDownload: free, genre: raw.genre?.trim() || undefined })
			}
			next = items.length ? (res.next_href ?? null) : null
		}
		return { tracks, next, scanned }
	}

	/**
	 * Baja un tema con la descarga de SoundCloud (el archivo que subió el artista) a la playlist «SoundCloud gratis», en
	 * la calidad y el formato elegidos. Los que solo tienen un enlace del artista no se pueden bajar desde Kemix.
	 */
	async download(id: string, level?: QualityLevel | null, format?: OutputFormat | null): Promise<{ playlistId: number }> {
		const [raw] = await this.lookup([id])
		const free = raw && freeDownloadOf(raw)
		const track = raw && toSourceTrack(raw)
		if (!track || !free) throw new Error('Ese tema ya no se puede bajar gratis desde SoundCloud')
		if (free.kind !== 'soundcloud') {
			throw new Error('Este tema se baja desde el enlace del artista, no desde SoundCloud: ábrelo con «Descarga gratis»')
		}
		return this.queue.enqueueLoose('soundcloud', [{ ...track, source: 'soundcloud' }], 'soundcloud', level, format)
	}
}
