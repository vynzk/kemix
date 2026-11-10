// Soundeo (soundeo.com): a download store for DJs. Every Premium plan downloads a number of tracks per day, each in
// MP3 320, WAV or AIFF; accounts without Premium can't download anything (Soundeo sells no single tracks).
// There's no public API: this talks to the same endpoints its website does, which answer JSON to XHR requests.
import { Readable } from 'node:stream'
import type { AudioQuality, OutputFormat, QualityLevel, TargetTrack } from '../types'
import type { AudioStream, Downloader } from '../download/lucida-adapter'
import { errorMessage } from '../util'

const BASE = 'https://soundeo.com'
const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/** The format ids in Soundeo's /download/<track>/<format> URLs. AIFF is made from the WAV, so it exists whenever that does. */
export const SOUNDEO_MP3 = 1
export const SOUNDEO_WAV = 2
export const SOUNDEO_AIFF = 3
export type SoundeoFormat = typeof SOUNDEO_MP3 | typeof SOUNDEO_WAV | typeof SOUNDEO_AIFF

const FORMAT_EXT: Record<SoundeoFormat, string> = { 1: 'mp3', 2: 'wav', 3: 'aiff' }
const EXT_MIME: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff' }

/** Soundeo's WAVs are CD quality; its MP3s, 320 kbps. */
export const SOUNDEO_WAV_QUALITY: AudioQuality = { codec: 'wav', lossless: true, bitDepth: 16, sampleRateHz: 44100 }
const MP3_320: AudioQuality = { codec: 'mp3', lossless: false, bitrateKbps: 320 }

const PREMIUM_ONLY =
	'Tu cuenta de Soundeo no tiene Premium: Soundeo solo deja descargar a cuentas Premium (no vende temas sueltos).'
const LIMIT_REACHED =
	'Se acabaron las descargas de hoy de tu plan de Soundeo. Se renuevan a medianoche (hora de Europa central): reintenta después.'
const SESSION_LOST = 'La sesión de Soundeo se cerró y no se pudo renovar: vuelve a conectar la cuenta en Cuentas.'

// ---------- parsing ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', raquo: '»', laquo: '«' }

export function decodeHtml(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === '#') {
			const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
			return Number.isFinite(code) ? String.fromCodePoint(code) : m
		}
		return ENTITIES[e.toLowerCase()] ?? m
	})
}

/** Text of an HTML fragment, on one line. */
function text(html: string): string {
	return decodeHtml(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' '))
		.replace(/\s+/g, ' ')
		.trim()
}

/** "Artist 1, Artist 2 - Title (Extended Mix)" → artists and title (Soundeo lists artists separated by commas). */
export function splitSoundeoTitle(full: string): { artists: string[]; title: string } {
	const m = full.match(/^(.+?)\s[-–]\s(.+)$/)
	if (!m) return { artists: [], title: full.trim() }
	return {
		artists: m[1]!
			.split(/\s*,\s*/)
			.map((a) => a.trim())
			.filter(Boolean),
		title: m[2]!.trim()
	}
}

/** "6:11" or "1:02:03" → ms; "0:00" (unknown) → undefined. */
function parseDuration(s: string | undefined): number | undefined {
	if (!s) return undefined
	const parts = s.trim().split(':').map(Number)
	if (parts.some((n) => !Number.isFinite(n))) return undefined
	const seconds = parts.reduce((acc, n) => acc * 60 + n, 0)
	return seconds > 0 ? seconds * 1000 : undefined
}

/** Covers come in 50 and 500 px; placeholders ("stub") mean there's none. */
function coverUrl(src: string | undefined): string | undefined {
	if (!src || /\/stub\./.test(src)) return undefined
	return src.replace(/-\d+\.(jpe?g|png)$/i, '-500.$1')
}

export function soundeoTrackUrl(id: string, path?: string): string {
	return path ? new URL(path, BASE).href : `${BASE}/tracks/status/${id}`
}

/** The track id in a Soundeo URL: /track/<slug>-<id>.html (its page) or /tracks/status/<id>. */
export function soundeoTrackId(url: string): string | null {
	return url.match(/-(\d+)\.html(?:[?#]|$)/)?.[1] ?? url.match(/\/tracks?\/(?:status\/)?(\d+)(?:[/?#]|$)/)?.[1] ?? null
}

/** Best quality among Soundeo's formats: the WAV if there is one, else the MP3. */
function formatsQuality(formats: number[]): AudioQuality | undefined {
	if (formats.includes(SOUNDEO_WAV)) return SOUNDEO_WAV_QUALITY
	if (formats.includes(SOUNDEO_MP3)) return MP3_320
	return undefined
}

function baseTrack(fields: {
	id: string
	full: string
	path?: string
	release?: string
	genre?: string
	date?: string
	cover?: string
	durationMs?: number
	formats: number[]
}): TargetTrack {
	const { artists, title } = splitSoundeoTitle(fields.full)
	const year = Number(fields.date?.slice(0, 4))
	return {
		service: 'soundeo',
		id: fields.id,
		url: soundeoTrackUrl(fields.id, fields.path),
		title,
		artists,
		album: fields.release || undefined,
		durationMs: fields.durationMs,
		coverUrl: coverUrl(fields.cover),
		year: year > 1900 ? year : undefined,
		genres: fields.genre ? [fields.genre] : undefined,
		maxQuality: formatsQuality(fields.formats)
	}
}

/**
 * The tracks in a Soundeo track list (search results, /list/tracks pages). Only the ones that can be downloaded:
 * the rest are tracks Soundeo has only for voting, which no account can get.
 */
export function parseTrackList(html: string): TargetTrack[] {
	const out: TargetTrack[] = []
	for (const chunk of html.split('<div class="trackitem"').slice(1)) {
		// The last item runs into the rest of the page: cut it at the next section.
		const block = chunk.split(/<div class="folder"|<h1[\s>]|class="pagination|class="paging/)[0]!
		const id = block.match(/data-track-id="(\d+)"/)?.[1]
		const link = block.match(/<strong>[\s\S]*?<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
		if (!id || !link) continue
		const formats = [...block.matchAll(/data-track-format="(\d+)"/g)].map((m) => Number(m[1]))
		if (!formats.length) continue
		out.push(
			baseTrack({
				id,
				full: text(link[2]!),
				path: decodeHtml(link[1]!),
				durationMs: parseDuration(block.match(/<time>([^<]*)<\/time>/)?.[1]),
				// The release name is the link right before "by <label>" (the cover links to the release too).
				release: text(block.match(/<a href="\/release\/[^"]*">([^<]*)<\/a>\s*<i>by<\/i>/)?.[1] ?? ''),
				date: block.match(/<i>at<\/i>\s*(\d{4}-\d{2}-\d{2})/)?.[1],
				genre: text(block.match(/<i>in<\/i>\s*<a [^>]*>([^<]*)<\/a>/)?.[1] ?? ''),
				cover: block.match(/<img src="([^"]+)"[^>]*class="cover/)?.[1],
				formats
			})
		)
	}
	return out
}

/** A track as /tracks/status/<id> describes it. */
export interface SoundeoStatusTrack {
	id: string
	title: string
	cover?: string | null
	trackUrl?: string | null
	release?: string | null
	genre?: string | null
	date?: string | null
	downloadable?: boolean
	format1?: number | null
	format1str?: string | null
	format2?: number | null
	format2str?: string | null
	restricted?: boolean
	broken?: boolean
	inprogress?: boolean
	replacement?: boolean
}

export interface SoundeoTrackInfo {
	meta: TargetTrack
	/** Formats it can be downloaded in (SOUNDEO_*). Empty: it can't be downloaded. */
	formats: number[]
	/** Why it can't be downloaded, if it can't. */
	unavailable: string | null
}

export function parseStatusTrack(t: SoundeoStatusTrack): SoundeoTrackInfo {
	const stems = t.format1str === 'STEM' && !t.format2
	const formats = stems ? [] : [t.format1, t.format2].filter((f): f is number => !!f)
	let unavailable: string | null = null
	if (t.broken || t.replacement) unavailable = 'Soundeo tiene marcado este tema como defectuoso y lo está reemplazando: prueba más tarde.'
	else if (t.inprogress) unavailable = 'Soundeo todavía está publicando este tema: prueba más tarde.'
	else if (stems) unavailable = 'En Soundeo este tema solo está en stems, que Kemix no descarga.'
	else if (t.restricted || !t.downloadable || !formats.length) {
		unavailable = 'Este tema no está disponible para descargar en Soundeo (solo se puede votar para que lo publiquen).'
	}
	return {
		meta: baseTrack({
			id: String(t.id),
			full: decodeHtml(t.title),
			path: t.trackUrl ?? undefined,
			release: decodeHtml(t.release ?? ''),
			genre: decodeHtml(t.genre ?? ''),
			date: t.date ?? undefined,
			cover: t.cover ?? undefined,
			formats
		}),
		formats,
		unavailable
	}
}

/** The preview clip of track `id` in a Soundeo page (a track page also lists other tracks, each with its own). */
export function findPreviewUrl(html: string, id: string): string | null {
	for (const m of html.matchAll(/data-track-url="([^"]+)"/g)) {
		const url = decodeHtml(m[1]!)
		if (new RegExp(`/${id}\\.mp3(?:[?#]|$)`).test(url)) return url
	}
	return null
}

/** What the header of a Soundeo page says about the session. */
export interface SoundeoAccountState {
	loggedIn: boolean
	/** Downloads counter in the header: only accounts with Premium have one. */
	premium: boolean
	/** Downloads left today, from the plan. */
	downloadsLeft: number | null
	/** Bonus downloads (they don't expire at midnight). */
	bonusLeft: number | null
	/** When the plan's downloads are reset, e.g. "6 h 57 min". */
	resetsIn: string | null
}

/** "18 hours 54 minutes 50 seconds" → "18 h 54 min". */
function shortDuration(s: string): string {
	const h = Number(s.match(/(\d+)\s*hour/)?.[1] ?? 0)
	const m = Number(s.match(/(\d+)\s*minute/)?.[1] ?? 0)
	if (!h && !m) return s.includes('second') ? 'menos de 1 min' : s.trim()
	return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ')
}

/**
 * Read the session from a page header. Signed out, the account menu links to the login form. With Premium there's a
 * downloads counter: `<span id='span-downloads'><span title="Main (will be reset in …)">149</span> + <span
 * title="Bonus …">300</span></span>`.
 */
export function parseAccountHeader(header: string | undefined | null): SoundeoAccountState {
	const html = header ?? ''
	const at = html.search(/id=['"]span-downloads['"]/)
	// The account menu entry says it best; without one, any link to the login form means signed out.
	const accountLink = html.match(/id=["']top-menu-account["'][^>]*>\s*<a href="([^"]*)"/)?.[1]
	const toLogin = accountLink !== undefined ? accountLink.startsWith('/account/logoreg') : /href="\/account\/logoreg"/.test(html)
	const loggedIn = at >= 0 || (!!html && !toLogin)
	const state: SoundeoAccountState = { loggedIn, premium: false, downloadsLeft: null, bonusLeft: null, resetsIn: null }
	if (!loggedIn || at < 0) return state
	const end = html.indexOf('</a>', at)
	const counter = html.slice(at, end < 0 ? undefined : end)
	const spans = [...counter.matchAll(/<span[^>]*?title=(["'])([^"']*)\1[^>]*>\s*(\d+)\s*<\/span>/g)].map((m) => ({
		title: m[2]!,
		n: Number(m[3])
	}))
	const main = spans.find((s) => /^main/i.test(s.title)) ?? spans.find((s) => !/^bonus/i.test(s.title))
	const bonus = spans.find((s) => /^bonus/i.test(s.title))
	const reset = main?.title.match(/will be reset in ([^)]+)/)?.[1]
	return {
		loggedIn,
		premium: true,
		downloadsLeft: main?.n ?? null,
		bonusLeft: bonus?.n ?? null,
		resetsIn: reset ? shortDuration(reset) : null
	}
}

/** Soundeo's JSON answer to an XHR request for a page or an action. */
export interface SoundeoPage {
	header?: string
	modal?: string
	content?: string
	url?: string
	flash?: unknown
	message?: string
	jsActions?: Record<string, unknown>
	ce?: Record<string, string>
	jscookie?: Record<string, { value?: string; expires?: number }>
}

/** The error shown in a modal form (a failed login: "Wrong email or password"). */
export function modalError(modal: string | undefined): string | null {
	const m = modal?.match(/<div class="error">([\s\S]*?)<\/div>/)
	return m ? text(m[1]!.replace(/<a [\s\S]*?<\/a>/g, '')) || null : null
}

/** Messages Soundeo shows instead of a download: a flash notice, or the text of the modal it opens. */
function pageMessage(page: SoundeoPage): string | null {
	const flash = (page.jsActions?.flash ?? page.flash) as { message?: string } | { message?: string }[] | undefined
	const fromFlash = Array.isArray(flash) ? flash.find((f) => f?.message)?.message : flash?.message
	if (fromFlash) return text(fromFlash)
	if (page.message) return text(page.message)
	const info = page.modal?.match(/<div class="(?:info|error)">([\s\S]*?)<\/div>/)?.[1]
	return info ? text(info) : null
}

/**
 * Why a download didn't start, in the user's words, and whether it's about the account (no session, no Premium, no
 * downloads left: asking for another format won't help). `state` is null when the answer had no header to read it from.
 */
export function downloadError(page: SoundeoPage, state: SoundeoAccountState | null): { message: string; account: boolean } {
	const account = (message: string) => ({ message, account: true })
	if (state && !state.loggedIn) return account(SESSION_LOST)
	const outOfDownloads = !!state?.premium && state.downloadsLeft === 0 && !state.bonusLeft
	const message = pageMessage(page)
	if (message) {
		if (/limit|no (?:more )?downloads|out of downloads|downloads left|run out/i.test(message)) return account(LIMIT_REACHED)
		if (/premium/i.test(message)) return account(outOfDownloads ? LIMIT_REACHED : PREMIUM_ONLY)
		return { message: `Soundeo no entregó el tema: ${message}`, account: false }
	}
	if (outOfDownloads) return account(LIMIT_REACHED)
	if (state && !state.premium) return account(PREMIUM_ONLY)
	return { message: 'Soundeo no entregó el enlace de descarga.', account: false }
}

/**
 * The format to ask Soundeo for. AIFF and WAV come straight from Soundeo (nothing to convert); "as delivered" is its
 * WAV. MP3 levels get its MP3 320. A track without a WAV only has the MP3.
 */
export function pickFormats(formats: number[], level: QualityLevel, format: OutputFormat = 'original'): SoundeoFormat[] {
	const mp3Level = level === 'mp3_320' || level === 'mp3_128' || level === 'mp3_compat'
	const hasWav = formats.includes(SOUNDEO_WAV)
	if (mp3Level && formats.includes(SOUNDEO_MP3)) return [SOUNDEO_MP3]
	if (!hasWav) return formats.includes(SOUNDEO_MP3) ? [SOUNDEO_MP3] : []
	// AIFF is made from the WAV on Soundeo's side; if that ever fails, the WAV is converted here instead.
	return format === 'aiff' ? [SOUNDEO_AIFF, SOUNDEO_WAV] : [SOUNDEO_WAV]
}

// ---------- the client ----------

export interface SoundeoCredentials {
	email: string
	password: string
}

export interface SoundeoApiOptions {
	/** Session cookies from an earlier login. */
	cookies?: Record<string, string>
	/** To sign in again when Soundeo closes the session. */
	credentials?: SoundeoCredentials
	/** Called whenever the session cookies change, to keep them. */
	onCookies?: (cookies: Record<string, string>) => void
	/** Signing in again failed (the password changed…): the account needs the user. */
	onSessionLost?: (err: Error) => void
}

/** A soundeo.com session: keeps its cookies as a browser would, and signs in again when the session ends. */
export class SoundeoApi {
	#cookies: Map<string, string>
	#relogin: Promise<void> | null = null

	constructor(private opts: SoundeoApiOptions = {}) {
		this.#cookies = new Map(Object.entries(opts.cookies ?? {}))
	}

	cookies(): Record<string, string> {
		return Object.fromEntries(this.#cookies)
	}

	#cookieHeader() {
		return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ')
	}

	/** Set (or, with no value, remove) cookies; tells the owner when the session changed. */
	#setCookies(entries: [name: string, value: string | null][]) {
		let changed = false
		for (const [name, value] of entries) {
			if (value === null || value === '' || value === 'deleted') {
				changed = this.#cookies.delete(name) || changed
			} else if (this.#cookies.get(name) !== value) {
				this.#cookies.set(name, value)
				changed = true
			}
		}
		if (changed) this.opts.onCookies?.(this.cookies())
	}

	/** The cookies a response sets (expired ones remove theirs). */
	#absorbHeaders(res: Response) {
		this.#setCookies(
			res.headers.getSetCookie().flatMap((line): [string, string | null][] => {
				const [pair, ...attrs] = line.split(';')
				const eq = pair!.indexOf('=')
				if (eq <= 0) return []
				const expired = attrs.some((a) => {
					const [k, v] = a.split('=').map((x) => x.trim())
					if (/^max-age$/i.test(k!)) return Number(v) <= 0
					if (/^expires$/i.test(k!)) return Date.parse(v ?? '') < Date.now()
					return false
				})
				return [[pair!.slice(0, eq).trim(), expired ? null : pair!.slice(eq + 1).trim()]]
			})
		)
	}

	/** What the site's own scripts store from a page: its browser id (`bruid`, kept once set) and `jscookie` entries. */
	#absorbPage(page: SoundeoPage) {
		const entries: [string, string | null][] = Object.entries(page.jscookie ?? {}).map(([k, c]) => [k, c?.value ?? null])
		const bruid = page.ce?.bruid
		if (bruid && !this.#cookies.has('bruid')) entries.push(['bruid', bruid])
		this.#setCookies(entries)
	}

	/** A request to soundeo.com with the session; redirects are followed here so no cookie set along the way is lost. */
	async #fetch(path: string, init: { form?: Record<string, string>; xhr?: boolean } = {}): Promise<Response> {
		let url = new URL(path, BASE)
		let method = init.form ? 'POST' : 'GET'
		let body: string | undefined = init.form ? new URLSearchParams(init.form).toString() : undefined
		for (let hop = 0; hop < 6; hop++) {
			const headers: Record<string, string> = {
				'user-agent': USER_AGENT,
				'accept-language': 'en-US,en;q=0.9'
			}
			if (init.xhr) {
				headers['x-requested-with'] = 'XMLHttpRequest'
				headers.accept = 'application/json, text/javascript, */*; q=0.01'
			}
			if (body !== undefined) {
				headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
				headers.origin = BASE
				headers.referer = `${BASE}/`
			}
			const cookie = this.#cookieHeader()
			if (cookie) headers.cookie = cookie
			const res = await fetch(url, { method, headers, body, redirect: 'manual' })
			this.#absorbHeaders(res)
			const location = res.headers.get('location')
			if (res.status < 300 || res.status >= 400 || !location) return res
			url = new URL(location, url)
			if (url.host !== new URL(BASE).host) throw new Error(`Soundeo redirigió a otro sitio (${url.host})`)
			if (res.status !== 307 && res.status !== 308) {
				method = 'GET'
				body = undefined
			}
		}
		throw new Error('Soundeo redirigió demasiadas veces')
	}

	/** A page or action as the site's scripts get it: JSON. Non-JSON answers come back as an empty page. */
	async page(path: string, form?: Record<string, string>): Promise<SoundeoPage> {
		const res = await this.#fetch(path, { form, xhr: true })
		const raw = await res.text()
		let page: SoundeoPage = {}
		try {
			page = raw ? (JSON.parse(raw) as SoundeoPage) : {}
		} catch {
			if (!res.ok) throw new Error(`soundeo.com respondió ${res.status}`)
		}
		if (!res.ok && !page.header && !page.modal && !page.message) throw new Error(`soundeo.com respondió ${res.status}`)
		this.#absorbPage(page)
		return page
	}

	/** Sign in. Throws with Soundeo's reason when it refuses. */
	async login(email: string, password: string): Promise<SoundeoAccountState> {
		// Like opening the login form: gets the session cookie and the browser id the site expects.
		await this.page('/account/login')
		const res = await this.page('/account/login', {
			_method: 'POST',
			'data[User][login]': email,
			'data[User][password]': password,
			'data[remember]': '1'
		})
		const error = modalError(res.modal)
		if (error && /wrong email or password/i.test(error)) throw new Error('Email o contraseña incorrectos')
		if (/h-?captcha/i.test(res.modal ?? '')) {
			throw new Error(
				'Soundeo pide resolver un captcha para iniciar sesión. Inicia sesión una vez en soundeo.com desde el navegador y vuelve a intentarlo aquí.'
			)
		}
		if (error) throw new Error(`Soundeo dijo: ${error}`)
		const state = parseAccountHeader((await this.page('/')).header)
		if (!state.loggedIn) {
			throw new Error('Soundeo no abrió la sesión. Comprueba que puedes iniciar sesión en soundeo.com con ese email y contraseña.')
		}
		return state
	}

	/** Sign in again with the stored credentials (once, however many requests noticed the session ended). */
	async #renew(): Promise<void> {
		const creds = this.opts.credentials
		if (!creds) throw new Error(SESSION_LOST)
		this.#relogin ??= (async () => {
			try {
				this.#cookies.clear()
				await this.login(creds.email, creds.password)
			} catch (err) {
				const lost = new Error(`${SESSION_LOST} (${errorMessage(err)})`)
				this.opts.onSessionLost?.(lost)
				throw lost
			} finally {
				this.#relogin = null
			}
		})()
		return this.#relogin
	}

	/** The account's state now (Premium, downloads left), signing in again if the session ended. */
	async status(): Promise<SoundeoAccountState> {
		let state = parseAccountHeader((await this.page('/')).header)
		if (!state.loggedIn && this.opts.credentials) {
			await this.#renew()
			state = parseAccountHeader((await this.page('/')).header)
		}
		return state
	}

	/** Downloadable tracks matching `query`. Works without signing in. */
	async search(query: string): Promise<TargetTrack[]> {
		const q = encodeURIComponent(query.trim()).replace(/%20/g, '+')
		const res = await this.#fetch(`/list/tracks?availableFilter=1&searchFilter=${q}`)
		if (!res.ok) throw new Error(`La búsqueda en Soundeo respondió ${res.status}`)
		return parseTrackList(await res.text())
	}

	/** Soundeo's own clip of a track (about two minutes), from its page: to hear that very mix before picking it. */
	async preview(id: string): Promise<string | null> {
		const page = (await this.page(`/tracks/status/${id}`)) as SoundeoPage & { track?: SoundeoStatusTrack }
		if (!page.track?.trackUrl) return null
		const res = await this.#fetch(page.track.trackUrl)
		if (!res.ok) return null
		return findPreviewUrl(await res.text(), id)
	}

	async track(id: string): Promise<SoundeoTrackInfo> {
		const page = (await this.page(`/tracks/status/${id}`)) as SoundeoPage & { track?: SoundeoStatusTrack }
		if (!page.track) throw new Error(`Soundeo no tiene el tema ${id}`)
		return parseStatusTrack(page.track)
	}

	/**
	 * Where to download a track in a format. Each track downloaded uses up one of the plan's downloads for the day
	 * (downloading it again doesn't), so this is only called to actually download.
	 */
	async downloadUrl(id: string, format: SoundeoFormat): Promise<string> {
		for (let attempt = 0; ; attempt++) {
			const page = await this.page(`/download/${id}/${format}`)
			const redirect = page.jsActions?.redirect as { url?: string } | undefined
			if (redirect?.url) return new URL(redirect.url, BASE).href
			const state = page.header ? parseAccountHeader(page.header) : null
			if (state && !state.loggedIn && attempt === 0 && this.opts.credentials) {
				await this.#renew()
				continue
			}
			const why = downloadError(page, state)
			throw new SoundeoDownloadError(why.message, why.account)
		}
	}

	/** Start downloading a file Soundeo pointed at (on soundeo.com, or wherever it redirects to). */
	async open(fileUrl: string, format: SoundeoFormat): Promise<AudioStream> {
		const url = new URL(fileUrl)
		const headers: Record<string, string> = { 'user-agent': USER_AGENT }
		// fetch drops the cookie if a redirect leaves soundeo.com.
		if (url.host === new URL(BASE).host && this.#cookies.size) headers.cookie = this.#cookieHeader()
		const res = await fetch(url, { headers })
		if (!res.ok || !res.body) throw new Error(`Soundeo no entregó el audio (HTTP ${res.status})`)
		const type = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
		if (type === 'text/html' || type === 'application/json') {
			await res.body.cancel().catch(() => {})
			throw new Error('Soundeo respondió una página en lugar del audio. Vuelve a intentarlo.')
		}
		const ext = fileExtension(res.headers.get('content-disposition'), res.url || url.href) ?? FORMAT_EXT[format]
		const size = Number(res.headers.get('content-length'))
		return {
			stream: Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
			mimeType: EXT_MIME[ext] ?? EXT_MIME[FORMAT_EXT[format]]!,
			sizeBytes: size > 0 ? size : undefined
		}
	}
}

/** A download Soundeo refused. `account`: it's about the account (no session, no Premium, no downloads left), not the format. */
export class SoundeoDownloadError extends Error {
	constructor(
		message: string,
		readonly account: boolean
	) {
		super(message)
	}
}

/** The audio file's extension, from its name in Content-Disposition or its URL. */
function fileExtension(disposition: string | null, url: string): string | null {
	const name =
		disposition?.match(/filename\*=(?:UTF-8'')?([^;]+)/i)?.[1] ?? disposition?.match(/filename="?([^";]+)"?/i)?.[1] ?? null
	const fromName = name ? decodeURIComponent(name).match(/\.([a-z0-9]+)\s*$/i)?.[1] : null
	const fromUrl = new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1]
	const ext = (fromName ?? fromUrl)?.toLowerCase()
	return ext && ext in EXT_MIME ? ext : null
}

/** Downloads from Soundeo, with the connected account. Searching needs no account; downloading needs Premium. */
export class SoundeoDownloader implements Downloader {
	readonly service = 'soundeo' as const

	constructor(private api: SoundeoApi) {}

	/** Soundeo doesn't show ISRCs. */
	async isrcLookup(): Promise<TargetTrack | null> {
		return null
	}

	async search(query: string, limit: number): Promise<TargetTrack[]> {
		return (await this.api.search(query)).slice(0, limit)
	}

	async getTrack(url: string) {
		const id = soundeoTrackId(url)
		if (!id) throw new Error(`La URL no es un tema de Soundeo: ${url}`)
		const info = await this.api.track(id)
		return {
			meta: info.meta,
			open: (level: QualityLevel, format?: OutputFormat) => this.#open(id, info, level, format)
		}
	}

	async #open(id: string, info: SoundeoTrackInfo, level: QualityLevel, format?: OutputFormat): Promise<AudioStream> {
		if (info.unavailable) throw new Error(info.unavailable)
		const formats = pickFormats(info.formats, level, format)
		let firstError: unknown
		for (const f of formats) {
			try {
				return await this.api.open(await this.api.downloadUrl(id, f), f)
			} catch (err) {
				firstError ??= err
				if (err instanceof SoundeoDownloadError && err.account) break
			}
		}
		throw firstError ?? new Error('Soundeo no tiene este tema en ningún formato descargable')
	}

	async accountInfo() {
		return { premium: (await this.api.status()).premium }
	}

	/** Its WAVs are 16-bit/44.1 kHz whatever the plan; the plan only sets how many tracks a day. */
	async accountQuality(): Promise<AudioQuality> {
		return SOUNDEO_WAV_QUALITY
	}
}
