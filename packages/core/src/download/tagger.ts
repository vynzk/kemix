import fs from 'node:fs/promises'
import path from 'node:path'
import { ByteVector, File, Picture, PictureType, TagTypes, WaveFileSettings } from 'node-taglib-sharp'
import type { TargetTrack } from '../types'

// WAV files get an ID3v2 chunk (what DJ software reads, with the cover) and a RIFF INFO list, not the video-oriented
// DivX/MovieID tags taglib would also add by default.
WaveFileSettings.defaultTagTypes = TagTypes.Id3v2 | TagTypes.RiffInfo

export async function fetchCover(url: string | undefined): Promise<Buffer | undefined> {
	if (!url) return undefined
	try {
		const res = await fetch(url)
		if (!res.ok) return undefined
		return Buffer.from(await res.arrayBuffer())
	} catch {
		return undefined
	}
}

/** Write tags and embedded cover art. lucida delivers raw audio without metadata. */
export function writeTags(filePath: string, meta: TargetTrack, cover?: Buffer) {
	const file = File.createFromPath(filePath)
	try {
		const tag = file.tag
		tag.title = meta.title
		tag.performers = meta.artists
		if (meta.album) tag.album = meta.album
		tag.albumArtists = meta.albumArtists?.length ? meta.albumArtists : meta.artists.slice(0, 1)
		if (meta.trackNumber) tag.track = meta.trackNumber
		if (meta.discNumber) tag.disc = meta.discNumber
		if (meta.year) tag.year = meta.year
		if (meta.genres?.length) tag.genres = meta.genres
		if (meta.isrc) tag.isrc = meta.isrc
		if (meta.copyright) tag.copyright = meta.copyright
		if (cover) {
			const pic = Picture.fromData(ByteVector.fromByteArray(cover))
			pic.type = PictureType.FrontCover
			tag.pictures = [pic]
		}
		file.save()
	} finally {
		file.dispose()
	}
}

/**
 * Write the BPM (TBPM / BPM, a whole number as the tag requires) and the key (TKEY / INITIALKEY, written "Am", "F#")
 * into an audio file, for DJ software. Only what's given is written.
 */
export function writeKeyBpm(filePath: string, values: { bpm?: number | null; key?: string | null }) {
	if (!values.bpm && !values.key) return
	const file = File.createFromPath(filePath)
	try {
		if (values.bpm) file.tag.beatsPerMinute = Math.round(values.bpm)
		if (values.key) file.tag.initialKey = values.key
		file.save()
	} finally {
		file.dispose()
	}
}

/** The BPM and key a file's tags already carry (some downloads come with them), if any. */
export function readKeyBpm(filePath: string): { bpm: number | null; key: string | null } {
	try {
		const file = File.createFromPath(filePath)
		try {
			const bpm = file.tag.beatsPerMinute
			return { bpm: bpm > 0 ? bpm : null, key: file.tag.initialKey?.trim() || null }
		} finally {
			file.dispose()
		}
	} catch {
		return { bpm: null, key: null }
	}
}

/** Copy tags and cover art from one audio file to another (a file converted from an earlier download). */
export function copyTags(fromPath: string, toPath: string) {
	const from = File.createFromPath(fromPath)
	try {
		const to = File.createFromPath(toPath)
		try {
			from.tag.copyTo(to.tag, true)
			to.tag.pictures = from.tag.pictures
			to.save()
		} finally {
			to.dispose()
		}
	} finally {
		from.dispose()
	}
}

/** Write an extended M3U playlist with paths relative to the playlist folder. */
export async function writeM3u(
	dir: string,
	name: string,
	entries: { path: string; durationMs?: number | null; label: string }[]
) {
	const lines = ['#EXTM3U', `#PLAYLIST:${name}`]
	for (const e of entries) {
		lines.push(`#EXTINF:${e.durationMs ? Math.round(e.durationMs / 1000) : -1},${e.label}`)
		lines.push(path.relative(dir, e.path).split(path.sep).join('/'))
	}
	// Write then rename, so a player (or a concurrent reader) never sees a half-written file.
	const target = path.join(dir, `${path.basename(dir)}.m3u8`)
	await fs.writeFile(`${target}.tmp`, lines.join('\n') + '\n', 'utf8')
	await fs.rename(`${target}.tmp`, target)
}
