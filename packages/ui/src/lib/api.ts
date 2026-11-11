import type {
	AccountInfo,
	AccountService,
	AudioQuality,
	DownloadRow,
	DownloadService,
	ExploreCreated,
	ExplorePage,
	Folder,
	MatchCandidate,
	OutputFormat,
	PlaylistDetail,
	PlaylistSummary,
	QualityLevel,
	ReviewItem,
	ScanState,
	Settings,
	SlskSearch,
	SoulseekStatus,
	SoundeoStatus,
	SourceService,
	SourceTrack,
	TrackFeatures,
	TrackPreview,
	YtMusicAccount
} from '@kemix/core'

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
	const res = await fetch(url, {
		method,
		headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined
	})
	const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null
	if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`)
	return data as T
}

export interface AppState {
	accounts: AccountInfo[]
	settings: Settings
	syncing: boolean
	spotifyRedirectUri: string
	/** Desktop app: services can be connected by signing in on their site in a window. */
	browserLogin: boolean
}

/** A track outside the library whose key and BPM are wanted: a search result, or a review option. */
export interface FeatureLookupItem {
	service: string
	track: Pick<SourceTrack, 'sourceId' | 'title' | 'artists' | 'durationMs' | 'isrc'>
}

export interface DownloadOptions {
	positions?: number[]
	provider?: DownloadService | null
	quality?: QualityLevel | null
	format?: OutputFormat | null
}

export const api = {
	state: () => request<AppState>('GET', '/api/state'),
	updateSettings: (patch: Partial<Settings>) => request<Settings>('PUT', '/api/settings', patch),

	connectQobuzInBrowser: () => request('POST', '/api/accounts/qobuz/browser'),
	connectDeezer: (arl: string) => request('POST', '/api/accounts/deezer', { arl }),
	/** Desktop app: sign in on soundcloud.com in a window. */
	connectSoundCloudInBrowser: () => request('POST', '/api/accounts/soundcloud/browser'),
	/** Cookies of soundcloud.com (or the bare oauth_token). */
	connectSoundCloud: (cookie: string) => request('POST', '/api/accounts/soundcloud', { cookie }),
	/** Without a cookie, reuses the stored one (to switch between the Google accounts it covers). */
	connectYtMusic: (body: { cookie?: string; accountIndex?: number }) =>
		request<{ status: 'connected' } | { status: 'choose'; accounts: YtMusicAccount[] }>('POST', '/api/accounts/ytmusic', body),
	startSpotify: () => request<{ url: string }>('POST', '/api/accounts/spotify/start'),
	/** Any account, Premium or not: sign in on open.spotify.com in a window (desktop app). */
	connectSpotifyWeb: () => request('POST', '/api/accounts/spotify/web'),
	/** Soundeo signs in with email and password (any account; only Premium ones download). */
	connectSoundeo: (body: { email: string; password: string }) =>
		request<SoundeoStatus>('POST', '/api/accounts/soundeo', body),
	/** Whether the connected Soundeo account has Premium, and its downloads left today. */
	soundeoStatus: () => request<SoundeoStatus>('GET', '/api/accounts/soundeo'),
	/** Soulseek: usuario y contraseña (un usuario nuevo se crea al entrar por primera vez). */
	connectSoulseek: (body: { username: string; password: string }) =>
		request<SoulseekStatus>('POST', '/api/accounts/soulseek', body),
	/** Si la sesión de Soulseek está en línea y si el puerto para otros usuarios está abierto. */
	soulseekStatus: () => request<SoulseekStatus>('GET', '/api/accounts/soulseek'),
	disconnect: (service: AccountService) => request('DELETE', `/api/accounts/${service}`),
	/** Best quality each download service gives with the connected account. */
	downloadQualities: () => request<Partial<Record<DownloadService, AudioQuality>>>('GET', '/api/accounts/quality'),

	sync: () => request('POST', '/api/sync'),
	library: () => request<{ folders: Folder[]; playlists: PlaylistSummary[] }>('GET', '/api/library'),
	playlist: (id: number) => request<PlaylistDetail>('GET', `/api/playlists/${id}`),
	resyncPlaylist: (id: number) => request('POST', `/api/playlists/${id}/sync`),
	/**
	 * Without positions, queues the whole playlist. Without a provider, services are tried in priority order.
	 * Without a quality or format, the ones in settings are used.
	 */
	downloadPlaylist: (id: number, opts: DownloadOptions = {}) => request('POST', `/api/playlists/${id}/download`, opts),
	/** Look the tracks up (without downloading) to learn the best quality each has; runs in the background. */
	scanPlaylist: (id: number, positions?: number[], provider?: DownloadService | null) =>
		request<{ scan: ScanState }>('POST', `/api/playlists/${id}/scan`, { positions, provider }),
	scanState: (id: number) => request<{ scan: ScanState | null }>('GET', `/api/playlists/${id}/scan`),
	/** Key and BPM of the given positions (again), or of every track still missing them; runs in the background. */
	analyzeFeatures: (id: number, positions?: number[]) =>
		request<{ scan: ScanState }>('POST', `/api/playlists/${id}/features`, { positions }),
	featuresState: (id: number) => request<{ scan: ScanState | null }>('GET', `/api/playlists/${id}/features`),
	/**
	 * Key and BPM of tracks outside the library: what's known now (null for the rest, which come as `track-features`
	 * events). A new batch from the same `group` stops what's left of the previous one.
	 */
	lookupFeatures: (items: FeatureLookupItem[], group: string) =>
		request<{ results: (TrackFeatures | null)[] }>('POST', '/api/features/lookup', { items, group }),
	preview: (trackId: number) => request<{ preview: TrackPreview | null }>('GET', `/api/tracks/${trackId}/preview`),
	/**
	 * Audio for a track that isn't in the library (a search result from `service`): the service's full song, else
	 * YouTube. `exact`: that very recording, so the service's own clip beats a YouTube video of maybe another version.
	 */
	previewTrack: (service: AccountService, track: SourceTrack, exact = false) =>
		request<{ preview: TrackPreview | null }>('POST', `/api/preview/${service}${exact ? '?exact=1' : ''}`, track),
	movePlaylist: (id: number, folderId: number | null) => request('PATCH', `/api/playlists/${id}`, { folderId }),
	search: (service: SourceService, query: string) => request<SourceTrack[]>('POST', `/api/search/${service}`, { query }),
	/** A new playlist on `service` with tracks from another one, each looked up there; the ones not found come back. */
	copyPlaylist: (service: SourceService, name: string, tracks: SourceTrack[]) =>
		request<{ playlistId: number | null; added: number; missing: SourceTrack[] }>('POST', `/api/playlists/copy/${service}`, {
			name,
			tracks
		}),
	createPlaylist: (service: SourceService, name: string, trackIds: string[]) =>
		request<{ playlistId: number | null }>('POST', `/api/playlists/create/${service}`, { name, trackIds }),

	/** Empieza una búsqueda libre en Soulseek; los resultados llegan con eventos `slsk-search` y se leen con la otra. */
	startSoulseekSearch: (query: string) => request<SlskSearch>('POST', '/api/soulseek/searches', { query }),
	soulseekSearch: (id: string) => request<SlskSearch>('GET', `/api/soulseek/searches/${encodeURIComponent(id)}`),
	stopSoulseekSearch: (id: string) => request('POST', `/api/soulseek/searches/${encodeURIComponent(id)}/stop`),
	/** Baja un resultado a la playlist "Soulseek", en la calidad y el formato elegidos (sin ellos, los de Ajustes). */
	soulseekDownload: (searchId: string, username: string, path: string, opts: Omit<DownloadOptions, 'positions'> = {}) =>
		request<{ playlistId: number }>('POST', '/api/soulseek/download', { searchId, username, path, ...opts }),
	/**
	 * Baja temas de una búsqueda en `service`: van a la playlist «Temas sueltos» y se bajan como cualquier playlist
	 * (proveedor, calidad y formato opcionales).
	 */
	downloadFromSearch: (service: SourceService, tracks: SourceTrack[], opts: Omit<DownloadOptions, 'positions'> = {}) =>
		request<{ playlistId: number }>('POST', '/api/search/download', { service, tracks, ...opts }),

	/** Temas de SoundCloud con descarga gratis, por género o tag; `cursor`: el `next` de la tanda anterior. */
	explore: (p: { genre?: string; q?: string; created?: ExploreCreated | null; cursor?: string | null }) => {
		const params = new URLSearchParams()
		for (const [k, v] of Object.entries(p)) if (v) params.set(k, v)
		return request<ExplorePage>('GET', `/api/soundcloud/explore?${params}`)
	},
	/** Baja un tema de Explorar a «SoundCloud gratis». */
	exploreDownload: (id: string, opts: Omit<DownloadOptions, 'positions' | 'provider'> = {}) =>
		request<{ playlistId: number }>('POST', '/api/soundcloud/download', { id, ...opts }),

	createFolder: (name: string, parentId: number | null) => request<Folder>('POST', '/api/folders', { name, parentId }),
	updateFolder: (id: number, patch: { name?: string; parentId?: number | null }) =>
		request('PATCH', `/api/folders/${id}`, patch),
	deleteFolder: (id: number) => request('DELETE', `/api/folders/${id}`),

	review: () => request<ReviewItem[]>('GET', '/api/review'),
	/** Without a provider, searches every connected service in priority order. */
	searchCandidates: (trackId: number, query?: string, provider?: DownloadService | null) =>
		request<MatchCandidate[]>('POST', `/api/review/${trackId}/search`, { query, provider }),
	/** With a provider other than the candidate's, that same recording is looked up there and downloaded from it. */
	accept: (trackId: number, candidate: MatchCandidate, provider?: DownloadService | null) =>
		request('POST', `/api/review/${trackId}/accept`, { candidate, provider }),
	skip: (trackId: number) => request('POST', `/api/review/${trackId}/skip`),
	downloadFromYouTube: (trackIds: number[]) =>
		request<{ queued: number; notFound: number }>('POST', '/api/review/youtube', { trackIds }),

	downloads: () => request<DownloadRow[]>('GET', '/api/downloads'),
	retryFailed: () => request('POST', '/api/downloads/retry'),
	clearFinished: () => request('POST', '/api/downloads/clear'),
	/** Stops it if running, deletes its file from disk and removes it from the list. */
	removeDownload: (id: number) => request('DELETE', `/api/downloads/${id}`)
}
