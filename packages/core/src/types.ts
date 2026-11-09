// Shared domain + API types. The UI imports these as type-only, so keep this file free of runtime deps.

export type SourceService = 'spotify' | 'ytmusic' | 'qobuz' | 'deezer'
/** Lossless download services, tried in the user's priority order. */
export type TargetService = 'qobuz' | 'deezer'
/** Everything a track can be downloaded from. YouTube is lossy and only used when the user asks for it. */
export type DownloadService = TargetService | 'youtube'

export const SOURCE_SERVICES: SourceService[] = ['spotify', 'ytmusic', 'qobuz', 'deezer']
export const TARGET_SERVICES: TargetService[] = ['qobuz', 'deezer']
export const DOWNLOAD_SERVICES: DownloadService[] = ['qobuz', 'deezer', 'youtube']
export const DOWNLOAD_SERVICE_LABEL: Record<DownloadService, string> = { qobuz: 'Qobuz', deezer: 'Deezer', youtube: 'YouTube' }

export function isDownloadService(s: unknown): s is DownloadService {
	return typeof s === 'string' && (DOWNLOAD_SERVICES as string[]).includes(s)
}

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

/**
 * Quality to download in: the best the service has, or a ceiling. Each service gives the best it has up to it.
 * Qobuz has nothing below MP3 320, Deezer has a single lossless format (16-bit/44.1 kHz), and YouTube always gives
 * its one audio format.
 */
export type QualityLevel = 'max' | 'hires96' | 'cd' | 'mp3_320' | 'mp3_128'
export const QUALITY_LEVELS: QualityLevel[] = ['max', 'hires96', 'cd', 'mp3_320', 'mp3_128']

export function isQualityLevel(s: unknown): s is QualityLevel {
	return typeof s === 'string' && (QUALITY_LEVELS as string[]).includes(s)
}

/**
 * The levels that come out the same on a service, collapsed into one, so files downloaded at any of them can be
 * reused for the others.
 */
export function serviceQualityLevel(service: DownloadService, level: QualityLevel): QualityLevel {
	if (service === 'youtube') return 'max'
	if (service === 'deezer') return level === 'hires96' || level === 'cd' ? 'max' : level
	return level === 'mp3_128' ? 'mp3_320' : level
}

/** Audio quality of a stream or file. */
export interface AudioQuality {
	codec: 'flac' | 'alac' | 'mp3' | 'aac' | 'opus' | 'vorbis' | 'other'
	lossless: boolean
	bitDepth?: number
	sampleRateHz?: number
	bitrateKbps?: number
}

/** A track as it exists on a download (target) service. */
export interface TargetTrack {
	service: DownloadService
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
	/** Best quality the service can deliver for this track (before downloading). */
	maxQuality?: AudioQuality
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
	/** Services tried, in order, when a download has no provider chosen. YouTube (lossy) only if the user adds it. */
	servicePriority: DownloadService[]
	/** Default quality for downloads; each download can pick another. */
	downloadQuality: QualityLevel
	concurrency: number
	autoAcceptThreshold: number
	spotifyClientId: string
	/** Path to yt-dlp, used for YouTube downloads. Empty: Kemix's own copy (downloaded on first use), else the PATH. */
	ytDlpPath: string
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
		targetService: DownloadService | null
		targetUrl: string | null
		confidence: number | null
		maxQuality: AudioQuality | null
	} | null
	download: {
		/** The download's id, as in `DownloadRow`. */
		id: number
		status: DownloadStatus
		error: string | null
		path: string | null
		/** Quality of the downloaded file, read from the file itself. */
		quality: AudioQuality | null
		service: DownloadService | null
	} | null
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
	/** Not found on any lossless service: YouTube is the remaining option. */
	notFound: boolean
}

export interface YouTubePreview {
	videoId: string
	title: string
	channel?: string
}

/** Audio straight from a streaming service. `full` is false for the short clips some services give. */
export interface StreamPreview {
	url: string
	full: boolean
}

/** What the player can play for a track: a YouTube video, or the service's own audio. */
export type TrackPreview =
	| ({ kind: 'youtube' } & YouTubePreview)
	| ({ kind: 'stream'; service: SourceService; title: string } & StreamPreview)

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
	quality: AudioQuality | null
	service: DownloadService | null
}

export type KemixEvent =
	| { type: 'accounts' }
	| { type: 'library' }
	| { type: 'sync'; state: 'start' | 'progress' | 'done' | 'error'; message?: string }
	| { type: 'playlist'; playlistId: number }
	| { type: 'download'; row: DownloadRow }
	| { type: 'download-removed'; id: number; playlistId: number }
	| { type: 'review' }
