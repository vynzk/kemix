import crypto from 'node:crypto'
import type { Db } from './db'

/** Encrypts secrets at rest. Desktop uses Electron safeStorage (OS keychain/DPAPI); the web server uses a key from env. */
export interface Cipher {
	encrypt(plain: string): string
	decrypt(stored: string): string
}

/** AES-256-GCM with a key derived from a passphrase (for standalone/web mode). */
export function passphraseCipher(passphrase: string): Cipher {
	const key = crypto.scryptSync(passphrase, 'kemix-secrets-v1', 32)
	return {
		encrypt(plain) {
			const iv = crypto.randomBytes(12)
			const c = crypto.createCipheriv('aes-256-gcm', key, iv)
			const data = Buffer.concat([c.update(plain, 'utf8'), c.final()])
			return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64')
		},
		decrypt(stored) {
			const buf = Buffer.from(stored, 'base64')
			const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
			d.setAuthTag(buf.subarray(12, 28))
			return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')
		}
	}
}

export class SecretStore {
	constructor(
		private db: Db,
		private cipher: Cipher
	) {}

	get<T>(key: string): T | null {
		const row = this.db.prepare('SELECT value FROM secrets WHERE key = ?').get(key) as { value: string } | undefined
		if (!row) return null
		try {
			return JSON.parse(this.cipher.decrypt(row.value)) as T
		} catch {
			// Undecryptable (e.g. key changed): treat as missing so the user can reconnect.
			return null
		}
	}

	set(key: string, value: unknown) {
		this.db
			.prepare('INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
			.run(key, this.cipher.encrypt(JSON.stringify(value)))
	}

	delete(key: string) {
		this.db.prepare('DELETE FROM secrets WHERE key = ?').run(key)
	}
}
