import type { AudioQuality, DownloadService, SourceService } from '@kemix/core'

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
