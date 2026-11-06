// Shared domain + API types. The UI imports these as type-only, so keep this file free of runtime deps.

export type SourceService = 'spotify' | 'ytmusic' | 'qobuz' | 'deezer'
export type TargetService = 'qobuz' | 'deezer'

export const SOURCE_SERVICES: SourceService[] = ['spotify', 'ytmusic', 'qobuz', 'deezer']
export const TARGET_SERVICES: TargetService[] = ['qobuz', 'deezer']

export function isTargetService(s: string): s is TargetService {
	return (TARGET_SERVICES as string[]).includes(s)
}

export interface SourcePlaylist {
	sourceId: string
	name: string
	owner?: string
	coverUrl?: string
	trackCount?: number
	/** Opaque value that changes whenever the playlist contents change (snapshot id, checksum, mtime…). */
	snapshot?: string
}

export interface SourceTrack {
	sourceId: string
	title: string
	artists: string[]
	album?: string
	durationMs?: number
	isrc?: string
	coverUrl?: string
	url?: string
}

/** A track as it exists on a download (target) service. */
export interface TargetTrack {
	service: TargetService
	id: string
	url: string
	title: string
	artists: string[]
	album?: string
	albumArtists?: string[]
	durationMs?: number
	isrc?: string
	coverUrl?: string
	trackNumber?: number
	discNumber?: number
	year?: number
	genres?: string[]
	copyright?: string
}

export interface MatchCandidate extends TargetTrack {
	score: number
}

export type MatchStatus = 'auto' | 'pending' | 'accepted' | 'skipped' | 'notfound'
export type DownloadStatus =
	| 'queued'
	| 'matching'
	| 'needs_review'
	| 'downloading'
	| 'done'
	| 'error'
	| 'skipped'

export type AccountStatus = 'connected' | 'disconnected' | 'error'

export interface AccountInfo {
	service: SourceService
	status: AccountStatus
	displayName?: string | null
	/** Email of the connected account, when the service exposes it. */
	email?: string | null
	error?: string | null
}

export interface AccountIdentity {
	name?: string
	email?: string
}

export interface Settings {
	downloadDir: string
	servicePriority: TargetService[]
	concurrency: number
	autoAcceptThreshold: number
	spotifyClientId: string
	/** Port the local server listens on (used for the Spotify OAuth redirect). */
	port: number
}

export interface Folder {
	id: number
	name: string
	parentId: number | null
	position: number
}

export interface PlaylistSummary {
	id: number
	source: SourceService
	sourceId: string
	name: string
	owner: string | null
	coverUrl: string | null
	trackCount: number | null
	folderId: number | null
	position: number
	syncedAt: number | null
	removed: boolean
	downloads: { done: number; total: number; error: number; review: number; active: number }
}

export interface PlaylistTrackRow {
	position: number
	trackId: number
	title: string
	artists: string[]
	album: string | null
	durationMs: number | null
	isrc: string | null
	match: {
		status: MatchStatus
		targetService: TargetService | null
		targetUrl: string | null
		confidence: number | null
	} | null
	download: { status: DownloadStatus; error: string | null; path: string | null } | null
}

export interface PlaylistDetail extends PlaylistSummary {
	tracks: PlaylistTrackRow[]
}

export interface ReviewItem {
	trackId: number
	title: string
	artists: string[]
	album: string | null
	durationMs: number | null
	source: SourceService
	playlists: string[]
	candidates: MatchCandidate[]
}

export interface DownloadRow {
	id: number
	playlistId: number
	playlistName: string
	trackId: number
	title: string
	artists: string[]
	status: DownloadStatus
	error: string | null
	bytes: number | null
	totalBytes: number | null
	updatedAt: number
}

export type KemixEvent =
	| { type: 'accounts' }
	| { type: 'library' }
	| { type: 'sync'; state: 'start' | 'progress' | 'done' | 'error'; message?: string }
	| { type: 'playlist'; playlistId: number }
	| { type: 'download'; row: DownloadRow }
	| { type: 'review' }
