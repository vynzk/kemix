import path from 'node:path'

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
const MAX_SEGMENT = 120

/** Make a single path segment safe on Windows, macOS and Linux. */
export function sanitizeSegment(name: string, fallback = 'Sin título'): string {
	let s = name
		.normalize('NFC')
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
		.replace(/\s+/g, ' ')
		.trim()
		// Windows silently drops trailing dots/spaces, which breaks later lookups.
		.replace(/[. ]+$/, '')
	if (!s) s = fallback
	if (RESERVED.test(s)) s = `_${s}`
	if (s.length > MAX_SEGMENT) s = s.slice(0, MAX_SEGMENT).replace(/[. ]+$/, '')
	return s
}

const MIME_EXT: Record<string, string> = {
	'audio/flac': 'flac',
	'audio/x-flac': 'flac',
	'audio/mpeg': 'mp3',
	'audio/mp3': 'mp3',
	'audio/mp4': 'm4a',
	'audio/aac': 'm4a',
	'audio/ogg': 'ogg'
}

export function extensionFor(mimeType: string): string {
	return MIME_EXT[mimeType.split(';')[0]!.trim().toLowerCase()] ?? 'audio'
}

export function playlistDir(root: string, playlistName: string): string {
	return path.join(root, sanitizeSegment(playlistName))
}

export function trackFileName(opts: { position: number; total: number; artists: string[]; title: string; ext: string }) {
	const width = Math.max(2, String(opts.total).length)
	const num = String(opts.position + 1).padStart(width, '0')
	const artist = opts.artists.slice(0, 3).join(', ') || 'Desconocido'
	const base = sanitizeSegment(`${num} - ${artist} - ${opts.title}`)
	return `${base}.${opts.ext}`
}
