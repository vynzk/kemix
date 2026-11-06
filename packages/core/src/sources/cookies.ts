/**
 * Turn whatever the user pasted into a `Cookie` header value for the given domain. Accepts:
 * - a raw header value: `a=1; b=2` (optionally prefixed with `cookie:`)
 * - Netscape cookies.txt (what "Get cookies.txt" and similar extensions export)
 * - a JSON array of {name, value, domain} (EditThisCookie, Cookie-Editor…)
 */
export function normalizeCookieInput(raw: string, domain: string): string {
	const input = raw.replace(/^\uFEFF/, '').trim()
	if (!input) return ''

	let pairs: { name: string; value: string; domain?: string; expires?: number }[]
	if (input.startsWith('[')) pairs = parseJson(input)
	else if (isNetscape(input)) pairs = parseNetscape(input)
	else return input.replace(/^cookie:\s*/i, '').replace(/\s*\r?\n\s*/g, ' ').trim()

	const now = Date.now() / 1000
	const byName = new Map<string, { value: string; specificity: number }>()
	for (const c of pairs) {
		const d = (c.domain ?? domain).replace(/^\./, '').toLowerCase()
		// Keep cookies sent to `domain`: the domain itself or any parent (e.g. youtube.com for music.youtube.com).
		if (domain !== d && !domain.endsWith(`.${d}`)) continue
		if (c.expires && c.expires > 0 && c.expires < now) continue
		// When the same name exists on several domains, the most specific one wins (like a browser would send first).
		const prev = byName.get(c.name)
		if (!prev || d.length >= prev.specificity) byName.set(c.name, { value: c.value, specificity: d.length })
	}
	return [...byName].map(([name, { value }]) => `${name}=${value}`).join('; ')
}

function isNetscape(s: string) {
	return /^# ?(Netscape )?HTTP Cookie File/im.test(s) || s.split(/\r?\n/).some((l) => l.split('\t').length >= 7)
}

function parseNetscape(s: string) {
	const out: { name: string; value: string; domain: string; expires: number }[] = []
	for (let line of s.split(/\r?\n/)) {
		line = line.replace(/^#HttpOnly_/, '')
		if (!line.trim() || line.startsWith('#')) continue
		const f = line.split('\t')
		if (f.length < 7) continue
		out.push({ domain: f[0]!, expires: Number(f[4]) || 0, name: f[5]!, value: f.slice(6).join('\t').trim() })
	}
	return out
}

function parseJson(s: string) {
	const arr = JSON.parse(s) as { name: string; value: string; domain?: string; expirationDate?: number; expires?: number }[]
	if (!Array.isArray(arr)) throw new Error('El JSON de cookies debe ser una lista')
	return arr.map((c) => ({ name: c.name, value: c.value, domain: c.domain, expires: c.expirationDate ?? c.expires }))
}

export function getCookie(header: string, name: string): string | undefined {
	for (const part of header.split(/;\s*/)) {
		const i = part.indexOf('=')
		if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1)
	}
	return undefined
}
