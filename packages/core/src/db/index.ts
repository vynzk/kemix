import { DatabaseSync } from 'node:sqlite'

export type Db = DatabaseSync

/**
 * Append-only list of migrations. Never edit an entry that has shipped; add a new one instead.
 * `PRAGMA user_version` tracks how many have been applied.
 */
const MIGRATIONS: string[] = [
	`
	CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE accounts (
		service TEXT PRIMARY KEY,
		display_name TEXT,
		status TEXT NOT NULL DEFAULT 'disconnected',
		error TEXT,
		updated_at INTEGER
	);
	CREATE TABLE folders (
		id INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
		position INTEGER NOT NULL DEFAULT 0
	);
	CREATE TABLE playlists (
		id INTEGER PRIMARY KEY,
		source TEXT NOT NULL,
		source_id TEXT NOT NULL,
		name TEXT NOT NULL,
		owner TEXT,
		cover_url TEXT,
		track_count INTEGER,
		snapshot TEXT,
		tracks_snapshot TEXT,
		folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
		position INTEGER NOT NULL DEFAULT 0,
		synced_at INTEGER,
		removed INTEGER NOT NULL DEFAULT 0,
		UNIQUE (source, source_id)
	);
	CREATE TABLE tracks (
		id INTEGER PRIMARY KEY,
		source TEXT NOT NULL,
		source_id TEXT NOT NULL,
		title TEXT NOT NULL,
		artists TEXT NOT NULL,
		album TEXT,
		duration_ms INTEGER,
		isrc TEXT,
		cover_url TEXT,
		url TEXT,
		UNIQUE (source, source_id)
	);
	CREATE TABLE playlist_tracks (
		playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
		position INTEGER NOT NULL,
		track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
		PRIMARY KEY (playlist_id, position)
	);
	CREATE TABLE matches (
		track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
		status TEXT NOT NULL,
		target_service TEXT,
		target_id TEXT,
		target_url TEXT,
		target_meta TEXT,
		confidence REAL,
		candidates TEXT,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE downloads (
		id INTEGER PRIMARY KEY,
		playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
		position INTEGER NOT NULL,
		track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
		status TEXT NOT NULL,
		path TEXT,
		error TEXT,
		attempts INTEGER NOT NULL DEFAULT 0,
		bytes INTEGER,
		total_bytes INTEGER,
		updated_at INTEGER NOT NULL,
		UNIQUE (playlist_id, position)
	);
	CREATE INDEX downloads_status ON downloads(status);
	CREATE TABLE files (
		target_service TEXT NOT NULL,
		target_id TEXT NOT NULL,
		path TEXT NOT NULL,
		PRIMARY KEY (target_service, target_id)
	);
	`,
	// 2: show which account (email) each service is connected with.
	`ALTER TABLE accounts ADD COLUMN email TEXT;`,
	// 3: remember which service each file came from and the quality it was downloaded in.
	`
	ALTER TABLE downloads ADD COLUMN quality TEXT;
	ALTER TABLE downloads ADD COLUMN service TEXT;
	ALTER TABLE files ADD COLUMN quality TEXT;
	`,
	// 4: the provider the user picked for a download (NULL: automatic, by service priority).
	`ALTER TABLE downloads ADD COLUMN provider TEXT;`
]

export function openDb(file: string): Db {
	const db = new DatabaseSync(file)
	db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
	migrate(db)
	return db
}

function migrate(db: Db) {
	const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number }
	for (let i = current; i < MIGRATIONS.length; i++) {
		tx(db, () => {
			db.exec(MIGRATIONS[i]!)
			db.exec(`PRAGMA user_version = ${i + 1}`)
		})
	}
}

export function tx<T>(db: Db, fn: () => T): T {
	db.exec('BEGIN')
	try {
		const result = fn()
		db.exec('COMMIT')
		return result
	} catch (err) {
		db.exec('ROLLBACK')
		throw err
	}
}
