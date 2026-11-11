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
	`ALTER TABLE downloads ADD COLUMN provider TEXT;`,
	// 5: the quality level each download asks for (NULL: the one in settings), and one file per track and level so
	// a file is only reused for the quality it was downloaded in. Everything until now was downloaded at 'max'.
	`
	ALTER TABLE downloads ADD COLUMN quality_level TEXT;
	CREATE TABLE files_new (
		target_service TEXT NOT NULL,
		target_id TEXT NOT NULL,
		quality_level TEXT NOT NULL,
		path TEXT NOT NULL,
		quality TEXT,
		PRIMARY KEY (target_service, target_id, quality_level)
	);
	INSERT INTO files_new (target_service, target_id, quality_level, path, quality)
		SELECT target_service, target_id, 'max', path, quality FROM files;
	DROP TABLE files;
	ALTER TABLE files_new RENAME TO files;
	`,
	// 6: the file format each download asks for (NULL: the one in settings), and one file per track, level and
	// format, so a converted file (AIFF, WAV, MP3) is only reused in that same format. Everything until now is 'original'.
	`
	ALTER TABLE downloads ADD COLUMN format TEXT;
	CREATE TABLE files_new (
		target_service TEXT NOT NULL,
		target_id TEXT NOT NULL,
		quality_level TEXT NOT NULL,
		format TEXT NOT NULL,
		path TEXT NOT NULL,
		quality TEXT,
		PRIMARY KEY (target_service, target_id, quality_level, format)
	);
	INSERT INTO files_new (target_service, target_id, quality_level, format, path, quality)
		SELECT target_service, target_id, quality_level, 'original', path, quality FROM files;
	DROP TABLE files;
	ALTER TABLE files_new RENAME TO files;
	`,
	// 7: BPM and key of each track, and where each came from. A row means the track was looked up (even if nothing was
	// found), so opening a playlist doesn't look it up again. key_tonic: pitch class, 0 = C … 11 = B.
	`
	CREATE TABLE track_features (
		track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
		bpm REAL,
		bpm_source TEXT,
		key_tonic INTEGER,
		key_minor INTEGER,
		key_source TEXT,
		status TEXT NOT NULL,
		error TEXT,
		updated_at INTEGER NOT NULL
	);
	`,
	// 8: temas de SoundCloud que se pueden bajar gratis (JSON de FreeDownload: descarga de SoundCloud o enlace del artista).
	`ALTER TABLE tracks ADD COLUMN free_download TEXT;`
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
