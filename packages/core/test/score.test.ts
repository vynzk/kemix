import { describe, expect, it } from 'vitest'
import {
	cleanArtist,
	cleanTitle,
	coreTitle,
	scoreMatch,
	scoreYouTube,
	searchQueries,
	searchQuery,
	stripArtistPrefix,
	tokenSimilarity
} from '../src/match/score'
import type { TargetTrack } from '../src/types'

const target = (t: Partial<TargetTrack>): TargetTrack => ({
	service: 'qobuz',
	id: '1',
	url: 'https://play.qobuz.com/track/1',
	title: '',
	artists: [],
	...t
})

describe('cleanTitle', () => {
	it('strips featuring credits', () => {
		expect(cleanTitle('Song (feat. Someone)').trim()).toBe('Song')
		expect(cleanTitle('Song [ft. A & B]').trim()).toBe('Song')
		expect(cleanTitle('Song - feat. Someone').trim()).toBe('Song')
	})
	it('strips remaster / edition noise', () => {
		expect(cleanTitle('Bohemian Rhapsody - Remastered 2011').trim()).toBe('Bohemian Rhapsody')
		expect(cleanTitle('Bohemian Rhapsody - 2011 Remaster').trim()).toBe('Bohemian Rhapsody')
		expect(cleanTitle('Song (2019 Remaster)').trim()).toBe('Song')
		expect(cleanTitle('Song (Deluxe Edition)').trim()).toBe('Song')
		expect(cleanTitle('Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)').trim()).toBe('Get Lucky')
	})
	it('keeps meaningful version info', () => {
		expect(cleanTitle('Song (Live)')).toContain('Live')
		expect(cleanTitle('Song - Remix')).toContain('Remix')
	})
	it('strips YouTube video noise', () => {
		expect(cleanTitle('Song (Official Music Video)').trim()).toBe('Song')
		expect(cleanTitle('Canción [Video Oficial]').trim()).toBe('Canción')
		expect(cleanTitle('Song (Lyrics) | Some Channel').trim()).toBe('Song')
	})
	it('strips soundtrack credits', () => {
		expect(cleanTitle('Let It Go - From "Frozen"/Soundtrack Version').trim()).toBe('Let It Go')
		expect(cleanTitle('Let It Go (From "Frozen")').trim()).toBe('Let It Go')
	})
})

describe('coreTitle', () => {
	it('keeps only the song name', () => {
		expect(coreTitle('Bohemian Rhapsody - Live at Wembley')).toBe('Bohemian Rhapsody')
		expect(coreTitle('Song (Extended Mix) [feat. X]')).toBe('Song')
	})
})

describe('cleanArtist / stripArtistPrefix', () => {
	it('turns channel names into artist names', () => {
		expect(cleanArtist('Daft Punk - Topic')).toBe('Daft Punk')
		expect(cleanArtist('DaftPunkVEVO')).toBe('DaftPunk')
	})
	it('drops an "Artist - " prefix only when it names the artist', () => {
		expect(stripArtistPrefix('Bad Bunny - Tití Me Preguntó', ['Bad Bunny'])).toBe('Tití Me Preguntó')
		expect(stripArtistPrefix('Bad Bunny & Jhay Cortez - Dákiti', ['Bad Bunny', 'Jhay Cortez'])).toBe('Dákiti')
		expect(stripArtistPrefix('Bohemian Rhapsody - Remastered 2011', ['Queen'])).toBe('Bohemian Rhapsody - Remastered 2011')
	})
})

describe('tokenSimilarity', () => {
	it('ignores case, accents and punctuation', () => {
		expect(tokenSimilarity('Canción Número Uno!', 'cancion numero uno')).toBe(1)
	})
	it('is 0 for unrelated strings', () => {
		expect(tokenSimilarity('hello world', 'foo bar')).toBe(0)
	})
})

describe('scoreMatch', () => {
	const src = { title: 'Bohemian Rhapsody - Remastered 2011', artists: ['Queen'], durationMs: 354_000 }

	it('is 1 when ISRCs match', () => {
		expect(scoreMatch({ ...src, isrc: 'GBUM71029604' }, target({ title: 'x', isrc: 'gbum71029604' }))).toBe(1)
	})

	it('scores the same song on another service very high', () => {
		const s = scoreMatch(src, target({ title: 'Bohemian Rhapsody (Remastered 2011)', artists: ['Queen'], durationMs: 355_000 }))
		expect(s).toBeGreaterThanOrEqual(0.95)
	})

	it('penalises a live version of a studio track', () => {
		const s = scoreMatch(src, target({ title: 'Bohemian Rhapsody (Live)', artists: ['Queen'], durationMs: 354_000 }))
		expect(s).toBeLessThan(0.9)
	})

	it('penalises a big duration difference', () => {
		const close = scoreMatch(src, target({ title: 'Bohemian Rhapsody', artists: ['Queen'], durationMs: 355_000 }))
		const far = scoreMatch(src, target({ title: 'Bohemian Rhapsody', artists: ['Queen'], durationMs: 200_000 }))
		expect(far).toBeLessThan(close)
		expect(far).toBeLessThan(0.9)
	})

	it('scores a different artist low', () => {
		const s = scoreMatch(src, target({ title: 'Bohemian Rhapsody', artists: ['Some Cover Band'], durationMs: 354_000 }))
		expect(s).toBeLessThan(0.9)
	})

	it('matches a YouTube Music video entry with the song on a music service', () => {
		const s = scoreMatch(
			{ title: 'Bad Bunny - Tití Me Preguntó (Video Oficial)', artists: ['BadBunnyVEVO'], durationMs: 243_000 },
			target({ title: 'Tití Me Preguntó', artists: ['Bad Bunny'], durationMs: 243_700 })
		)
		expect(s).toBeGreaterThanOrEqual(0.9)
	})

	it('matches soundtrack credits written differently', () => {
		const s = scoreMatch(
			{ title: 'Let It Go - From "Frozen"/Soundtrack Version', artists: ['Idina Menzel'], durationMs: 224_000 },
			target({ title: 'Let It Go (From "Frozen")', artists: ['Idina Menzel'], durationMs: 224_500 })
		)
		expect(s).toBeGreaterThanOrEqual(0.95)
	})

	it('treats artist names that differ only in spacing or punctuation as the same', () => {
		const s = scoreMatch(
			{ title: 'Back In Black', artists: ['AC/DC'], durationMs: 255_000 },
			target({ title: 'Back In Black', artists: ['ACDC'], durationMs: 255_000 })
		)
		expect(s).toBe(1)
	})

	it('handles featured artists listed separately', () => {
		const s = scoreMatch(
			{ title: 'Stay (with Justin Bieber)', artists: ['The Kid LAROI', 'Justin Bieber'], durationMs: 141_000 },
			target({ title: 'Stay', artists: ['The Kid LAROI', 'Justin Bieber'], durationMs: 141_800 })
		)
		expect(s).toBeGreaterThanOrEqual(0.95)
	})
})

describe('searchQuery', () => {
	it('uses primary artist and cleaned title', () => {
		expect(searchQuery({ title: 'Song (feat. X) - 2011 Remaster', artists: ['A', 'X'] })).toBe('A Song')
	})
})

describe('searchQueries', () => {
	it('goes from the full title to broader searches, without repeats', () => {
		expect(searchQueries({ title: '¿Qué Hay De Malo? (En Vivo)', artists: ['Kevin Kaarl'] })).toEqual([
			'Kevin Kaarl ¿Qué Hay De Malo? (En Vivo)',
			'Kevin Kaarl ¿Qué Hay De Malo?',
			'kevin kaarl que hay de malo',
			'¿Qué Hay De Malo?'
		])
	})
	it('cleans YouTube-style titles and channel names first', () => {
		expect(searchQueries({ title: 'Bad Bunny - Tití Me Preguntó (Video Oficial)', artists: ['Bad Bunny - Topic'] })[0]).toBe(
			'Bad Bunny Tití Me Preguntó'
		)
	})
	it('never returns an empty query', () => {
		expect(searchQueries({ title: 'Song', artists: [] })).toEqual(['Song'])
	})
})

describe('scoreYouTube', () => {
	const track = { title: 'Get Lucky', artists: ['Daft Punk'], durationMs: 248_000 }
	const yt = (title: string, channel: string, durationMs = 248_000) =>
		({ service: 'youtube', id: 'x', url: '', title, artists: [channel], durationMs }) as const

	it('sees through "Artist - Title (Official Video)" titles', () => {
		expect(scoreYouTube(track, yt('Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams', 'Daft Punk'))).toBeGreaterThan(0.9)
		expect(scoreYouTube(track, yt('Daft Punk - Get Lucky (Official Video)', 'convar HUN'))).toBeGreaterThan(0.85)
	})

	it('still penalizes other versions and songs', () => {
		expect(scoreYouTube(track, yt('Daft Punk - Get Lucky (Live)', 'Daft Punk'))).toBeLessThan(0.8)
		expect(scoreYouTube(track, yt('Daft Punk - One More Time', 'Daft Punk', 320_000))).toBeLessThan(0.5)
	})

	describe('"Title - Artists" titles', () => {
		const funk = { title: 'ROCK', artists: ['Moura Dj', 'MC VK DA VS'], durationMs: 119_000 }

		it('reads the artists after the title, with or without an album in between', () => {
			expect(scoreYouTube(funk, yt('ROCK - DJ AIMI, MOURA DJ & DJ MODDER (MC VK DA VS)', 'Dj Aimi', 115_000))).toBeGreaterThan(0.9)
			expect(
				scoreYouTube(funk, yt('ROCK - “UnKnOwN” (Faixa 9) - Moura Dj, Dj Aimi, Dj Modder e Mc Vk da Vs', 'Moura Dj', 116_000))
			).toBeGreaterThan(0.9)
		})

		it('still tells other songs by the same artists apart', () => {
			expect(
				scoreYouTube(funk, yt('TUIN NO PAREDÃO X BARULHO DO ROCK - “UnKnOwN” (Faixa 6) - Moura Dj e Mc Vk da Vs', 'Moura Dj', 130_000))
			).toBeLessThan(0.6)
		})

		it('keeps version words found after the title', () => {
			expect(scoreYouTube(track, yt('Get Lucky - Some DJ Remix - Daft Punk', 'Some DJ'))).toBeLessThan(0.8)
			expect(scoreYouTube(funk, yt('ROCK - Moura Dj [8D Sound]', '8D Sound', 119_000))).toBeLessThan(0.8)
		})
	})
})
