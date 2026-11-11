import { describe, expect, it } from 'vitest'
import { freeDownloadOf, freeLinkIn, toSourceTrack, type RawTrack } from '../src/sources/soundcloud-api'
import { parseSearchOutput, SoundCloud, sourceUpload } from '../src/sources/soundcloud'
import type { YtDlp } from '../src/sources/yt-dlp'

const PERMALINK = 'https://soundcloud.com/dj/tema'
const raw = (extra: Partial<RawTrack> = {}): RawTrack => ({ id: 7, title: 'Tema', permalink_url: PERMALINK, ...extra })
const AAC = [{ format_id: 'hls_aac_160k', ext: 'm4a', acodec: 'mp4a.40.2', abr: 160, quality: 0 }]

describe('freeDownloadOf', () => {
	it('la descarga de SoundCloud, mientras le queden descargas', () => {
		expect(freeDownloadOf(raw({ downloadable: true, has_downloads_left: true }))).toEqual({ kind: 'soundcloud', url: PERMALINK })
		expect(freeDownloadOf(raw({ downloadable: true, has_downloads_left: false }))).toBeNull()
	})

	it('el botón de compra cuando es una descarga gratis', () => {
		expect(freeDownloadOf(raw({ purchase_title: 'FREE DOWNLOAD', purchase_url: 'https://www.toneden.io/dj/post/x' }))).toEqual({
			kind: 'link',
			url: 'https://www.toneden.io/dj/post/x'
		})
		// Un sitio de descargas, aunque el botón diga «Buy».
		expect(freeDownloadOf(raw({ purchase_title: 'Buy', purchase_url: 'https://hypeddit.com/track/abc' }))).toMatchObject({
			kind: 'link'
		})
		// Una tienda no es gratis aunque el botón diga «Download»; una compra normal tampoco.
		expect(freeDownloadOf(raw({ purchase_title: 'Download', purchase_url: 'https://www.beatport.com/track/x/1' }))).toBeNull()
		expect(freeDownloadOf(raw({ purchase_title: 'Buy', purchase_url: 'https://example.com/shop' }))).toBeNull()
	})

	it('un enlace en la descripción', () => {
		const description = 'Mi tema nuevo\nFREE DL: https://bit.ly/abc123\nBeatport: https://www.beatport.com/track/x/1'
		expect(freeDownloadOf(raw({ description }))).toEqual({ kind: 'link', url: 'https://bit.ly/abc123' })
		expect(freeLinkIn('Escúchalo en https://open.spotify.com/track/1')).toBeNull()
		expect(freeLinkIn('Los stems: https://www.dropbox.com/s/xyz/tema.wav?dl=0')).toEqual({
			kind: 'link',
			url: 'https://www.dropbox.com/s/xyz/tema.wav?dl=0'
		})
		expect(freeLinkIn(null)).toBeNull()
	})

	it('viaja con el tema (Buscar, playlists importadas) y con su propia subida', () => {
		const track = toSourceTrack(raw({ downloadable: true }))!
		expect(track.freeDownload).toEqual({ kind: 'soundcloud', url: PERMALINK })
		const own = sourceUpload({ ...track, source: 'soundcloud' })
		expect(own).toMatchObject({ freeDownload: { kind: 'soundcloud' } })
		expect(own?.maxQuality).toBeUndefined()
	})
})

describe('resultados de yt-dlp', () => {
	const line = (o: object) => JSON.stringify({ title: 'T', uploader: 'U', formats: AAC, ...o })

	it('toma el enlace de la descripción, y entonces no da calidad', () => {
		const [t] = parseSearchOutput(
			line({ id: 1, webpage_url: 'https://soundcloud.com/u/t', description: 'free download → https://hypeddit.com/x' })
		)
		expect(t).toMatchObject({ freeDownload: { kind: 'link', url: 'https://hypeddit.com/x' } })
		expect(t!.maxQuality).toBeUndefined()
	})

	function soundCloud(stdout: string, lookup: (ids: string[]) => Promise<RawTrack[]>) {
		const ytDlp = { bin: async () => 'yt-dlp', output: async () => ({ stdout, stderr: '', code: 0 }) } as unknown as YtDlp
		return new SoundCloud(ytDlp, () => null, lookup)
	}

	it('completa con el botón de compra de la API, que yt-dlp no trae', async () => {
		const stdout = [1, 2].map((id) => line({ id, webpage_url: `https://soundcloud.com/u/t${id}` })).join('\n')
		const asked: string[][] = []
		const sc = soundCloud(stdout, async (ids) => {
			asked.push(ids)
			return [raw({ id: 2, purchase_title: 'Free Download', purchase_url: 'https://hypeddit.com/t2' })]
		})
		const [a, b] = await sc.search('t', 10)
		expect(asked).toEqual([['1', '2']])
		expect(a).toMatchObject({ maxQuality: { codec: 'aac', bitrateKbps: 160 } })
		expect(a!.freeDownload).toBeUndefined()
		expect(b).toMatchObject({ freeDownload: { kind: 'link', url: 'https://hypeddit.com/t2' } })
		expect(b!.maxQuality).toBeUndefined()
	})

	it('si la API falla, quedan como los dio yt-dlp', async () => {
		const sc = soundCloud(line({ id: 1, webpage_url: 'https://soundcloud.com/u/t1' }), async () => {
			throw new Error('sin red')
		})
		const [a] = await sc.search('t', 10)
		expect(a).toMatchObject({ maxQuality: { codec: 'aac' } })
	})
})
