import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Kemix, passphraseCipher, type SlskFile, type SourceTrack } from '../src/index'
import type { SourceConnector } from '../src/sources/types'
import { CLIENT_IP, FakeNet, FakeServer, SERVER } from './soulseek-fake'
import type { SoulseekNetwork } from '../src/sources/soulseek-client'
import type { SearchResponse, SharedFile } from '../src/sources/soulseek-protocol'
import {
	SoulseekDownloader,
	parseSlskPath,
	parseSlskUrl,
	pickForQuery,
	rankFiles,
	slskQuality,
	slskQuery,
	slskUrl,
	toSlskFiles
} from '../src/sources/soulseek'
import { scoreSoulseek } from '../src/match/score'

const file = (path: string, size: number, attrs: SharedFile['attrs'] = {}): SharedFile => ({ path, size, ext: '', attrs })

function response(username: string, files: SharedFile[], extra: Partial<SearchResponse> = {}): SearchResponse {
	return { username, token: 1, files, slotFree: true, avgSpeed: 1_000_000, queueLength: 0, ...extra }
}

/** Una red falsa: siempre las mismas respuestas, y descargas que salen bien o fallan según el usuario y la ruta. */
function fakeNetwork(responses: SearchResponse[], downloads: Record<string, Buffer | Error>) {
	const calls = { search: [] as string[], download: [] as string[] }
	const network: SoulseekNetwork = {
		async search(query) {
			calls.search.push(query)
			return responses
		},
		async download(username, path) {
			calls.download.push(`${username}:${path}`)
			const d = downloads[`${username}:${path}`]
			if (!d) throw new Error(`${username} no responde`)
			if (d instanceof Error) throw d
			return { stream: Readable.from([d]), size: d.length }
		}
	}
	return { network, calls }
}

describe('slsk:// URLs', () => {
	it('ida y vuelta exacta, con espacios, acentos y una / dentro de un nombre', () => {
		const path = 'Música\\AC/DC - Back in Black\\01 - Hells Bells.flac'
		const url = slskUrl('ana b', path)
		expect(url).toBe('slsk://ana%20b/M%C3%BAsica/AC%2FDC%20-%20Back%20in%20Black/01%20-%20Hells%20Bells.flac')
		expect(parseSlskUrl(url)).toEqual({ username: 'ana b', path })
	})

	it('rechaza lo que no es un enlace de Soulseek', () => {
		expect(parseSlskUrl('https://www.qobuz.com/track/1')).toBeNull()
	})
})

describe('parseSlskPath', () => {
	it('"Artista - Álbum (Año) [FLAC]\\01 - Título"', () => {
		expect(parseSlskPath('Music\\Daft Punk - Discovery (2001) [FLAC]\\01 - One More Time.flac')).toEqual({
			artists: ['Daft Punk'],
			title: 'One More Time',
			album: 'Discovery',
			trackNumber: 1
		})
	})

	it('"Artista\\Álbum\\01. Título"', () => {
		expect(parseSlskPath('C:\\Music\\Daft Punk\\Discovery\\01. One More Time.flac')).toEqual({
			artists: ['Daft Punk'],
			title: 'One More Time',
			album: 'Discovery',
			trackNumber: 1
		})
	})

	it('"Artista - Título" suelto', () => {
		expect(parseSlskPath('mp3\\Daft Punk - One More Time (Radio Edit).mp3')).toMatchObject({
			artists: ['Daft Punk'],
			title: 'One More Time (Radio Edit)'
		})
	})

	it('"Artista - Álbum - 01 - Título" en el nombre', () => {
		expect(parseSlskPath('Daft Punk - Discovery - 01 - One More Time.flac')).toEqual({
			artists: ['Daft Punk'],
			title: 'One More Time',
			album: 'Discovery',
			trackNumber: 1
		})
	})

	it('caras de vinilo y títulos que son números', () => {
		expect(parseSlskPath('rips\\A1. Daft Punk - One More Time.wav')).toMatchObject({ artists: ['Daft Punk'], title: 'One More Time' })
		expect(parseSlskPath('mp3\\1979.mp3')).toMatchObject({ title: '1979' })
	})
})

describe('calidad y orden', () => {
	it('calidad según extensión y atributos', () => {
		expect(slskQuality('flac', { bitDepth: 24, sampleRateHz: 96000 })).toEqual({
			codec: 'flac',
			lossless: true,
			bitDepth: 24,
			sampleRateHz: 96000
		})
		expect(slskQuality('flac', {})).toMatchObject({ bitDepth: 16, sampleRateHz: 44100 })
		expect(slskQuality('mp3', { bitrateKbps: 320 })).toEqual({ codec: 'mp3', lossless: false, bitrateKbps: 320 })
		expect(slskQuality('m4a', { bitDepth: 16 })).toMatchObject({ codec: 'alac', lossless: true })
		expect(slskQuality('jpg', {})).toBeNull()
	})

	it('solo audio; la extensión sale de la ruta si no viene', () => {
		const files = toSlskFiles([
			response('ana', [file('Album\\01 - Tema.flac', 30), file('Album\\cover.jpg', 1), file('Album\\album.cue', 1)])
		])
		expect(files.map((f) => f.path)).toEqual(['Album\\01 - Tema.flac'])
		expect(files[0]).toMatchObject({ username: 'ana', url: slskUrl('ana', 'Album\\01 - Tema.flac'), quality: { codec: 'flac' } })
	})

	const make = (over: Partial<SlskFile>): SlskFile => ({
		username: 'u',
		path: 'x\\a.flac',
		url: 'slsk://u/x/a.flac',
		size: 1,
		title: 'Tema',
		artists: ['Artista'],
		quality: { codec: 'flac', lossless: true, bitDepth: 16, sampleRateHz: 44100 },
		slotFree: true,
		speed: 100,
		queueLength: 0,
		...over
	})
	const mp3 = { codec: 'mp3', lossless: false, bitrateKbps: 320 } as const

	it('sin pérdida primero; con MP3 en Ajustes, MP3 320 primero', () => {
		const flac = make({ username: 'flac' })
		const lossy = make({ username: 'mp3', quality: mp3 })
		expect(rankFiles([lossy, flac], true).map((f) => f.username)).toEqual(['flac', 'mp3'])
		expect(rankFiles([flac, lossy], false).map((f) => f.username)).toEqual(['mp3', 'flac'])
	})

	it('a igual calidad: hueco libre, cola corta, más rápido', () => {
		const files = [
			make({ username: 'lento', speed: 10 }),
			make({ username: 'ocupado', slotFree: false }),
			make({ username: 'cola', queueLength: 5 }),
			make({ username: 'rapido', speed: 1000 })
		]
		expect(rankFiles(files, true).map((f) => f.username)).toEqual(['rapido', 'lento', 'cola', 'ocupado'])
	})

	it('lo que responde a la búsqueda va antes que otra versión en mejor calidad; cada archivo una vez', () => {
		const files = [
			make({ username: 'a', title: 'One More Time (Live)', path: 'x\\live.flac' }),
			make({ username: 'b', title: 'One More Time', path: 'y\\01 - One More Time.mp3', quality: mp3, size: 9 }),
			make({ username: 'c', title: 'One More Time', path: 'z\\01 - One More Time.mp3', quality: mp3, size: 9, speed: 5000 })
		]
		const picked = pickForQuery(files, 'Artista One More Time', true)
		expect(picked.map((f) => f.username)).toEqual(['c', 'a'])
	})

	it('búsquedas sin puntuación (un "-" delante excluye la palabra)', () => {
		expect(slskQuery('Daft Punk - One More Time (Radio Edit)')).toBe('Daft Punk One More Time Radio Edit')
		expect(slskQuery('Beyoncé — Halo!')).toBe('Beyoncé Halo')
	})

	it('scoreSoulseek también lee "Título - Artista"', () => {
		const source = { title: 'One More Time', artists: ['Daft Punk'], durationMs: 320_000 }
		const swapped = { service: 'soulseek' as const, id: '1', url: '', title: 'Daft Punk', artists: ['One More Time'], durationMs: 320_000 }
		expect(scoreSoulseek(source, swapped)).toBeGreaterThanOrEqual(0.9)
	})
})

describe('SoulseekDownloader', () => {
	const PATH_A = 'Music\\Daft Punk - Discovery (2001) [FLAC]\\01 - One More Time.flac'
	const DATA = Buffer.alloc(50, 1)

	it('busca, devuelve el mejor archivo de cada uno y guarda la búsqueda un rato', async () => {
		const { network, calls } = fakeNetwork(
			[
				response('ana', [file(PATH_A, 50, { durationSec: 320 })]),
				response('beto', [file('mp3\\Daft Punk - One More Time.mp3', 9, { bitrateKbps: 320, durationSec: 320 })])
			],
			{}
		)
		const d = new SoulseekDownloader(() => network)
		const found = await d.search('Daft Punk - One More Time', 10)
		expect(found[0]).toMatchObject({
			service: 'soulseek',
			url: slskUrl('ana', PATH_A),
			id: slskUrl('ana', PATH_A),
			title: 'One More Time',
			artists: ['Daft Punk'],
			durationMs: 320_000,
			maxQuality: { codec: 'flac', lossless: true }
		})
		expect(found).toHaveLength(2)
		await d.search('Daft Punk One More Time', 10)
		expect(calls.search).toEqual(['Daft Punk One More Time'])
	})

	it('si un usuario no lo envía, lo baja de otro que tiene el mismo archivo', async () => {
		const { network, calls } = fakeNetwork(
			[response('ana', [file(PATH_A, 50)]), response('beto', [file('otra\\carpeta\\01 - One More Time.flac', 50)])],
			{ 'beto:otra\\carpeta\\01 - One More Time.flac': DATA }
		)
		const d = new SoulseekDownloader(() => network)
		const [first] = await d.search('Daft Punk One More Time', 10)
		expect(first!.url).toBe(slskUrl('ana', PATH_A))
		const audio = await (await d.getTrack(first!.url)).open('max')
		expect(audio.mimeType).toBe('audio/flac')
		expect((await buffer(audio.stream)).equals(DATA)).toBe(true)
		expect(calls.download).toEqual([`ana:${PATH_A}`, 'beto:otra\\carpeta\\01 - One More Time.flac'])
	})

	it('cuando nadie lo envía, explica el último motivo', async () => {
		const { network } = fakeNetwork([response('ana', [file(PATH_A, 50)]), response('beto', [file(PATH_A, 50)])], {
			[`ana:${PATH_A}`]: new Error('ana no deja bajar ese archivo: ya no lo comparte')
		})
		const d = new SoulseekDownloader(() => network)
		await d.search('Daft Punk One More Time', 10)
		await expect((await d.getTrack(slskUrl('ana', PATH_A))).open('max')).rejects.toThrow(
			'No se pudo bajar de ninguno de 2 usuarios. El último: beto no responde'
		)
	})

	it('si se cancela no prueba otras fuentes', async () => {
		const abort = new AbortController()
		const { network, calls } = fakeNetwork([response('ana', [file(PATH_A, 50)]), response('beto', [file(PATH_A, 50)])], {})
		network.download = async (username, path) => {
			calls.download.push(`${username}:${path}`)
			abort.abort()
			throw new Error('cancelada')
		}
		const d = new SoulseekDownloader(() => network)
		await d.search('Daft Punk One More Time', 10)
		await expect((await d.getTrack(slskUrl('ana', PATH_A))).open('max', 'original', abort.signal)).rejects.toThrow('cancelada')
		expect(calls.download).toHaveLength(1)
	})

	it('describe un archivo que solo conoce por su URL (de una sesión anterior)', async () => {
		const { network } = fakeNetwork([], {})
		const { meta } = await new SoulseekDownloader(() => network).getTrack(slskUrl('ana', PATH_A))
		expect(meta).toMatchObject({ service: 'soulseek', title: 'One More Time', artists: ['Daft Punk'], maxQuality: { codec: 'flac' } })
	})
})

// ---------- en Kemix, sobre una red Soulseek de mentira ----------

/** Un WAV PCM mínimo y válido (para que se pueda etiquetar y leer su calidad). */
function wavFile(frames = 4410): Buffer {
	const dataSize = frames * 4
	const b = Buffer.alloc(44 + dataSize)
	b.write('RIFF', 0)
	b.writeUInt32LE(36 + dataSize, 4)
	b.write('WAVE', 8)
	b.write('fmt ', 12)
	b.writeUInt32LE(16, 16)
	b.writeUInt16LE(1, 20)
	b.writeUInt16LE(2, 22)
	b.writeUInt32LE(44100, 24)
	b.writeUInt32LE(44100 * 4, 28)
	b.writeUInt16LE(4, 32)
	b.writeUInt16LE(16, 34)
	b.write('data', 36)
	b.writeUInt32LE(dataSize, 40)
	return b
}

describe('Soulseek en Kemix', () => {
	const WAV = wavFile()
	const WAV_PATH = 'Music\\Daft Punk - Discovery (2001)\\01 - One More Time.wav'
	let dir: string
	let kemix: Kemix
	let server: FakeServer

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kemix-soulseek-'))
		const net = new FakeNet()
		server = new FakeServer(net)
		server.addPeer('ana', '10.0.0.2', 2234, [{ path: WAV_PATH, data: WAV, attrs: { durationSec: 320 } }])
		kemix = new Kemix({
			dataDir: path.join(dir, 'data'),
			cipher: passphraseCipher('test'),
			soulseek: {
				transport: net.transport(CLIENT_IP),
				server: SERVER,
				timing: { searchWindowMs: 150, searchIntervalMs: 0, peerMs: 500, connectMs: 200, initMs: 500 }
			}
		})
		kemix.settings.update({ downloadDir: path.join(dir, 'music') })
		// La clave y el BPM tras cada descarga tienen sus propios tests (features-analyzer.test.ts).
		Object.assign(kemix.features, { trackDownloaded: () => {} })
		kemix.start()
	})

	afterEach(() => {
		kemix.close()
		fs.rmSync(dir, { recursive: true, force: true })
	})

	async function waitForDownload(playlistId: number, position = 0) {
		let row
		await vi.waitFor(
			async () => {
				row = (await kemix.library.getPlaylist(playlistId)).tracks[position]!.download
				expect(['done', 'error']).toContain(row?.status)
			},
			{ timeout: 5000, interval: 20 }
		)
		return row!
	}

	it('conecta con usuario y contraseña y entra en la prioridad después de los servicios sin pérdida', async () => {
		kemix.settings.update({ servicePriority: ['qobuz', 'deezer', 'youtube'] })
		expect(await kemix.accounts.connectSoulseek({ username: ' kemix ', password: 'clave' })).toEqual({
			online: true,
			listening: true,
			port: 2234,
			error: null
		})
		expect(kemix.accounts.list().find((a) => a.service === 'soulseek')).toMatchObject({
			status: 'connected',
			displayName: 'kemix'
		})
		expect(kemix.settings.get().servicePriority).toEqual(['qobuz', 'deezer', 'soulseek', 'youtube'])
		expect(await kemix.accounts.soulseekStatus()).toMatchObject({ online: true })
	})

	it('una contraseña incorrecta no rompe la conexión que ya funciona', async () => {
		await kemix.accounts.connectSoulseek({ username: 'kemix', password: 'clave' })
		await expect(kemix.accounts.connectSoulseek({ username: 'kemix', password: 'otra' })).rejects.toThrow(
			'Iniciar sesión en Soulseek: Usuario o contraseña de Soulseek incorrectos'
		)
		expect(kemix.accounts.isConnected('soulseek')).toBe(true)
		expect(await kemix.accounts.soulseekStatus()).toMatchObject({ online: true })
	})

	it('busca, baja un archivo suelto a la playlist "Soulseek" y no lo repite', async () => {
		await kemix.accounts.connectSoulseek({ username: 'kemix', password: 'clave' })
		const { id } = kemix.soulseek.start('Daft Punk - One More Time')
		await vi.waitFor(() => expect(kemix.soulseek.get(id).results).toHaveLength(1))
		kemix.soulseek.stop(id)
		await vi.waitFor(() => expect(kemix.soulseek.get(id).running).toBe(false))
		expect(kemix.soulseek.get(id).results[0]).toMatchObject({
			username: 'ana',
			path: WAV_PATH,
			title: 'One More Time',
			artists: ['Daft Punk'],
			durationMs: 320_000,
			quality: { codec: 'wav', lossless: true }
		})

		const { playlistId } = await kemix.soulseek.download(id, 'ana', WAV_PATH)
		const row = await waitForDownload(playlistId)
		expect(row.error).toBeNull()
		expect(row).toMatchObject({ status: 'done', service: 'soulseek', quality: { codec: 'wav', lossless: true } })
		expect(row.path).toMatch(/Soulseek[\\/]01 - Daft Punk - One More Time\.wav$/)
		expect(kemix.library.listPlaylists()).toMatchObject([{ id: playlistId, source: 'soulseek', name: 'Soulseek', trackCount: 1 }])

		await kemix.soulseek.download(id, 'ana', WAV_PATH)
		expect((await kemix.library.getPlaylist(playlistId)).tracks).toHaveLength(1)
	})

	it('el matching automático encuentra en Soulseek un tema de una playlist y lo baja', async () => {
		await kemix.accounts.connectSoulseek({ username: 'kemix', password: 'clave' })
		kemix.settings.update({ servicePriority: ['soulseek'] })
		const track: SourceTrack = { sourceId: 's1', title: 'One More Time', artists: ['Daft Punk'], durationMs: 321_000 }
		const source: SourceConnector = {
			service: 'spotify',
			identity: async () => ({ name: 'Test' }),
			listPlaylists: async () => [{ sourceId: 'p1', name: 'House', trackCount: 1, snapshot: 'v1' }],
			getPlaylistTracks: async () => [track],
			search: async () => [],
			createPlaylist: async () => 'x'
		}
		const connected = kemix.accounts.isConnected.bind(kemix.accounts)
		Object.assign(kemix.accounts, {
			isConnected: (s: string) => s === 'spotify' || connected(s as 'soulseek'),
			source: () => source,
			findIsrc: async () => null
		})
		await kemix.library.syncAll()
		const [playlist] = kemix.library.listPlaylists()
		await kemix.queue.enqueuePlaylist(playlist!.id)
		const row = await waitForDownload(playlist!.id)
		expect(row.error).toBeNull()
		expect(row).toMatchObject({ status: 'done', service: 'soulseek' })
		expect(row.path).toMatch(/House[\\/]01 - Daft Punk - One More Time\.wav$/)
	})
})
