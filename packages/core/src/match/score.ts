import type { SourceTrack, TargetTrack } from '../types'

/** Words that change which recording a track is: a mismatch on these strongly suggests the wrong version. */
const VERSION_WORDS = [
	'live',
	'remix',
	'acoustic',
	'instrumental',
	'karaoke',
	'demo',
	'cover',
	'sped up',
	'slowed',
	'en vivo',
	'acustico'
]

export function normalize(s: string): string {
	return s
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036F]/g, '')
		.replace(/&/g, ' and ')
		.replace(/[\u2019'`]/g, '')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
}

/** Remove featuring credits and remaster/edition noise, but keep meaningful version info (live, remix…). */
export function cleanTitle(title: string): string {
	return title
		.replace(/[([](?:feat|ft|featuring|with|con)\.?\s[^)\]]*[)\]]/gi, ' ')
		.replace(/\s[-–]\s(?:feat|ft)\.?\s.*$/i, ' ')
		.replace(/\s(?:feat|ft)\.\s.*$/i, ' ')
		.replace(
			/[([][^)\]]*(?:remaster|deluxe|edition|explicit|clean|mono|stereo|single version|album version|radio edit)[^)\]]*[)\]]/gi,
			' '
		)
		.replace(/\s[-–]\s(?:\d{4}\s)?(?:digital(?:ly)?\s)?remaster(?:ed)?(?:\s\d{4})?(?:\sversion)?\s*$/i, ' ')
		.replace(/\s[-–]\s(?:single|album|radio) (?:version|edit)\s*$/i, ' ')
}

function tokens(s: string): string[] {
	return normalize(s).split(' ').filter(Boolean)
}

/** Sørensen–Dice coefficient over word tokens (order-insensitive, tolerant to extra words). */
export function tokenSimilarity(a: string, b: string): number {
	const ta = tokens(a)
	const tb = tokens(b)
	if (!ta.length && !tb.length) return 1
	if (!ta.length || !tb.length) return 0
	const counts = new Map<string, number>()
	for (const t of ta) counts.set(t, (counts.get(t) ?? 0) + 1)
	let common = 0
	for (const t of tb) {
		const c = counts.get(t)
		if (c) {
			common++
			counts.set(t, c - 1)
		}
	}
	return (2 * common) / (ta.length + tb.length)
}

function artistSimilarity(a: string[], b: string[]): number {
	if (!a.length || !b.length) return 0.5
	// Best pairing for the primary artist, or overlap of the whole credit list, whichever is higher.
	const primary = Math.max(...b.map((x) => tokenSimilarity(a[0]!, x)), ...a.map((x) => tokenSimilarity(x, b[0]!)))
	const all = tokenSimilarity(a.join(' '), b.join(' '))
	return Math.max(primary, all)
}

function durationScore(a?: number, b?: number): number | null {
	if (!a || !b) return null
	const diff = Math.abs(a - b) / 1000
	if (diff <= 2) return 1
	if (diff >= 15) return 0
	return 1 - (diff - 2) / 13
}

function versionPenalty(a: string, b: string): number {
	const na = normalize(a)
	const nb = normalize(b)
	let penalty = 0
	for (const w of VERSION_WORDS) {
		const re = new RegExp(`\\b${w}\\b`)
		if (re.test(na) !== re.test(nb)) penalty += 0.25
	}
	return Math.min(penalty, 0.5)
}

/** 0..1 confidence that `candidate` is the same recording as `source`. */
export function scoreMatch(
	source: Pick<SourceTrack, 'title' | 'artists' | 'durationMs' | 'isrc'>,
	candidate: TargetTrack
): number {
	if (source.isrc && candidate.isrc && source.isrc.toUpperCase() === candidate.isrc.toUpperCase()) return 1
	const title = tokenSimilarity(cleanTitle(source.title), cleanTitle(candidate.title))
	const artist = artistSimilarity(source.artists, candidate.artists)
	const duration = durationScore(source.durationMs, candidate.durationMs)
	const base = duration === null ? 0.6 * title + 0.4 * artist : 0.5 * title + 0.3 * artist + 0.2 * duration
	const score = base - versionPenalty(source.title, candidate.title)
	return Math.max(0, Math.min(1, Math.round(score * 1000) / 1000))
}

/**
 * YouTube video titles look like "Artist - Title (Official Video)" and the channel stands in for the artist.
 * Drop the video noise and split off the "Artist - " prefix before scoring like any other candidate.
 */
export function scoreYouTube(
	source: Pick<SourceTrack, 'title' | 'artists' | 'durationMs'>,
	candidate: TargetTrack
): number {
	let title = candidate.title
		.replace(
			/[([][^)\]]*(?:official|video|audio|lyrics?|letra|visuali[sz]er|hd|hq|4k|m\/v|\bmv\b)[^)\]]*[)\]]/gi,
			' '
		)
		.replace(/\|.*$/, ' ')
	let artists = candidate.artists
	const parts = title.split(/\s[-–—]\s/)
	if (parts.length >= 2) {
		artists = [parts[0]!, ...artists]
		title = parts.slice(1).join(' ')
	}
	return scoreMatch({ ...source, isrc: undefined }, { ...candidate, title, artists })
}

export function searchQuery(track: Pick<SourceTrack, 'title' | 'artists'>): string {
	return `${track.artists[0] ?? ''} ${cleanTitle(track.title)}`.replace(/\s+/g, ' ').trim()
}
