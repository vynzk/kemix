// Cliente de la red Soulseek: la sesión con el servidor, las conexiones con otros usuarios, las búsquedas y las
// descargas. Kemix solo descarga: anuncia 0 archivos compartidos y rechaza con educación lo que otros le piden.
import net from 'node:net'
import { PassThrough, type Duplex, type Readable } from 'node:stream'
import { errorMessage, sleep } from '../util'
import {
	MessageReader,
	FrameSplitter,
	PeerCode,
	ProtocolError,
	SERVER_HOST,
	SERVER_PORT,
	ServerCode,
	cantConnectToPeerMessage,
	connectToPeerMessage,
	fileOffsetMessage,
	fileSearchMessage,
	getPeerAddressMessage,
	loginMessage,
	parseConnectToPeer,
	parseLogin,
	parsePeerAddress,
	parsePeerInit,
	parseSearchResponse,
	parseTransferRequest,
	peerInitMessage,
	pierceFireWallMessage,
	placeInQueueRequestMessage,
	queueUploadMessage,
	setStatusMessage,
	setWaitPortMessage,
	sharedFileListResponseMessage,
	sharedFoldersFilesMessage,
	transferResponseMessage,
	uploadDeniedMessage,
	userInfoResponseMessage,
	type ConnectToPeerRequest,
	type LoginResult,
	type PeerAddress,
	type PeerInit,
	type SearchResponse
} from './soulseek-protocol'

/** Cómo se abren los sockets: TCP de verdad, o streams en memoria en los tests. */
export interface SlskTransport {
	connect(host: string, port: number, timeoutMs: number): Promise<Duplex>
	/** Escucha conexiones entrantes en `port`; null si no se pudo (puerto ocupado, sin permiso…). */
	listen(port: number, onSocket: (socket: Duplex) => void): Promise<{ close(): void } | null>
}

export const tcpTransport: SlskTransport = {
	connect: (host, port, timeoutMs) =>
		new Promise((resolve, reject) => {
			const socket = net.connect({ host, port })
			const timer = setTimeout(() => {
				socket.destroy()
				reject(new Error(`tiempo agotado al conectar con ${host}:${port}`))
			}, timeoutMs)
			socket.once('connect', () => {
				clearTimeout(timer)
				socket.setNoDelay(true)
				socket.setKeepAlive(true, 60_000)
				resolve(socket)
			})
			socket.once('error', (err) => {
				clearTimeout(timer)
				reject(err)
			})
		}),
	listen: (port, onSocket) =>
		new Promise((resolve) => {
			const server = net.createServer((socket) => {
				socket.setNoDelay(true)
				onSocket(socket)
			})
			server.once('error', () => resolve(null))
			server.listen(port, () => {
				server.on('error', () => {})
				resolve({ close: () => server.close() })
			})
		})
}

/** Tiempos de espera; los tests los acortan. */
export interface SlskTiming {
	connectMs: number
	loginMs: number
	/** Para lograr una conexión con otro usuario, directa o indirecta. */
	peerMs: number
	/** Para que quien se conecta con nosotros mande su primer mensaje. */
	initMs: number
	/** Desde que el otro usuario acepta enviar un archivo hasta que abre la conexión para enviarlo. */
	fileConnectMs: number
	/** Lo máximo que se espera en la cola de otro usuario antes de probar otra fuente. */
	queueMs: number
	/** Cuándo se le pregunta en qué puesto de su cola estamos. */
	placeAskMs: number
	searchWindowMs: number
	/** Separación mínima entre búsquedas: el servidor castiga a quien busca demasiado seguido. */
	searchIntervalMs: number
}

const DEFAULT_TIMING: SlskTiming = {
	connectMs: 15_000,
	loginMs: 20_000,
	peerMs: 20_000,
	initMs: 15_000,
	fileConnectMs: 30_000,
	queueMs: 3 * 60_000,
	placeAskMs: 60_000,
	searchWindowMs: 6_000,
	searchIntervalMs: 2_000
}

const MAX_SEARCHES = 2
const SEARCH_MAX_FILES = 300
/** Más atrás que esto en una cola, no se espera: se prueba otra fuente. */
const MAX_QUEUE_PLACE = 10
const PEER_IDLE_MS = 5 * 60_000
const STATUS_ONLINE = 2

const RELOGGED =
	'Otro programa inició sesión en Soulseek con tu usuario y el servidor cerró esta sesión. Cierra el otro programa (o usa otro usuario) y vuelve a conectar Soulseek en Cuentas.'

export interface SlskClientOptions {
	username: string
	password: string
	/** Puerto en el que se escuchan conexiones de otros usuarios. */
	port: () => number
	transport?: SlskTransport
	server?: { host: string; port: number }
	timing?: Partial<SlskTiming>
	/** La sesión se perdió y no se va a recuperar sola (otro programa entró con el mismo usuario). */
	onSessionLost?: (err: Error) => void
}

export interface SearchOptions {
	windowMs?: number
	maxFiles?: number
	signal?: AbortSignal
	/** Cada respuesta según llega, para mostrar resultados en vivo. */
	onResponse?: (res: SearchResponse) => void
}

export interface DownloadOptions {
	signal?: AbortSignal
	queueMs?: number
}

export interface StartedDownload {
	stream: Readable
	size: number
}

/** Lo que el downloader necesita de la red (los tests lo simulan). */
export interface SoulseekNetwork {
	search(query: string, opts?: SearchOptions): Promise<SearchResponse[]>
	download(username: string, path: string, opts?: DownloadOptions): Promise<StartedDownload>
}

export interface SlskStatus {
	online: boolean
	/** Si se pudo abrir el puerto para que otros usuarios se conecten directamente. */
	listening: boolean
	port: number
}

const noop = () => {}

function loginError(r: Extract<LoginResult, { ok: false }>): string {
	switch (r.reason) {
		case 'INVALIDPASS':
			return 'Usuario o contraseña de Soulseek incorrectos'
		case 'INVALIDUSERNAME':
			return `Soulseek no acepta ese nombre de usuario${r.detail ? ` (${r.detail})` : ''}`
		case 'SVRFULL':
			return 'El servidor de Soulseek está lleno: prueba más tarde'
		case 'SVRPRIVATE':
			return 'El servidor de Soulseek no acepta usuarios nuevos ahora: usa una cuenta que ya exista'
		default:
			return `Soulseek rechazó el inicio de sesión (${r.reason})`
	}
}

/** Los motivos de rechazo más comunes, en palabras del usuario. */
function denialReason(reason: string): string {
	if (/not shared/i.test(reason)) return 'ya no lo comparte'
	if (/banned/i.test(reason)) return 'no te deja bajar sus archivos'
	if (/too many/i.test(reason)) return 'tiene demasiadas descargas en cola'
	if (/shutdown/i.test(reason)) return 'está cerrando su programa'
	return reason
}

const downloadKey = (username: string, path: string) => `${username}\n${path}`

/** Conexión que intercambia mensajes con largo y código uint32: la del servidor y las P entre usuarios. */
class MessageConnection {
	#splitter = new FrameSplitter()
	#closed = false
	onMessage: (code: number, r: MessageReader) => void = noop
	onClose: () => void = noop
	/** Último mensaje, para cerrar las conexiones con usuarios que llevan rato sin hablar. */
	lastUsed = Date.now()

	constructor(private socket: Duplex) {
		socket.on('error', noop)
		socket.on('close', () => this.close())
	}

	/** Empieza a leer. `initial`: lo que llegó detrás del mensaje de inicio de la conexión. */
	start(initial: Buffer = Buffer.alloc(0)) {
		if (this.socket.destroyed) return this.close()
		this.socket.on('data', (chunk: Buffer) => this.#feed(chunk))
		if (initial.length) this.#feed(initial)
		this.socket.resume()
	}

	get closed() {
		return this.#closed
	}

	#feed(chunk: Buffer) {
		this.lastUsed = Date.now()
		let frames: Buffer[]
		try {
			frames = this.#splitter.push(chunk)
		} catch {
			return this.close()
		}
		for (const frame of frames) {
			if (this.#closed) return
			if (frame.length < 4) continue
			try {
				this.onMessage(frame.readUInt32LE(0), new MessageReader(frame.subarray(4)))
			} catch {
				// Un mensaje mal formado no tumba la conexión.
			}
		}
	}

	send(buf: Buffer) {
		if (this.#closed) return
		this.lastUsed = Date.now()
		this.socket.write(buf)
	}

	close() {
		if (this.#closed) return
		this.#closed = true
		this.socket.destroy()
		this.onClose()
	}
}

/** Lee el primer mensaje de una conexión entre usuarios y deja el socket en pausa con lo que sobró. */
function readInit(socket: Duplex, timeoutMs: number): Promise<{ init: PeerInit; rest: Buffer }> {
	return new Promise((resolve, reject) => {
		let buf = Buffer.alloc(0)
		const finish = (err: Error | null, value?: { init: PeerInit; rest: Buffer }) => {
			clearTimeout(timer)
			socket.off('data', onData)
			socket.off('close', onClose)
			socket.pause()
			if (err) {
				socket.destroy()
				reject(err)
			} else resolve(value!)
		}
		const onData = (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk])
			if (buf.length < 4) return
			const len = buf.readUInt32LE(0)
			if (len > 4096) return finish(new ProtocolError('Inicio de conexión demasiado largo'))
			if (buf.length < 4 + len) return
			try {
				finish(null, { init: parsePeerInit(buf.subarray(4, 4 + len)), rest: buf.subarray(4 + len) })
			} catch (err) {
				finish(err as Error)
			}
		}
		const onClose = () => finish(new Error('la conexión se cerró'))
		const timer = setTimeout(() => finish(new Error('el otro usuario no se presentó')), timeoutMs)
		socket.on('data', onData)
		socket.on('close', onClose)
		socket.resume()
	})
}

/** Una descarga pedida: esperando en la cola del otro usuario, o a que abra la conexión para enviar el archivo. */
class PendingDownload {
	token?: number
	size = 0
	#timers = new Set<NodeJS.Timeout>()
	#settled = false

	constructor(
		readonly username: string,
		readonly path: string,
		private onSettle: () => void,
		private resolve: (started: StartedDownload) => void,
		private reject: (err: Error) => void
	) {}

	get settled() {
		return this.#settled
	}

	after(ms: number, fn: () => void) {
		const t = setTimeout(() => {
			this.#timers.delete(t)
			fn()
		}, ms)
		this.#timers.add(t)
	}

	clearTimers() {
		for (const t of this.#timers) clearTimeout(t)
		this.#timers.clear()
	}

	fail(err: Error) {
		if (this.#settled) return
		this.#settled = true
		this.clearTimers()
		this.onSettle()
		this.reject(err)
	}

	start(started: StartedDownload) {
		if (this.#settled) return started.stream.destroy()
		this.#settled = true
		this.clearTimers()
		this.onSettle()
		this.resolve(started)
	}
}

interface SearchCollector {
	add(res: SearchResponse): void
	finish(): void
}

/** Una conexión que pedimos al servidor que el otro usuario abra hacia nosotros (con PierceFireWall y este token). */
interface IndirectRequest {
	accept(socket: Duplex, rest: Buffer): void
	failed(): void
}

/** Una sesión de Soulseek con una cuenta. Se conecta al usarla por primera vez y se reconecta si se cae. */
export class SlskClient implements SoulseekNetwork {
	#transport: SlskTransport
	#timing: SlskTiming
	#server: MessageConnection | null = null
	#session: Promise<MessageConnection> | null = null
	/** undefined: todavía no se intentó escuchar; null: no se pudo. */
	#listener: { close(): void } | null | undefined
	#port: number | null = null
	#destroyed = false
	#lost: Error | null = null
	#nextToken = Math.floor(Math.random() * 0x7fffffff)
	#reconnectTimer?: NodeJS.Timeout
	#reconnectDelay = 1000
	#sweepTimer?: NodeJS.Timeout

	/** La última conexión P abierta con cada usuario. */
	#peers = new Map<string, MessageConnection>()
	#allPeers = new Set<MessageConnection>()
	#connecting = new Map<string, Promise<MessageConnection>>()
	#indirect = new Map<number, IndirectRequest>()
	#addressWaiters = new Map<string, ((addr: PeerAddress) => void)[]>()
	#searches = new Map<number, SearchCollector>()
	#activeSearches = 0
	#lastSearchAt = 0
	#downloads = new Map<string, PendingDownload>()
	#transfers = new Map<number, PendingDownload>()

	constructor(private opts: SlskClientOptions) {
		this.#transport = opts.transport ?? tcpTransport
		this.#timing = { ...DEFAULT_TIMING, ...opts.timing }
	}

	get username() {
		return this.opts.username
	}

	/** Inicia sesión (si no la hay ya). Lanza el motivo si Soulseek la rechaza. */
	async login(): Promise<void> {
		await this.#ensure()
	}

	status(): SlskStatus {
		return {
			online: !!this.#server && !this.#server.closed,
			listening: !!this.#listener,
			port: this.#port ?? this.opts.port()
		}
	}

	/** Cierra todo: la sesión, el puerto y las descargas en curso. */
	destroy() {
		if (this.#destroyed) return
		this.#destroyed = true
		clearTimeout(this.#reconnectTimer)
		clearInterval(this.#sweepTimer)
		const closed = new Error('Se cerró la conexión con Soulseek')
		for (const d of [...this.#downloads.values(), ...this.#transfers.values()]) d.fail(closed)
		for (const s of [...this.#searches.values()]) s.finish()
		for (const r of [...this.#indirect.values()]) r.failed()
		for (const p of [...this.#allPeers]) p.close()
		this.#server?.close()
		this.#listener?.close()
	}

	#token(): number {
		this.#nextToken = (this.#nextToken + 1) >>> 0
		return this.#nextToken
	}

	// ---------- sesión ----------

	#ensure(): Promise<MessageConnection> {
		if (this.#destroyed) return Promise.reject(new Error('Se cerró la conexión con Soulseek'))
		if (this.#lost) return Promise.reject(this.#lost)
		if (this.#server && !this.#server.closed) return Promise.resolve(this.#server)
		this.#session ??= this.#connect().finally(() => {
			this.#session = null
		})
		return this.#session
	}

	async #connect(): Promise<MessageConnection> {
		const { host, port } = this.opts.server ?? { host: SERVER_HOST, port: SERVER_PORT }
		let socket: Duplex
		try {
			socket = await this.#transport.connect(host, port, this.#timing.connectMs)
		} catch (err) {
			throw new Error(`No se pudo conectar con el servidor de Soulseek (${errorMessage(err)})`)
		}
		const conn = new MessageConnection(socket)
		const result = await new Promise<LoginResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				conn.close()
				reject(new Error('El servidor de Soulseek no respondió al inicio de sesión'))
			}, this.#timing.loginMs)
			conn.onMessage = (code, r) => {
				if (code !== ServerCode.Login) return
				clearTimeout(timer)
				resolve(parseLogin(r))
			}
			conn.onClose = () => {
				clearTimeout(timer)
				reject(new Error('El servidor de Soulseek cerró la conexión al iniciar sesión'))
			}
			conn.start()
			conn.send(loginMessage(this.opts.username, this.opts.password))
		})
		if (!result.ok) {
			conn.close()
			throw new Error(loginError(result))
		}
		if (this.#destroyed) {
			conn.close()
			throw new Error('Se cerró la conexión con Soulseek')
		}
		conn.onMessage = (code, r) => this.#onServerMessage(code, r)
		conn.onClose = () => this.#onServerClosed(conn)
		this.#server = conn
		this.#reconnectDelay = 1000
		if (this.#listener === undefined) {
			this.#port = this.opts.port()
			this.#listener = await this.#transport.listen(this.#port, (s) => this.#onIncoming(s))
		}
		// Sin puerto abierto no se anuncia ninguno: los demás se conectarán a través del servidor.
		if (this.#listener && this.#port) conn.send(setWaitPortMessage(this.#port))
		conn.send(sharedFoldersFilesMessage(0, 0))
		conn.send(setStatusMessage(STATUS_ONLINE))
		this.#sweepTimer ??= setInterval(() => this.#sweepPeers(), 60_000)
		this.#sweepTimer.unref?.()
		return conn
	}

	#onServerClosed(conn: MessageConnection) {
		if (this.#server === conn) this.#server = null
		if (this.#destroyed || this.#lost) return
		// Con descargas esperando, hay que seguir en línea para que los demás puedan ubicarnos y enviarlas.
		if (this.#downloads.size) this.#scheduleReconnect()
	}

	#scheduleReconnect() {
		if (this.#reconnectTimer || this.#destroyed) return
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined
			this.#ensure().catch(() => {
				this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 60_000)
				if (this.#downloads.size) this.#scheduleReconnect()
			})
		}, this.#reconnectDelay)
	}

	#lose(err: Error) {
		if (this.#lost) return
		this.#lost = err
		for (const d of [...this.#downloads.values(), ...this.#transfers.values()]) d.fail(err)
		this.#server?.close()
		this.opts.onSessionLost?.(err)
	}

	#onServerMessage(code: number, r: MessageReader) {
		switch (code) {
			case ServerCode.GetPeerAddress: {
				const addr = parsePeerAddress(r)
				const waiters = this.#addressWaiters.get(addr.username) ?? []
				this.#addressWaiters.delete(addr.username)
				for (const w of waiters) w(addr)
				return
			}
			case ServerCode.ConnectToPeer:
				return void this.#onConnectToPeer(parseConnectToPeer(r))
			case ServerCode.CantConnectToPeer:
				return this.#indirect.get(r.uint32())?.failed()
			case ServerCode.Relogged:
				return this.#lose(new Error(RELOGGED))
		}
	}

	// ---------- conexiones con otros usuarios ----------

	/** La dirección de un usuario según el servidor; puerto 0 si no está en línea o no escucha. */
	#peerAddress(username: string): Promise<PeerAddress> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const list = this.#addressWaiters.get(username)?.filter((w) => w !== waiter)
				if (list?.length) this.#addressWaiters.set(username, list)
				else this.#addressWaiters.delete(username)
				reject(new Error('el servidor no dio su dirección'))
			}, this.#timing.peerMs)
			const waiter = (addr: PeerAddress) => {
				clearTimeout(timer)
				resolve(addr)
			}
			const list = this.#addressWaiters.get(username)
			if (list) list.push(waiter)
			else {
				this.#addressWaiters.set(username, [waiter])
				this.#server?.send(getPeerAddressMessage(username))
			}
		})
	}

	/** Una conexión P con `username`: la que ya hay, o una nueva. */
	#peer(username: string): Promise<MessageConnection> {
		const open = this.#peers.get(username)
		if (open && !open.closed) return Promise.resolve(open)
		let pending = this.#connecting.get(username)
		if (!pending) {
			pending = this.#connectPeer(username).finally(() => this.#connecting.delete(username))
			this.#connecting.set(username, pending)
		}
		return pending
	}

	/**
	 * Como los clientes actuales: se pide al servidor que el otro usuario se conecte con nosotros (por si no podemos
	 * llegar a él) y a la vez se intenta llegar directamente. Gana la primera conexión que funcione.
	 */
	#connectPeer(username: string): Promise<MessageConnection> {
		const server = this.#server
		if (!server) return Promise.reject(new Error('No hay sesión con Soulseek'))
		const token = this.#token()
		return new Promise((resolve, reject) => {
			let done = false
			let directFailed = false
			let indirectFailed = false
			const finish = (err: Error | null, socket?: Duplex, rest?: Buffer) => {
				if (done) {
					socket?.destroy()
					return
				}
				done = true
				clearTimeout(timer)
				this.#indirect.delete(token)
				if (err) return reject(err)
				resolve(this.#adoptPeer(username, socket!, rest ?? Buffer.alloc(0)))
			}
			const unreachable = () =>
				new Error(`No se pudo conectar con ${username} (está desconectado o detrás de un firewall)`)
			const maybeFail = () => {
				if (directFailed && indirectFailed) finish(unreachable())
			}
			const timer = setTimeout(() => finish(unreachable()), this.#timing.peerMs)
			this.#indirect.set(token, {
				accept: (socket, rest) => finish(null, socket, rest),
				failed: () => {
					indirectFailed = true
					maybeFail()
				}
			})
			server.send(connectToPeerMessage(token, username, 'P'))
			this.#peerAddress(username)
				.then(async ({ ip, port }) => {
					if (done) return
					if (!port || ip === '0.0.0.0') throw new Error('sin dirección')
					const socket = await this.#transport.connect(ip, port, this.#timing.connectMs)
					socket.on('error', noop)
					socket.write(peerInitMessage(this.opts.username, 'P'))
					finish(null, socket)
				})
				.catch(() => {
					directFailed = true
					maybeFail()
				})
		})
	}

	#adoptPeer(username: string, socket: Duplex, rest: Buffer): MessageConnection {
		const conn = new MessageConnection(socket)
		conn.onMessage = (code, r) => this.#onPeerMessage(username, conn, code, r)
		conn.onClose = () => {
			this.#allPeers.delete(conn)
			if (this.#peers.get(username) === conn) this.#peers.delete(username)
		}
		this.#allPeers.add(conn)
		this.#peers.set(username, conn)
		conn.start(rest)
		return conn
	}

	/** Cierra las conexiones con usuarios que llevan un rato sin hablar (y sin descargas pendientes con ellos). */
	#sweepPeers() {
		const busy = new Set([...this.#downloads.values()].map((d) => d.username))
		const limit = Date.now() - PEER_IDLE_MS
		for (const [username, conn] of this.#peers) {
			if (!busy.has(username) && conn.lastUsed < limit) conn.close()
		}
	}

	/** Alguien se conecta con nosotros: se presenta (PeerInit) o responde a una conexión que pedimos (PierceFireWall). */
	async #onIncoming(socket: Duplex) {
		socket.on('error', noop)
		if (this.#destroyed) return socket.destroy()
		let init: PeerInit
		let rest: Buffer
		try {
			;({ init, rest } = await readInit(socket, this.#timing.initMs))
		} catch {
			return
		}
		if (init.kind === 'pierce') {
			const request = this.#indirect.get(init.token)
			if (request) request.accept(socket, rest)
			else socket.destroy()
			return
		}
		if (init.type === 'P') this.#adoptPeer(init.username, socket, rest)
		else if (init.type === 'F') this.#acceptFile(socket, rest)
		else socket.destroy()
	}

	/** El servidor dice que otro usuario no pudo conectarse con nosotros: nos conectamos nosotros a él. */
	async #onConnectToPeer(req: ConnectToPeerRequest) {
		if (this.#destroyed || (req.type !== 'P' && req.type !== 'F')) return
		let socket: Duplex
		try {
			socket = await this.#transport.connect(req.ip, req.port, this.#timing.connectMs)
		} catch {
			this.#server?.send(cantConnectToPeerMessage(req.token, req.username))
			return
		}
		socket.on('error', noop)
		socket.write(pierceFireWallMessage(req.token))
		if (req.type === 'P') this.#adoptPeer(req.username, socket, Buffer.alloc(0))
		else this.#acceptFile(socket, Buffer.alloc(0))
	}

	#onPeerMessage(username: string, conn: MessageConnection, code: number, r: MessageReader) {
		switch (code) {
			case PeerCode.FileSearchResponse: {
				const res = parseSearchResponse(r.rest())
				return this.#searches.get(res.token)?.add(res)
			}
			case PeerCode.TransferRequest: {
				const req = parseTransferRequest(r)
				// Nos piden un archivo a nosotros: no compartimos nada.
				if (req.direction !== 1) return conn.send(transferResponseMessage(req.token, false, 'File not shared.'))
				const d = this.#downloads.get(downloadKey(username, req.path))
				if (!d || d.token !== undefined) return conn.send(transferResponseMessage(req.token, false, 'Cancelled'))
				d.token = req.token
				d.size = req.size ?? 0
				this.#transfers.set(req.token, d)
				d.clearTimers()
				d.after(this.#timing.fileConnectMs, () =>
					d.fail(new Error(`${username} aceptó enviar el archivo, pero no se pudo abrir la conexión para recibirlo`))
				)
				return conn.send(transferResponseMessage(req.token, true))
			}
			case PeerCode.PlaceInQueueResponse: {
				const path = r.string()
				const place = r.uint32()
				if (place > MAX_QUEUE_PLACE) {
					this.#downloads
						.get(downloadKey(username, path))
						?.fail(new Error(`El archivo está en el puesto ${place} de la cola de ${username}: se prueba otra fuente`))
				}
				return
			}
			case PeerCode.UploadDenied: {
				const path = r.string()
				const reason = r.string()
				return this.#downloads
					.get(downloadKey(username, path))
					?.fail(new Error(`${username} no deja bajar ese archivo: ${denialReason(reason)}`))
			}
			case PeerCode.UploadFailed:
				return this.#downloads
					.get(downloadKey(username, r.string()))
					?.fail(new Error(`${username} no pudo enviar el archivo`))
			case PeerCode.QueueUpload:
				return conn.send(uploadDeniedMessage(r.string(), 'File not shared.'))
			case PeerCode.UserInfoRequest:
				return conn.send(userInfoResponseMessage())
			case PeerCode.GetShareFileList:
				return conn.send(sharedFileListResponseMessage())
		}
	}

	/** Una conexión de archivo: el otro usuario manda primero el token de la transferencia y después el archivo. */
	#acceptFile(socket: Duplex, initial: Buffer) {
		let buf = initial
		const timer = setTimeout(() => socket.destroy(), this.#timing.initMs)
		const check = () => {
			if (buf.length < 4) return
			clearTimeout(timer)
			socket.off('data', onData)
			socket.off('close', onClose)
			socket.pause()
			const d = this.#transfers.get(buf.readUInt32LE(0))
			if (!d) return socket.destroy()
			this.#receive(d, socket, buf.subarray(4))
		}
		const onData = (chunk: Buffer) => {
			buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
			check()
		}
		const onClose = () => clearTimeout(timer)
		socket.on('data', onData)
		socket.on('close', onClose)
		check()
		if (buf.length < 4) socket.resume()
	}

	/** Pide el archivo desde el principio y lo entrega como stream, de exactamente `d.size` bytes. */
	#receive(d: PendingDownload, socket: Duplex, initial: Buffer) {
		const out = new PassThrough()
		const size = d.size
		let received = 0
		const onData = (chunk: Buffer) => {
			const take = chunk.subarray(0, size - received)
			received += take.length
			if (take.length && !out.write(take)) socket.pause()
			if (received >= size) {
				socket.off('data', onData)
				out.end()
				// Quien descarga cierra la conexión al terminar.
				socket.destroy()
			}
		}
		out.on('drain', () => socket.resume())
		// Si quien lee el stream lo abandona (descarga borrada o cancelada), se corta la transferencia.
		out.on('close', () => socket.destroy())
		socket.on('close', () => {
			if (received < size) {
				out.destroy(new Error(`La transferencia desde ${d.username} se cortó (${received} de ${size} bytes)`))
			}
		})
		socket.write(fileOffsetMessage(0))
		d.start({ stream: out, size })
		if (size === 0) {
			out.end()
			socket.destroy()
			return
		}
		socket.on('data', onData)
		if (initial.length) onData(initial)
		socket.resume()
	}

	// ---------- búsqueda y descarga ----------

	/** Espera turno: como mucho dos búsquedas a la vez y una cada `searchIntervalMs`. */
	async #searchSlot(signal?: AbortSignal) {
		while (this.#activeSearches >= MAX_SEARCHES || Date.now() - this.#lastSearchAt < this.#timing.searchIntervalMs) {
			signal?.throwIfAborted()
			await sleep(100)
		}
		this.#activeSearches++
		this.#lastSearchAt = Date.now()
	}

	/**
	 * Busca en toda la red. Las respuestas llegan de cada usuario por separado durante unos segundos: se juntan las
	 * que lleguen en `windowMs` (o hasta `maxFiles` archivos). Cancelar con `signal` devuelve lo que haya hasta ahí.
	 */
	async search(query: string, opts: SearchOptions = {}): Promise<SearchResponse[]> {
		const server = await this.#ensure()
		await this.#searchSlot(opts.signal)
		const token = this.#token()
		const maxFiles = opts.maxFiles ?? SEARCH_MAX_FILES
		const responses: SearchResponse[] = []
		let files = 0
		return new Promise((resolve) => {
			const finish = () => {
				if (!this.#searches.has(token)) return
				this.#searches.delete(token)
				this.#activeSearches--
				clearTimeout(timer)
				opts.signal?.removeEventListener('abort', finish)
				resolve(responses)
			}
			const timer = setTimeout(finish, opts.windowMs ?? this.#timing.searchWindowMs)
			this.#searches.set(token, {
				add: (res) => {
					responses.push(res)
					files += res.files.length
					opts.onResponse?.(res)
					if (files >= maxFiles) finish()
				},
				finish
			})
			opts.signal?.addEventListener('abort', finish, { once: true })
			server.send(fileSearchMessage(token, query))
		})
	}

	/**
	 * Pide un archivo a otro usuario y espera a que empiece a enviarlo. Lanza si lo rechaza, si no se puede llegar a
	 * él o si la espera en su cola se alarga demasiado (para que se pruebe otra fuente).
	 */
	async download(username: string, path: string, opts: DownloadOptions = {}): Promise<StartedDownload> {
		const { signal } = opts
		signal?.throwIfAborted()
		await this.#ensure()
		const key = downloadKey(username, path)
		if (this.#downloads.has(key)) throw new Error('Ese archivo ya se está bajando')
		const conn = await this.#peer(username)
		signal?.throwIfAborted()
		return new Promise<StartedDownload>((resolve, reject) => {
			const onAbort = () => d.fail(signal?.reason instanceof Error ? signal.reason : new Error('Descarga cancelada'))
			const d: PendingDownload = new PendingDownload(
				username,
				path,
				() => {
					if (this.#downloads.get(key) === d) this.#downloads.delete(key)
					if (d.token !== undefined) this.#transfers.delete(d.token)
					signal?.removeEventListener('abort', onAbort)
				},
				resolve,
				reject
			)
			this.#downloads.set(key, d)
			signal?.addEventListener('abort', onAbort, { once: true })
			conn.send(queueUploadMessage(path))
			d.after(this.#timing.placeAskMs, () => this.#peers.get(username)?.send(placeInQueueRequestMessage(path)))
			d.after(opts.queueMs ?? this.#timing.queueMs, () =>
				d.fail(new Error(`${username} tiene el archivo en cola y no empezó a enviarlo: se prueba otra fuente`))
			)
		})
	}
}
