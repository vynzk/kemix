import type {
	AccountInfo,
	DownloadRow,
	Folder,
	MatchCandidate,
	PlaylistDetail,
	PlaylistSummary,
	ReviewItem,
	Settings,
	SourceService,
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

	connectQobuz: (body: {
		email?: string
		password?: string
		session?: string
		appId?: string
		appSecret?: string
	}) =>
		request('POST', '/api/accounts/qobuz', body),
	connectQobuzInBrowser: () => request('POST', '/api/accounts/qobuz/browser'),
	connectDeezer: (arl: string) => request('POST', '/api/accounts/deezer', { arl }),
	/** Without a cookie, reuses the stored one (to switch between the Google accounts it covers). */
	connectYtMusic: (body: { cookie?: string; accountIndex?: number }) =>
		request<{ status: 'connected' } | { status: 'choose'; accounts: YtMusicAccount[] }>('POST', '/api/accounts/ytmusic', body),
	startSpotify: () => request<{ url: string }>('POST', '/api/accounts/spotify/start'),
	disconnect: (service: SourceService) => request('DELETE', `/api/accounts/${service}`),

	sync: () => request('POST', '/api/sync'),
	library: () => request<{ folders: Folder[]; playlists: PlaylistSummary[] }>('GET', '/api/library'),
	playlist: (id: number) => request<PlaylistDetail>('GET', `/api/playlists/${id}`),
	resyncPlaylist: (id: number) => request('POST', `/api/playlists/${id}/sync`),
	downloadPlaylist: (id: number) => request('POST', `/api/playlists/${id}/download`),
	movePlaylist: (id: number, folderId: number | null) => request('PATCH', `/api/playlists/${id}`, { folderId }),

	createFolder: (name: string, parentId: number | null) => request<Folder>('POST', '/api/folders', { name, parentId }),
	updateFolder: (id: number, patch: { name?: string; parentId?: number | null }) =>
		request('PATCH', `/api/folders/${id}`, patch),
	deleteFolder: (id: number) => request('DELETE', `/api/folders/${id}`),

	review: () => request<ReviewItem[]>('GET', '/api/review'),
	searchCandidates: (trackId: number, query?: string) =>
		request<MatchCandidate[]>('POST', `/api/review/${trackId}/search`, { query }),
	accept: (trackId: number, candidate: MatchCandidate) => request('POST', `/api/review/${trackId}/accept`, { candidate }),
	skip: (trackId: number) => request('POST', `/api/review/${trackId}/skip`),

	downloads: () => request<DownloadRow[]>('GET', '/api/downloads'),
	retryFailed: () => request('POST', '/api/downloads/retry'),
	clearFinished: () => request('POST', '/api/downloads/clear')
}
