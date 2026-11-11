import { useEffect, useState } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { DownloadRow, KemixEvent } from '@kemix/core'
import { trackFeaturesKey } from './hooks'

export interface SyncState {
	running: boolean
	message?: string
	error?: string
}

/** Subscribes to the server's SSE stream and keeps the React Query cache fresh. */
export function useLiveEvents(): SyncState {
	const qc = useQueryClient()
	const [sync, setSync] = useState<SyncState>({ running: false })

	useEffect(() => {
		const source = new EventSource('/api/events')
		const invalidateLibrary = throttle(() => qc.invalidateQueries({ queryKey: ['library'] }), 750)
		const invalidatePlaylist = throttleByKey((id: number) => qc.invalidateQueries({ queryKey: ['playlist', id] }), 750)
		// Each track downloaded from Soundeo uses one of the day's downloads: keep the counter in Cuentas current.
		const invalidateSoundeo = throttle(() => qc.invalidateQueries({ queryKey: ['soundeo-status'] }), 2000)
		// Una búsqueda en Soulseek trae resultados durante varios segundos: se relee a medida que llegan.
		const invalidateSlskSearch = throttleByKey((id: string) => qc.invalidateQueries({ queryKey: ['slsk-search', id] }), 500)

		source.onmessage = (msg) => {
			const event = JSON.parse(msg.data) as KemixEvent
			switch (event.type) {
				case 'accounts':
					qc.invalidateQueries({ queryKey: ['state'] })
					qc.invalidateQueries({ queryKey: ['soundeo-status'] })
					qc.invalidateQueries({ queryKey: ['soulseek-status'] })
					break
				case 'slsk-search':
					invalidateSlskSearch(event.id)
					break
				case 'library':
					invalidateLibrary()
					break
				case 'playlist':
					invalidatePlaylist(event.playlistId)
					invalidateLibrary()
					break
				case 'review':
					qc.invalidateQueries({ queryKey: ['review'] })
					break
				case 'scan':
					qc.setQueryData(['scan', event.scan.playlistId], { scan: event.scan })
					break
				case 'features':
					qc.setQueryData(['features', event.scan.playlistId], { scan: event.scan })
					break
				case 'track-features':
					qc.setQueryData(trackFeaturesKey(event.service, event.sourceId), event.features)
					break
				case 'download':
					upsertDownload(qc, event.row)
					invalidatePlaylist(event.row.playlistId)
					invalidateLibrary()
					if (event.row.service === 'soundeo' && event.row.status === 'done') invalidateSoundeo()
					break
				case 'download-removed':
					qc.setQueryData<DownloadRow[]>(['downloads'], (rows) => rows?.filter((r) => r.id !== event.id))
					invalidatePlaylist(event.playlistId)
					invalidateLibrary()
					break
				case 'sync':
					if (event.state === 'start') setSync({ running: true })
					else if (event.state === 'progress') setSync({ running: true, message: event.message })
					else if (event.state === 'done') setSync({ running: false, message: event.message })
					else setSync({ running: false, error: event.message })
					break
			}
		}
		// EventSource reconnects on its own; refetch on reconnect so nothing missed while offline stays stale.
		source.onopen = () => qc.invalidateQueries()
		return () => source.close()
	}, [qc])

	return sync
}

function upsertDownload(qc: QueryClient, row: DownloadRow) {
	qc.setQueryData<DownloadRow[]>(['downloads'], (rows) => {
		if (!rows) return rows
		const i = rows.findIndex((r) => r.id === row.id)
		if (i === -1) return [row, ...rows]
		const next = rows.slice()
		next[i] = row
		return next
	})
}

function throttle(fn: () => void, ms: number) {
	let timer: ReturnType<typeof setTimeout> | undefined
	return () => {
		if (timer) return
		timer = setTimeout(() => {
			timer = undefined
			fn()
		}, ms)
	}
}

function throttleByKey<K>(fn: (key: K) => void, ms: number) {
	const timers = new Map<K, ReturnType<typeof setTimeout>>()
	return (key: K) => {
		if (timers.has(key)) return
		timers.set(
			key,
			setTimeout(() => {
				timers.delete(key)
				fn(key)
			}, ms)
		)
	}
}
