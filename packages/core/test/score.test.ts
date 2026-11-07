import { describe, expect, it } from 'vitest'
import { cleanTitle, scoreMatch, scoreYouTube, searchQuery, tokenSimilarity } from '../src/match/score'
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
	})
	it('keeps meaningful version info', () => {
		expect(cleanTitle('Song (Live)')).toContain('Live')
		expect(cleanTitle('Song - Remix')).toContain('Remix')
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
})
