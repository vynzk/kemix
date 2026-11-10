import fs from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import type {
	DownloadService,
	Kemix,
	MatchCandidate,
	Settings,
	SourceService,
	SourceTrack,
	SpotifyWebLogin
} from '@kemix/core'
import { SOURCE_SERVICES, isAccountService, isDownloadService, isOutputFormat, isQualityLevel } from '@kemix/core'

export interface ServerOptions {
	kemix: Kemix
	/** Built UI to serve at `/` (production). In dev the Vite server serves it instead. */
	uiDir?: string
	/** When set, every /api request must carry `x-kemix-token: <token>`. */
	token?: string
	logger?: boolean
	/**
	 * Desktop only: open the service's real login page in a window and capture the session from its traffic.
	 * Resolves with text `parseQobuzSession` understands (app id + auth token headers).
	 */
	browserLogin?: {
		qobuz(): Promise<string>
		spotify: SpotifyWebLogin
		/** Sign in on soundcloud.com; resolves with the session's `oauth_token` cookie. */
		soundcloud(): Promise<string>
	}
}

/** Routes reachable without the token (the browser hitting the OAuth redirect has no way to send it). */
const PUBLIC_ROUTES = new Set(['/api/auth/spotify/callback'])

export async function createServer(opts: ServerOptions): Promise<FastifyInstance> {
	const { kemix } = opts
	const app = Fastify({ logger: opts.logger ?? false })
	if (opts.browserLogin) kemix.accounts.setSpotifyWebLogin(opts.browserLogin.spotify)

	app.addHook('onRequest', async (req, reply) => {
		if (!opts.token || !req.url.startsWith('/api/')) return
		if (PUBLIC_ROUTES.has(req.url.split('?')[0]!)) return
		if (req.headers['x-kemix-token'] !== opts.token) return reply.code(401).send({ error: 'No autorizado' })
	})

	app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
		const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 400
		reply.code(status).send({ error: err.message })
	})

	const id = (params: unknown) => {
		const n = Number((params as { id: string }).id)
		if (!Number.isInteger(n)) throw Object.assign(new Error('id inválido'), { statusCode: 400 })
		return n
	}
	const service = (params: unknown): SourceService => {
		const s = (params as { service: string }).service as SourceService
		if (!SOURCE_SERVICES.includes(s)) throw Object.assign(new Error('Servicio desconocido'), { statusCode: 404 })
		return s
	}

	// ---------- state / settings ----------

	app.get('/api/state', async () => ({
		accounts: kemix.accounts.list(),
		settings: kemix.settings.get(),
		syncing: kemix.library.syncing,
		spotifyRedirectUri: kemix.accounts.spotifyRedirectUri(),
		browserLogin: !!opts.browserLogin
	}))

	app.put('/api/settings', async (req) => kemix.settings.update(req.body as Partial<Settings>))

	// ---------- accounts ----------

	app.post('/api/accounts/qobuz/browser', async () => {
		if (!opts.browserLogin) {
			throw Object.assign(new Error('El inicio de sesión en ventana solo está disponible en la app de escritorio'), {
				statusCode: 404
			})
		}
		await kemix.accounts.connectQobuz(await opts.browserLogin.qobuz())
		void kemix.library.syncAll()
		return { ok: true }
	})
	app.post('/api/accounts/soundcloud/browser', async () => {
		if (!opts.browserLogin) {
			throw Object.assign(new Error('El inicio de sesión en ventana solo está disponible en la app de escritorio'), {
				statusCode: 404
			})
		}
		await kemix.accounts.connectSoundCloud({ cookie: await opts.browserLogin.soundcloud() })
		void kemix.library.syncAll()
		return { ok: true }
	})
	app.post('/api/accounts/soundcloud', async (req) => {
		const cookie = (req.body as { cookie?: unknown } | undefined)?.cookie
		if (typeof cookie !== 'string') throw Object.assign(new Error('Faltan las cookies'), { statusCode: 400 })
		await kemix.accounts.connectSoundCloud({ cookie })
		void kemix.library.syncAll()
		return { ok: true }
	})
	app.post('/api/accounts/deezer', async (req) => {
		await kemix.accounts.connectDeezer(req.body as { arl: string })
		void kemix.library.syncAll()
		return { ok: true }
	})
	app.post('/api/accounts/ytmusic', async (req) => {
		const result = await kemix.accounts.connectYtMusic(req.body as { cookie?: string; accountIndex?: number })
		if (result.status === 'connected') void kemix.library.syncAll()
		return result
	})
	app.get('/api/accounts/quality', async () => kemix.accounts.downloadQualities())
	app.post('/api/accounts/spotify/start', async () => ({ url: kemix.accounts.startSpotifyAuth() }))
	app.post('/api/accounts/spotify/web', async () => {
		await kemix.accounts.connectSpotifyWeb()
		void kemix.library.syncAll()
		return { ok: true }
	})
	app.get('/api/auth/spotify/callback', async (req, reply) => {
		const q = req.query as { code?: string; state?: string; error?: string }
		reply.type('text/html; charset=utf-8')
		try {
			if (q.error || !q.code || !q.state) throw new Error(q.error ?? 'Faltan parámetros')
			await kemix.accounts.finishSpotifyAuth(q.code, q.state)
			void kemix.library.syncAll()
			return callbackPage('Spotify conectado', 'Ya puedes cerrar esta pestaña y volver a Kemix.')
		} catch (err) {
			return callbackPage('No se pudo conectar Spotify', (err as Error).message)
		}
	})
	// Soundeo only downloads: nothing to import, so no library sync.
	app.post('/api/accounts/soundeo', async (req) => {
		const body = req.body as { email?: unknown; password?: unknown } | undefined
		if (typeof body?.email !== 'string' || typeof body.password !== 'string') {
			throw Object.assign(new Error('Faltan el email o la contraseña'), { statusCode: 400 })
		}
		return kemix.accounts.connectSoundeo({ email: body.email, password: body.password })
	})
	app.get('/api/accounts/soundeo', async () => kemix.accounts.soundeoStatus())
	app.delete('/api/accounts/:service', async (req) => {
		const s = (req.params as { service: string }).service
		if (!isAccountService(s)) throw Object.assign(new Error('Servicio desconocido'), { statusCode: 404 })
		kemix.accounts.disconnect(s)
		return { ok: true }
	})

	// ---------- library ----------

	app.post('/api/sync', async (_req, reply) => {
		void kemix.library.syncAll()
		return reply.code(202).send({ ok: true })
	})

	app.get('/api/library', async () => ({
		folders: kemix.library.listFolders(),
		playlists: kemix.library.listPlaylists()
	}))

	app.post('/api/search/:service', async (req) => {
		const query = (req.body as { query?: unknown } | undefined)?.query
		if (typeof query !== 'string') throw Object.assign(new Error('query inválida'), { statusCode: 400 })
		return kemix.library.search(service(req.params), query)
	})
	app.post('/api/playlists/create/:service', async (req) => {
		const body = req.body as { name?: unknown; trackIds?: unknown } | undefined
		const trackIds = body?.trackIds
		if (typeof body?.name !== 'string' || !Array.isArray(trackIds) || !trackIds.every((t) => typeof t === 'string')) {
			throw Object.assign(new Error('Datos de playlist inválidos'), { statusCode: 400 })
		}
		return kemix.library.createPlaylist(service(req.params), body.name, trackIds as string[])
	})

	/** A new playlist on `:service` with tracks found on another one: each is looked up there by search. */
	app.post('/api/playlists/copy/:service', async (req) => {
		const body = req.body as { name?: unknown; tracks?: unknown } | undefined
		const tracks = body?.tracks
		const valid = (t: unknown): t is SourceTrack => {
			const x = t as Partial<SourceTrack> | null
			return !!x && typeof x.sourceId === 'string' && typeof x.title === 'string' && Array.isArray(x.artists)
		}
		if (typeof body?.name !== 'string' || !Array.isArray(tracks) || !tracks.every(valid)) {
			throw Object.assign(new Error('Datos de playlist inválidos'), { statusCode: 400 })
		}
		const clean = tracks.map((t) => ({
			sourceId: t.sourceId,
			title: t.title,
			artists: t.artists.filter((a): a is string => typeof a === 'string'),
			album: typeof t.album === 'string' ? t.album : undefined,
			durationMs: typeof t.durationMs === 'number' ? t.durationMs : undefined,
			isrc: typeof t.isrc === 'string' ? t.isrc : undefined
		}))
		return kemix.library.copyPlaylist(service(req.params), body.name, clean)
	})
	app.get('/api/playlists/:id', async (req) => {
		const playlistId = id(req.params)
		const playlist = await kemix.library.getPlaylist(playlistId)
		// Key and BPM of tracks never looked up, in the background (nothing to do most of the time).
		kemix.features.autoPlaylist(playlistId)
		return playlist
	})
	app.post('/api/playlists/:id/sync', async (req) => {
		await kemix.library.syncPlaylistTracks(id(req.params), true)
		return { ok: true }
	})
	/** What to download (or scan) and how. Positions: undefined = the whole playlist. */
	const downloadOptions = (body: unknown) => {
		const { positions, provider, quality, format } =
			(body as { positions?: unknown; provider?: unknown; quality?: unknown; format?: unknown } | undefined) ?? {}
		if (positions !== undefined && (!Array.isArray(positions) || !positions.every((n) => Number.isInteger(n)))) {
			throw Object.assign(new Error('positions inválidas'), { statusCode: 400 })
		}
		if (provider != null && !isDownloadService(provider)) {
			throw Object.assign(new Error('Proveedor desconocido'), { statusCode: 400 })
		}
		if (quality != null && !isQualityLevel(quality)) {
			throw Object.assign(new Error('Calidad desconocida'), { statusCode: 400 })
		}
		if (format != null && !isOutputFormat(format)) {
			throw Object.assign(new Error('Formato desconocido'), { statusCode: 400 })
		}
		return { positions: positions as number[] | undefined, provider: provider ?? null, level: quality ?? null, format: format ?? null }
	}
	app.post('/api/playlists/:id/download', async (req) => {
		const o = downloadOptions(req.body)
		await kemix.queue.enqueuePlaylist(id(req.params), o.positions, o.provider, o.level, o.format)
		return { ok: true }
	})
	app.get('/api/playlists/:id/features', async (req) => ({ scan: kemix.features.state(id(req.params)) }))
	/** Key and BPM: of the given positions (again, from scratch), or of every track still missing them. */
	app.post('/api/playlists/:id/features', async (req) => {
		const o = downloadOptions(req.body)
		return { scan: await kemix.features.analyzePlaylist(id(req.params), o.positions) }
	})
	/**
	 * Key and BPM of tracks outside the library (search results, review options): what's known now, null for the rest,
	 * which arrive later as `track-features` events. `group` names the screen asking; a new batch from it stops the last.
	 */
	app.post('/api/features/lookup', async (req) => {
		const body = req.body as { group?: unknown; items?: unknown } | undefined
		const items = body?.items
		const valid = (x: unknown): x is { service: string; track: SourceTrack } => {
			const i = x as { service?: unknown; track?: Partial<SourceTrack> } | null
			const t = i?.track
			return (
				(isAccountService(i?.service) || isDownloadService(i?.service)) &&
				!!t &&
				typeof t.sourceId === 'string' &&
				typeof t.title === 'string' &&
				Array.isArray(t.artists)
			)
		}
		if (typeof body?.group !== 'string' || !Array.isArray(items) || items.length > 200 || !items.every(valid)) {
			throw Object.assign(new Error('Temas inválidos'), { statusCode: 400 })
		}
		const clean = items.map(({ service, track: t }) => ({
			service,
			track: {
				sourceId: t.sourceId,
				title: t.title,
				artists: t.artists.filter((a): a is string => typeof a === 'string'),
				durationMs: typeof t.durationMs === 'number' ? t.durationMs : undefined,
				isrc: typeof t.isrc === 'string' && t.isrc ? t.isrc : undefined
			}
		}))
		return { results: kemix.features.lookupTracks(clean, body.group) }
	})
	app.get('/api/playlists/:id/scan', async (req) => ({ scan: kemix.queue.scanState(id(req.params)) }))
	app.post('/api/playlists/:id/scan', async (req) => {
		const o = downloadOptions(req.body)
		return { scan: await kemix.queue.scanPlaylist(id(req.params), o.positions, o.provider) }
	})
	app.patch('/api/playlists/:id', async (req) => {
		const body = req.body as { folderId: number | null }
		kemix.library.movePlaylist(id(req.params), body.folderId)
		return { ok: true }
	})

	app.post('/api/folders', async (req) => {
		const body = req.body as { name: string; parentId?: number | null }
		return kemix.library.createFolder(body.name, body.parentId ?? null)
	})
	app.patch('/api/folders/:id', async (req) => {
		kemix.library.updateFolder(id(req.params), req.body as { name?: string; parentId?: number | null })
		return { ok: true }
	})
	app.delete('/api/folders/:id', async (req) => {
		kemix.library.deleteFolder(id(req.params))
		return { ok: true }
	})

	// ---------- review ----------

	/** Optional provider picked by hand; missing or null = automatic. */
	const provider = (v: unknown): DownloadService | null => {
		if (v == null) return null
		if (!isDownloadService(v)) throw Object.assign(new Error('Proveedor desconocido'), { statusCode: 400 })
		return v
	}

	app.get('/api/review', async () => kemix.library.listReview())
	app.post('/api/review/:id/search', async (req) => {
		const body = req.body as { query?: unknown; provider?: unknown } | undefined
		const query = typeof body?.query === 'string' ? body.query : undefined
		return kemix.queue.searchCandidates(id(req.params), query, provider(body?.provider))
	})
	app.post('/api/review/:id/accept', async (req) => {
		const body = req.body as { candidate: MatchCandidate; provider?: unknown }
		const from = provider(body.provider)
		if (from) await kemix.queue.acceptCandidateFrom(id(req.params), body.candidate, from)
		else kemix.queue.acceptCandidate(id(req.params), body.candidate)
		return { ok: true }
	})
	app.post('/api/review/:id/skip', async (req) => {
		kemix.queue.skipTrack(id(req.params))
		return { ok: true }
	})
	app.post('/api/review/youtube', async (req) => {
		const ids = (req.body as { trackIds?: unknown } | undefined)?.trackIds
		if (!Array.isArray(ids) || !ids.every((n) => Number.isInteger(n))) {
			throw Object.assign(new Error('trackIds inválidos'), { statusCode: 400 })
		}
		return kemix.queue.downloadFromYouTube(ids as number[])
	})

	// ---------- preview ----------

	app.get('/api/tracks/:id/preview', async (req) => ({ preview: await kemix.queue.preview(id(req.params)) }))
	app.post('/api/preview/:service', async (req) => {
		const t = req.body as Partial<SourceTrack> | undefined
		if (!t || typeof t.sourceId !== 'string' || typeof t.title !== 'string' || !Array.isArray(t.artists)) {
			throw Object.assign(new Error('tema inválido'), { statusCode: 400 })
		}
		const track: SourceTrack = {
			sourceId: t.sourceId,
			title: t.title,
			artists: t.artists.filter((a): a is string => typeof a === 'string'),
			durationMs: typeof t.durationMs === 'number' ? t.durationMs : undefined
		}
		const exact = (req.query as { exact?: string }).exact === '1'
		// Soundeo too: its candidates in Review play Soundeo's own clip of that very mix.
		const from = (req.params as { service: string }).service
		if (!isAccountService(from)) throw Object.assign(new Error('Servicio desconocido'), { statusCode: 404 })
		return { preview: await kemix.queue.previewTrack(from, track, exact) }
	})

	// ---------- downloads ----------

	app.get('/api/downloads', async () => kemix.queue.list())
	app.post('/api/downloads/retry', async () => {
		kemix.queue.retryFailed()
		return { ok: true }
	})
	app.post('/api/downloads/clear', async () => {
		kemix.queue.clearFinished()
		return { ok: true }
	})
	app.delete('/api/downloads/:id', async (req) => {
		await kemix.queue.remove(id(req.params))
		return { ok: true }
	})

	// ---------- live events (SSE) ----------

	app.get('/api/events', (req, reply) => {
		reply.hijack()
		const res = reply.raw
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		})
		res.write(': connected\n\n')
		const unsubscribe = kemix.events.subscribe((event) => res.write(`data: ${JSON.stringify(event)}\n\n`))
		const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000)
		req.raw.on('close', () => {
			clearInterval(heartbeat)
			unsubscribe()
		})
	})

	// ---------- UI ----------

	if (opts.uiDir && fs.existsSync(opts.uiDir)) {
		await app.register(fastifyStatic, { root: opts.uiDir })
		app.setNotFoundHandler((req, reply) => {
			if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'No encontrado' })
			return reply.sendFile('index.html')
		})
	}

	return app
}

function callbackPage(title: string, message: string) {
	const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
	return `<!doctype html><html lang="es"><meta charset="utf-8"><title>${esc(title)}</title>
<body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1>${esc(title)}</h1><p>${esc(message)}</p></div></body></html>`
}
