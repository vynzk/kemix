import { describe, expect, it } from 'vitest'
import { getCookie, normalizeCookieInput } from '../src/sources/cookies'

const D = 'music.youtube.com'
const future = Math.floor(Date.now() / 1000) + 86400 * 365

describe('normalizeCookieInput', () => {
	it('passes a raw header through (and strips a "cookie:" prefix)', () => {
		expect(normalizeCookieInput('cookie: SAPISID=abc; SID=x', D)).toBe('SAPISID=abc; SID=x')
		expect(normalizeCookieInput('  SAPISID=abc;\n SID=x  ', D)).toBe('SAPISID=abc; SID=x')
	})

	it('parses Netscape cookies.txt (Get cookies.txt export)', () => {
		const txt = [
			'# Netscape HTTP Cookie File',
			'# http://curl.haxx.se/rfc/cookie_spec.html',
			'',
			`.youtube.com\tTRUE\t/\tTRUE\t${future}\tSAPISID\tabc/def`,
			`#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t${future}\t__Secure-3PSID\tsecret`,
			`music.youtube.com\tFALSE\t/\tTRUE\t0\tPREF\tf6=80`,
			`.google.com\tTRUE\t/\tTRUE\t${future}\tNID\tnope`,
			`.youtube.com\tTRUE\t/\tTRUE\t1000\tOLD\texpired`
		].join('\r\n')
		const header = normalizeCookieInput(txt, D)
		expect(getCookie(header, 'SAPISID')).toBe('abc/def')
		expect(getCookie(header, '__Secure-3PSID')).toBe('secret')
		expect(getCookie(header, 'PREF')).toBe('f6=80')
		expect(getCookie(header, 'NID')).toBeUndefined()
		expect(getCookie(header, 'OLD')).toBeUndefined()
	})

	it('prefers the more specific domain when a name repeats', () => {
		const txt = [
			`music.youtube.com\tFALSE\t/\tTRUE\t0\tPREF\tmusic`,
			`.youtube.com\tTRUE\t/\tTRUE\t0\tPREF\tgeneric`
		].join('\n')
		expect(normalizeCookieInput(txt, D)).toBe('PREF=music')
	})

	it('parses a JSON export', () => {
		const json = JSON.stringify([
			{ name: 'SAPISID', value: 'abc', domain: '.youtube.com', expirationDate: future },
			{ name: 'X', value: 'y', domain: '.example.com' }
		])
		expect(normalizeCookieInput(json, D)).toBe('SAPISID=abc')
	})

	it('ignores a byte-order mark at the start of the file', () => {
		const txt = `\uFEFF# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tabc`
		expect(normalizeCookieInput(txt, D)).toBe('SAPISID=abc')
	})

	it('returns empty for empty input', () => {
		expect(normalizeCookieInput('   ', D)).toBe('')
	})
})
