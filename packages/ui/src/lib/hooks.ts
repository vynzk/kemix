import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { DownloadService, KeyNotation, TrackFeatures } from '@kemix/core'
import { api, type FeatureLookupItem } from './api'
import { isLossy } from './format'

/**
 * Download services the user can pick by hand: YouTube and SoundCloud need no account (only yt-dlp); Qobuz, Deezer and
 * Soundeo once connected.
 */
export function useDownloadProviders(): DownloadService[] {
	const state = useQuery({ queryKey: ['state'], queryFn: api.state })
	return useMemo(() => {
		const connected = new Set(state.data?.accounts.filter((a) => a.status === 'connected').map((a) => a.service))
		return (['qobuz', 'deezer', 'soundeo', 'youtube', 'soundcloud'] as const).filter((s) => isLossy(s) || connected.has(s))
	}, [state.data])
}

/** Best quality each download service gives with the connected account; refetched when an account changes. */
export function useDownloadQualities() {
	const state = useQuery({ queryKey: ['state'], queryFn: api.state })
	// Includes who's signed in: switching YouTube Music account can change the quality (Premium or not).
	const connectedKey = (state.data?.accounts ?? []).map((a) => `${a.service}:${a.status}:${a.email ?? a.displayName ?? ''}`).join(',')
	return useQuery({
		queryKey: ['account-quality', connectedKey],
		queryFn: api.downloadQualities,
		enabled: !!state.data
	})
}

/** Where each track outside the library keeps its key and BPM in the query cache, filled by `useFeatureLookup` and events. */
export const trackFeaturesKey = (service: string, sourceId: string) => ['trackFeatures', service, sourceId]

/**
 * Ask for the key and BPM of a list of tracks outside the library (search results, a review item's options). What's
 * known comes back right away; the rest arrives as events, track by track. Read each one with `useTrackFeatures`.
 * Returns whether a lookup is under way, to tell "still looking" from "nothing found".
 */
export function useFeatureLookup(group: string, items: FeatureLookupItem[] | undefined): boolean {
	const qc = useQueryClient()
	const key = items?.map((i) => `${i.service}:${i.track.sourceId}`).join(',') ?? ''
	const lookup = useQuery({
		queryKey: ['featureLookup', group, key],
		enabled: !!items?.length,
		staleTime: Infinity,
		// Forgotten as soon as the list changes: coming back to it asks again, since a newer batch may have stopped it.
		gcTime: 0,
		queryFn: async () => {
			const { results } = await api.lookupFeatures(items!, group)
			results.forEach((f, i) => {
				// An event may have answered already: only fill in, never clear.
				if (f) qc.setQueryData(trackFeaturesKey(items![i]!.service, items![i]!.track.sourceId), f)
			})
			return true
		}
	})
	return !!items?.length && !lookup.isError
}

/** Key and BPM of a track outside the library; undefined while not known (see `useFeatureLookup`). */
export function useTrackFeatures(service: string, sourceId: string): TrackFeatures | undefined {
	return useQuery<TrackFeatures | null>({
		queryKey: trackFeaturesKey(service, sourceId),
		queryFn: () => Promise.resolve(null),
		enabled: false,
		staleTime: Infinity
	}).data ?? undefined
}

/** How keys are shown, from Ajustes. */
export function useKeyNotation(): KeyNotation {
	const state = useQuery({ queryKey: ['state'], queryFn: api.state })
	return state.data?.settings.keyNotation ?? 'camelot'
}

/** Whether GetSongBPM may be among the sources (there's an API key), so its credit has to show. */
export function useGetSongBpm(): boolean {
	const state = useQuery({ queryKey: ['state'], queryFn: api.state })
	return !!state.data?.settings.getSongBpmKey
}
