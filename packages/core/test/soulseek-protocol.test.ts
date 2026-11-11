import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
	FrameSplitter,
	MessageReader,
	MessageWriter,
	PeerCode,
	ServerCode,
	ipFromUint32,
	ipToUint32,
	loginMessage,
	parseConnectToPeer,
	parseLogin,
	parsePeerInit,
	parseSearchResponse,
	parseTransferRequest,
	peerInitMessage,
	pierceFireWallMessage,
	searchResponseMessage,
	transferRequestMessage,
	type SearchResponse
} from '../src/sources/soulseek-protocol'

/** Separa un mensaje con código uint32: [código, lector del resto]. */
function open(msg: Buffer): [number, MessageReader] {
	const frames = new FrameSplitter().push(msg)
	expect(frames).toHaveLength(1)
	const r = new MessageReader(frames[0]!)
	return [r.uint32(), r]
}

describe('MessageWriter / MessageReader', () => {
	it('ida y vuelta de cada tipo', () => {
		const buf = new MessageWriter().uint8(7).bool(true).uint32(0xfffffffe).uint64(5_000_000_000).string('Café ♫').toBuffer()
		const r = new MessageReader(buf)
		expect(r.uint8()).toBe(7)
		expect(r.bool()).toBe(true)
		expect(r.uint32()).toBe(0xfffffffe)
		expect(r.uint64()).toBe(5_000_000_000)
		expect(r.string()).toBe('Café ♫')
		expect(r.remaining).toBe(0)
	})

	it('lee como latin-1 los strings que no son UTF-8', () => {
		const latin = Buffer.from('Beyoncé', 'latin1')
		const buf = new MessageWriter().uint32(latin.length).bytes(latin).toBuffer()
		expect(new MessageReader(buf).string()).toBe('Beyoncé')
	})

	it('avisa si el mensaje se corta', () => {
		expect(() => new MessageReader(Buffer.from([1, 0])).uint32()).toThrow(/incompleto/)
	})
})

describe('FrameSplitter', () => {
	it('junta mensajes partidos en trozos y separa los que llegan pegados', () => {
		const a = loginMessage('yo', 'clave')
		const b = pierceFireWallMessage(99)
		const all = Buffer.concat([a, b])
		const splitter = new FrameSplitter()
		const frames: Buffer[] = []
		for (let i = 0; i < all.length; i += 3) frames.push(...splitter.push(all.subarray(i, i + 3)))
		expect(frames).toHaveLength(2)
		expect(frames[0]!.readUInt32LE(0)).toBe(ServerCode.Login)
		expect(parsePeerInit(frames[1]!)).toEqual({ kind: 'pierce', token: 99 })
	})

	it('deja lo que sobra tras el último mensaje completo', () => {
		const splitter = new FrameSplitter()
		const frames = splitter.push(Buffer.concat([peerInitMessage('ana', 'F'), Buffer.from([1, 2, 3])]))
		expect(parsePeerInit(frames[0]!)).toEqual({ kind: 'init', username: 'ana', type: 'F' })
		expect([...splitter.rest()]).toEqual([1, 2, 3])
	})

	it('rechaza mensajes más grandes que el tope', () => {
		const splitter = new FrameSplitter(10)
		expect(() => splitter.push(new MessageWriter().uint32(11).toBuffer())).toThrow(/demasiado grande/)
	})
})

describe('servidor', () => {
	it('el login lleva usuario, contraseña, versión y el md5 de ambos', () => {
		const [code, r] = open(loginMessage('yo', 'clave'))
		expect(code).toBe(ServerCode.Login)
		expect(r.string()).toBe('yo')
		expect(r.string()).toBe('clave')
		expect(r.uint32()).toBe(160)
		expect(r.string()).toBe(createHash('md5').update('yoclave').digest('hex'))
		expect(r.uint32()).toBe(1)
	})

	it('respuesta de login aceptada y rechazada', () => {
		expect(parseLogin(new MessageReader(new MessageWriter().bool(true).string('Hola').toBuffer()))).toEqual({
			ok: true,
			greeting: 'Hola'
		})
		expect(parseLogin(new MessageReader(new MessageWriter().bool(false).string('INVALIDPASS').toBuffer()))).toEqual({
			ok: false,
			reason: 'INVALIDPASS',
			detail: undefined
		})
		const invalidName = new MessageWriter().bool(false).string('INVALIDUSERNAME').string('Nombre vacío').toBuffer()
		expect(parseLogin(new MessageReader(invalidName))).toEqual({
			ok: false,
			reason: 'INVALIDUSERNAME',
			detail: 'Nombre vacío'
		})
	})

	it('las IPs vienen como uint32 con los bytes al revés', () => {
		expect(ipFromUint32(ipToUint32('192.168.1.20'))).toBe('192.168.1.20')
		expect(ipFromUint32(0x7f000001)).toBe('127.0.0.1')
	})

	it('ConnectToPeer entrante', () => {
		const body = new MessageWriter()
			.string('ana')
			.string('F')
			.uint32(ipToUint32('10.0.0.5'))
			.uint32(2234)
			.uint32(77)
			.bool(false)
			.toBuffer()
		expect(parseConnectToPeer(new MessageReader(body))).toEqual({
			username: 'ana',
			type: 'F',
			ip: '10.0.0.5',
			port: 2234,
			token: 77
		})
	})
})

describe('mensajes entre usuarios', () => {
	it('FileSearchResponse comprimido, con atributos', () => {
		const res: SearchResponse = {
			username: 'ana',
			token: 1234,
			files: [
				{
					path: 'Música\\Daft Punk - Discovery (2001) [FLAC]\\01 - One More Time.flac',
					size: 45_000_000,
					ext: 'flac',
					attrs: { durationSec: 320, sampleRateHz: 44100, bitDepth: 16 }
				},
				{ path: 'mp3\\One More Time.mp3', size: 9_000_000, ext: '', attrs: { bitrateKbps: 320, durationSec: 321, vbr: false } }
			],
			slotFree: true,
			avgSpeed: 1_500_000,
			queueLength: 2
		}
		const [code, r] = open(searchResponseMessage(res))
		expect(code).toBe(PeerCode.FileSearchResponse)
		expect(parseSearchResponse(r.rest())).toEqual(res)
	})

	it('TransferRequest de subida lleva el tamaño; el de descarga no', () => {
		const up = { direction: 1, token: 5, path: 'a\\b.flac', size: 123_456 }
		expect(parseTransferRequest(open(transferRequestMessage(up))[1])).toEqual(up)
		const down = { direction: 0, token: 6, path: 'a\\b.flac' }
		expect(parseTransferRequest(open(transferRequestMessage(down))[1])).toEqual({ ...down, size: undefined })
	})
})
