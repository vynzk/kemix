import type { AudioQuality, DownloadService, QualityLevel, SourceService } from '@kemix/core'

export const SERVICE_LABEL: Record<SourceService | DownloadService, string> = {
	spotify: 'Spotify',
	ytmusic: 'YouTube Music',
	qobuz: 'Qobuz',
	deezer: 'Deezer',
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

/** Download quality choices, best first. The UI keeps @kemix/core type-only, so the list lives here too. */
export const QUALITY_LEVEL_OPTIONS: { value: QualityLevel; label: string; hint: string }[] = [
	{ value: 'max', label: 'Máxima disponible', hint: 'Qobuz hasta FLAC 24-bit/192 kHz; Deezer FLAC 16-bit/44.1 kHz.' },
	{ value: 'hires96', label: 'Hi-Res hasta 24-bit/96 kHz', hint: 'Qobuz FLAC hasta 24-bit/96 kHz; Deezer FLAC 16-bit/44.1 kHz.' },
	{ value: 'cd', label: 'CD (FLAC 16-bit/44.1 kHz)', hint: 'Sin pérdida, en archivos más chicos que Hi-Res.' },
	{ value: 'mp3_320', label: 'MP3 320 kbps', hint: 'Con pérdida. Ocupa unas 3 veces menos que FLAC CD.' },
	{ value: 'mp3_128', label: 'MP3 128 kbps', hint: 'Con pérdida. Qobuz no baja de MP3 320: ahí se descarga en 320.' },
	{
		value: 'mp3_compat',
		label: 'MP3 compatible (cualquier reproductor)',
		hint:
			'Siempre MP3, venga de donde venga: si el servicio lo entrega en otro formato (FLAC, AAC de YouTube, Opus) se ' +
			'convierte a MP3 de 320 kbps (192 kbps si el original ya tenía pérdida). Sirve para el auto, parlantes, ' +
			'celulares viejos o cualquier programa. La primera vez que hay que convertir, Kemix baja ffmpeg (unos 30 MB).'
	}
]

/** Levels each service can tell apart, best first; the others come out the same as one of these. */
const SERVICE_LEVELS: Record<DownloadService, QualityLevel[]> = {
	qobuz: ['max', 'hires96', 'cd', 'mp3_320', 'mp3_compat'],
	deezer: ['max', 'mp3_320', 'mp3_128', 'mp3_compat'],
	youtube: ['max', 'mp3_compat'],
	soundcloud: ['max', 'mp3_compat']
}

/** What 'max' gives on each service when the account's own limit isn't known (yet). */
const SERVICE_MAX_LABEL: Record<DownloadService, string> = {
	qobuz: 'Máxima (hasta FLAC 24-bit/192 kHz)',
	deezer: 'Máxima (FLAC 16-bit/44.1 kHz)',
	youtube: 'AAC ~128 kbps, 256 con Premium (única calidad)',
	soundcloud: 'La mejor que tenga (hasta AAC 160 kbps u original)'
}

/** Mirrors `serviceQualityLevel` in @kemix/core (the UI only imports types from it). */
function serviceLevel(service: DownloadService, level: QualityLevel): QualityLevel {
	// Its own choice everywhere (in core it's the same file as MP3 320 on Qobuz/Deezer, but the user asked for it).
	if (level === 'mp3_compat') return level
	if (isLossy(service)) return 'max'
	if (service === 'deezer') return level === 'hires96' || level === 'cd' ? 'max' : level
	return level === 'mp3_128' ? 'mp3_320' : level
}

const LEVEL_RANK: Record<QualityLevel, number> = { mp3_compat: 0, mp3_128: 1, mp3_320: 2, cd: 3, hires96: 4, max: 5 }

/** The level an account's best quality corresponds to, as a rank comparable with LEVEL_RANK. */
function qualityRank(q: AudioQuality): number {
	if (!q.lossless) return (q.bitrateKbps ?? 128) > 128 ? 2 : 1
	if ((q.bitDepth ?? 16) <= 16 && (q.sampleRateHz ?? 44100) <= 48000) return 3
	return (q.sampleRateHz ?? 96000) <= 96000 ? 4 : 5
}

/**
 * Quality choices when downloading from `service`: only the levels it can tell apart, and none above what the
 * account gets (`account`, its best quality, when known). 'Máxima' and 'MP3 compatible' are always there.
 */
export function providerQualityOptions(service: DownloadService, account?: AudioQuality): { value: QualityLevel; label: string }[] {
	const rank = account && !isLossy(service) ? qualityRank(account) : Infinity
	return SERVICE_LEVELS[service]
		.filter((l) => l === 'max' || l === 'mp3_compat' || LEVEL_RANK[l] < rank)
		.map((l) => ({
			value: l,
			label:
				l !== 'max'
					? QUALITY_LEVEL_OPTIONS.find((o) => o.value === l)!.label
					: account && !isLossy(service)
						? `Máxima: ${qualityLabel(account)}`
						: SERVICE_MAX_LABEL[service]
		}))
}

/** `level` as it comes out on `service` with that account: always one of `providerQualityOptions`' values. */
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

/** Hi-res (above CD quality) gets its own colour. */
export function qualityTone(q: AudioQuality | null | undefined): string {
	if (!q) return 'text-muted'
	if (!q.lossless) return 'text-amber-300'
	if ((q.bitDepth ?? 16) > 16 || (q.sampleRateHz ?? 44100) > 48000) return 'text-sky-300'
	return 'text-emerald-300'
}

export const SERVICE_COLOR: Record<SourceService, string> = {
	spotify: '#1ed760',
	ytmusic: '#ff3b30',
	qobuz: '#4b8bf5',
	deezer: '#a238ff',
	soundcloud: '#ff5500'
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
