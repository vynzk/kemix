import fs from 'node:fs'
import path from 'node:path'
import { openDb, type Db } from './db'
import { EventBus } from './events'
import { SecretStore, type Cipher } from './secrets'
import { SettingsStore } from './settings'
import { Accounts } from './accounts'
import { Library } from './library'
import { DownloadQueue } from './download/queue'
import { Ffmpeg, ManagedFfmpeg, type AudioConverter, type AudioDecoder, type RawDecoder } from './download/ffmpeg'
import { FeatureAnalyzer } from './features/analyzer'
import type { FeatureSources } from './features/lookup'
import { SoulseekSearches } from './soulseek-search'
import { SoundCloudExplore } from './soundcloud-explore'
import type { SlskClientOptions } from './sources/soulseek-client'
import { SpectrumAnalyzer } from './spectrum'

export * from './types'
export { passphraseCipher, type Cipher } from './secrets'
export { DEFAULT_PORT } from './settings'
export type { Accounts, SpotifyWebLogin } from './accounts'
export type { SpotifyWebOp, SpotifyWebSession } from './sources/spotify-web'
export type { Library } from './library'
export type { DownloadQueue } from './download/queue'
export type { AudioConverter, AudioDecoder, Mp3Converter, PcmFormat, RawAudio, RawDecoder } from './download/ffmpeg'
export type { FeatureAnalyzer } from './features/analyzer'
export type { SoulseekSearches } from './soulseek-search'
export type { SoundCloudExplore } from './soundcloud-explore'
export type { SpectrumAnalyzer } from './spectrum'
export { FeatureSources } from './features/lookup'
export type { YtMusicAccount } from './sources/ytmusic'

export interface KemixOptions {
	/** Directory for the database and the tools Kemix downloads for itself (yt-dlp, ffmpeg). */
	dataDir: string
	cipher: Cipher
	/**
	 * Conversion to MP3, AIFF and WAV; by default ffmpeg (Kemix's own copy, downloaded on first use). Tests pass a
	 * fake one.
	 */
	converter?: AudioConverter
	/** Decodes audio to analyze its key and BPM; by default the same ffmpeg. Tests pass a fake one. */
	decoder?: AudioDecoder
	/** Decodifica el audio tal cual, para el espectro; por defecto el mismo ffmpeg. Los tests pasan uno falso. */
	rawDecoder?: RawDecoder
	/** Catalogs for key and BPM; tests pass one without request delays. */
	featureSources?: FeatureSources
	/** Cómo se conecta Soulseek; los tests pasan una red en memoria. */
	soulseek?: Pick<SlskClientOptions, 'transport' | 'server' | 'timing'>
}

/** The whole backend, independent of how it is exposed (Electron, HTTP server…). */
export class Kemix {
	readonly db: Db
	readonly events = new EventBus()
	readonly settings: SettingsStore
	readonly secrets: SecretStore
	readonly accounts: Accounts
	readonly library: Library
	readonly queue: DownloadQueue
	readonly features: FeatureAnalyzer
	/** Búsquedas libres en Soulseek y descargas de archivos sueltos. */
	readonly soulseek: SoulseekSearches
	/** Explorar: temas de SoundCloud con descarga gratis, por género. */
	readonly explore: SoundCloudExplore
	/** Espectro: si la calidad de un archivo es la que dice. */
	readonly spectrum: SpectrumAnalyzer

	constructor(opts: KemixOptions) {
		fs.mkdirSync(opts.dataDir, { recursive: true })
		this.db = openDb(path.join(opts.dataDir, 'kemix.db'))
		this.settings = new SettingsStore(this.db)
		this.secrets = new SecretStore(this.db, opts.cipher)
		const binDir = path.join(opts.dataDir, 'bin')
		this.accounts = new Accounts(this.db, this.secrets, this.settings, this.events, binDir, opts.soulseek)
		this.library = new Library(this.db, this.accounts, this.events)
		const ffmpeg = new Ffmpeg(new ManagedFfmpeg(binDir))
		this.features = new FeatureAnalyzer(
			this.db,
			this.library,
			this.settings,
			this.events,
			opts.decoder ?? ffmpeg,
			(track, minScore) => this.accounts.findIsrc(track, minScore),
			opts.featureSources
		)
		this.queue = new DownloadQueue(
			this.db,
			this.accounts,
			this.library,
			this.settings,
			this.events,
			opts.converter ?? ffmpeg,
			(trackId) => this.features.trackDownloaded(trackId)
		)
		this.soulseek = new SoulseekSearches(this.accounts, this.queue, this.settings, this.events)
		this.explore = new SoundCloudExplore(this.queue)
		this.spectrum = new SpectrumAnalyzer(this.db, opts.rawDecoder ?? ffmpeg)
	}

	start() {
		this.queue.start()
		// Accounts connected before emails were stored get theirs filled in, in the background.
		void this.accounts.refreshIdentities()
	}

	close() {
		this.queue.stop()
		this.features.stop()
		this.spectrum.stop()
		this.soulseek.close()
		this.accounts.close()
		this.db.close()
	}
}
