import type { SourceService, TargetService } from '@kemix/core'

export const SERVICE_LABEL: Record<SourceService | TargetService, string> = {
	spotify: 'Spotify',
	ytmusic: 'YouTube Music',
	qobuz: 'Qobuz',
	deezer: 'Deezer'
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
