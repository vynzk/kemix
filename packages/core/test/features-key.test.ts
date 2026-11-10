import { describe, expect, it } from 'vitest'
import { camelot, keyTag, openKey, parseKey, sameKey } from '../src/features/key'
import type { MusicalKey } from '../src/types'

const k = (tonic: number, minor: boolean): MusicalKey => ({ tonic, minor })

describe('key notations', () => {
	it('writes tags with sharps', () => {
		expect(keyTag(k(9, true))).toBe('Am')
		expect(keyTag(k(6, true))).toBe('F#m')
		expect(keyTag(k(10, false))).toBe('A#')
		expect(keyTag(k(0, false))).toBe('C')
	})

	it('places keys on the Camelot wheel', () => {
		expect(camelot(k(0, false))).toBe('8B')
		expect(camelot(k(9, true))).toBe('8A')
		expect(camelot(k(7, false))).toBe('9B')
		expect(camelot(k(4, true))).toBe('9A')
		expect(camelot(k(5, false))).toBe('7B')
		expect(camelot(k(8, true))).toBe('1A') // G#m / Abm
		expect(camelot(k(11, false))).toBe('1B')
		expect(camelot(k(1, true))).toBe('12A') // C#m
	})

	it('places keys on Open Key', () => {
		expect(openKey(k(0, false))).toBe('1d')
		expect(openKey(k(9, true))).toBe('1m')
		expect(openKey(k(7, false))).toBe('2d')
		expect(openKey(k(5, false))).toBe('12d')
	})

	it('round-trips every key through Camelot and Open Key', () => {
		for (let tonic = 0; tonic < 12; tonic++) {
			for (const minor of [false, true]) {
				const key = k(tonic, minor)
				expect(parseKey(camelot(key))).toEqual(key)
				expect(parseKey(openKey(key))).toEqual(key)
				expect(parseKey(keyTag(key))).toEqual(key)
			}
		}
	})
})

describe('parseKey', () => {
	it.each([
		['Am', k(9, true)],
		['A minor', k(9, true)],
		['a min', k(9, true)],
		['A♭m', k(8, true)],
		['Abm', k(8, true)],
		['G#', k(8, false)],
		['F# Major', k(6, false)],
		['Bbmin', k(10, true)],
		['Bm', k(11, true)],
		['B', k(11, false)],
		['Eb', k(3, false)],
		['E♭', k(3, false)],
		['C♯m', k(1, true)],
		['F sharp minor', k(6, true)],
		['8A', k(9, true)],
		['08B', k(0, false)],
		['12a', k(1, true)],
		['1m', k(9, true)],
		['1d', k(0, false)]
	])('reads %s', (raw, key) => {
		expect(parseKey(raw)).toEqual(key)
	})

	it.each(['', 'o', '13A', 'H', 'Am7', 'unknown', null, undefined])('rejects %s', (raw) => {
		expect(parseKey(raw)).toBeNull()
	})

	it('compares keys', () => {
		expect(sameKey(parseKey('Gbm'), parseKey('F#m'))).toBe(true)
		expect(sameKey(parseKey('Am'), parseKey('C'))).toBe(false)
	})
})
