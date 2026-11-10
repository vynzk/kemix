import type { MusicalKey } from '../types'

/** Pitch-class names as written in tags: sharps, as ID3's TKEY asks for ("C#m", not "Dbm"). */
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

const mod12 = (n: number) => ((n % 12) + 12) % 12

/** The key as ID3 TKEY / Vorbis INITIALKEY want it: "Am", "F#m", "C". */
export function keyTag(key: MusicalKey): string {
	return `${SHARP_NAMES[mod12(key.tonic)]}${key.minor ? 'm' : ''}`
}

/** Camelot wheel position: 1–12 and A (minor) / B (major). C major is 8B, A minor 8A; each fifth up adds one. */
export function camelot(key: MusicalKey): string {
	// The relative major of a minor key shares its number.
	const major = key.minor ? mod12(key.tonic + 3) : mod12(key.tonic)
	return `${mod12(major * 7 + 7) + 1}${key.minor ? 'A' : 'B'}`
}

/** Open Key (Traktor): 1d is C major, 1m A minor; each fifth up adds one. */
export function openKey(key: MusicalKey): string {
	const major = key.minor ? mod12(key.tonic + 3) : mod12(key.tonic)
	return `${mod12(major * 7) + 1}${key.minor ? 'm' : 'd'}`
}

/**
 * Read a key written any of the ways tags, catalogs and DJ software write it: "Am", "A minor", "A♭m", "Abm", "G#",
 * "F# Major", "Bbmin", "8A" (Camelot), "1m"/"1d" (Open Key). Null for anything else (including "o", off key).
 */
export function parseKey(raw: string | null | undefined): MusicalKey | null {
	const s = raw?.trim().replace(/♯/g, '#').replace(/♭/g, 'b')
	if (!s) return null

	const wheel = s.match(/^0?(\d{1,2})\s*([ABabdm])$/)
	if (wheel) {
		const n = Number(wheel[1])
		if (n < 1 || n > 12) return null
		const letter = wheel[2]!
		// Camelot: A/B. Open Key: m/d.
		if (letter === 'A' || letter === 'a' || letter === 'B' || letter === 'b') {
			const minor = letter.toUpperCase() === 'A'
			// Inverse of `camelot`: n = (7·major + 7) mod 12 + 1, and 7 is its own inverse mod 12.
			const major = mod12((n - 8) * 7)
			return { tonic: minor ? mod12(major - 3) : major, minor }
		}
		const minor = letter === 'm'
		const major = mod12((n - 1) * 7)
		return { tonic: minor ? mod12(major - 3) : major, minor }
	}

	const named = s.match(/^([A-Ga-g])\s*(#|b|-?sharp|-?flat)?\s*(.*)$/i)
	if (!named) return null
	let tonic = LETTER[named[1]!.toUpperCase()]!
	const accidental = named[2]?.toLowerCase()
	if (accidental === '#' || accidental?.endsWith('sharp')) tonic++
	else if (accidental === 'b' || accidental?.endsWith('flat')) tonic--
	const rest = named[3]!.trim()
	let minor: boolean
	if (rest === '' || /^(maj|major|dur)\.?$/i.test(rest)) minor = false
	// A bare lowercase "m" (or "min", "minor", "moll") is minor; "M" alone would be major in some tools, but nobody
	// writes it that way for keys, so any "m…" here is minor.
	else if (/^(m|min|minor|moll)\.?$/i.test(rest)) minor = true
	else return null
	return { tonic: mod12(tonic), minor }
}

/** Same key: same tonic and mode. */
export function sameKey(a: MusicalKey | null, b: MusicalKey | null): boolean {
	return !!a && !!b && mod12(a.tonic) === mod12(b.tonic) && a.minor === b.minor
}
