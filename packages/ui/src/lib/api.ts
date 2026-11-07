import type {
	AccountInfo,
	AudioQuality,
	DownloadRow,
	DownloadService,
	Folder,
	MatchCandidate,
	PlaylistDetail,
	PlaylistSummary,
	ReviewItem,
	Settings,
	SourceService,
	SourceTrack,
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

export const api = {
	state: () => request<AppState>('GET', '/api/state'),
	updateSettings: (patch: Partial<Settings>) => request<Settings>('PUT', '/api/settings', patch),

	connectQobuzInBrowser: () => request('POST', '/api/accounts/qobuz/browser'),
	connectDeezer: (arl: string) => request('POST', '/api/accounts/deezer', { arl }),
	/** Without a cookie, reuses the stored one (to switch between the Google accounts it covers). */
	connectYtMusic: (body: { cookie?: string; accountIndex?: number }) =>
		request<{ status: 'connected' } | { status: 'choose'; accounts: YtMusicAccount[] }>('POST', '/api/accounts/ytmusic', body),
	startSpotify: () => request<{ url: string }>('POST', '/api/accounts/spotify/start'),
	/** Any account, Premium or not: sign in on open.spotify.com in a window (desktop app). */
	connectSpotifyWeb: () => request('POST', '/api/accounts/spotify/web'),
	disconnect: (service: SourceService) => request('DELETE', `/api/accounts/${service}`),
	/** Best quality each download service gives with the connected account. */
	downloadQualities: () => request<Partial<Record<DownloadService, AudioQuality>>>('GET', '/api/accounts/quality'),

	sync: () => request('POST', '/api/sync'),
	library: () => request<{ folders: Folder[]; playlists: PlaylistSummary[] }>('GET', '/api/library'),
	playlist: (id: number) => request<PlaylistDetail>('GET', `/api/playlists/${id}`),
	resyncPlaylist: (id: number) => request('POST', `/api/playlists/${id}/sync`),
	/** Without positions, queues the whole playlist. Without a provider, services are tried in priority order. */
	downloadPlaylist: (id: number, positions?: number[], provider?: DownloadService | null) =>
		request('POST', `/api/playlists/${id}/download`, { positions, provider }),
	preview: (trackId: number) => request<{ preview: TrackPreview | null }>('GET', `/api/tracks/${trackId}/preview`),
	/** YouTube video to listen to a track that isn't in the library (a search result from `service`). */
	previewTrack: (service: SourceService, track: SourceTrack) =>
		request<{ preview: TrackPreview | null }>('POST', `/api/preview/${service}`, track),
	movePlaylist: (id: number, folderId: number | null) => request('PATCH', `/api/playlists/${id}`, { folderId }),
	search: (service: SourceService, query: string) => request<SourceTrack[]>('POST', `/api/search/${service}`, { query }),
	createPlaylist: (service: SourceService, name: string, trackIds: string[]) =>
		request<{ playlistId: number | null }>('POST', `/api/playlists/create/${service}`, { name, trackIds }),

	createFolder: (name: string, parentId: number | null) => request<Folder>('POST', '/api/folders', { name, parentId }),
	updateFolder: (id: number, patch: { name?: string; parentId?: number | null }) =>
		request('PATCH', `/api/folders/${id}`, patch),
	deleteFolder: (id: number) => request('DELETE', `/api/folders/${id}`),

	review: () => request<ReviewItem[]>('GET', '/api/review'),
	searchCandidates: (trackId: number, query?: string) =>
		request<MatchCandidate[]>('POST', `/api/review/${trackId}/search`, { query }),
	accept: (trackId: number, candidate: MatchCandidate) => request('POST', `/api/review/${trackId}/accept`, { candidate }),
	skip: (trackId: number) => request('POST', `/api/review/${trackId}/skip`),
	youtubeCandidates: (trackId: number, query?: string) =>
		request<MatchCandidate[]>('POST', `/api/review/${trackId}/youtube`, { query }),
	downloadFromYouTube: (trackIds: number[]) =>
		request<{ queued: number; notFound: number }>('POST', '/api/review/youtube', { trackIds }),

	downloads: () => request<DownloadRow[]>('GET', '/api/downloads'),
	retryFailed: () => request('POST', '/api/downloads/retry'),
	clearFinished: () => request('POST', '/api/downloads/clear')
}
