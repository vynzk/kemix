import { buffer } from 'node:stream/consumers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlskClient, type SlskClientOptions } from '../src/sources/soulseek-client'
import { CLIENT_IP, FakeNet, FakeServer, SERVER } from './soulseek-fake'

const FLAC = Buffer.alloc(25_000, 7)
const PATH = 'Música\\Daft Punk - Discovery (2001) [FLAC]\\01 - One More Time.flac'

const clients: SlskClient[] = []

afterEach(() => {
	for (const c of clients.splice(0)) c.destroy()
})

/** Una red con un servidor y el cliente de Kemix (que escucha en el 2234 salvo que `listening` sea false). */
function setup(opts: { listening?: boolean } & Partial<SlskClientOptions> = {}) {
	const net = new FakeNet()
	const server = new FakeServer(net)
	// Otro programa ocupando el puerto: el cliente no puede escuchar.
	if (opts.listening === false) void net.transport(CLIENT_IP).listen(2234, () => {})
	const client = new SlskClient({
		username: 'kemix',
		password: 'clave',
		port: () => 2234,
		transport: net.transport(CLIENT_IP),
		server: SERVER,
		timing: { searchWindowMs: 150, searchIntervalMs: 0, peerMs: 500, connectMs: 200, initMs: 500, ...opts.timing },
		...opts
	})
	clients.push(client)
	return { net, server, client }
}

describe('SlskClient: sesión', () => {
	it('inicia sesión y abre el puerto', async () => {
		const { client } = setup()
		await client.login()
		expect(client.status()).toEqual({ online: true, listening: true, port: 2234 })
	})

	it('sin el puerto libre sigue funcionando, sin escuchar', async () => {
		const { client } = setup({ listening: false })
		await client.login()
		expect(client.status()).toMatchObject({ online: true, listening: false })
	})

	it('explica una contraseña incorrecta', async () => {
		const { client } = setup({ password: 'otra' })
		await expect(client.login()).rejects.toThrow('Usuario o contraseña de Soulseek incorrectos')
	})

	it('avisa cuando otro programa entra con el mismo usuario', async () => {
		const onSessionLost = vi.fn()
		const { client, server } = setup({ onSessionLost })
		await client.login()
		server.relog('kemix')
		await vi.waitFor(() => expect(onSessionLost).toHaveBeenCalled())
		expect(onSessionLost.mock.calls[0]![0].message).toMatch(/Otro programa inició sesión/)
		await expect(client.search('x')).rejects.toThrow(/Otro programa/)
	})
})

describe('SlskClient: búsqueda', () => {
	it('junta las respuestas de usuarios con y sin puerto abierto', async () => {
		const { server, client } = setup()
		server.addPeer('ana', '10.0.0.2', 2234, [{ path: PATH, data: FLAC, attrs: { durationSec: 320, bitDepth: 16 } }])
		server.addPeer('beto', '10.0.0.3', 0, [{ path: 'mp3\\Daft Punk - One More Time.mp3', data: FLAC, attrs: { bitrateKbps: 320 } }])
		server.addPeer('carla', '10.0.0.4', 2234, [{ path: 'otra\\cosa.flac', data: FLAC }])
		const responses = await client.search('daft one more')
		expect(responses.map((r) => r.username).sort()).toEqual(['ana', 'beto'])
		const ana = responses.find((r) => r.username === 'ana')!
		expect(ana.files).toEqual([{ path: PATH, size: FLAC.length, ext: 'flac', attrs: { durationSec: 320, bitDepth: 16 } }])
		expect(ana.slotFree).toBe(true)
	})

	it('si el cliente no escucha, los usuarios con puerto le llegan a través del servidor', async () => {
		const { server, client } = setup({ listening: false })
		server.addPeer('ana', '10.0.0.2', 2234, [{ path: PATH, data: FLAC }])
		// Nadie puede abrir la conexión: sus resultados no llegan.
		server.addPeer('beto', '10.0.0.3', 0, [{ path: PATH, data: FLAC }])
		const responses = await client.search('one more time')
		expect(responses.map((r) => r.username)).toEqual(['ana'])
	})

	it('va mostrando las respuestas según llegan', async () => {
		const { server, client } = setup()
		server.addPeer('ana', '10.0.0.2', 2234, [{ path: PATH, data: FLAC }])
		const seen: string[] = []
		await client.search('one more', { onResponse: (r) => seen.push(r.username) })
		expect(seen).toEqual(['ana'])
	})
})

describe('SlskClient: descarga', () => {
	it('baja el archivo completo de un usuario con puerto abierto', async () => {
		const { server, client } = setup()
		server.addPeer('ana', '10.0.0.2', 2234, [{ path: PATH, data: FLAC }])
		const got = await client.download('ana', PATH)
		expect(got.size).toBe(FLAC.length)
		expect((await buffer(got.stream)).equals(FLAC)).toBe(true)
	})

	it('baja de un usuario sin puerto: él abre la conexión hacia nosotros', async () => {
		const { server, client } = setup()
		server.addPeer('beto', '10.0.0.3', 0, [{ path: PATH, data: FLAC }])
		const got = await client.download('beto', PATH)
		expect((await buffer(got.stream)).equals(FLAC)).toBe(true)
	})

	it('sin puerto propio, el archivo llega por una conexión que abrimos nosotros (PierceFireWall)', async () => {
		const { server, client } = setup({ listening: false })
		server.addPeer('ana', '10.0.0.2', 2234, [{ path: PATH, data: FLAC }])
		const got = await client.download('ana', PATH)
		expect((await buffer(got.stream)).equals(FLAC)).toBe(true)
	})

	it('explica por qué el otro usuario rechaza la descarga', async () => {
		const { server, client } = setup()
		server.addPeer('ana', '10.0.0.2', 2234, [{ path: PATH, data: FLAC }]).deny = 'Banned'
		await expect(client.download('ana', PATH)).rejects.toThrow('ana no deja bajar ese archivo: no te deja bajar sus archivos')
	})

	it('no espera para siempre en una cola', async () => {
		const { server, client } = setup()
		server.addPeer('ana', '10.0.0.2', 2234, [{ path: PATH, data: FLAC }]).queueForever = true
		await expect(client.download('ana', PATH, { queueMs: 200 })).rejects.toThrow(/en cola/)
	})

	it('abandona pronto si el puesto en la cola es muy alto', async () => {
		const { server, client } = setup({ timing: { placeAskMs: 50 } })
		const ana = server.addPeer('ana', '10.0.0.2', 2234, [{ path: PATH, data: FLAC }])
		ana.queueForever = true
		ana.place = 40
		await expect(client.download('ana', PATH, { queueMs: 5000 })).rejects.toThrow('puesto 40')
	})

	it('se puede cancelar mientras espera, y volver a pedir', async () => {
		const { server, client } = setup()
		const ana = server.addPeer('ana', '10.0.0.2', 2234, [{ path: PATH, data: FLAC }])
		ana.queueForever = true
		const abort = new AbortController()
		const pending = client.download('ana', PATH, { signal: abort.signal })
		await vi.waitFor(() => expect(ana.requested).toHaveLength(1))
		abort.abort()
		await expect(pending).rejects.toThrow()
		ana.queueForever = false
		const got = await client.download('ana', PATH)
		expect((await buffer(got.stream)).length).toBe(FLAC.length)
	})

	it('si la transferencia se corta, el stream termina con error', async () => {
		const { server, client } = setup()
		server.addPeer('ana', '10.0.0.2', 2234, [{ path: PATH, data: FLAC }]).cutAfter = 1000
		const got = await client.download('ana', PATH)
		await expect(buffer(got.stream)).rejects.toThrow(/se cortó/)
	})

	it('no puede llegar a un usuario sin puerto si tampoco escucha el cliente', async () => {
		const { server, client } = setup({ listening: false })
		server.addPeer('beto', '10.0.0.3', 0, [{ path: PATH, data: FLAC }])
		await expect(client.download('beto', PATH)).rejects.toThrow('No se pudo conectar con beto')
	})

	it('cerrar el cliente corta lo que esperaba', async () => {
		const { server, client } = setup()
		const ana = server.addPeer('ana', '10.0.0.2', 2234, [{ path: PATH, data: FLAC }])
		ana.queueForever = true
		const pending = client.download('ana', PATH)
		await vi.waitFor(() => expect(ana.requested).toHaveLength(1))
		client.destroy()
		await expect(pending).rejects.toThrow('Se cerró la conexión con Soulseek')
	})
})
