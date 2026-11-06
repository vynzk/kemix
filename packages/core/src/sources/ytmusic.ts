import { Innertube, YTNodes } from 'youtubei.js'
import type { Helpers, IParsedResponse } from 'youtubei.js'
import type { SourceConnector } from './types'
import type { AccountIdentity, SourcePlaylist, SourceTrack } from '../types'

type YTNode = Helpers.YTNode

function isPlaylistItem(node: YTNode): boolean {
	return (node as { item_type?: string }).item_type === 'playlist'
}

/**
 * YouTube Music has no public API for a user's library, so this uses youtubei.js (InnerTube) authenticated
 * with the cookies of a logged-in music.youtube.com session. Unofficial: may break when YouTube changes things.
 */
export interface YtMusicAccount {
	/** Google's `authuser` index: which of the signed-in Google accounts in the cookies to act as. */
	index: number
	name: string
	email?: string
}

const MAX_GOOGLE_ACCOUNTS = 10

export class YtMusicSource implements SourceConnector {
	readonly service = 'ytmusic' as const
	#yt?: Promise<Innertube>

	constructor(
		private cookie: string,
		private accountIndex = 0
	) {}

	/**
	 * Cookies from a browser with several Google accounts signed in cover all of them; Google picks one per request
	 * by index (authuser). Probe indexes 0, 1, 2… until one fails or repeats an account already seen
	 * (Google falls back to the default account for indexes that don't exist).
	 */
	static async discoverAccounts(cookie: string): Promise<YtMusicAccount[]> {
		const accounts: YtMusicAccount[] = []
		const seen = new Set<string>()
		for (let index = 0; index < MAX_GOOGLE_ACCOUNTS; index++) {
			let id: AccountIdentity
			try {
				id = await new YtMusicSource(cookie, index).verify()
			} catch (err) {
				if (index === 0) throw err
				break
			}
			const key = (id.email ?? id.name ?? '').toLowerCase()
			if (seen.has(key)) break
			seen.add(key)
			accounts.push({ index, name: id.name ?? `Cuenta ${index + 1}`, email: id.email })
		}
		return accounts
	}

	#client() {
		this.#yt ??= Innertube.create({
			cookie: this.cookie,
			account_index: this.accountIndex,
			retrieve_player: false
		}).catch((err) => {
			this.#yt = undefined
			throw err
		})
		return this.#yt
	}

	/**
	 * Check the cookies really give a signed-in session and return who it is.
	 * The library endpoint only answers for signed-in users, so it is the actual login test; the identity is best-effort.
	 */
	async verify(): Promise<AccountIdentity> {
		const yt = await this.#client()
		try {
			await yt.music.getLibrary()
		} catch (err) {
			throw new Error(
				`YouTube rechazó la sesión: ${err instanceof Error ? err.message : String(err)}. ` +
					'Exporta las cookies de nuevo con la sesión iniciada en music.youtube.com.'
			)
		}
		return this.identity()
	}

	/**
	 * The account switcher holds the active channel's name and, in its section header, the Google account's email.
	 * Two variants of it are tried because YouTube returns slightly different shapes per client.
	 */
	async identity(): Promise<AccountIdentity> {
		const yt = await this.#client()
		const texts: string[] = []
		let name: string | undefined
		const take = (items: InstanceType<typeof YTNodes.AccountItem>[], headers: (string | undefined)[]) => {
			const active = items.find((i) => i.is_selected) ?? items[0]
			name ??= active?.account_name?.toString()
			texts.push(...headers.filter((h): h is string => !!h))
			for (const i of items) texts.push(i.account_byline?.toString() ?? '', i.channel_handle?.toString() ?? '')
		}
		try {
			const info = await yt.account.getInfo()
			take(info.contents?.contents?.filterType(YTNodes.AccountItem) ?? [], [info.contents?.header?.title?.toString()])
		} catch {
			// try the other variant
		}
		try {
			const res = await new YTNodes.NavigationEndpoint({
				getAccountsListInnertubeEndpoint: {
					requestType: 'ACCOUNTS_LIST_REQUEST_TYPE_CHANNEL_SWITCHER',
					callCircumstance: 'SWITCHING_USERS_FULL'
				}
			}).call(yt.actions, { client: 'WEB', parse: true })
			take(
				res.actions_memo?.getType(YTNodes.AccountItem) ?? [],
				(res.actions_memo?.getType(YTNodes.AccountItemSectionHeader) ?? []).map((h) => h.title?.toString())
			)
		} catch {
			// identity is cosmetic
		}
		const email = texts.map((t) => t.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0]).find(Boolean)
		return { name: name ?? 'Sesión iniciada', email }
	}

	async listPlaylists(): Promise<SourcePlaylist[]> {
		const yt = await this.#client()
		// The library's dedicated "Playlists" page (what ytmusicapi uses). Unlike the library landing page it only
		// holds playlists and doesn't depend on picking a filter chip by its (localized) name.
		let nodes = await this.#browseAll(yt, 'FEmusic_liked_playlists')
		if (!nodes.some(isPlaylistItem)) nodes = await this.#browseAll(yt, 'FEmusic_library_landing')
		return this.#toPlaylists(nodes)
	}

	/** Fetch a YT Music browse page and every continuation page, returning all list/grid items found. */
	async #browseAll(yt: Innertube, browseId: string): Promise<YTNode[]> {
		const opts = { client: 'YTMUSIC', parse: true } as const
		const items: YTNode[] = []
		const seenTokens = new Set<string>()
		let res: IParsedResponse = await new YTNodes.NavigationEndpoint({ browseEndpoint: { browseId } }).call(yt.actions, opts)
		for (let page = 0; page < 50; page++) {
			const memos = [res.contents_memo, res.continuation_contents_memo, res.on_response_received_actions_memo]
			let next: (() => Promise<IParsedResponse>) | undefined
			for (const memo of memos) {
				if (!memo) continue
				items.push(...memo.getType(YTNodes.MusicTwoRowItem, YTNodes.MusicResponsiveListItem))
				// Old-style continuation token on the grid/shelf…
				for (const node of memo.getType(YTNodes.Grid, YTNodes.MusicShelf)) {
					const token = (node as { continuation?: string | null }).continuation
					if (token && !seenTokens.has(token)) {
						seenTokens.add(token)
						next ??= () => yt.actions.execute('/browse', { ...opts, continuation: token })
					}
				}
				// …or a newer "continuation item" at the end of the list.
				for (const node of memo.getType(YTNodes.ContinuationItem)) {
					const token = JSON.stringify(node.endpoint?.payload ?? null)
					if (node.endpoint && !seenTokens.has(token)) {
						seenTokens.add(token)
						next ??= () => node.endpoint.call(yt.actions, opts)
					}
				}
			}
			const cont = res.continuation_contents as { continuation?: string } | undefined
			if (!next && cont?.continuation && !seenTokens.has(cont.continuation)) {
				const token = cont.continuation
				seenTokens.add(token)
				next = () => yt.actions.execute('/browse', { ...opts, continuation: token })
			}
			if (!next) break
			res = await next()
		}
		return items
	}

	#toPlaylists(nodes: YTNode[]): SourcePlaylist[] {
		const out: SourcePlaylist[] = []
		const seen = new Set<string>()
		for (const node of nodes) {
			const item = node as {
				id?: string
				item_type?: string
				title?: { toString(): string } | string
				subtitle?: { toString(): string }
				item_count?: string | null
				song_count?: string
				thumbnail?: { url: string; width?: number }[] | { contents?: { url: string; width?: number }[] } | null
				author?: { name: string }
			}
			if (!isPlaylistItem(node) || !item.id) continue
			const id = item.id.replace(/^VL/, '')
			// "New playlist" button and auto-generated "Episodes for later" have no real playlist id.
			if (seen.has(id) || id === 'SE') continue
			seen.add(id)
			const thumbs = Array.isArray(item.thumbnail) ? item.thumbnail : item.thumbnail?.contents
			const countText = item.item_count ?? item.song_count ?? item.subtitle?.toString() ?? ''
			const count = countText.match(/(\d[\d.,]*)\s*(songs|canciones|tracks|temas)/i)?.[1]
			out.push({
				sourceId: id,
				name: String(item.title ?? id),
				owner: item.author?.name,
				coverUrl: thumbs?.length ? [...thumbs].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]!.url : undefined,
				trackCount: count ? Number(count.replace(/[.,]/g, '')) : undefined,
				snapshot: countText
			})
		}
		return out
	}

	async getPlaylistTracks(playlistId: string): Promise<SourceTrack[]> {
		const yt = await this.#client()
		let page = await yt.music.getPlaylist(playlistId)
		const out: SourceTrack[] = []
		const take = () => {
			for (const node of page.items ?? []) {
				if (!node.is(YTNodes.MusicResponsiveListItem)) continue
				const item = node
				if (!item.id || !item.title) continue
				out.push({
					sourceId: item.id,
					title: item.title,
					artists: (item.artists ?? item.authors ?? []).map((a) => a.name),
					album: item.album?.name,
					durationMs: item.duration?.seconds ? item.duration.seconds * 1000 : undefined,
					coverUrl: item.thumbnail?.contents?.[0]?.url,
					url: `https://music.youtube.com/watch?v=${item.id}`
				})
			}
		}
		take()
		while (page.has_continuation) {
			page = await page.getContinuation()
			take()
		}
		return out
	}
}
