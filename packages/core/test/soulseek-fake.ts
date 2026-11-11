// Una red Soulseek de mentira, en memoria: un servidor y otros usuarios que comparten archivos. Sirve para probar
// SlskClient de punta a punta sin tocar la red.
import { duplexPair, type Duplex } from 'node:stream'
import type { SlskTransport } from '../src/sources/soulseek-client'
import {
	FrameSplitter,
	MessageReader,
	MessageWriter,
	PeerCode,
	ServerCode,
	fileTransferInitMessage,
	ipToUint32,
	parsePeerInit,
	peerInitMessage,
	pierceFireWallMessage,
	placeInQueueResponseMessage,
	searchResponseMessage,
	transferRequestMessage,
	uploadDeniedMessage,
	type ConnectionType,
	type FileAttributes
} from '../src/sources/soulseek-protocol'

export const SERVER = { host: 'server', port: 2242 }
export const CLIENT_IP = '10.0.0.1'

/** Un mensaje con código uint32, como los manda el servidor o un usuario por una conexión P. */
export function frame(code: number, build: (w: MessageWriter) => void = () => {}): Buffer {
	const w = new MessageWriter().uint32(code)
	build(w)
	const body = w.toBuffer()
	return Buffer.concat([new MessageWriter().uint32(body.length).toBuffer(), body])
}

/** Sockets en memoria: cada equipo (IP) escucha en sus puertos y se conecta a los de los demás. */
export class FakeNet {
	#listeners = new Map<string, (socket: Duplex) => void>()

	transport(ip: string): SlskTransport {
		return {
			connect: async (host, port) => {
				const listener = this.#listeners.get(`${host}:${port}`)
				if (!listener) throw new Error('ECONNREFUSED')
				const [a, b] = duplexPair()
				// Cerrar un extremo cierra el otro, como un socket TCP.
				a.on('close', () => b.destroy())
				b.on('close', () => a.destroy())
				a.on('error', () => {})
				b.on('error', () => {})
				setImmediate(() => listener(b))
				return a
			},
			listen: async (port, onSocket) => {
				const key = `${ip}:${port}`
				if (this.#listeners.has(key)) return null
				this.#listeners.set(key, onSocket)
				return { close: () => this.#listeners.delete(key) }
			}
		}
	}
}

/** Lee mensajes con largo y código uint32 de un socket. */
class Conn {
	#splitter = new FrameSplitter()
	onMessage: (code: number, r: MessageReader) => void = () => {}

	constructor(readonly socket: Duplex, initial: Buffer = Buffer.alloc(0)) {
		socket.on('data', (chunk: Buffer) => this.#feed(chunk))
		if (initial.length) setImmediate(() => this.#feed(initial))
	}

	#feed(chunk: Buffer) {
		for (const f of this.#splitter.push(chunk)) this.onMessage(f.readUInt32LE(0), new MessageReader(f.subarray(4)))
	}

	send(buf: Buffer) {
		if (!this.socket.destroyed) this.socket.write(buf)
	}
}

/** Lee el primer mensaje (de inicio) de una conexión entrante. */
function readFirst(socket: Duplex): Promise<{ body: Buffer; rest: Buffer }> {
	return new Promise((resolve) => {
		let buf = Buffer.alloc(0)
		const onData = (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk])
			if (buf.length < 4) return
			const len = buf.readUInt32LE(0)
			if (buf.length < 4 + len) return
			socket.off('data', onData)
			socket.pause()
			resolve({ body: buf.subarray(4, 4 + len), rest: buf.subarray(4 + len) })
		}
		socket.on('data', onData)
	})
}

export class FakeServer {
	password = 'clave'
	peers = new Map<string, FakePeer>()
	#clients = new Map<string, { conn: Conn; port: number }>()

	constructor(readonly net: FakeNet) {
		void net.transport(SERVER.host).listen(SERVER.port, (s) => this.#accept(s))
	}

	addPeer(name: string, ip: string, port: number, files: FakeFile[] = []): FakePeer {
		const peer = new FakePeer(name, ip, port, files, this)
		this.peers.set(name, peer)
		return peer
	}

	/** Dónde escucha el cliente; puerto 0 si no anunció ninguno. */
	clientAddress(name: string) {
		return { ip: CLIENT_IP, port: this.#clients.get(name)?.port ?? 0 }
	}

	/** Reenvía al cliente el pedido de un usuario que no pudo conectarse con él (ConnectToPeer). */
	askClientToConnect(client: string, from: FakePeer, type: ConnectionType, token: number) {
		this.#clients.get(client)?.conn.send(
			frame(ServerCode.ConnectToPeer, (w) =>
				w.string(from.name).string(type).uint32(ipToUint32(from.ip)).uint32(from.port).uint32(token).bool(false)
			)
		)
	}

	/** Echa al cliente porque alguien más entró con su usuario. */
	relog(client: string) {
		this.#clients.get(client)?.conn.send(frame(ServerCode.Relogged))
	}

	#accept(socket: Duplex) {
		const conn = new Conn(socket)
		let me = ''
		conn.onMessage = (code, r) => {
			switch (code) {
				case ServerCode.Login: {
					const username = r.string()
					const password = r.string()
					if (password !== this.password) return conn.send(frame(ServerCode.Login, (w) => w.bool(false).string('INVALIDPASS')))
					me = username
					this.#clients.set(me, { conn, port: 0 })
					return conn.send(
						frame(ServerCode.Login, (w) => w.bool(true).string('Hola').uint32(ipToUint32(CLIENT_IP)).string('').bool(false))
					)
				}
				case ServerCode.SetWaitPort:
					this.#clients.get(me)!.port = r.uint32()
					return
				case ServerCode.GetPeerAddress: {
					const username = r.string()
					const peer = this.peers.get(username)
					return conn.send(
						frame(ServerCode.GetPeerAddress, (w) =>
							w
								.string(username)
								.uint32(ipToUint32(peer?.ip ?? '0.0.0.0'))
								.uint32(peer?.port ?? 0)
						)
					)
				}
				case ServerCode.ConnectToPeer: {
					const token = r.uint32()
					const username = r.string()
					const type = r.string() as ConnectionType
					const peer = this.peers.get(username)
					if (peer) peer.connectBack(me, token, type).catch(() => {})
					else conn.send(frame(ServerCode.CantConnectToPeer, (w) => w.uint32(token)))
					return
				}
				case ServerCode.FileSearch: {
					const token = r.uint32()
					const query = r.string()
					// Quien no puede abrir conexión con el cliente simplemente no le llega.
					for (const peer of this.peers.values()) peer.onSearch(me, token, query).catch(() => {})
				}
			}
		}
	}
}

export interface FakeFile {
	path: string
	data: Buffer
	attrs?: FileAttributes
}

export class FakePeer {
	/** Rechaza todo lo que se le pide, con este motivo. */
	deny: string | null = null
	/** Deja las descargas en su cola para siempre. */
	queueForever = false
	/** Puesto en su cola que contesta cuando se le pregunta. */
	place = 0
	/** Corta la transferencia tras enviar estos bytes. */
	cutAfter: number | null = null
	/** Pedidos de archivo que recibió (QueueUpload). */
	requested: string[] = []
	#uploads = new Map<number, FakeFile>()
	#pierce = new Map<number, (socket: Duplex) => void>()
	#nextToken = 500

	constructor(
		readonly name: string,
		readonly ip: string,
		/** 0: no escucha (detrás de un firewall). */
		readonly port: number,
		public files: FakeFile[],
		private server: FakeServer
	) {
		if (port) void server.net.transport(ip).listen(port, (s) => void this.#onIncoming(s))
	}

	async #onIncoming(socket: Duplex) {
		const { body, rest } = await readFirst(socket)
		const init = parsePeerInit(body)
		if (init.kind === 'pierce') return this.#pierce.get(init.token)?.(socket)
		socket.resume()
		if (init.type === 'P') this.#serve(init.username, socket, rest)
	}

	/** Una conexión de tipo `type` con el cliente: directa si escucha; si no, que se conecte él (PierceFireWall). */
	async #open(client: string, type: ConnectionType): Promise<Duplex> {
		const addr = this.server.clientAddress(client)
		if (addr.port) {
			const socket = await this.server.net.transport(this.ip).connect(addr.ip, addr.port, 1000)
			socket.write(peerInitMessage(this.name, type))
			return socket
		}
		if (!this.port) throw new Error('ninguno de los dos puede recibir conexiones')
		const token = this.#nextToken++
		const opened = new Promise<Duplex>((resolve) => this.#pierce.set(token, resolve))
		this.server.askClientToConnect(client, this, type, token)
		const socket = await opened
		socket.resume()
		return socket
	}

	/** El cliente pidió (por el servidor) que nos conectemos con él. */
	async connectBack(client: string, token: number, type: ConnectionType) {
		const addr = this.server.clientAddress(client)
		if (!addr.port) return
		const socket = await this.server.net.transport(this.ip).connect(addr.ip, addr.port, 1000)
		socket.write(pierceFireWallMessage(token))
		if (type === 'P') this.#serve(client, socket)
	}

	async onSearch(client: string, token: number, query: string) {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean)
		const hits = this.files.filter((f) => words.every((w) => f.path.toLowerCase().includes(w)))
		if (!hits.length) return
		const socket = await this.#open(client, 'P')
		// Como un cliente real: lo que el otro mande después por esta conexión (p. ej. pedir el archivo) se atiende.
		this.#serve(client, socket)
		socket.write(
			searchResponseMessage({
				username: this.name,
				token,
				files: hits.map((f) => ({ path: f.path, size: f.data.length, ext: f.path.split('.').pop() ?? '', attrs: f.attrs ?? {} })),
				slotFree: true,
				avgSpeed: 1_000_000,
				queueLength: 0
			})
		)
	}

	/** Atiende los mensajes del cliente por una conexión P. */
	#serve(client: string, socket: Duplex, initial?: Buffer) {
		const conn = new Conn(socket, initial)
		conn.onMessage = (code, r) => {
			if (code === PeerCode.QueueUpload) {
				const path = r.string()
				this.requested.push(path)
				const file = this.files.find((f) => f.path === path)
				if (this.deny || !file) return conn.send(uploadDeniedMessage(path, this.deny ?? 'File not shared.'))
				if (this.queueForever) return
				const token = this.#nextToken++
				this.#uploads.set(token, file)
				conn.send(transferRequestMessage({ direction: 1, token, path, size: file.data.length }))
			} else if (code === PeerCode.TransferResponse) {
				const token = r.uint32()
				if (r.bool()) this.#sendFile(client, token).catch(() => {})
			} else if (code === PeerCode.PlaceInQueueRequest) {
				conn.send(placeInQueueResponseMessage(r.string(), this.place))
			}
		}
	}

	async #sendFile(client: string, token: number) {
		const file = this.#uploads.get(token)!
		const socket = await this.#open(client, 'F')
		socket.write(fileTransferInitMessage(token))
		// Espera el FileOffset (uint64) del cliente antes de mandar el archivo.
		await new Promise<void>((resolve) => {
			let got = 0
			const onData = (chunk: Buffer) => {
				got += chunk.length
				if (got >= 8) {
					socket.off('data', onData)
					resolve()
				}
			}
			socket.on('data', onData)
		})
		if (this.cutAfter !== null) {
			socket.write(file.data.subarray(0, this.cutAfter))
			setImmediate(() => socket.destroy())
			return
		}
		// En trozos, como llegaría por la red.
		for (let i = 0; i < file.data.length; i += 1000) socket.write(file.data.subarray(i, i + 1000))
	}
}
