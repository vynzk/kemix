import fs from 'node:fs'
import path from 'node:path'
import { openDb, type Db } from './db'
import { EventBus } from './events'
import { SecretStore, type Cipher } from './secrets'
import { SettingsStore } from './settings'
import { Accounts } from './accounts'
import { Library } from './library'
import { DownloadQueue } from './download/queue'

export * from './types'
export { passphraseCipher, type Cipher } from './secrets'
export { DEFAULT_PORT } from './settings'
export type { Accounts, SpotifyWebLogin } from './accounts'
export type { SpotifyWebOp, SpotifyWebSession } from './sources/spotify-web'
export type { Library } from './library'
export type { DownloadQueue } from './download/queue'
export type { YtMusicAccount } from './sources/ytmusic'

export interface KemixOptions {
	/** Directory for the database and the tools Kemix downloads for itself (yt-dlp). */
	dataDir: string
	cipher: Cipher
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
		this.accounts = new Accounts(this.db, this.secrets, this.settings, this.events, path.join(opts.dataDir, 'bin'))
		this.library = new Library(this.db, this.accounts, this.events)
		this.queue = new DownloadQueue(this.db, this.accounts, this.library, this.settings, this.events)
	}

	start() {
		this.queue.start()
		// Accounts connected before emails were stored get theirs filled in, in the background.
		void this.accounts.refreshIdentities()
	}

	close() {
		this.db.close()
	}
}
