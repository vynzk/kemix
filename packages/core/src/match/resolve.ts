import type { Downloader } from '../download/lucida-adapter'
import type { DownloadService, MatchCandidate, MatchStatus, SourceService, SourceTrack, TargetService } from '../types'
import { DOWNLOAD_SERVICE_LABEL, isTargetService } from '../types'
import { errorMessage } from '../util'
import { scoreMatch, scoreYouTube, searchQueries } from './score'

/** A YouTube video scoring at least this is taken as the song (titles there are noisier than on Qobuz/Deezer). */
export const YOUTUBE_MIN_SCORE = 0.6
/** Below this the best candidate is noise (another song by the artist, a namesake…): the track counts as not found. */
export const NOT_FOUND_BELOW = 0.5

export interface ResolveResult {
	status: MatchStatus
	target: MatchCandidate | null
	candidates: MatchCandidate[]
}

/** The track's ISRC, found somewhere else, and how sure that lookup is that it's the same recording (0..1). */
export type IsrcFinder = (track: SourceTrack, minScore: number) => Promise<{ isrc: string; score: number } | null>

export interface ResolveOptions {
	/** For sources without ISRCs (Spotify's web player, YouTube Music): look the ISRC up elsewhere. */
	findIsrc?: IsrcFinder
}

export function scorerFor(service: DownloadService) {
	return service === 'youtube' ? scoreYouTube : scoreMatch
}

/**
 * Run `queries` on one service, in order, until one finds a candidate scoring at least `enough`.
 * The recording the track's source already points at on this service, if any, comes first at 100% (the first query
 * still runs, so there are alternatives to pick from).
 * Throws only when every query failed (service down, session expired…) and there's no such recording, so that is
 * never taken for "not there".
 */
export async function searchService(
	track: SourceTrack & { source?: string },
	downloader: Downloader,
	queries: string[],
	enough = Infinity
): Promise<MatchCandidate[]> {
	const score = scorerFor(downloader.service)
	const exact = downloader.exact?.(track)
	const found: MatchCandidate[] = exact ? [{ ...exact, score: 1 }] : []
	let failed = 0
	let lastError: unknown
	for (const query of queries) {
		try {
			for (const r of await downloader.search(query, 10)) found.push({ ...r, score: score(track, r) })
		} catch (err) {
			failed++
			lastError = err
		}
		if (found.some((c) => c.score >= enough)) break
	}
	if (queries.length && failed === queries.length && !exact) throw lastError
	return dedupe(found.sort((a, b) => b.score - a.score))
}

/**
 * Find a track on the download services, tried in the given (priority) order:
 * 1. The source is itself a download service → use it directly.
 * 2. ISRC lookup on each service.
 * 3. Text search on each service, from the most specific query to broader ones; the first service with a match
 *    above the threshold wins.
 * 4. No ISRC from the source: find it elsewhere and go back to 2.
 * Otherwise the candidates are left for manual review.
 */
export async function resolveTrack(
	track: SourceTrack & { source: SourceService },
	downloaders: Downloader[],
	threshold: number,
	opts: ResolveOptions = {}
): Promise<ResolveResult> {
	if (isTargetService(track.source) && track.url && downloaders.some((d) => d.service === track.source)) {
		const direct: MatchCandidate = {
			service: track.source as TargetService,
			id: track.sourceId,
			url: track.url,
			title: track.title,
			artists: track.artists,
			album: track.album,
			durationMs: track.durationMs,
			isrc: track.isrc,
			coverUrl: track.coverUrl,
			score: 1
		}
		return { status: 'auto', target: direct, candidates: [] }
	}

	if (track.isrc) {
		const hit = await isrcMatch(track, track.isrc, downloaders)
		if (hit) return { status: 'auto', target: { ...hit, score: Math.max(hit.score, 0.95) }, candidates: [] }
	}

	const queries = searchQueries(track)
	const candidates: MatchCandidate[] = []
	const failures: string[] = []
	for (const [rank, d] of downloaders.entries()) {
		// Once YouTube has a convincing video, more searches there won't find a better one.
		const enough = d.service === 'youtube' ? Math.min(threshold, YOUTUBE_MIN_SCORE) : threshold
		let found: MatchCandidate[]
		try {
			found = await searchService(track, d, queries, enough)
		} catch (err) {
			// One service failing shouldn't block matching on the others.
			failures.push(`${DOWNLOAD_SERVICE_LABEL[d.service]}: ${errorMessage(err)}`)
			continue
		}
		if (found[0] && found[0].score >= threshold) return { status: 'auto', target: found[0], candidates: top(found) }
		// A tiny rank penalty breaks ties in favour of the preferred service.
		candidates.push(...found.map((c) => ({ ...c, score: Math.max(0, c.score - rank * 0.001) })))
	}

	if (!track.isrc && opts.findIsrc && downloaders.some((d) => d.service !== 'youtube')) {
		const found = await opts.findIsrc(track, threshold).catch(() => null)
		const hit = found && (await isrcMatch(track, found.isrc, downloaders))
		if (found && hit) return { status: 'auto', target: { ...hit, score: Math.max(hit.score, found.score) }, candidates: [] }
	}

	const best = top(candidates)
	if (!best.length || best[0]!.score < NOT_FOUND_BELOW) {
		// A service that couldn't be searched may well have it: fail (and retry later) instead of saying it isn't there.
		if (failures.length) throw new Error(`No se pudo buscar el tema (${failures.join(' · ')})`)
		return { status: 'notfound', target: null, candidates: best }
	}
	// YouTube is in the user's list: when no lossless service has anything close, take a convincing video.
	const video = best.find((c) => c.service === 'youtube')
	const lossless = best.some((c) => c.service !== 'youtube' && c.score >= YOUTUBE_MIN_SCORE)
	if (video && video.score >= YOUTUBE_MIN_SCORE && !lossless) return { status: 'auto', target: video, candidates: best }
	return { status: 'pending', target: null, candidates: best }
}

/** The recording with this ISRC on the first service that has it, if its metadata agrees with the track. */
export async function isrcMatch(
	track: SourceTrack,
	isrc: string,
	downloaders: Downloader[]
): Promise<MatchCandidate | null> {
	for (const d of downloaders) {
		let hit
		try {
			hit = await d.isrcLookup(isrc)
		} catch {
			continue
		}
		if (!hit) continue
		// Same ISRC with wildly different metadata usually means a bad ISRC on the source side.
		const score = scoreMatch({ ...track, isrc: undefined }, hit)
		if (score >= 0.5) return { ...hit, score }
	}
	return null
}

function top(list: MatchCandidate[]): MatchCandidate[] {
	return dedupe([...list].sort((a, b) => b.score - a.score)).slice(0, 5)
}

function dedupe(list: MatchCandidate[]): MatchCandidate[] {
	const seen = new Set<string>()
	return list.filter((c) => {
		const key = `${c.service}:${c.id}`
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}
