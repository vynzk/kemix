/**
 * Pull a Qobuz session (user auth token, and user id when present) out of whatever the user pasted:
 * - a request copied from DevTools ("Copy as cURL", or the raw request headers): has `x-user-auth-token`
 * - the play.qobuz.com `localuser` localStorage JSON: `{ "id": …, "token": … }`
 * - a cookies.txt / JSON cookie export: any qobuz.com cookie whose name looks like an auth token
 * - the bare token
 * Returns every plausible token (best guess first), since a cookie export may contain several candidates.
 */
export interface QobuzSession {
	tokens: string[]
	/** Where each token came from (same order as `tokens`), for error messages. Never contains the token itself. */
	sources: string[]
	userId?: string
	appId?: string
}

export function parseQobuzSession(raw: string): QobuzSession {
	const text = raw.replace(/^\uFEFF/, '').trim()
	const tokens: string[] = []
	const sources: string[] = []
	let userId: string | undefined
	const add = (t: string | undefined, source: string) => {
		const clean = t?.trim().replace(/^["']|["']$/g, '')
		if (clean && /^[\w.\-~+/=]{20,}$/.test(clean) && !tokens.includes(clean)) {
			tokens.push(clean)
			sources.push(source)
		}
	}

	// Headers / cURL / query strings.
	for (const m of text.matchAll(/x-user-auth-token["']?\s*[:=]\s*["']?([\w.\-~+/=]+)/gi)) add(m[1], 'header x-user-auth-token')
	for (const m of text.matchAll(/user_auth_token["']?\s*[:=]\s*["']?([\w.\-~+/=]+)/gi)) add(m[1], 'parámetro user_auth_token')
	userId ??= text.match(/user_id["']?\s*[:=]\s*["']?(\d+)/i)?.[1]
	// A token only works with the app id that issued it; a copied request carries that app id too.
	const appId = text.match(/x-app-id["']?\s*[:=]\s*["']?(\d{6,12})/i)?.[1] ?? text.match(/[?&]app_id=(\d{6,12})/)?.[1]

	// JSON: localuser object, or a JSON cookie export.
	if (text.startsWith('{') || text.startsWith('[')) {
		try {
			walkJson(JSON.parse(text), (key, value, parent) => {
				const k = key.toLowerCase()
				if (typeof value === 'string' && (k === 'token' || k === 'user_auth_token' || k === 'usertoken')) add(value, `campo "${key}" del JSON`)
				if ((k === 'id' || k === 'user_id' || k === 'userid') && /^\d+$/.test(String(value)) && hasTokenSibling(parent)) {
					userId ??= String(value)
				}
				// JSON cookie export: { name, value, domain }
				if (k === 'name' && typeof value === 'string' && isAuthCookieName(value) && isQobuzDomain(parent?.domain)) {
					add(String(parent?.value ?? ''), `cookie "${value}"`)
				}
			})
		} catch {
			// not JSON after all
		}
	}

	// Netscape cookies.txt lines: domain, flag, path, secure, expiry, name, value.
	for (let line of text.split(/\r?\n/)) {
		line = line.replace(/^#HttpOnly_/, '')
		const f = line.split('\t')
		if (f.length >= 7 && isQobuzDomain(f[0]) && isAuthCookieName(f[5]!)) add(f.slice(6).join('\t'), `cookie "${f[5]}"`)
	}

	// Just the token.
	if (!tokens.length && /^[\w.\-~+/=]{20,}$/.test(text)) add(text, 'token pegado')

	return { tokens, sources, userId, appId }
}

function isQobuzDomain(domain: unknown) {
	return typeof domain === 'string' && /(^|\.)qobuz\.com$/i.test(domain.replace(/^\./, ''))
}

/** Cookie-consent, analytics and anti-CSRF cookies have "token"/"session" in their names but are never a login. */
const NOT_AUTH_COOKIE = /didomi|consent|euconsent|cookie|csrf|xsrf|^_ga|^_gid|^_fb|^_hj|optanon|datadome|cf_|__cf/i

function isAuthCookieName(name: string) {
	return /token|auth|session/i.test(name) && !NOT_AUTH_COOKIE.test(name)
}

function hasTokenSibling(obj: Record<string, unknown> | undefined) {
	return !!obj && Object.keys(obj).some((k) => /token/i.test(k))
}

function walkJson(
	node: unknown,
	visit: (key: string, value: unknown, parent: Record<string, unknown> | undefined) => void,
	depth = 0
) {
	if (depth > 8 || !node || typeof node !== 'object') return
	if (Array.isArray(node)) {
		for (const item of node) walkJson(item, visit, depth + 1)
		return
	}
	const obj = node as Record<string, unknown>
	for (const [k, v] of Object.entries(obj)) {
		visit(k, v, obj)
		// localStorage values are often JSON encoded strings.
		if (typeof v === 'string' && /^[[{]/.test(v.trim())) {
			try {
				walkJson(JSON.parse(v), visit, depth + 1)
			} catch {
				// plain string
			}
		} else {
			walkJson(v, visit, depth + 1)
		}
	}
}
