import { describe, expect, it } from 'vitest'
import { parseQobuzSession } from '../src/sources/qobuz-session'

const TOKEN = 'AbCdEf0123456789-_ghIJklMNopQRstuvWXyz0123456789abcdEFGH'

describe('parseQobuzSession', () => {
	it('reads a request copied as cURL', () => {
		const curl = `curl 'https://www.qobuz.com/api.json/0.2/favorite/getUserFavorites?user_id=1234567&type=tracks' \\
  -H 'accept: application/json' \\
  -H 'x-app-id: 950096963' \\
  -H 'x-user-auth-token: ${TOKEN}'`
		expect(parseQobuzSession(curl)).toEqual({ tokens: [TOKEN], sources: ['header x-user-auth-token'], userId: '1234567', appId: '950096963' })
	})

	it('reads raw request headers (Windows cmd / PowerShell copies included)', () => {
		expect(parseQobuzSession(`X-User-Auth-Token: ${TOKEN}\r\nX-App-Id: 1`).tokens).toEqual([TOKEN])
		expect(parseQobuzSession(`-H "x-user-auth-token: ${TOKEN}"`).tokens).toEqual([TOKEN])
	})

	it('reads the localuser localStorage JSON', () => {
		const localuser = JSON.stringify({ id: 1234567, token: TOKEN, login: 'someone', credential: { id: 9 } })
		expect(parseQobuzSession(localuser)).toMatchObject({ tokens: [TOKEN], userId: '1234567' })
	})

	it('reads a JSON-encoded string inside JSON', () => {
		const wrapped = JSON.stringify({ localuser: JSON.stringify({ id: 42, token: TOKEN }) })
		expect(parseQobuzSession(wrapped)).toMatchObject({ tokens: [TOKEN], userId: '42' })
	})

	it('finds auth-like qobuz cookies in a cookies.txt', () => {
		const txt = [
			'# Netscape HTTP Cookie File',
			`.qobuz.com\tTRUE\t/\tTRUE\t0\tqobuz-auth-token\t${TOKEN}`,
			`.qobuz.com\tTRUE\t/\tTRUE\t0\tlang\tes`,
			`.example.com\tTRUE\t/\tTRUE\t0\tauth_token\tnotqobuz-notqobuz-notqobuz`
		].join('\n')
		expect(parseQobuzSession(txt)).toMatchObject({ tokens: [TOKEN], sources: ['cookie "qobuz-auth-token"'] })
	})

	it('ignores consent and anti-CSRF cookies that only look like tokens', () => {
		const line = (name: string, value: string) => ['.qobuz.com', 'TRUE', '/', 'TRUE', '0', name, value].join('\t')
		const txt = [
			line('didomi_token', TOKEN),
			line('XSRF-TOKEN', `${TOKEN}x`),
			line('cookie_session_consent', `${TOKEN}y`)
		].join('\n')
		expect(parseQobuzSession(txt).tokens).toEqual([])
	})

	it('finds auth-like qobuz cookies in a JSON cookie export', () => {
		const json = JSON.stringify([{ name: 'user_session', value: TOKEN, domain: 'play.qobuz.com' }])
		expect(parseQobuzSession(json).tokens).toEqual([TOKEN])
	})

	it('takes the app id from a query string when there is no header', () => {
		const url = `https://www.qobuz.com/api.json/0.2/user/get?app_id=123456789&user_auth_token=${TOKEN}`
		expect(parseQobuzSession(url)).toMatchObject({ tokens: [TOKEN], appId: '123456789' })
	})

	it('accepts a bare token, even with a byte-order mark in front', () => {
		expect(parseQobuzSession(`  ${TOKEN}  `).tokens).toEqual([TOKEN])
		expect(parseQobuzSession(`\uFEFF${TOKEN}`)).toMatchObject({ tokens: [TOKEN], sources: ['token pegado'] })
	})

	it('finds nothing in unrelated text', () => {
		expect(parseQobuzSession('hola').tokens).toEqual([])
		expect(parseQobuzSession(`.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tabcabcabcabcabcabcabcabc`).tokens).toEqual([])
	})
})
