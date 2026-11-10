import type { AccountService, AudioQuality, DownloadService, OutputFormat, QualityLevel } from '@kemix/core'

export const SERVICE_LABEL: Record<AccountService | DownloadService, string> = {
	spotify: 'Spotify',
	ytmusic: 'YouTube Music',
	qobuz: 'Qobuz',
	deezer: 'Deezer',
	soundeo: 'Soundeo',
	youtube: 'YouTube',
	soundcloud: 'SoundCloud'
}

/** Mirrors `isLossyService` in @kemix/core (the UI only imports types from it): no account, lossy, only on request. */
export function isLossy(service: DownloadService): service is 'youtube' | 'soundcloud' {
	return service === 'youtube' || service === 'soundcloud'
}

/** What a lossy service gives, to warn before downloading from it. */
export const LOSSY_NOTE: Record<'youtube' | 'soundcloud', string> = {
	youtube: 'No es calidad máxima: AAC ~128 kbps (256 con YouTube Music Premium), con pérdida.',
	soundcloud: 'No es calidad máxima: hasta AAC 160 kbps, con pérdida (o el archivo original, si el artista lo permite).'
}

const CODEC_LABEL: Record<AudioQuality['codec'], string> = {
	flac: 'FLAC',
	alac: 'ALAC',
	wav: 'WAV',
	aiff: 'AIFF',
	mp3: 'MP3',
	aac: 'AAC',
	opus: 'Opus',
	vorbis: 'Vorbis',
	other: 'Audio'
}

/** "FLAC 24-bit/96 kHz", "MP3 320 kbps"… */
export function qualityLabel(q: AudioQuality | null | undefined): string {
	if (!q) return ''
	const codec = CODEC_LABEL[q.codec]
	if (q.lossless) {
		const khz = q.sampleRateHz ? `${+(q.sampleRateHz / 1000).toFixed(1)} kHz` : ''
		const bits = q.bitDepth ? `${q.bitDepth}-bit` : ''
		const detail = [bits, khz].filter(Boolean).join('/')
		return detail ? `${codec} ${detail}` : codec
	}
	return q.bitrateKbps ? `${codec} ${q.bitrateKbps} kbps` : codec
}

/** The label, plus what the file was converted from: "AIFF 16-bit/44.1 kHz (convertido desde MP3 320 kbps)". */
export function qualityDetail(q: AudioQuality | null | undefined): string {
	if (!q) return ''
	return q.convertedFrom ? `${qualityLabel(q)} (convertido desde ${qualityLabel(q.convertedFrom)})` : qualityLabel(q)
}

/** Mirrors `serviceQualityLevel` in @kemix/core (the UI only imports types from it). */
function serviceLevel(service: DownloadService, level: QualityLevel): QualityLevel {
	// Its own choice everywhere (in core it's the same file as MP3 320 on Qobuz/Deezer, but the user asked for it).
	if (level === 'mp3_compat') return level
	if (isLossy(service)) return 'max'
	if (service === 'deezer') return level === 'hires96' || level === 'cd' ? 'max' : level
	if (service === 'soundeo') return level === 'mp3_320' || level === 'mp3_128' ? 'mp3_320' : 'max'
	return level === 'mp3_128' ? 'mp3_320' : level
}

const LEVEL_RANK: Record<QualityLevel, number> = { mp3_compat: 0, mp3_128: 1, mp3_320: 2, cd: 3, hires96: 4, max: 5 }

/** The level an account's best quality corresponds to, as a rank comparable with LEVEL_RANK. */
function qualityRank(q: AudioQuality): number {
	if (!q.lossless) return (q.bitrateKbps ?? 128) > 128 ? 2 : 1
	if ((q.bitDepth ?? 16) <= 16 && (q.sampleRateHz ?? 44100) <= 48000) return 3
	return (q.sampleRateHz ?? 96000) <= 96000 ? 4 : 5
}

/** `level` as it comes out on `service` with that account: levels it cannot tell apart, or above the account, become another. */
export function fitQualityLevel(service: DownloadService, level: QualityLevel, account?: AudioQuality): QualityLevel {
	const l = serviceLevel(service, level)
	return account && l !== 'max' && l !== 'mp3_compat' && LEVEL_RANK[l] >= qualityRank(account) ? 'max' : l
}

const FLAC = (bitDepth: number, sampleRateHz: number): AudioQuality => ({ codec: 'flac', lossless: true, bitDepth, sampleRateHz })
const MP3 = (bitrateKbps: number): AudioQuality => ({ codec: 'mp3', lossless: false, bitrateKbps })
/** The most each level lets through ('max' lets everything through). */
const LEVEL_CAP: Partial<Record<QualityLevel, AudioQuality>> = {
	hires96: FLAC(24, 96000),
	cd: FLAC(16, 44100),
	mp3_320: MP3(320),
	mp3_128: MP3(128)
}

/**
 * What a download will come out in: the best the track has (`max`), within what the account gets and the level
 * picked. Mirrors how the queue opens the audio and converts 'mp3_compat'.
 */
export function expectedQuality(
	max: AudioQuality,
	service: DownloadService,
	level: QualityLevel,
	account?: AudioQuality
): AudioQuality {
	const l = fitQualityLevel(service, level, account)
	if (l === 'mp3_compat') {
		// YouTube/SoundCloud audio is converted (320 from a lossless original, else 192); Qobuz/Deezer send their MP3.
		if (isLossy(service)) return max.codec === 'mp3' ? max : MP3(max.lossless ? 320 : 192)
		return account && !account.lossless && (account.bitrateKbps ?? 320) < 320 ? account : MP3(320)
	}
	let q = max
	if (account && !isLossy(service) && qualityRank(account) < qualityRank(q)) q = account
	const cap = LEVEL_CAP[l]
	if (cap && qualityRank(cap) < qualityRank(q)) q = cap
	return q
}

/** Quality tiers, for summaries. */
export type QualityTier = 'hires' | 'cd' | 'lossy'
export function qualityTier(q: AudioQuality): QualityTier {
	if (!q.lossless) return 'lossy'
	return (q.bitDepth ?? 16) > 16 || (q.sampleRateHz ?? 44100) > 48000 ? 'hires' : 'cd'
}

// ---------- the "Calidad y formato" selector ----------

/** One choice of the "Calidad y formato" selector: the quality to download in, and the format to save the file as. */
export interface DownloadPreset {
	level: QualityLevel
	format: OutputFormat
	label: string
	group: string
}

const GROUP = {
	original: 'Sin convertir',
	aiff: 'AIFF · sin pérdida, para DJ',
	wav: 'WAV · sin pérdida',
	mp3: 'MP3 · con pérdida'
}

/**
 * Every choice, best first within each group. AIFF/WAV keep the bits and kHz of what's downloaded, so their own
 * levels matter (older CDJs don't read hi-res). "MP3 320 kbps" is the always-an-MP3 level ('mp3_compat').
 */
export const DOWNLOAD_PRESETS: DownloadPreset[] = [
	{ level: 'max', format: 'original', group: GROUP.original, label: 'FLAC · máxima disponible' },
	{ level: 'hires96', format: 'original', group: GROUP.original, label: 'FLAC · hasta 24-bit/96 kHz' },
	{ level: 'cd', format: 'original', group: GROUP.original, label: 'FLAC · CD 16-bit/44.1 kHz' },
	{ level: 'max', format: 'aiff', group: GROUP.aiff, label: 'AIFF · máxima disponible' },
	{ level: 'hires96', format: 'aiff', group: GROUP.aiff, label: 'AIFF · hasta 24-bit/96 kHz' },
	{ level: 'cd', format: 'aiff', group: GROUP.aiff, label: 'AIFF · 16-bit/44.1 kHz' },
	{ level: 'max', format: 'wav', group: GROUP.wav, label: 'WAV · máxima disponible' },
	{ level: 'hires96', format: 'wav', group: GROUP.wav, label: 'WAV · hasta 24-bit/96 kHz' },
	{ level: 'cd', format: 'wav', group: GROUP.wav, label: 'WAV · 16-bit/44.1 kHz' },
	{ level: 'mp3_compat', format: 'original', group: GROUP.mp3, label: 'MP3 320 kbps' },
	{ level: 'mp3_128', format: 'original', group: GROUP.mp3, label: 'MP3 128 kbps' }
]

export const presetKey = (p: { level: QualityLevel; format: OutputFormat }) => `${p.level}:${p.format}`

/** The choice for a level and format (as stored in settings); a combination that isn't on the list gets the closest. */
export function findPreset(level: QualityLevel, format: OutputFormat): DownloadPreset {
	// Plain MP3 320 (from before the selector merged them) comes out as "MP3 320 kbps".
	const l = level === 'mp3_320' ? 'mp3_compat' : level
	return (
		DOWNLOAD_PRESETS.find((p) => p.level === l && p.format === format) ??
		DOWNLOAD_PRESETS.find((p) => p.level === l) ??
		DOWNLOAD_PRESETS.find((p) => p.format === format) ??
		DOWNLOAD_PRESETS[0]!
	)
}

/** The choices grouped for <optgroup>s, in order. */
export function groupPresets(presets: DownloadPreset[]): [string, DownloadPreset[]][] {
	const groups = new Map<string, DownloadPreset[]>()
	for (const p of presets) groups.set(p.group, [...(groups.get(p.group) ?? []), p])
	return [...groups]
}

/**
 * What a choice comes out as on `service`: levels it can't tell apart count as one, and so does Qobuz/Deezer's own
 * MP3 whether or not "always MP3" was asked for (it's the same file).
 */
function outcome(service: DownloadService, p: DownloadPreset, account?: AudioQuality): string {
	let level = fitQualityLevel(service, p.level, account)
	if (level === 'mp3_compat' && !isLossy(service)) level = fitQualityLevel(service, 'mp3_320', account)
	return `${level}:${p.format}`
}

/**
 * The choices when downloading from `service`: one per different result with that service and account, so it never
 * offers what it can't give. Without a service (automatic), all of them.
 */
export function presetOptions(service?: DownloadService, account?: AudioQuality): DownloadPreset[] {
	if (!service) return DOWNLOAD_PRESETS
	const seen = new Set<string>()
	const out: DownloadPreset[] = []
	for (const p of DOWNLOAD_PRESETS) {
		const key = outcome(service, p, account)
		if (seen.has(key)) continue
		seen.add(key)
		if (p.level !== 'max' || p.format !== 'original') out.push(p)
		else {
			const max = account && !isLossy(service) ? qualityLabel(account) : SERVICE_MAX_SHORT[service]
			const upTo = service === 'qobuz' && account?.lossless ? 'hasta ' : ''
			out.push({ ...p, label: `Sin convertir · ${upTo}${max}` })
		}
	}
	return out
}

/** What the best quality gives on each service when the account's own limit isn't known (yet). */
const SERVICE_MAX_SHORT: Record<DownloadService, string> = {
	qobuz: 'hasta FLAC 24-bit/192 kHz',
	deezer: 'FLAC 16-bit/44.1 kHz',
	soundeo: 'WAV 16-bit/44.1 kHz',
	youtube: 'AAC ~128 kbps (256 con Premium)',
	soundcloud: 'hasta AAC 160 kbps u original'
}

/** `preset` as it comes out on `service`: always one of `presetOptions(service, account)`. */
export function fitPreset(service: DownloadService, preset: DownloadPreset, account?: AudioQuality): DownloadPreset {
	const key = outcome(service, preset, account)
	const options = presetOptions(service, account)
	return options.find((p) => outcome(service, p, account) === key) ?? options[0]!
}

// ---------- conversions and their warning ----------

/** What a choice converts the downloads to; null: they're saved as the service delivers them. */
export type ConversionTarget = 'aiff' | 'wav' | 'mp3'

export function conversionTarget(level: QualityLevel, format: OutputFormat): ConversionTarget | null {
	if (format !== 'original') return format
	return level === 'mp3_compat' ? 'mp3' : null
}

export const TARGET_LABEL: Record<ConversionTarget, string> = { aiff: 'AIFF', wav: 'WAV', mp3: 'MP3 320' }

/**
 * The file a download of quality `q` ends up as in `format`. Mirrors the queue: AIFF/WAV keep the sample rate, in
 * 24-bit only when there are more than 16 bits to keep. (MP3 is already part of `expectedQuality`.)
 */
export function outputQuality(format: OutputFormat, q: AudioQuality): AudioQuality {
	if (format === 'original') return q
	const bitDepth = q.lossless && (q.bitDepth ?? 16) > 16 ? 24 : 16
	return { codec: format, lossless: true, bitDepth, sampleRateHz: q.sampleRateHz ?? 44100, convertedFrom: q }
}

/**
 * Whether what will be downloaded (`q`, after the MP3 conversion if any) falls short of the conversion asked for:
 * lossy audio for AIFF/WAV (converting doesn't bring the quality back), under 320 kbps for MP3 320.
 */
export function belowTarget(target: ConversionTarget | null, q: AudioQuality): boolean {
	if (target === 'aiff' || target === 'wav') return !q.lossless
	if (target === 'mp3') return !q.lossless && (q.bitrateKbps ?? 0) < 320
	return false
}

/** The warning, in a few words. */
export function belowTargetShort(target: ConversionTarget): string {
	return target === 'mp3' ? 'Menos de 320 kbps' : 'Fuente con pérdida'
}

/** Hi-res (above CD quality) gets its own colour; lossy (or converted from lossy) audio, a warning one. */
export function qualityTone(q: AudioQuality | null | undefined): string {
	if (!q) return 'text-muted'
	if (!q.lossless || (q.convertedFrom && !q.convertedFrom.lossless)) return 'text-amber-300'
	if ((q.bitDepth ?? 16) > 16 || (q.sampleRateHz ?? 44100) > 48000) return 'text-sky-300'
	return 'text-emerald-300'
}

export const SERVICE_COLOR: Record<AccountService, string> = {
	spotify: '#1ed760',
	ytmusic: '#ff3b30',
	qobuz: '#4b8bf5',
	deezer: '#a238ff',
	soundcloud: '#ff5500',
	soundeo: '#f5a623'
}

export function duration(ms: number | null | undefined) {
	if (!ms) return '–'
	const s = Math.round(ms / 1000)
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function bytes(n: number | null | undefined) {
	if (!n) return ''
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
	return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function cx(...classes: (string | false | null | undefined)[]) {
	return classes.filter(Boolean).join(' ')
}
