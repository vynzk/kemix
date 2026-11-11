// Búsquedas libres en Soulseek (la pantalla «Soulseek»): los resultados llegan durante unos segundos, de cada usuario
// por separado, y se guardan un rato en memoria. Desde ahí se baja un archivo suelto a la playlist local "Soulseek".
import { randomUUID } from 'node:crypto'
import type { Accounts } from './accounts'
import type { EventBus } from './events'
import type { Library } from './library'
import type { DownloadQueue } from './download/queue'
import type { SettingsStore } from './settings'
import type { SlskFile, SlskSearch } from './types'
import { prefersLossless, rankFiles, slskQuery, toSlskFiles } from './sources/soulseek'
import { errorMessage } from './util'

/** Más largas que las del matching automático: aquí alguien mira los resultados según llegan. */
const SEARCH_WINDOW_MS = 15_000
const MAX_FILES = 2000
const KEEP_MS = 15 * 60_000
const MAX_SEARCHES = 5
/** Cada cuánto se avisa a la UI de que llegaron resultados. */
const EMIT_EVERY_MS = 700

interface Search {
	state: SlskSearch
	abort: AbortController
	startedAt: number
}

export class SoulseekSearches {
	#searches = new Map<string, Search>()

	constructor(
		private accounts: Accounts,
		private library: Library,
		private queue: DownloadQueue,
		private settings: SettingsStore,
		private events: EventBus
	) {}

	/** Empieza una búsqueda. Los resultados se leen con `get` a medida que llegan eventos `slsk-search`. */
	start(query: string): SlskSearch {
		if (!this.accounts.isConnected('soulseek')) throw new Error('Conecta Soulseek en Cuentas para buscar ahí')
		const q = slskQuery(query)
		if (!q) throw new Error('Escribe qué buscar')
		this.#prune()
		const id = randomUUID()
		const search: Search = {
			state: { id, query: q, running: true, results: [], error: null },
			abort: new AbortController(),
			startedAt: Date.now()
		}
		this.#searches.set(id, search)
		void this.#run(search)
		return { ...search.state }
	}

	async #run({ state, abort }: Search) {
		let pending: SlskFile[] = []
		let timer: NodeJS.Timeout | undefined
		const flush = () => {
			clearTimeout(timer)
			timer = undefined
			if (!pending.length) return
			state.results = rankFiles([...state.results, ...pending], prefersLossless(this.settings.get().downloadQuality))
			pending = []
			this.events.emit({ type: 'slsk-search', id: state.id })
		}
		try {
			const downloader = await this.accounts.soulseekDownloader()
			await this.accounts.soulseek().search(state.query, {
				windowMs: SEARCH_WINDOW_MS,
				maxFiles: MAX_FILES,
				signal: abort.signal,
				onResponse: (res) => {
					const files = toSlskFiles([res])
					// Así el downloader conoce otras fuentes por si el usuario elegido no envía el archivo.
					downloader.remember(files)
					pending.push(...files)
					timer ??= setTimeout(flush, EMIT_EVERY_MS)
				}
			})
		} catch (err) {
			state.error = errorMessage(err)
		} finally {
			flush()
			state.running = false
			this.events.emit({ type: 'slsk-search', id: state.id })
		}
	}

	get(id: string): SlskSearch {
		const search = this.#searches.get(id)
		if (!search) throw new Error('Esa búsqueda ya no está: busca de nuevo')
		return { ...search.state }
	}

	/** Deja de esperar resultados; los que llegaron se quedan. */
	stop(id: string) {
		this.#searches.get(id)?.abort.abort()
	}

	/** Baja un archivo de una búsqueda: lo agrega a la playlist local "Soulseek" y lo pone en la cola. */
	async download(searchId: string, username: string, path: string): Promise<{ playlistId: number }> {
		const file = this.#searches.get(searchId)?.state.results.find((f) => f.username === username && f.path === path)
		if (!file) throw new Error('Ese resultado ya no está: busca de nuevo')
		const { playlistId, position } = this.library.addSoulseekFile(file)
		await this.queue.enqueuePlaylist(playlistId, [position], 'soulseek')
		return { playlistId }
	}

	/** Olvida las búsquedas viejas, y las que sobran (las más antiguas primero). */
	#prune() {
		const old = Date.now() - KEEP_MS
		for (const [id, s] of this.#searches) {
			if (s.startedAt >= old && this.#searches.size < MAX_SEARCHES) continue
			s.abort.abort()
			this.#searches.delete(id)
		}
	}

	close() {
		for (const s of this.#searches.values()) s.abort.abort()
		this.#searches.clear()
	}
}
