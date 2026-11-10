// Shared domain + API types. The UI imports these as type-only, so keep this file free of runtime deps.

/** Services playlists are imported from (and searched, and created in). */
export type SourceService = 'spotify' | 'ytmusic' | 'qobuz' | 'deezer' | 'soundcloud'
/** Services with an account in Kemix: the sources, plus Soundeo, which only downloads (it has no playlists). */
export type AccountService = SourceService | 'soundeo'
/**
 * Download services that need an account, tried in the user's priority order: lossless where the account allows it.
 * Soundeo only downloads with Premium, and each new track uses one of the plan's daily downloads.
 */
export type TargetService = 'qobuz' | 'deezer' | 'soundeo'
/** Lossy download services: need no account (they go through yt-dlp) and are only used when the user asks for them. */
export type LossyService = 'youtube' | 'soundcloud'
/** Everything a track can be downloaded from. */
export type DownloadService = TargetService | LossyService

export const SOURCE_SERVICES: SourceService[] = ['spotify', 'ytmusic', 'qobuz', 'deezer', 'soundcloud']
export const ACCOUNT_SERVICES: AccountService[] = [...SOURCE_SERVICES, 'soundeo']
export const TARGET_SERVICES: TargetService[] = ['qobuz', 'deezer', 'soundeo']
export const LOSSY_SERVICES: LossyService[] = ['youtube', 'soundcloud']
export const DOWNLOAD_SERVICES: DownloadService[] = ['qobuz', 'deezer', 'soundeo', 'youtube', 'soundcloud']
export const DOWNLOAD_SERVICE_LABEL: Record<DownloadService, string> = {
	qobuz: 'Qobuz',
	deezer: 'Deezer',
	soundeo: 'Soundeo',
	youtube: 'YouTube',
	soundcloud: 'SoundCloud'
}

export function isSourceService(s: unknown): s is SourceService {
	return typeof s === 'string' && (SOURCE_SERVICES as string[]).includes(s)
}

export function isAccountService(s: unknown): s is AccountService {
	return typeof s === 'string' && (ACCOUNT_SERVICES as string[]).includes(s)
}

export function isLossyService(s: string): s is LossyService {
	return (LOSSY_SERVICES as string[]).includes(s)
}

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
 * Qobuz has nothing below MP3 320, Deezer has a single lossless format (16-bit/44.1 kHz), Soundeo has its WAV/AIFF
 * (16-bit/44.1 kHz) and MP3 320, and YouTube and SoundCloud always give their one audio format.
 * `mp3_compat` is always an MP3, from any service: Qobuz/Deezer send their MP3 and anything else (YouTube's AAC/Opus,
 * a FLAC) is converted with ffmpeg, so the file plays on any player.
 */
export type QualityLevel = 'max' | 'hires96' | 'cd' | 'mp3_320' | 'mp3_128' | 'mp3_compat'
export const QUALITY_LEVELS: QualityLevel[] = ['max', 'hires96', 'cd', 'mp3_320', 'mp3_128', 'mp3_compat']

export function isQualityLevel(s: unknown): s is QualityLevel {
	return typeof s === 'string' && (QUALITY_LEVELS as string[]).includes(s)
}

/**
 * The levels that come out the same on a service, collapsed into one, so files downloaded at any of them can be
 * reused for the others.
 */
export function serviceQualityLevel(service: DownloadService, level: QualityLevel): QualityLevel {
	// Qobuz/Deezer's own MP3 is already compatible; YouTube/SoundCloud's audio gets converted, so it's another file.
	if (level === 'mp3_compat') return isLossyService(service) ? 'mp3_compat' : serviceQualityLevel(service, 'mp3_320')
	if (isLossyService(service)) return 'max'
	if (service === 'deezer') return level === 'hires96' || level === 'cd' ? 'max' : level
	// Soundeo: one lossless file (its WAV, or the AIFF made from it) and one MP3 (320).
	if (service === 'soundeo') return level === 'mp3_320' || level === 'mp3_128' ? 'mp3_320' : 'max'
	return level === 'mp3_128' ? 'mp3_320' : level
}

/**
 * Format the file is saved in: as the service delivers it, or converted after downloading (with ffmpeg) to the
 * uncompressed formats DJ software and producers use. AIFF/WAV keep the sample rate and bit depth of what was
 * downloaded. (MP3 for any player is a quality level, 'mp3_compat'.)
 */
export type OutputFormat = 'original' | 'aiff' | 'wav'
export const OUTPUT_FORMATS: OutputFormat[] = ['original', 'aiff', 'wav']

export function isOutputFormat(s: unknown): s is OutputFormat {
	return typeof s === 'string' && (OUTPUT_FORMATS as string[]).includes(s)
}

/** Audio quality of a stream or file. */
export interface AudioQuality {
	codec: 'flac' | 'alac' | 'wav' | 'aiff' | 'mp3' | 'aac' | 'opus' | 'vorbis' | 'other'
	lossless: boolean
	bitDepth?: number
	sampleRateHz?: number
	bitrateKbps?: number
	/** Quality of what was downloaded, when the file was converted from it (an AIFF made from an MP3 isn't lossless). */
	convertedFrom?: AudioQuality
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
	service: AccountService
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

/** A Soundeo account right now: whether it can download (Premium) and how many tracks it has left today. */
export interface SoundeoStatus {
	premium: boolean
	/** Downloads left today from the plan (reset every midnight, Central European Time). */
	downloadsLeft: number | null
	/** Bonus downloads, usable any day while the account has Premium. */
	bonusLeft: number | null
	/** Time until the plan's downloads are reset, e.g. "6 h 57 min". */
	resetsIn: string | null
}

export interface Settings {
	downloadDir: string
	/** Services tried, in order, when a download has no provider chosen. YouTube/SoundCloud (lossy) only if the user adds them. */
	servicePriority: DownloadService[]
	/** Default quality for downloads; each download can pick another. */
	downloadQuality: QualityLevel
	/** Default file format for downloads; each download can pick another. */
	outputFormat: OutputFormat
	concurrency: number
	autoAcceptThreshold: number
	spotifyClientId: string
	/** Path to yt-dlp, used for YouTube and SoundCloud. Empty: Kemix's own copy (downloaded on first use), else the PATH. */
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
	/** Not found on any lossless service: YouTube/SoundCloud are the remaining options. */
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

/** What the player can play for a track: a YouTube video, a SoundCloud track (its embedded player), or the service's own audio. */
export type TrackPreview =
	| ({ kind: 'youtube' } & YouTubePreview)
	| { kind: 'soundcloud'; url: string; title: string }
	| ({ kind: 'stream'; service: AccountService; title: string } & StreamPreview)

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

/**
 * Quality scan of a playlist: its tracks are looked up on the download services (as a download would) to learn the
 * best quality each one has, without downloading anything.
 */
export interface ScanState {
	playlistId: number
	running: boolean
	/** Tracks looked up so far, out of `total`. */
	done: number
	total: number
	/** Tracks whose lookup failed (service down, session expired…). */
	failed: number
	/** First failure, to tell the user why. */
	error: string | null
}

export type KemixEvent =
	| { type: 'scan'; scan: ScanState }
	| { type: 'accounts' }
	| { type: 'library' }
	| { type: 'sync'; state: 'start' | 'progress' | 'done' | 'error'; message?: string }
	| { type: 'playlist'; playlistId: number }
	| { type: 'download'; row: DownloadRow }
	| { type: 'download-removed'; id: number; playlistId: number }
	| { type: 'review' }
