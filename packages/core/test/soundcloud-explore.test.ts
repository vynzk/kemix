import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Kemix, passphraseCipher } from '../src/index'
import type { Downloader } from '../src/download/lucida-adapter'
import type { RawTrack } from '../src/sources/soundcloud-api'
import { sourceUpload } from '../src/sources/soundcloud'
import { SoundCloudExplore } from '../src/soundcloud-explore'

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

const API = 'https://api-v2.soundcloud.com/'
const raw = (id: number, extra: Partial<RawTrack> = {}): RawTrack => ({
	id,
	title: `Tema ${id}`,
	permalink_url: `https://soundcloud.com/dj/tema-${id}`,
	duration: 200_000,
	user: { username: 'DJ Prueba' },
	genre: 'Afro House',
	...extra
})
const own = (id: number) => raw(id, { downloadable: true, has_downloads_left: true })
const link = (id: number) => raw(id, { purchase_title: 'Free Download', purchase_url: `https://hypeddit.com/t${id}` })

let dir: string
let kemix: Kemix

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kemix-explore-'))
	kemix = new Kemix({ dataDir: path.join(dir, 'data'), cipher: passphraseCipher('test') })
	kemix.settings.update({ downloadDir: path.join(dir, 'music') })
	Object.assign(kemix.features, { trackDownloaded: () => {} })
})

afterEach(() => {
	kemix.close()
	fs.rmSync(dir, { recursive: true, force: true })
})

/** Una API falsa: páginas de resultados enlazadas con next_href, y los temas por id. */
function fakeApi(pages: RawTrack[][]) {
	const calls: { url: string; query: Record<string, string | number> }[] = []
	const get = async <T,>(pathOrUrl: string, query: Record<string, string | number> = {}): Promise<T> => {
		calls.push({ url: pathOrUrl, query })
		const at = pathOrUrl === 'search/tracks' ? 0 : Number(new URL(pathOrUrl).searchParams.get('page'))
		const next = at + 1 < pages.length ? `${API}search/tracks?page=${at + 1}` : null
		return { collection: pages[at] ?? [], next_href: next } as T
	}
	const all = pages.flat()
	const lookup = async (ids: string[]) => all.filter((t) => ids.includes(String(t.id)))
	return { calls, explore: new SoundCloudExplore(kemix.queue, get, lookup) }
}

describe('Explorar', () => {
	it('busca por género y fecha, y se queda solo con los descargables', async () => {
		const { calls, explore } = fakeApi([[own(1), raw(2), link(3)]])
		const page = await explore.explore({ genre: 'Afro House', created: 'last_month' })
		expect(calls[0]).toEqual({
			url: 'search/tracks',
			query: { q: '*', limit: 50, 'filter.genre_or_tag': 'Afro House', 'filter.created_at': 'last_month' }
		})
		expect(page.tracks.map((t) => [t.sourceId, t.freeDownload.kind, t.genre])).toEqual([
			['1', 'soundcloud', 'Afro House'],
			['3', 'link', 'Afro House']
		])
		expect(page).toMatchObject({ next: null, scanned: 3 })
	})

	it('recorre páginas hasta juntar una tanda, y deja seguir con el cursor', async () => {
		// 5 páginas de 10 temas, con un descargable cada dos: 25 descargables en total.
		const pages = Array.from({ length: 5 }, (_, p) =>
			Array.from({ length: 10 }, (_, i) => (i % 2 ? raw(p * 10 + i) : own(p * 10 + i)))
		)
		const { calls, explore } = fakeApi(pages)
		const first = await explore.explore({ genre: 'Techno' })
		expect(first.tracks).toHaveLength(25)
		expect(calls).toHaveLength(5)
		expect(first.next).toBeNull()
		await expect(explore.explore({ genre: 'Techno', cursor: 'https://evil.example/x' })).rejects.toThrow('Cursor')
		await expect(explore.explore({})).rejects.toThrow('Elige un género')
	})

	it('no revisa más de 6 páginas por tanda', async () => {
		const pages = Array.from({ length: 10 }, (_, p) => [raw(p)])
		const { calls, explore } = fakeApi(pages)
		const page = await explore.explore({ query: 'remix' })
		expect(calls).toHaveLength(6)
		expect(calls[0]!.query).toMatchObject({ q: 'remix' })
		expect(page).toMatchObject({ tracks: [], scanned: 6, next: `${API}search/tracks?page=6` })
	})

	it('un tema que solo tiene el enlace del artista no se baja con Kemix', async () => {
		const { explore } = fakeApi([[link(3)]])
		await expect(explore.download('3')).rejects.toThrow('enlace del artista')
	})

	it('baja la descarga de SoundCloud a «SoundCloud gratis»', async () => {
		const opened: string[] = []
		const soundcloud: Downloader = {
			service: 'soundcloud',
			isrcLookup: async () => null,
			search: async () => [],
			exact: sourceUpload,
			getTrack: async (url) => ({
				meta: { service: 'soundcloud', id: url, url, title: url, artists: [] },
				open: async () => {
					opened.push(url)
					return { stream: Readable.from([wavFile()]), mimeType: 'audio/wav' }
				}
			}),
			accountInfo: async () => ({}),
			accountQuality: async () => ({ codec: 'aac', lossless: false, bitrateKbps: 160 })
		}
		Object.assign(kemix.accounts, { downloader: async () => soundcloud, findIsrc: async () => null })
		kemix.start()
		const { explore } = fakeApi([[own(1)]])
		const { playlistId } = await explore.download('1', 'max', 'original')
		let row
		await vi.waitFor(
			async () => {
				row = (await kemix.library.getPlaylist(playlistId)).tracks[0]!.download
				expect(['done', 'error']).toContain(row?.status)
			},
			{ timeout: 5000, interval: 20 }
		)
		expect(row).toMatchObject({ status: 'done', service: 'soundcloud', quality: { codec: 'wav', lossless: true } })
		expect(opened).toEqual(['https://soundcloud.com/dj/tema-1'])
		expect(kemix.library.listPlaylists()).toMatchObject([{ source: 'local', name: 'SoundCloud gratis', trackCount: 1 }])
	})
})
