import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Kemix, passphraseCipher, type OutputFormat, type QualityLevel, type SourceTrack, type TargetTrack } from '../src/index'
import type { Downloader } from '../src/download/lucida-adapter'
import type { SourceConnector } from '../src/sources/types'
import {
	downloadError,
	findPreviewUrl,
	modalError,
	parseAccountHeader,
	parseStatusTrack,
	parseTrackList,
	pickFormats,
	SoundeoApi,
	SoundeoDownloader,
	soundeoTrackId,
	splitSoundeoTitle
} from '../src/sources/soundeo'

// ---------- fixtures (trimmed from real soundeo.com answers) ----------

const LIST_HTML = `
<h1 class="line">Search results</h1>
<div class="folder">
	<div class="trackitem" data-track-id="17079030">
		<div class="vis ">&nbsp;</div>
		<a href="/release/charlotte-de-witte-overdrive-ep-4004212.html"><img src="https://covers.sndstatic.com/2023/05/17/4004212-charlotte-de-witte-overdrive-ep-50.jpg" title="Charlotte de Witte - Overdrive EP" alt="Charlotte de Witte - Overdrive EP" class="cover cover-30"></a>
		<button class="action stop" data-track-url="https://preview.sndstatic.com/preview/1/2023-11-22/17079030.mp3?t=1794504578&amp;h=630b&amp;secure=XE7I,1794504578" data-track-id="17079030">&nbsp;</button>
		<div class="info">
			<strong>
				<a href="/track/charlotte-de-witte-high-street-original-mix-17079030.html">Charlotte de Witte - High Street (Original Mix)</a>
			</strong>
			<time>6:11</time>
			<span>
				<a href="/release/charlotte-de-witte-overdrive-ep-4004212.html">Overdrive EP</a>				<i>by</i> <a href="/list/releases?availableFilter=0&amp;labelFilter=74477">KNTXT</a>				<i>at</i> 2023-05-17				<i>in</i> <a href="/list/tracks?availableFilter=1&amp;genreFilter=6">Techno (Peak Time / Driving)</a>			</span>
		</div>
		<button class="favorites" data-track-id="17079030"></button>
		<div class="download ">
			<a href="javascript:void(0);" class="track-download-lnk" data-track-id="17079030" data-track-format="1"><span>MP3</span><span>14.43 MB</span></a>
			<a href="javascript:void(0);" class="track-download-lnk" data-track-id="17079030" data-track-format="2"><span>WAV</span><span>62.47 MB</span></a>
		</div>
	</div>
	<div class="trackitem" data-track-id="1234">
		<a href="/release/daft-punk-one-more-time-1.html"><img src="https://cdn.sndstatic.com/img/stub.50.png" class="cover cover-30"></a>
		<div class="info">
			<strong><a href="/track/daft-punk-one-more-time-short-radio-edit-1234.html">Daft Punk - One More Time (Short Radio Edit)</a></strong>
			<time>3:55</time>
		</div>
		<div class="vote"><button>&nbsp;</button><span class="number">12 | </span><span class="link">Vote</span></div>
	</div>
	<div class="trackitem" data-track-id="555">
		<a href="/release/x-555.html"><img src="https://cdn.sndstatic.com/img/stub.50.png" class="cover cover-30"></a>
		<div class="info">
			<strong><a href="/track/daft-punk-one-more-time-romanthonys-unplugged-555.html">Daft Punk, Romanthony - One More Time (Romanthony&#039;s Unplugged)</a></strong>
			<time>3:40</time>
			<span><a href="/release/x-555.html">Alive &amp; Well</a> <i>by</i> <a href="/list/releases?labelFilter=1">Daft Life</a> <i>at</i> 2008-02-25 <i>in</i> <a href="/list/tracks?genreFilter=5">House</a></span>
		</div>
		<div class="download "><a class="track-download-lnk" data-track-id="555" data-track-format="1"><span>MP3</span></a></div>
	</div>
</div>
<div class="paging"><a href="?page=2">2</a></div>`

const STATUS_TRACK = {
	id: '17079030',
	title: 'Charlotte de Witte - High Street (Original Mix)',
	cover: 'https://covers.sndstatic.com/2023/05/17/4004212-charlotte-de-witte-overdrive-ep-50.jpg',
	trackUrl: '/track/charlotte-de-witte-high-street-original-mix-17079030.html',
	release: 'Overdrive EP',
	label: 'KNTXT',
	genre: 'Techno (Peak Time / Driving)',
	date: '2023-05-17',
	bpm: '138',
	key: 'Cmin',
	downloadable: true,
	downloadedF1: false,
	downloadedF2: false,
	format1: 1,
	format1str: 'MP3',
	format1size: '14.43 MB',
	format2: 2,
	format2str: 'WAV',
	format2size: '62.47 MB',
	restricted: false,
	broken: false,
	inprogress: false,
	replacement: false
}

const LOGGED_OUT_HEADER = `<ul class="top-menu"> <li class="active" id="top-menu-home"><a href="/"><i class="ico-home"></i>Home</a></li> <li id="top-menu-premium"><a href="/account/premium"><i class="ico-premium"></i>Premium</a></li> <li id="top-menu-account"><a href="/account/logoreg"><span class="dashed"><i class="ico-user"></i>Account</span></a></li> </ul>`
const PREMIUM_HEADER = `<ul class="top-menu"><li id="top-menu-downloads"><a href="/account/downloads"><i class="ico-downloads"></i><span id="span-downloads"><span class="active" title="Main (will be reset in 6 hours 57 minutes 9 seconds)">149</span> + <span class="" title="Bonus (can be used on any day with premium account)">300</span></span></a></li><li id="top-menu-account"><a href="/account/journal"><span class="dashed"><i class="ico-user"></i>Account</span></a></li></ul>`
const FREE_HEADER = `<ul class="top-menu"><li id="top-menu-premium"><a href="/account/premium">Premium</a></li><li id="top-menu-account"><a href="/account/journal"><span class="dashed">Account</span></a></li></ul>`
const PREMIUM_MODAL = `<h2>SOUNDEO REGISTRATION</h2> <div class="info">You need to be a premium member to download tracks. You can register and purchase premium account right now. It will take only a couple of minutes.</div> <form action="/account/logoreg/next:download/track:17079030" class="xhr-credentials mailcheck-form"></form>`
const LOGIN_ERROR_MODAL = `<h2>LOGIN TO YOUR ACCOUNT</h2> <div class="error">Wrong email or password<br /><a href="/account/recovery">Try to recover your password</a></div> <form action="/account/login" class="xhr-credentials" id="UserLoginForm"></form>`

// ---------- parsing ----------

describe('Soundeo pages', () => {
	it('reads the downloadable tracks of a list, skipping the ones only open to votes', () => {
		const tracks = parseTrackList(LIST_HTML)
		expect(tracks.map((t) => t.id)).toEqual(['17079030', '555'])
		expect(tracks[0]).toEqual({
			service: 'soundeo',
			id: '17079030',
			url: 'https://soundeo.com/track/charlotte-de-witte-high-street-original-mix-17079030.html',
			title: 'High Street (Original Mix)',
			artists: ['Charlotte de Witte'],
			album: 'Overdrive EP',
			durationMs: 371_000,
			coverUrl: 'https://covers.sndstatic.com/2023/05/17/4004212-charlotte-de-witte-overdrive-ep-500.jpg',
			year: 2023,
			genres: ['Techno (Peak Time / Driving)'],
			maxQuality: { codec: 'wav', lossless: true, bitDepth: 16, sampleRateHz: 44100 }
		})
		// Entities decoded, several artists, no cover for the placeholder, and only an MP3.
		expect(tracks[1]).toMatchObject({
			title: "One More Time (Romanthony's Unplugged)",
			artists: ['Daft Punk', 'Romanthony'],
			album: 'Alive & Well',
			coverUrl: undefined,
			maxQuality: { codec: 'mp3', lossless: false, bitrateKbps: 320 }
		})
	})

	it('splits "Artists - Title" keeping dashes inside the title', () => {
		expect(splitSoundeoTitle('Delilah Montagu, Fred again.. - Delilah (pull me out of this)')).toEqual({
			artists: ['Delilah Montagu', 'Fred again..'],
			title: 'Delilah (pull me out of this)'
		})
		expect(splitSoundeoTitle('Daft Punk - Stardust - Human After All (Original Mix)').title).toBe(
			'Stardust - Human After All (Original Mix)'
		)
	})

	it('reads a track status, and why a track cannot be downloaded', () => {
		const ok = parseStatusTrack(STATUS_TRACK)
		expect(ok.formats).toEqual([1, 2])
		expect(ok.unavailable).toBeNull()
		expect(ok.meta).toMatchObject({ id: '17079030', title: 'High Street (Original Mix)', artists: ['Charlotte de Witte'] })
		expect(parseStatusTrack({ ...STATUS_TRACK, downloadable: false, format1: null, format2: null }).unavailable).toMatch(/votar/)
		expect(parseStatusTrack({ ...STATUS_TRACK, format1str: 'STEM', format2: null }).unavailable).toMatch(/stems/)
		expect(parseStatusTrack({ ...STATUS_TRACK, broken: true }).unavailable).toMatch(/defectuoso/)
	})

	it('knows a track id from either kind of Soundeo URL', () => {
		expect(soundeoTrackId('https://soundeo.com/track/x-mix-2016-17079030.html')).toBe('17079030')
		expect(soundeoTrackId('https://soundeo.com/tracks/status/42')).toBe('42')
		expect(soundeoTrackId('https://soundeo.com/release/x.html')).toBeNull()
	})

	it('reads the session and the downloads left from the page header', () => {
		expect(parseAccountHeader(LOGGED_OUT_HEADER)).toMatchObject({ loggedIn: false, premium: false })
		expect(parseAccountHeader(PREMIUM_HEADER)).toEqual({
			loggedIn: true,
			premium: true,
			downloadsLeft: 149,
			bonusLeft: 300,
			resetsIn: '6 h 57 min'
		})
		expect(parseAccountHeader(FREE_HEADER)).toEqual({
			loggedIn: true,
			premium: false,
			downloadsLeft: null,
			bonusLeft: null,
			resetsIn: null
		})
		// Signed in even if a "register" promo elsewhere links to the login form.
		expect(parseAccountHeader(`${FREE_HEADER}<a href="/account/logoreg">Register</a>`).loggedIn).toBe(true)
		expect(parseAccountHeader('').loggedIn).toBe(false)
	})

	it('explains why a download was refused', () => {
		const loggedOut = parseAccountHeader(LOGGED_OUT_HEADER)
		const free = parseAccountHeader(FREE_HEADER)
		const spent = parseAccountHeader(PREMIUM_HEADER.replace('>149<', '>0<').replace(/ \+ <span[^]*?300<\/span>/, ''))
		expect(downloadError({ modal: PREMIUM_MODAL }, loggedOut)).toMatchObject({ message: /sesión de Soundeo/, account: true })
		expect(downloadError({ modal: PREMIUM_MODAL }, free)).toMatchObject({ message: /no tiene Premium/, account: true })
		expect(downloadError({ modal: PREMIUM_MODAL }, spent)).toMatchObject({ message: /Se acabaron/, account: true })
		expect(downloadError({ jsActions: { flash: { message: 'Daily download limit reached' } } }, null)).toMatchObject({
			message: /Se acabaron/
		})
		expect(downloadError({ jsActions: { flash: { message: 'File is being replaced' } } }, null)).toEqual({
			message: 'Soundeo no entregó el tema: File is being replaced',
			account: false
		})
	})

	it('reads the error of a failed login', () => {
		expect(modalError(LOGIN_ERROR_MODAL)).toBe('Wrong email or password')
		expect(modalError('<h2>LOGIN</h2><form></form>')).toBeNull()
	})

	it('asks Soundeo for its AIFF or WAV as is, and its MP3 for MP3 levels', () => {
		expect(pickFormats([1, 2], 'max', 'aiff')).toEqual([3, 2])
		expect(pickFormats([1, 2], 'cd', 'wav')).toEqual([2])
		expect(pickFormats([1, 2], 'max', 'original')).toEqual([2])
		expect(pickFormats([1, 2], 'mp3_compat', 'original')).toEqual([1])
		expect(pickFormats([1, 2], 'mp3_128')).toEqual([1])
		// No WAV: the MP3 is all there is, whatever was asked for.
		expect(pickFormats([1], 'max', 'aiff')).toEqual([1])
		expect(pickFormats([], 'max')).toEqual([])
	})

	it("finds the track's own preview clip in its page", () => {
		const page = `<button data-track-url="https://preview.sndstatic.com/preview/1/2026-10-31/23539257.mp3?t=1&amp;h=a" data-track-id="23539257"></button>
			<button data-track-url="https://preview.sndstatic.com/preview/1/2023-05-17/17079029.mp3?t=2&amp;h=b" data-track-id="17079029"></button>`
		expect(findPreviewUrl(page, '17079029')).toBe('https://preview.sndstatic.com/preview/1/2023-05-17/17079029.mp3?t=2&h=b')
		expect(findPreviewUrl(page, '1')).toBeNull()
	})
})

// ---------- a fake soundeo.com ----------

interface FakeOptions {
	premium?: boolean
	password?: string
	/** What /download answers instead of a link, for a signed-in account. */
	refuse?: { header: string; modal?: string }
}

interface Call {
	method: string
	path: string
	cookie: string
	body: string
}

const AUDIO = Buffer.from('RIFF----WAVEfmt fake audio')

function fakeSoundeo(opts: FakeOptions = {}) {
	const calls: Call[] = []
	const password = opts.password ?? 'secret'
	vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input))
		const headers = new Headers(init?.headers)
		const cookie = headers.get('cookie') ?? ''
		const call = { method: init?.method ?? 'GET', path: url.pathname + url.search, cookie, body: String(init?.body ?? '') }
		if (url.hostname === 'files.example.com') {
			calls.push(call)
			return new Response(AUDIO, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(AUDIO.length) } })
		}
		calls.push(call)
		const signedIn = cookie.includes('snda[data]=REMEMBER')
		const json = (body: object, cookies: string[] = []) =>
			new Response(JSON.stringify(body), {
				headers: [['content-type', 'application/json; charset=UTF-8'], ...cookies.map((c): [string, string] => ['set-cookie', c])]
			})
		const header = signedIn ? (opts.premium === false ? FREE_HEADER : PREMIUM_HEADER) : LOGGED_OUT_HEADER

		if (url.pathname === '/account/login' && call.method === 'GET') {
			return json({ header, modal: '<form id="UserLoginForm"></form>', ce: { bruid: 'BROWSER1' } }, ['snd=SESSION1; path=/; secure; HttpOnly'])
		}
		if (url.pathname === '/account/login' && call.method === 'POST') {
			const form = new URLSearchParams(call.body)
			if (form.get('data[User][login]') !== 'dj@example.com' || form.get('data[User][password]') !== password) {
				return json({ header, modal: LOGIN_ERROR_MODAL })
			}
			// Signed in: the remember-me cookie, and a redirect the client follows itself.
			return new Response(null, {
				status: 302,
				headers: [
					['location', '/'],
					['set-cookie', 'snda[data]=REMEMBER; expires=Fri, 31-Dec-2027 23:59:59 GMT; path=/'],
					['set-cookie', 'snd=SESSION2; path=/; secure; HttpOnly']
				]
			})
		}
		if (url.pathname === '/') return json({ header })
		if (url.pathname === '/tracks/status/17079030') return json({ track: STATUS_TRACK, ce: { bruid: 'OTHER' } })
		if (url.pathname.startsWith('/track/')) {
			return new Response(
				'<button data-track-url="https://preview.sndstatic.com/preview/1/2023-05-17/17079030.mp3?t=9&amp;h=c" data-track-id="17079030"></button>'
			)
		}
		const download = url.pathname.match(/^\/download\/(\d+)\/(\d)$/)
		if (download) {
			if (!signedIn) return json({ header, modal: PREMIUM_MODAL })
			if (opts.refuse) return json({ header: opts.refuse.header, modal: opts.refuse.modal })
			const ext = { 1: 'mp3', 2: 'wav', 3: 'aiff' }[download[2] as '1' | '2' | '3']
			return json({ jsActions: { redirect: { url: `https://files.example.com/get/${download[1]}.${ext}?sig=1` } } })
		}
		if (url.pathname === '/list/tracks') return new Response(LIST_HTML)
		return new Response('not found', { status: 404 })
	})
	return calls
}

async function readAll(stream: Readable): Promise<Buffer> {
	const chunks: Buffer[] = []
	for await (const c of stream) chunks.push(Buffer.from(c))
	return Buffer.concat(chunks)
}

const TRACK_URL = 'https://soundeo.com/track/charlotte-de-witte-high-street-original-mix-17079030.html'

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('SoundeoApi', () => {
	it('signs in like the website and downloads the WAV with the session', async () => {
		const calls = fakeSoundeo()
		const api = new SoundeoApi()
		const state = await api.login('dj@example.com', 'secret')
		expect(state).toMatchObject({ loggedIn: true, premium: true, downloadsLeft: 149, bonusLeft: 300 })
		// The login goes with the session cookie and browser id the login form gave, and the redirect keeps cookies.
		const post = calls.find((c) => c.method === 'POST')!
		expect(post.cookie).toContain('snd=SESSION1')
		expect(post.cookie).toContain('bruid=BROWSER1')
		expect(new URLSearchParams(post.body).get('data[remember]')).toBe('1')
		expect(api.cookies()).toEqual({ snd: 'SESSION2', bruid: 'BROWSER1', 'snda[data]': 'REMEMBER' })

		const got = await new SoundeoDownloader(api).getTrack(TRACK_URL)
		expect(got.meta.title).toBe('High Street (Original Mix)')
		const audio = await got.open('max', 'original')
		expect(audio.mimeType).toBe('audio/wav')
		expect(audio.sizeBytes).toBe(AUDIO.length)
		expect(await readAll(audio.stream)).toEqual(AUDIO)
		expect(calls.filter((c) => c.path.startsWith('/download/')).map((c) => c.path)).toEqual(['/download/17079030/2'])
		// The file host gets no Soundeo cookies.
		expect(calls.find((c) => c.path.startsWith('/get/'))!.cookie).toBe('')
	})

	it('gets the AIFF straight from Soundeo, and the MP3 for MP3 levels', async () => {
		const calls = fakeSoundeo()
		const api = new SoundeoApi()
		await api.login('dj@example.com', 'secret')
		const d = new SoundeoDownloader(api)
		const aiff = await (await d.getTrack(TRACK_URL)).open('max', 'aiff')
		expect(aiff.mimeType).toBe('audio/aiff')
		const mp3 = await (await d.getTrack(TRACK_URL)).open('mp3_compat', 'original')
		expect(mp3.mimeType).toBe('audio/mpeg')
		expect(calls.filter((c) => c.path.startsWith('/download/')).map((c) => c.path)).toEqual([
			'/download/17079030/3',
			'/download/17079030/1'
		])
	})

	it('says why a wrong password is refused', async () => {
		fakeSoundeo()
		await expect(new SoundeoApi().login('dj@example.com', 'nope')).rejects.toThrow('Email o contraseña incorrectos')
	})

	it('signs in again by itself when the session ended, and keeps the new cookies', async () => {
		const calls = fakeSoundeo()
		const saved: Record<string, string>[] = []
		const api = new SoundeoApi({
			cookies: { snd: 'EXPIRED', bruid: 'BROWSER0' },
			credentials: { email: 'dj@example.com', password: 'secret' },
			onCookies: (c) => saved.push(c)
		})
		const audio = await (await new SoundeoDownloader(api).getTrack(TRACK_URL)).open('max', 'wav')
		expect(audio.mimeType).toBe('audio/wav')
		expect(calls.filter((c) => c.path.startsWith('/download/')).length).toBe(2)
		expect(calls.some((c) => c.method === 'POST')).toBe(true)
		expect(saved.at(-1)).toMatchObject({ 'snda[data]': 'REMEMBER' })
	})

	it('reports a lost session once the password stops working', async () => {
		fakeSoundeo({ password: 'changed' })
		const lost = vi.fn()
		const api = new SoundeoApi({ credentials: { email: 'dj@example.com', password: 'secret' }, onSessionLost: lost })
		await expect((await new SoundeoDownloader(api).getTrack(TRACK_URL)).open('max', 'original')).rejects.toThrow(
			/sesión de Soundeo se cerró/
		)
		expect(lost).toHaveBeenCalledOnce()
	})

	it('without Premium, says so and does not try other formats', async () => {
		const calls = fakeSoundeo({ premium: false, refuse: { header: FREE_HEADER, modal: PREMIUM_MODAL } })
		const api = new SoundeoApi({ credentials: { email: 'dj@example.com', password: 'secret' } })
		const state = await api.login('dj@example.com', 'secret')
		expect(state).toMatchObject({ loggedIn: true, premium: false })
		await expect((await new SoundeoDownloader(api).getTrack(TRACK_URL)).open('max', 'aiff')).rejects.toThrow(/no tiene Premium/)
		expect(calls.filter((c) => c.path.startsWith('/download/')).map((c) => c.path)).toEqual(['/download/17079030/3'])
	})

	it('searches without an account, and finds the preview clip of a track', async () => {
		const calls = fakeSoundeo()
		const api = new SoundeoApi()
		const found = await new SoundeoDownloader(api).search('charlotte de witte high street', 1)
		expect(found.map((t) => t.id)).toEqual(['17079030'])
		expect(calls[0]!.path).toBe('/list/tracks?availableFilter=1&searchFilter=charlotte+de+witte+high+street')
		expect(await api.preview('17079030')).toBe('https://preview.sndstatic.com/preview/1/2023-05-17/17079030.mp3?t=9&h=c')
	})
})

// ---------- the account, in Kemix ----------

describe('Soundeo account', () => {
	let dir: string
	let kemix: Kemix

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kemix-soundeo-'))
		kemix = new Kemix({ dataDir: path.join(dir, 'data'), cipher: passphraseCipher('test') })
		// Key and BPM analysis after each download has its own tests (features-analyzer.test.ts).
		Object.assign(kemix.features, { trackDownloaded: () => {} })
	})

	afterEach(() => {
		kemix.close()
		fs.rmSync(dir, { recursive: true, force: true })
	})

	it('connects with email and password, joins the download priority with Premium, and downloads', async () => {
		fakeSoundeo()
		const status = await kemix.accounts.connectSoundeo({ email: ' dj@example.com ', password: 'secret' })
		expect(status).toEqual({ premium: true, downloadsLeft: 149, bonusLeft: 300, resetsIn: '6 h 57 min' })
		expect(kemix.accounts.list().find((a) => a.service === 'soundeo')).toMatchObject({
			status: 'connected',
			displayName: 'Premium',
			email: 'dj@example.com'
		})
		// After the lossless services, before the lossy ones.
		kemix.settings.update({ servicePriority: ['qobuz', 'deezer', 'youtube'] })
		kemix.accounts.disconnect('soundeo')
		await kemix.accounts.connectSoundeo({ email: 'dj@example.com', password: 'secret' })
		expect(kemix.settings.get().servicePriority).toEqual(['qobuz', 'deezer', 'soundeo', 'youtube'])

		const downloader = await kemix.accounts.downloader('soundeo')
		expect((await kemix.accounts.downloadQualities()).soundeo).toEqual({
			codec: 'wav',
			lossless: true,
			bitDepth: 16,
			sampleRateHz: 44100
		})
		const audio = await (await downloader.getTrack(TRACK_URL)).open('max')
		expect(await readAll(audio.stream)).toEqual(AUDIO)
		expect(await kemix.accounts.soundeoStatus()).toMatchObject({ premium: true })
	})

	it('connects an account without Premium without adding it to the priority', async () => {
		fakeSoundeo({ premium: false })
		const status = await kemix.accounts.connectSoundeo({ email: 'dj@example.com', password: 'secret' })
		expect(status.premium).toBe(false)
		expect(kemix.accounts.list().find((a) => a.service === 'soundeo')).toMatchObject({ displayName: 'sin Premium' })
		expect(kemix.settings.get().servicePriority).not.toContain('soundeo')
	})

	it('keeps a working connection when new credentials are refused', async () => {
		fakeSoundeo()
		await kemix.accounts.connectSoundeo({ email: 'dj@example.com', password: 'secret' })
		await expect(kemix.accounts.connectSoundeo({ email: 'dj@example.com', password: 'wrong' })).rejects.toThrow(
			/Email o contraseña incorrectos/
		)
		expect(kemix.accounts.isConnected('soundeo')).toBe(true)
		// A first connection that fails is shown as needing attention.
		kemix.accounts.disconnect('soundeo')
		await expect(kemix.accounts.connectSoundeo({ email: 'dj@example.com', password: 'wrong' })).rejects.toThrow()
		expect(kemix.accounts.list().find((a) => a.service === 'soundeo')!.status).toBe('error')
	})
})

// ---------- the queue, with a service that delivers AIFF/WAV itself ----------

/** A minimal valid PCM WAV file (what Soundeo sends). */
function wavFile(bits = 16, rate = 44100, channels = 2, frames = 4410): Buffer {
	const dataSize = frames * channels * (bits / 8)
	const b = Buffer.alloc(44 + dataSize)
	b.write('RIFF', 0)
	b.writeUInt32LE(36 + dataSize, 4)
	b.write('WAVE', 8)
	b.write('fmt ', 12)
	b.writeUInt32LE(16, 16)
	b.writeUInt16LE(1, 20)
	b.writeUInt16LE(channels, 22)
	b.writeUInt32LE(rate, 24)
	b.writeUInt32LE((rate * channels * bits) / 8, 28)
	b.writeUInt16LE((channels * bits) / 8, 32)
	b.writeUInt16LE(bits, 34)
	b.write('data', 36)
	b.writeUInt32LE(dataSize, 40)
	return b
}

describe('queue with Soundeo', () => {
	const track: SourceTrack = { sourceId: 's1', title: 'High Street', artists: ['Charlotte de Witte'], durationMs: 371_000 }
	const target: TargetTrack = {
		service: 'soundeo',
		id: '17079030',
		url: TRACK_URL,
		title: 'High Street (Original Mix)',
		artists: ['Charlotte de Witte'],
		durationMs: 371_000
	}

	let dir: string
	let kemix: Kemix
	const converter = {
		pcm: [] as string[],
		async toMp3() {
			throw new Error('no MP3 here')
		},
		async toPcm(input: string, output: string, opts: { format: string }) {
			converter.pcm.push(`${path.basename(input)}>${opts.format}`)
			fs.copyFileSync(input, output)
		}
	}
	/** Each download: the level and format asked for. */
	let asked: [QualityLevel, OutputFormat | undefined][]

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kemix-soundeo-queue-'))
		converter.pcm = []
		asked = []
		kemix = new Kemix({ dataDir: path.join(dir, 'data'), cipher: passphraseCipher('test'), converter })
		kemix.settings.update({ downloadDir: path.join(dir, 'music') })
		Object.assign(kemix.features, { trackDownloaded: () => {} })
		const soundeo: Downloader = {
			service: 'soundeo',
			isrcLookup: async () => null,
			search: async () => [target],
			getTrack: async () => ({
				meta: target,
				// Soundeo sends a WAV (an AIFF asked for falls back to it here, as if Soundeo's AIFF failed).
				open: async (level: QualityLevel, format?: OutputFormat) => {
					asked.push([level, format])
					return { stream: Readable.from([wavFile()]), mimeType: 'audio/wav' }
				}
			}),
			accountInfo: async () => ({ premium: true }),
			accountQuality: async () => ({ codec: 'wav', lossless: true, bitDepth: 16, sampleRateHz: 44100 })
		}
		const source: SourceConnector = {
			service: 'spotify',
			identity: async () => ({ name: 'Test' }),
			listPlaylists: async () => [{ sourceId: 'p1', name: 'Techno', trackCount: 1, snapshot: 'v1' }],
			getPlaylistTracks: async () => [track],
			search: async () => [],
			createPlaylist: async () => 'x'
		}
		Object.assign(kemix.accounts, {
			isConnected: (s: string) => s === 'spotify' || s === 'soundeo',
			source: () => source,
			downloader: async () => soundeo,
			downloaders: async () => [soundeo],
			findIsrc: async () => null
		})
		kemix.start()
	})

	afterEach(() => {
		kemix.close()
		fs.rmSync(dir, { recursive: true, force: true })
	})

	async function downloadAs(format: OutputFormat) {
		await kemix.library.syncAll()
		const [playlist] = kemix.library.listPlaylists()
		await kemix.queue.enqueuePlaylist(playlist!.id, undefined, null, 'max', format)
		const start = Date.now()
		while (Date.now() - start < 5000) {
			const row = (await kemix.library.getPlaylist(playlist!.id)).tracks[0]!.download
			if (row?.status === 'done' || row?.status === 'error') return row
			await new Promise((r) => setTimeout(r, 20))
		}
		throw new Error('download did not finish')
	}

	it('keeps the WAV Soundeo sends when WAV is asked for, without converting it', async () => {
		const row = await downloadAs('wav')
		expect(row.status).toBe('done')
		expect(row.path).toMatch(/High Street \(Original Mix\)\.wav$/)
		expect(asked).toEqual([['max', 'wav']])
		expect(converter.pcm).toEqual([])
		expect(row.quality).toMatchObject({ codec: 'wav', lossless: true, bitDepth: 16, sampleRateHz: 44100 })
		expect(row.quality?.convertedFrom).toBeUndefined()
	})

	it('converts what arrives in another format than the one asked for', async () => {
		const row = await downloadAs('aiff')
		expect(row.status).toBe('done')
		expect(asked).toEqual([['max', 'aiff']])
		expect(converter.pcm).toEqual(['01 - Charlotte de Witte - High Street (Original Mix).aiff.download.wav>aiff'])
	})
})
