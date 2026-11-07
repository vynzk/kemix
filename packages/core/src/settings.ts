import os from 'node:os'
import path from 'node:path'
import type { Db } from './db'
import { DOWNLOAD_SERVICES, type Settings } from './types'

export const DEFAULT_PORT = 47800

export function defaultSettings(): Settings {
	return {
		downloadDir: path.join(os.homedir(), 'Music', 'Kemix'),
		servicePriority: ['qobuz', 'deezer'],
		concurrency: 3,
		autoAcceptThreshold: 0.9,
		spotifyClientId: '',
		ytDlpPath: '',
		port: DEFAULT_PORT
	}
}

export class SettingsStore {
	constructor(private db: Db) {}

	get(): Settings {
		const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
		const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]))
		return { ...defaultSettings(), ...stored }
	}

	update(patch: Partial<Settings>): Settings {
		const next = sanitize({ ...this.get(), ...patch })
		const stmt = this.db.prepare(
			'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
		)
		for (const key of Object.keys(patch) as (keyof Settings)[]) {
			stmt.run(key, JSON.stringify(next[key]))
		}
		return next
	}
}

function sanitize(s: Settings): Settings {
	const priority = s.servicePriority.filter((x) => DOWNLOAD_SERVICES.includes(x))
	return {
		...s,
		downloadDir: s.downloadDir.trim() || defaultSettings().downloadDir,
		servicePriority: priority.length ? [...new Set(priority)] : defaultSettings().servicePriority,
		concurrency: clamp(Math.round(s.concurrency), 1, 8),
		autoAcceptThreshold: clamp(s.autoAcceptThreshold, 0.5, 1),
		spotifyClientId: s.spotifyClientId.trim(),
		ytDlpPath: (s.ytDlpPath ?? '').trim().replace(/^"(.*)"$/, '$1'),
		port: clamp(Math.round(s.port), 1024, 65535)
	}
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(n) ? n : min))
