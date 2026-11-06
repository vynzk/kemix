import fs from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import type { Kemix, MatchCandidate, Settings, SourceService } from '@kemix/core'
import { SOURCE_SERVICES } from '@kemix/core'

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
	}
}

/** Routes reachable without the token (the browser hitting the OAuth redirect has no way to send it). */
const PUBLIC_ROUTES = new Set(['/api/auth/spotify/callback'])

export async function createServer(opts: ServerOptions): Promise<FastifyInstance> {
	const { kemix } = opts
	const app = Fastify({ logger: opts.logger ?? false })

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

	app.post('/api/accounts/qobuz', async (req) => {
		await kemix.accounts.connectQobuz(req.body as Parameters<Kemix['accounts']['connectQobuz']>[0])
		void kemix.library.syncAll()
		return { ok: true }
	})
	app.post('/api/accounts/qobuz/browser', async () => {
		if (!opts.browserLogin) {
			throw Object.assign(new Error('El inicio de sesión en ventana solo está disponible en la app de escritorio'), {
				statusCode: 404
			})
		}
		const session = await opts.browserLogin.qobuz()
		try {
			await kemix.accounts.connectQobuz({ session })
		} catch (err) {
			// The generic errors talk about pasting cookies/cURL, which doesn't apply to the login window.
			const message = err instanceof Error ? err.message : String(err)
			throw new Error(
				message.startsWith('No encontré un token')
					? 'La ventana de Qobuz no entregó un token válido. Vuelve a intentarlo y espera a que cargue el reproductor.'
					: message
			)
		}
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
	app.post('/api/accounts/spotify/start', async () => ({ url: kemix.accounts.startSpotifyAuth() }))
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
	app.delete('/api/accounts/:service', async (req) => {
		kemix.accounts.disconnect(service(req.params))
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

	app.get('/api/playlists/:id', async (req) => kemix.library.getPlaylist(id(req.params)))
	app.post('/api/playlists/:id/sync', async (req) => {
		await kemix.library.syncPlaylistTracks(id(req.params), true)
		return { ok: true }
	})
	app.post('/api/playlists/:id/download', async (req) => {
		await kemix.queue.enqueuePlaylist(id(req.params))
		return { ok: true }
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

	app.get('/api/review', async () => kemix.library.listReview())
	app.post('/api/review/:id/search', async (req) =>
		kemix.queue.searchCandidates(id(req.params), (req.body as { query?: string } | undefined)?.query)
	)
	app.post('/api/review/:id/accept', async (req) => {
		kemix.queue.acceptCandidate(id(req.params), (req.body as { candidate: MatchCandidate }).candidate)
		return { ok: true }
	})
	app.post('/api/review/:id/skip', async (req) => {
		kemix.queue.skipTrack(id(req.params))
		return { ok: true }
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
