import { describe, expect, it } from 'vitest'
import { extensionFor, sanitizeSegment, trackFileName } from '../src/download/paths'

describe('sanitizeSegment', () => {
	it('replaces characters forbidden on Windows', () => {
		expect(sanitizeSegment('AC/DC: <Back> in "Black"? | * \\')).toBe('AC_DC_ _Back_ in _Black__ _ _ _')
	})
	it('prefixes reserved device names', () => {
		expect(sanitizeSegment('CON')).toBe('_CON')
		expect(sanitizeSegment('aux.txt')).toBe('_aux.txt')
		expect(sanitizeSegment('Lpt1')).toBe('_Lpt1')
		expect(sanitizeSegment('Console')).toBe('Console')
	})
	it('removes trailing dots and spaces', () => {
		expect(sanitizeSegment('Hello... ')).toBe('Hello')
	})
	it('falls back when empty', () => {
		expect(sanitizeSegment('   ')).toBe('Sin título')
		expect(sanitizeSegment('...')).toBe('Sin título')
	})
	it('limits length', () => {
		expect(sanitizeSegment('a'.repeat(500)).length).toBeLessThanOrEqual(120)
	})
	it('strips control characters', () => {
		expect(sanitizeSegment('a\u0001b\tc')).toBe('a_b_c')
	})
})

describe('trackFileName', () => {
	it('zero-pads by playlist size', () => {
		expect(trackFileName({ position: 0, total: 9, artists: ['A'], title: 'T', ext: 'flac' })).toBe('01 - A - T.flac')
		expect(trackFileName({ position: 4, total: 150, artists: ['A', 'B'], title: 'T', ext: 'mp3' })).toBe('005 - A, B - T.mp3')
	})
	it('sanitizes titles', () => {
		expect(trackFileName({ position: 0, total: 1, artists: ['AC/DC'], title: 'What?', ext: 'flac' })).toBe(
			'01 - AC_DC - What_.flac'
		)
	})
})

describe('extensionFor', () => {
	it('maps known mime types', () => {
		expect(extensionFor('audio/flac')).toBe('flac')
		expect(extensionFor('audio/mpeg')).toBe('mp3')
		expect(extensionFor('audio/flac; charset=binary')).toBe('flac')
	})
})
