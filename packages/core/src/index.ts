import fs from 'node:fs'
import path from 'node:path'
import { openDb, type Db } from './db'
import { EventBus } from './events'
import { SecretStore, type Cipher } from './secrets'
import { SettingsStore } from './settings'
import { Accounts } from './accounts'
import { Library } from './library'
import { DownloadQueue } from './download/queue'
import { Ffmpeg, ManagedFfmpeg, type Mp3Converter } from './download/ffmpeg'

export * from './types'
export { passphraseCipher, type Cipher } from './secrets'
export { DEFAULT_PORT } from './settings'
export type { Accounts, SpotifyWebLogin } from './accounts'
export type { SpotifyWebOp, SpotifyWebSession } from './sources/spotify-web'
export type { Library } from './library'
export type { DownloadQueue } from './download/queue'
export type { Mp3Converter } from './download/ffmpeg'
export type { YtMusicAccount } from './sources/ytmusic'

export interface KemixOptions {
	/** Directory for the database and the tools Kemix downloads for itself (yt-dlp, ffmpeg). */
	dataDir: string
	cipher: Cipher
	/** MP3 conversion; by default ffmpeg (Kemix's own copy, downloaded on first use). Tests pass a fake one. */
	mp3?: Mp3Converter
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

	constructor(opts: KemixOptions) {
		fs.mkdirSync(opts.dataDir, { recursive: true })
		this.db = openDb(path.join(opts.dataDir, 'kemix.db'))
		this.settings = new SettingsStore(this.db)
		this.secrets = new SecretStore(this.db, opts.cipher)
		const binDir = path.join(opts.dataDir, 'bin')
		this.accounts = new Accounts(this.db, this.secrets, this.settings, this.events, binDir)
		this.library = new Library(this.db, this.accounts, this.events)
		const mp3 = opts.mp3 ?? new Ffmpeg(new ManagedFfmpeg(binDir))
		this.queue = new DownloadQueue(this.db, this.accounts, this.library, this.settings, this.events, mp3)
	}

	start() {
		this.queue.start()
		// Accounts connected before emails were stored get theirs filled in, in the background.
		void this.accounts.refreshIdentities()
	}

	close() {
		this.queue.stopScans()
		this.db.close()
	}
}
