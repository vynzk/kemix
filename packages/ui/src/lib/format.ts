import type { AudioQuality, DownloadService, QualityLevel, SourceService } from '@kemix/core'

export const SERVICE_LABEL: Record<SourceService | DownloadService, string> = {
	spotify: 'Spotify',
	ytmusic: 'YouTube Music',
	qobuz: 'Qobuz',
	deezer: 'Deezer',
	youtube: 'YouTube'
}

const CODEC_LABEL: Record<AudioQuality['codec'], string> = {
	flac: 'FLAC',
	alac: 'ALAC',
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
	{ value: 'mp3_128', label: 'MP3 128 kbps', hint: 'Con pérdida. Qobuz no baja de MP3 320: ahí se descarga en 320.' }
]

/** Levels each service can tell apart, best first; the others come out the same as one of these. */
const SERVICE_LEVELS: Record<DownloadService, QualityLevel[]> = {
	qobuz: ['max', 'hires96', 'cd', 'mp3_320'],
	deezer: ['max', 'mp3_320', 'mp3_128'],
	youtube: ['max']
}

/** What 'max' gives on each service when the account's own limit isn't known (yet). */
const SERVICE_MAX_LABEL: Record<DownloadService, string> = {
	qobuz: 'Máxima (hasta FLAC 24-bit/192 kHz)',
	deezer: 'Máxima (FLAC 16-bit/44.1 kHz)',
	youtube: 'AAC ~128 kbps (única calidad)'
}

/** Mirrors `serviceQualityLevel` in @kemix/core (the UI only imports types from it). */
function serviceLevel(service: DownloadService, level: QualityLevel): QualityLevel {
	if (service === 'youtube') return 'max'
	if (service === 'deezer') return level === 'hires96' || level === 'cd' ? 'max' : level
	return level === 'mp3_128' ? 'mp3_320' : level
}

const LEVEL_RANK: Record<QualityLevel, number> = { mp3_128: 1, mp3_320: 2, cd: 3, hires96: 4, max: 5 }

/** The level an account's best quality corresponds to, as a rank comparable with LEVEL_RANK. */
function qualityRank(q: AudioQuality): number {
	if (!q.lossless) return (q.bitrateKbps ?? 128) > 128 ? 2 : 1
	if ((q.bitDepth ?? 16) <= 16 && (q.sampleRateHz ?? 44100) <= 48000) return 3
	return (q.sampleRateHz ?? 96000) <= 96000 ? 4 : 5
}

/**
 * Quality choices when downloading from `service`: only the levels it can tell apart, and none above what the
 * account gets (`account`, its best quality, when known). 'Máxima' is always there.
 */
export function providerQualityOptions(service: DownloadService, account?: AudioQuality): { value: QualityLevel; label: string }[] {
	const rank = account && service !== 'youtube' ? qualityRank(account) : Infinity
	return SERVICE_LEVELS[service]
		.filter((l) => l === 'max' || LEVEL_RANK[l] < rank)
		.map((l) => ({
			value: l,
			label:
				l !== 'max'
					? QUALITY_LEVEL_OPTIONS.find((o) => o.value === l)!.label
					: account && service !== 'youtube'
						? `Máxima: ${qualityLabel(account)}`
						: SERVICE_MAX_LABEL[service]
		}))
}

/** `level` as it comes out on `service` with that account: always one of `providerQualityOptions`' values. */
export function fitQualityLevel(service: DownloadService, level: QualityLevel, account?: AudioQuality): QualityLevel {
	const l = serviceLevel(service, level)
	return account && l !== 'max' && LEVEL_RANK[l] >= qualityRank(account) ? 'max' : l
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
	deezer: '#a238ff'
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
