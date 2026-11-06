import type { Downloader } from '../download/lucida-adapter'
import type { MatchCandidate, MatchStatus, SourceService, SourceTrack, TargetService } from '../types'
import { isTargetService } from '../types'
import { scoreMatch, searchQuery } from './score'

export interface ResolveResult {
	status: MatchStatus
	target: MatchCandidate | null
	candidates: MatchCandidate[]
}

/**
 * Find a track on the download services:
 * 1. The source is itself a download service → use it directly.
 * 2. ISRC lookup on each service, in priority order.
 * 3. Text search on each service, scored; auto-accept above the threshold, otherwise leave for manual review.
 */
export async function resolveTrack(
	track: SourceTrack & { source: SourceService },
	downloaders: Downloader[],
	threshold: number
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
		for (const d of downloaders) {
			const hit = await d.isrcLookup(track.isrc)
			if (!hit) continue
			// Same ISRC with wildly different metadata usually means a bad ISRC on the source side.
			const score = scoreMatch({ ...track, isrc: undefined }, hit)
			if (score >= 0.5) return { status: 'auto', target: { ...hit, score: Math.max(score, 0.95) }, candidates: [] }
		}
	}

	const query = searchQuery(track)
	const candidates: MatchCandidate[] = []
	for (const [rank, d] of downloaders.entries()) {
		try {
			const results = await d.search(query, 10)
			// A tiny rank penalty breaks ties in favour of the preferred service.
			for (const r of results) candidates.push({ ...r, score: Math.max(0, scoreMatch(track, r) - rank * 0.001) })
		} catch {
			// One service failing shouldn't block matching on the others.
		}
	}
	candidates.sort((a, b) => b.score - a.score)
	const top = dedupe(candidates).slice(0, 5)
	if (!top.length) return { status: 'notfound', target: null, candidates: [] }
	if (top[0]!.score >= threshold) return { status: 'auto', target: top[0]!, candidates: top }
	return { status: 'pending', target: null, candidates: top }
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
