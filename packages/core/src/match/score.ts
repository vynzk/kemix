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
	'nightcore',
	'8d',
	'bass boosted',
	'unplugged',
	'extended',
	'en vivo',
	'en directo',
	'acustico'
]

/**
 * Bracketed video noise from YouTube titles: "(Official Video)", "[Lyrics]", "(Video Oficial)"…
 * Never part of a track's title on a music service.
 */
const VIDEO_NOISE =
	/[([][^)\]]*\b(?:official|oficial|video|videoclip|audio|lyrics?|letra|visuali[sz]er|hd|hq|4k|m\/v|mv)\b[^)\]]*[)\]]/gi

export function normalize(s: string): string {
	return s
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/&/g, ' and ')
		.replace(/[’'`]/g, '')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
}

/** Letters and digits only: "AC/DC" and "ACDC", or "Bad Bunny" and "BadBunny", come out the same. */
function compact(s: string): string {
	return normalize(s).replace(/ /g, '')
}

/**
 * Remove featuring credits, remaster/edition noise, soundtrack credits and YouTube video noise,
 * but keep meaningful version info (live, remix…).
 */
export function cleanTitle(title: string): string {
	// Bracketed parts go first: a " - feat. …" inside "(Radio Edit - feat. …)" mustn't cut the brackets in half.
	return (
		title
			.replace(VIDEO_NOISE, ' ')
			.replace(/\s\|\s.*$/, ' ')
			.replace(/[([](?:feat|ft|featuring|with|con)\.?\s[^)\]]*[)\]]/gi, ' ')
			.replace(
				/[([][^)\]]*(?:remaster|deluxe|edition|explicit|clean|mono|stereo|single version|album version|radio edit|original mix|bonus track)[^)\]]*[)\]]/gi,
				' '
			)
			// Soundtrack credits: "Let It Go - From "Frozen"" vs "Let It Go (From "Frozen"/Soundtrack Version)".
			.replace(/[([]from\s[^)\]]*[)\]]/gi, ' ')
			.replace(/\s[-–]\s(?:feat|ft)\.?\s.*$/i, ' ')
			.replace(/\s(?:feat|ft)\.\s.*$/i, ' ')
			.replace(/\s[-–]\s(?:from|de)\s["“'«].*$/i, ' ')
			.replace(/\s[-–]\s(?:\d{4}\s)?(?:digital(?:ly)?\s)?remaster(?:ed)?(?:\s\d{4})?(?:\sversion)?\s*$/i, ' ')
			.replace(/\s[-–]\s(?:single|album|radio) (?:version|edit)\s*$/i, ' ')
			.replace(/\s[-–]\s(?:original mix|bonus track)\s*$/i, ' ')
	)
}

/** Just the song's name: cleaned, without anything in brackets or after " - ". Drops version info: for searching only. */
export function coreTitle(title: string): string {
	const clean = cleanTitle(title)
	const core = clean
		.replace(/[([][^)\]]*[)\]]/g, ' ')
		.replace(/\s[-–—]\s.*$/, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	return core || clean.replace(/\s+/g, ' ').trim()
}

/** YouTube channel names stand in for artists: "Daft Punk - Topic", "DaftPunkVEVO", "Daft Punk Official" → "Daft Punk". */
export function cleanArtist(name: string): string {
	const clean = name
		.replace(/\s+-\s+Topic$/i, '')
		.replace(/VEVO$/i, '')
		.replace(/\s+(?:Official|Oficial)$/i, '')
		.trim()
	return clean || name.trim()
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

function sameName(a: string, b: string): boolean {
	const ca = compact(a)
	return !!ca && ca === compact(b)
}

function artistSimilarity(a: string[], b: string[]): number {
	const ca = a.map(cleanArtist).filter(Boolean)
	const cb = b.map(cleanArtist).filter(Boolean)
	if (!ca.length || !cb.length) return 0.5
	const sim = (x: string, y: string) => (sameName(x, y) ? 1 : tokenSimilarity(x, y))
	// Best pairing for the primary artist, or overlap of the whole credit list, whichever is higher.
	const primary = Math.max(...cb.map((x) => sim(ca[0]!, x)), ...ca.map((x) => sim(x, cb[0]!)))
	const all = tokenSimilarity(ca.join(' '), cb.join(' '))
	return Math.max(primary, all)
}

/** Words joining artist names: "A & B", "A x B", "A feat. B"… */
const ARTIST_JOINERS = new Set(['and', 'x', 'y', 'e', 'feat', 'ft', 'featuring', 'with', 'con', 'vs'])

/**
 * "Artist - Title", common for YouTube videos (and so in YouTube Music libraries) → "Title",
 * when what's before the dash is nothing but the track's artists.
 */
export function stripArtistPrefix(title: string, artists: string[]): string {
	const m = title.match(/^(.+?)\s[-–—]\s(.+)$/)
	if (!m) return title
	const names = artists.map(cleanArtist).filter(Boolean)
	if (names.some((a) => sameName(m[1]!, a))) return m[2]!
	const prefix = tokens(m[1]!)
	const known = new Set(names.flatMap(tokens))
	const onlyArtists = prefix.every((w) => known.has(w) || ARTIST_JOINERS.has(w))
	const namesOne = names.some((a) => {
		const t = tokens(a)
		return t.length > 0 && t.every((w) => prefix.includes(w))
	})
	return onlyArtists && namesOne ? m[2]! : title
}

function durationScore(a?: number, b?: number): number | null {
	if (!a || !b) return null
	const diff = Math.abs(a - b) / 1000
	if (diff <= 2) return 1
	if (diff >= 15) return 0
	return 1 - (diff - 2) / 13
}

/** The version words ("live", "remix"…) in a title. */
function versionWords(s: string): string[] {
	const n = normalize(s)
	return VERSION_WORDS.filter((w) => new RegExp(`\\b${w}\\b`).test(n))
}

function versionPenalty(a: string, b: string): number {
	const wa = versionWords(a)
	const wb = versionWords(b)
	const mismatches = VERSION_WORDS.filter((w) => wa.includes(w) !== wb.includes(w)).length
	return Math.min(mismatches * 0.25, 0.5)
}

/** 0..1 confidence that `candidate` is the same recording as `source`. */
export function scoreMatch(
	source: Pick<SourceTrack, 'title' | 'artists' | 'durationMs' | 'isrc'>,
	candidate: TargetTrack
): number {
	if (source.isrc && candidate.isrc && source.isrc.toUpperCase() === candidate.isrc.toUpperCase()) return 1
	const sourceTitle = cleanTitle(stripArtistPrefix(source.title, source.artists))
	const candidateTitle = cleanTitle(stripArtistPrefix(candidate.title, candidate.artists))
	const title = tokenSimilarity(sourceTitle, candidateTitle)
	const artist = artistSimilarity(source.artists, candidate.artists)
	const duration = durationScore(source.durationMs, candidate.durationMs)
	const base = duration === null ? 0.6 * title + 0.4 * artist : 0.5 * title + 0.3 * artist + 0.2 * duration
	const score = base - versionPenalty(sourceTitle, candidateTitle)
	return Math.max(0, Math.min(1, Math.round(score * 1000) / 1000))
}

/** An artist credit split into names: "DJ A, Moura Dj & DJ B (MC C)" or "DJ A e MC C" → each name. */
function splitArtists(credit: string): string[] {
	return credit
		.split(/[,&/()[\]]|\s(?:and|e|y|x|feat\.?|ft\.?|featuring|with|con)\s/i)
		.map((a) => a.trim())
		.filter(Boolean)
}

/**
 * YouTube video titles name the artist before the title ("Artist - Title (Official Video)") or after it
 * ("Title - Artists", common in Brazilian funk, sometimes with the album in between: "Title - Album - Artists"),
 * and the channel stands in for the artist. Drop the video noise and score both readings like any other candidate:
 * the one that fits the title wins.
 */
export function scoreYouTube(
	source: Pick<SourceTrack, 'title' | 'artists' | 'durationMs'>,
	candidate: TargetTrack
): number {
	const title = candidate.title.replace(VIDEO_NOISE, ' ').replace(/\|.*$/, ' ')
	const score = (t: string, artists: string[]) =>
		scoreMatch({ ...source, isrc: undefined }, { ...candidate, title: t, artists })
	const parts = title.split(/\s[-–—]\s/)
	if (parts.length < 2) return score(title, candidate.artists)
	const [first, ...rest] = parts as [string, ...string[]]
	const artistFirst = score(rest.join(' '), [first, ...candidate.artists])
	// Version words after the title ("Title - DJ X Remix - Artist") still say which recording the video is.
	const titleFirst = score([first, ...versionWords(rest.join(' '))].join(' '), [
		...rest.flatMap(splitArtists),
		...candidate.artists
	])
	return Math.max(artistFirst, titleFirst)
}

/**
 * Un archivo de Soulseek, con artista y título sacados de su ruta. La ruta suele decir "Artista - Título", pero a veces
 * es "Título - Artista": se puntúan las dos lecturas, como un video de YouTube, y gana la que encaje.
 */
export function scoreSoulseek(
	source: Pick<SourceTrack, 'title' | 'artists' | 'durationMs' | 'isrc'>,
	candidate: TargetTrack
): number {
	const parsed = scoreMatch(source, candidate)
	if (!candidate.artists.length) return parsed
	const asWritten = { ...candidate, title: `${candidate.artists.join(', ')} - ${candidate.title}`, artists: [] }
	return Math.max(parsed, scoreYouTube(source, asWritten))
}

/** What searches are built from: the main artist, the cleaned title and the bare song name. */
export function queryParts(track: Pick<SourceTrack, 'title' | 'artists'>) {
	const title = stripArtistPrefix(track.title, track.artists)
	const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
	let artist = cleanArtist(track.artists[0] ?? '')
	// "BadBunnyVEVO" with a "Bad Bunny - …" title: the title spells the name properly.
	const prefix = title === track.title ? '' : track.title.slice(0, track.title.length - title.length).replace(/\s[-–—]\s$/, '')
	if (prefix && sameName(prefix, artist)) artist = prefix
	return { artist: squash(artist), title: squash(cleanTitle(title)), core: coreTitle(title) }
}

/**
 * Searches to try for a track, most specific first. Each service's search is picky in its own way (extra words in
 * the title, punctuation, how an artist is spelled), so the broader ones catch what the first one misses.
 */
export function searchQueries(track: Pick<SourceTrack, 'title' | 'artists'>): string[] {
	const { artist, title, core } = queryParts(track)
	const list = [
		`${artist} ${title}`,
		`${artist} ${core}`,
		// Without accents or punctuation ("¿", "'", "/", "!"…), which trip some search engines.
		normalize(`${artist} ${core}`),
		// Song name only: for artists spelled differently on each service ("P!nk", "JAY Z", other scripts…).
		core
	]
	const seen = new Set<string>()
	return list
		.map((q) => q.replace(/\s+/g, ' ').trim())
		.filter((q) => {
			const key = q.toLowerCase()
			if (!q || seen.has(key)) return false
			seen.add(key)
			return true
		})
}

/** The main search for a track. */
export function searchQuery(track: Pick<SourceTrack, 'title' | 'artists'>): string {
	return searchQueries(track)[0] ?? ''
}
