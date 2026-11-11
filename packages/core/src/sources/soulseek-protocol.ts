// Protocolo de Soulseek: cómo se codifican los mensajes que Kemix cruza con el servidor y con otros usuarios.
// Solo lo que hace falta para buscar y descargar. Referencia: la documentación del protocolo de Nicotine+
// (https://nicotine-plus.org/doc/SLSKPROTOCOL.html). Todo es little-endian; los strings van con su largo delante.
import { createHash } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'

export const SERVER_HOST = 'server.slsknet.org'
export const SERVER_PORT = 2242
/** Versión de cliente que se anuncia al iniciar sesión (la de Nicotine+). */
const CLIENT_VERSION = 160
const CLIENT_MINOR_VERSION = 1

/** Mensajes del servidor (uint32 de largo + uint32 de código). */
export const ServerCode = {
	Login: 1,
	SetWaitPort: 2,
	GetPeerAddress: 3,
	ConnectToPeer: 18,
	FileSearch: 26,
	SetStatus: 28,
	SharedFoldersFiles: 35,
	Relogged: 41,
	ExcludedSearchPhrases: 160,
	CantConnectToPeer: 1001
} as const

/** Primer mensaje de cada conexión entre usuarios (uint32 de largo + uint8 de código). */
export const InitCode = { PierceFireWall: 0, PeerInit: 1 } as const

/** Mensajes entre usuarios por una conexión P (uint32 de largo + uint32 de código). */
export const PeerCode = {
	GetShareFileList: 4,
	SharedFileListResponse: 5,
	FileSearchResponse: 9,
	UserInfoRequest: 15,
	UserInfoResponse: 16,
	TransferRequest: 40,
	TransferResponse: 41,
	QueueUpload: 43,
	PlaceInQueueResponse: 44,
	UploadFailed: 46,
	UploadDenied: 50,
	PlaceInQueueRequest: 51
} as const

/** Tipos de conexión entre usuarios: mensajes (P), archivos (F) o la red distribuida de búsquedas (D). */
export type ConnectionType = 'P' | 'F' | 'D'

/** Tope para un mensaje: una respuesta de búsqueda grande ocupa unos cientos de KB. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

export class ProtocolError extends Error {}

// ---------- escritura y lectura ----------

export class MessageWriter {
	#chunks: Buffer[] = []

	uint8(n: number) {
		const b = Buffer.alloc(1)
		b.writeUInt8(n)
		this.#chunks.push(b)
		return this
	}

	bool(v: boolean) {
		return this.uint8(v ? 1 : 0)
	}

	uint32(n: number) {
		const b = Buffer.alloc(4)
		b.writeUInt32LE(n >>> 0)
		this.#chunks.push(b)
		return this
	}

	uint64(n: number | bigint) {
		const b = Buffer.alloc(8)
		b.writeBigUInt64LE(BigInt(n))
		this.#chunks.push(b)
		return this
	}

	string(s: string) {
		const bytes = Buffer.from(s, 'utf8')
		this.uint32(bytes.length)
		this.#chunks.push(bytes)
		return this
	}

	bytes(b: Buffer) {
		this.#chunks.push(b)
		return this
	}

	toBuffer(): Buffer {
		return Buffer.concat(this.#chunks)
	}
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

export class MessageReader {
	#pos = 0

	constructor(readonly buf: Buffer) {}

	get remaining() {
		return this.buf.length - this.#pos
	}

	#take(n: number): number {
		if (this.#pos + n > this.buf.length) throw new ProtocolError('Mensaje de Soulseek incompleto')
		const at = this.#pos
		this.#pos += n
		return at
	}

	uint8() {
		return this.buf.readUInt8(this.#take(1))
	}

	bool() {
		return this.uint8() !== 0
	}

	uint32() {
		return this.buf.readUInt32LE(this.#take(4))
	}

	int32() {
		return this.buf.readInt32LE(this.#take(4))
	}

	/** Los tamaños de archivo caben de sobra en un number. */
	uint64() {
		return Number(this.buf.readBigUInt64LE(this.#take(8)))
	}

	/** UTF-8; algunos clientes viejos mandan latin-1, que se lee como tal. */
	string() {
		const len = this.uint32()
		const at = this.#take(len)
		const bytes = this.buf.subarray(at, at + len)
		try {
			return utf8.decode(bytes)
		} catch {
			return bytes.toString('latin1')
		}
	}

	rest(): Buffer {
		const at = this.#take(this.remaining)
		return this.buf.subarray(at)
	}
}

/**
 * Junta los trozos que llegan por un socket y entrega los mensajes completos (sin el uint32 de largo).
 * `rest()` devuelve lo que sobró: en una conexión de archivo, tras el primer mensaje vienen bytes sin formato.
 */
export class FrameSplitter {
	#buf: Buffer = Buffer.alloc(0)

	constructor(private maxBytes = MAX_MESSAGE_BYTES) {}

	push(chunk: Buffer): Buffer[] {
		this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk
		const out: Buffer[] = []
		while (this.#buf.length >= 4) {
			const len = this.#buf.readUInt32LE(0)
			if (len > this.maxBytes) throw new ProtocolError(`Mensaje de Soulseek demasiado grande (${len} bytes)`)
			if (this.#buf.length < 4 + len) break
			out.push(this.#buf.subarray(4, 4 + len))
			this.#buf = this.#buf.subarray(4 + len)
		}
		return out
	}

	rest(): Buffer {
		const rest = this.#buf
		this.#buf = Buffer.alloc(0)
		return rest
	}
}

/** Un mensaje con código uint32 (servidor y conexiones P). */
function message(code: number, build?: (w: MessageWriter) => void): Buffer {
	const w = new MessageWriter().uint32(code)
	build?.(w)
	const body = w.toBuffer()
	return Buffer.concat([new MessageWriter().uint32(body.length).toBuffer(), body])
}

/** Un mensaje de inicio de conexión entre usuarios (código uint8). */
function initMessage(code: number, build: (w: MessageWriter) => void): Buffer {
	const w = new MessageWriter().uint8(code)
	build(w)
	const body = w.toBuffer()
	return Buffer.concat([new MessageWriter().uint32(body.length).toBuffer(), body])
}

/** Una IP como la manda el servidor: uint32 con los bytes al revés. */
export function ipFromUint32(n: number): string {
	return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

export function ipToUint32(ip: string): number {
	const [a = 0, b = 0, c = 0, d = 0] = ip.split('.').map(Number)
	return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
}

// ---------- servidor ----------

export function loginMessage(username: string, password: string): Buffer {
	const hash = createHash('md5').update(username + password).digest('hex')
	return message(ServerCode.Login, (w) =>
		w.string(username).string(password).uint32(CLIENT_VERSION).string(hash).uint32(CLIENT_MINOR_VERSION)
	)
}

export type LoginResult = { ok: true; greeting: string } | { ok: false; reason: string; detail?: string }

export function parseLogin(r: MessageReader): LoginResult {
	if (r.bool()) return { ok: true, greeting: r.string() }
	const reason = r.string()
	const detail = reason === 'INVALIDUSERNAME' && r.remaining >= 4 ? r.string() : undefined
	return { ok: false, reason, detail }
}

export const setWaitPortMessage = (port: number) => message(ServerCode.SetWaitPort, (w) => w.uint32(port))
export const sharedFoldersFilesMessage = (folders: number, files: number) =>
	message(ServerCode.SharedFoldersFiles, (w) => w.uint32(folders).uint32(files))
/** 2 = en línea. */
export const setStatusMessage = (status: number) => message(ServerCode.SetStatus, (w) => w.uint32(status))
export const fileSearchMessage = (token: number, query: string) =>
	message(ServerCode.FileSearch, (w) => w.uint32(token).string(query))
export const getPeerAddressMessage = (username: string) => message(ServerCode.GetPeerAddress, (w) => w.string(username))
export const connectToPeerMessage = (token: number, username: string, type: ConnectionType) =>
	message(ServerCode.ConnectToPeer, (w) => w.uint32(token).string(username).string(type))
export const cantConnectToPeerMessage = (token: number, username: string) =>
	message(ServerCode.CantConnectToPeer, (w) => w.uint32(token).string(username))

export interface PeerAddress {
	username: string
	ip: string
	port: number
}

export function parsePeerAddress(r: MessageReader): PeerAddress {
	return { username: r.string(), ip: ipFromUint32(r.uint32()), port: r.uint32() }
}

/** Otro usuario quiere conectarse con nosotros y no pudo directamente: hay que conectarse a él. */
export interface ConnectToPeerRequest extends PeerAddress {
	type: ConnectionType
	token: number
}

export function parseConnectToPeer(r: MessageReader): ConnectToPeerRequest {
	const username = r.string()
	const type = r.string() as ConnectionType
	const ip = ipFromUint32(r.uint32())
	const port = r.uint32()
	const token = r.uint32()
	return { username, type, ip, port, token }
}

// ---------- inicio de conexiones entre usuarios ----------

export const pierceFireWallMessage = (token: number) => initMessage(InitCode.PierceFireWall, (w) => w.uint32(token))
export const peerInitMessage = (username: string, type: ConnectionType, token = 0) =>
	initMessage(InitCode.PeerInit, (w) => w.string(username).string(type).uint32(token))

export type PeerInit = { kind: 'pierce'; token: number } | { kind: 'init'; username: string; type: ConnectionType }

/** El primer mensaje de una conexión entre usuarios (sin el uint32 de largo). */
export function parsePeerInit(body: Buffer): PeerInit {
	const r = new MessageReader(body)
	const code = r.uint8()
	if (code === InitCode.PierceFireWall) return { kind: 'pierce', token: r.uint32() }
	if (code === InitCode.PeerInit) return { kind: 'init', username: r.string(), type: r.string() as ConnectionType }
	throw new ProtocolError(`Inicio de conexión desconocido (${code})`)
}

// ---------- mensajes entre usuarios ----------

/** Atributos de un archivo compartido. */
export interface FileAttributes {
	bitrateKbps?: number
	durationSec?: number
	vbr?: boolean
	sampleRateHz?: number
	bitDepth?: number
}

const ATTR_BITRATE = 0
const ATTR_DURATION = 1
const ATTR_VBR = 2
const ATTR_SAMPLE_RATE = 4
const ATTR_BIT_DEPTH = 5

export interface SharedFile {
	/** Ruta tal como la comparte el otro usuario (normalmente con `\`); hay que devolverla igual para pedirla. */
	path: string
	size: number
	/** Puede venir vacía (SoulseekQt no la manda): se saca de la ruta. */
	ext: string
	attrs: FileAttributes
}

export interface SearchResponse {
	username: string
	token: number
	files: SharedFile[]
	/** Tiene un hueco libre para subir ya. */
	slotFree: boolean
	/** Velocidad media de subida, en bytes/s. */
	avgSpeed: number
	/** Descargas esperando en su cola. */
	queueLength: number
}

function readFile(r: MessageReader): SharedFile {
	r.uint8()
	const path = r.string()
	const size = r.uint64()
	const ext = r.string()
	const attrs: FileAttributes = {}
	const count = r.uint32()
	for (let i = 0; i < count; i++) {
		const code = r.uint32()
		const value = r.uint32()
		if (code === ATTR_BITRATE) attrs.bitrateKbps = value
		else if (code === ATTR_DURATION) attrs.durationSec = value
		else if (code === ATTR_VBR) attrs.vbr = value === 1
		else if (code === ATTR_SAMPLE_RATE) attrs.sampleRateHz = value
		else if (code === ATTR_BIT_DEPTH) attrs.bitDepth = value
	}
	return { path, size, ext, attrs }
}

function writeFile(w: MessageWriter, f: SharedFile) {
	const attrs: [number, number | undefined][] = [
		[ATTR_BITRATE, f.attrs.bitrateKbps],
		[ATTR_DURATION, f.attrs.durationSec],
		[ATTR_VBR, f.attrs.vbr === undefined ? undefined : f.attrs.vbr ? 1 : 0],
		[ATTR_SAMPLE_RATE, f.attrs.sampleRateHz],
		[ATTR_BIT_DEPTH, f.attrs.bitDepth]
	]
	const present = attrs.filter((a): a is [number, number] => a[1] !== undefined)
	w.uint8(1).string(f.path).uint64(f.size).string(f.ext).uint32(present.length)
	for (const [code, value] of present) w.uint32(code).uint32(value)
}

/** El cuerpo de un FileSearchResponse (sin largo ni código), comprimido con zlib. Los archivos privados se ignoran. */
export function parseSearchResponse(payload: Buffer): SearchResponse {
	const r = new MessageReader(inflateSync(payload, { maxOutputLength: MAX_MESSAGE_BYTES }))
	const username = r.string()
	const token = r.uint32()
	const count = r.uint32()
	const files: SharedFile[] = []
	for (let i = 0; i < count; i++) files.push(readFile(r))
	const slotFree = r.bool()
	const avgSpeed = r.uint32()
	const queueLength = r.uint32()
	return { username, token, files, slotFree, avgSpeed, queueLength }
}

/** Lo contrario: lo que mandaría otro usuario. Kemix no responde búsquedas; sirve para los tests. */
export function searchResponseMessage(res: SearchResponse): Buffer {
	const w = new MessageWriter().string(res.username).uint32(res.token).uint32(res.files.length)
	for (const f of res.files) writeFile(w, f)
	w.bool(res.slotFree).uint32(res.avgSpeed).uint32(res.queueLength).uint32(0).uint32(0)
	return message(PeerCode.FileSearchResponse, (m) => m.bytes(deflateSync(w.toBuffer())))
}

export const queueUploadMessage = (path: string) => message(PeerCode.QueueUpload, (w) => w.string(path))
export const placeInQueueRequestMessage = (path: string) => message(PeerCode.PlaceInQueueRequest, (w) => w.string(path))

export function transferResponseMessage(token: number, allowed: boolean, reason?: string): Buffer {
	return message(PeerCode.TransferResponse, (w) => {
		w.uint32(token).bool(allowed)
		if (!allowed) w.string(reason ?? 'Cancelled')
	})
}

/** Kemix no comparte nada: perfil vacío y sin huecos de subida. */
export const userInfoResponseMessage = () =>
	message(PeerCode.UserInfoResponse, (w) => w.string('').bool(false).uint32(0).uint32(0).bool(false))

export const sharedFileListResponseMessage = () =>
	message(PeerCode.SharedFileListResponse, (w) =>
		w.bytes(deflateSync(new MessageWriter().uint32(0).uint32(0).uint32(0).toBuffer()))
	)

export const uploadDeniedMessage = (path: string, reason: string) =>
	message(PeerCode.UploadDenied, (w) => w.string(path).string(reason))

/** Dirección 1: el otro usuario está listo para subirnos `path`. 0: nos pide un archivo a nosotros. */
export interface TransferRequest {
	direction: number
	token: number
	path: string
	size?: number
}

export function parseTransferRequest(r: MessageReader): TransferRequest {
	const direction = r.uint32()
	const token = r.uint32()
	const path = r.string()
	const size = direction === 1 && r.remaining >= 8 ? r.uint64() : undefined
	return { direction, token, path, size }
}

export function transferRequestMessage(req: TransferRequest): Buffer {
	return message(PeerCode.TransferRequest, (w) => {
		w.uint32(req.direction).uint32(req.token).string(req.path)
		if (req.direction === 1) w.uint64(req.size ?? 0)
	})
}

export const placeInQueueResponseMessage = (path: string, place: number) =>
	message(PeerCode.PlaceInQueueResponse, (w) => w.string(path).uint32(place))
export const uploadFailedMessage = (path: string) => message(PeerCode.UploadFailed, (w) => w.string(path))

// ---------- conexiones de archivo (F) ----------

/** Lo primero que manda quien sube por una conexión F: el token del TransferRequest. Sin largo delante. */
export const fileTransferInitMessage = (token: number) => new MessageWriter().uint32(token).toBuffer()
/** La respuesta de quien descarga: desde qué byte quiere el archivo. Sin largo delante. */
export const fileOffsetMessage = (offset: number) => new MessageWriter().uint64(offset).toBuffer()
