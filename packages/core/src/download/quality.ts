import fs from 'node:fs'
import path from 'node:path'
import { File } from 'node-taglib-sharp'
import type { AudioQuality } from '../types'

/** Codec guessed from the file extension; refined with what taglib reports. */
function codecFor(ext: string, description: string): AudioQuality['codec'] {
	const d = description.toLowerCase()
	switch (ext) {
		case 'flac':
			return 'flac'
		case 'mp3':
			return 'mp3'
		case 'm4a':
		case 'mp4':
			return d.includes('alac') || d.includes('apple lossless') ? 'alac' : 'aac'
		case 'opus':
		case 'webm':
			return d.includes('vorbis') ? 'vorbis' : 'opus'
		case 'ogg':
			return d.includes('opus') ? 'opus' : 'vorbis'
		default:
			return 'other'
	}
}

/** Read the real quality of a downloaded file. Returns null if the file can't be parsed. */
export function readFileQuality(filePath: string): AudioQuality | null {
	try {
		const file = File.createFromPath(filePath)
		try {
			const p = file.properties
			const description = p?.description ?? ''
			const codec = codecFor(path.extname(filePath).slice(1).toLowerCase(), description)
			const lossless = codec === 'flac' || codec === 'alac'
			// Some containers (YouTube's DASH m4a) don't state a bitrate: derive the average from size and duration.
			let bitrate = p?.audioBitrate || 0
			if (!bitrate && p?.durationMilliseconds) bitrate = (fs.statSync(filePath).size * 8) / p.durationMilliseconds
			return {
				codec,
				lossless,
				bitDepth: lossless && p?.bitsPerSample ? p.bitsPerSample : undefined,
				sampleRateHz: p?.audioSampleRate || undefined,
				bitrateKbps: bitrate ? Math.round(bitrate) : undefined
			}
		} finally {
			file.dispose()
		}
	} catch {
		return null
	}
}
