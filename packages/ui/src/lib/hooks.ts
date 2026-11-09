import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { DownloadService } from '@kemix/core'
import { api } from './api'
import { isLossy } from './format'

/**
 * Download services the user can pick by hand: YouTube and SoundCloud need no account (only yt-dlp); Qobuz and Deezer
 * once connected.
 */
export function useDownloadProviders(): DownloadService[] {
	const state = useQuery({ queryKey: ['state'], queryFn: api.state })
	return useMemo(() => {
		const connected = new Set(state.data?.accounts.filter((a) => a.status === 'connected').map((a) => a.service))
		return (['qobuz', 'deezer', 'youtube', 'soundcloud'] as const).filter((s) => isLossy(s) || connected.has(s))
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
