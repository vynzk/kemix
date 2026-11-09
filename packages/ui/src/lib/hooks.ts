import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { DownloadService } from '@kemix/core'
import { api } from './api'

/** Download services the user can pick by hand: YouTube needs no account (only yt-dlp); Qobuz and Deezer once connected. */
export function useDownloadProviders(): DownloadService[] {
	const state = useQuery({ queryKey: ['state'], queryFn: api.state })
	return useMemo(() => {
		const connected = new Set(state.data?.accounts.filter((a) => a.status === 'connected').map((a) => a.service))
		return (['qobuz', 'deezer', 'youtube'] as const).filter((s) => s === 'youtube' || connected.has(s))
	}, [state.data])
}

/** Best quality each download service gives with the connected account; refetched when an account changes. */
export function useDownloadQualities() {
	const state = useQuery({ queryKey: ['state'], queryFn: api.state })
	const connectedKey = (state.data?.accounts ?? []).map((a) => `${a.service}:${a.status}`).join(',')
	return useQuery({
		queryKey: ['account-quality', connectedKey],
		queryFn: api.downloadQualities,
		enabled: !!state.data
	})
}
