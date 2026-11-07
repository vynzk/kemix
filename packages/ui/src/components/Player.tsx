import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SourceService, SourceTrack, TrackPreview } from '@kemix/core'
import { api } from '../lib/api'
import { SERVICE_LABEL } from '../lib/format'
import { Button } from './ui'

interface Playing {
	/** What was asked to play: a library track, a search result or a specific video. */
	key: string
	/** Library track (looked up on its service, then YouTube). */
	trackId?: number
	title: string
	artists: string[]
	state: 'loading' | 'ready' | 'notfound' | 'error'
	media?: TrackPreview
	error?: string
}

interface PlayerApi {
	playing: Playing | null
	playTrack(track: { trackId: number; title: string; artists: string[] }): void
	/** A search result from `service`: its own audio when possible, else looked up on YouTube. */
	playSourceTrack(service: SourceService, track: SourceTrack): void
	playVideo(video: { videoId: string; title: string; artists: string[] }): void
	stop(): void
}

const PlayerContext = createContext<PlayerApi | null>(null)

export function usePlayer(): PlayerApi {
	const ctx = useContext(PlayerContext)
	if (!ctx) throw new Error('usePlayer fuera de PlayerProvider')
	return ctx
}

export function PlayerProvider({ children }: { children: ReactNode }) {
	const [playing, setPlaying] = useState<Playing | null>(null)

	const lookUp = useCallback(
		(key: string, info: { trackId?: number; title: string; artists: string[] }, find: () => Promise<{ preview: TrackPreview | null }>) => {
			setPlaying({ key, ...info, state: 'loading' })
			// Ignore a slow answer if the user already moved on to another track.
			const isCurrent = (p: Playing | null) => p?.key === key && p.state === 'loading'
			find()
				.then(({ preview }) =>
					setPlaying((p) =>
						!isCurrent(p) ? p : preview ? { ...p!, state: 'ready', media: preview } : { ...p!, state: 'notfound' }
					)
				)
				.catch((err: Error) => setPlaying((p) => (isCurrent(p) ? { ...p!, state: 'error', error: err.message } : p)))
		},
		[]
	)

	const playTrack = useCallback(
		(t: { trackId: number; title: string; artists: string[] }) => lookUp(`track:${t.trackId}`, t, () => api.preview(t.trackId)),
		[lookUp]
	)

	const playSourceTrack = useCallback(
		(service: SourceService, t: SourceTrack) =>
			service === 'ytmusic'
				? setPlaying({
						key: `${service}:${t.sourceId}`,
						title: t.title,
						artists: t.artists,
						state: 'ready',
						media: { kind: 'youtube', videoId: t.sourceId, title: t.title }
					})
				: lookUp(`${service}:${t.sourceId}`, { title: t.title, artists: t.artists }, () => api.previewTrack(service, t)),
		[lookUp]
	)

	const playVideo = useCallback((v: { videoId: string; title: string; artists: string[] }) => {
		setPlaying({
			key: `video:${v.videoId}`,
			title: v.title,
			artists: v.artists,
			state: 'ready',
			media: { kind: 'youtube', videoId: v.videoId, title: v.title }
		})
	}, [])

	const stop = useCallback(() => setPlaying(null), [])
	const value = useMemo(
		() => ({ playing, playTrack, playSourceTrack, playVideo, stop }),
		[playing, playTrack, playSourceTrack, playVideo, stop]
	)
	return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
}

function fmtTime(s: number): string {
	const t = Math.max(0, Math.floor(s))
	return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

interface Time {
	current: number
	duration: number
	paused: boolean
}

/** Play/pause and seek for whichever element is playing. */
interface Transport {
	toggle(paused: boolean): void
	seek(seconds: number): void
}

/** Bottom bar: the service's own audio, or YouTube's embedded player. Shown only while something is playing. */
export function PlayerBar() {
	const { playing, stop } = usePlayer()
	const frame = useRef<HTMLIFrameElement>(null)
	const audio = useRef<HTMLAudioElement>(null)
	const [time, setTime] = useState<Time>({ current: 0, duration: 0, paused: false })
	const [seeking, setSeeking] = useState<number | null>(null)
	const media = playing?.state === 'ready' ? playing.media : undefined
	const videoId = media?.kind === 'youtube' ? media.videoId : undefined
	const streamUrl = media?.kind === 'stream' ? media.url : undefined

	useEffect(() => {
		setTime({ current: 0, duration: 0, paused: false })
		setSeeking(null)
	}, [videoId, streamUrl])

	// YouTube's iframe API reports progress through postMessage once we say we're listening.
	useEffect(() => {
		if (!videoId) return
		const onMessage = (e: MessageEvent) => {
			if (e.source !== frame.current?.contentWindow || typeof e.data !== 'string') return
			let msg: { event?: string; info?: { currentTime?: number; duration?: number; playerState?: number } }
			try {
				msg = JSON.parse(e.data)
			} catch {
				return
			}
			const info = msg.info
			if (!info || (msg.event !== 'infoDelivery' && msg.event !== 'initialDelivery')) return
			setTime((t) => ({
				current: info.currentTime ?? t.current,
				duration: info.duration || t.duration,
				paused: info.playerState === undefined ? t.paused : info.playerState === 2 || info.playerState === 0
			}))
		}
		window.addEventListener('message', onMessage)
		return () => window.removeEventListener('message', onMessage)
	}, [videoId])

	const sendYouTube = (func: string, args: unknown[] = []) =>
		frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), '*')
	const transport: Transport = streamUrl
		? {
				toggle: (paused) => void (paused ? audio.current?.play() : audio.current?.pause()),
				seek: (s) => {
					if (audio.current) audio.current.currentTime = s
				}
			}
		: {
				toggle: (paused) => sendYouTube(paused ? 'playVideo' : 'pauseVideo'),
				seek: (s) => sendYouTube('seekTo', [s, true])
			}
	const commitSeek = () => {
		if (seeking === null) return
		transport.seek(seeking)
		setTime((t) => ({ ...t, current: seeking }))
		setSeeking(null)
	}
	const fromAudio = (el: HTMLAudioElement) =>
		setTime({ current: el.currentTime, duration: Number.isFinite(el.duration) ? el.duration : 0, paused: el.paused })

	if (!playing) return null
	return (
		<div className="flex items-start gap-3 border-t border-line bg-panel px-4 py-2">
			{media?.kind !== 'stream' && (
				<div className="h-20 w-36 shrink-0 overflow-hidden rounded bg-ink">
					{videoId && (
						<iframe
							key={videoId}
							ref={frame}
							title="Reproductor de YouTube"
							className="h-full w-full"
							onLoad={() =>
								frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*')
							}
							src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&controls=0&rel=0&modestbranding=1&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`}
							allow="autoplay; encrypted-media; picture-in-picture"
							referrerPolicy="strict-origin-when-cross-origin"
							allowFullScreen
						/>
					)}
				</div>
			)}
			{streamUrl && (
				<audio
					key={streamUrl}
					ref={audio}
					src={streamUrl}
					autoPlay
					onTimeUpdate={(e) => fromAudio(e.currentTarget)}
					onLoadedMetadata={(e) => fromAudio(e.currentTarget)}
					onPlay={(e) => fromAudio(e.currentTarget)}
					onPause={(e) => fromAudio(e.currentTarget)}
					onEnded={(e) => fromAudio(e.currentTarget)}
				/>
			)}
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium">{playing.title}</p>
				<p className="truncate text-xs text-muted">{playing.artists.join(', ')}</p>
				<p className="line-clamp-2 text-xs text-zinc-500">
					{playing.state === 'loading' && 'Buscando el audio…'}
					{playing.state === 'notfound' && 'No encontré audio para este tema (ni en su servicio ni en YouTube).'}
					{playing.state === 'error' && <span className="text-red-300">{playing.error}</span>}
					{media?.kind === 'youtube' && `YouTube: ${media.title}`}
					{media?.kind === 'stream' &&
						`${SERVICE_LABEL[media.service]}${media.full ? '' : ' · vista previa de 30 s (no está en YouTube)'}`}
				</p>
				{media && (
					<div className="mt-1 flex items-center gap-2 text-[11px] text-muted tabular-nums">
						<button
							type="button"
							onClick={() => transport.toggle(time.paused)}
							title={time.paused ? 'Reproducir' : 'Pausar'}
							className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] text-zinc-200 hover:bg-accent hover:text-ink"
						>
							{time.paused ? '▶' : '❚❚'}
						</button>
						<span className="w-9 text-right">{fmtTime(seeking ?? time.current)}</span>
						<input
							type="range"
							aria-label="Posición"
							min={0}
							max={time.duration || 1}
							step={1}
							disabled={!time.duration}
							value={Math.min(seeking ?? time.current, time.duration || 1)}
							onChange={(e) => setSeeking(Number(e.target.value))}
							onPointerUp={commitSeek}
							onKeyUp={commitSeek}
							className="min-w-0 flex-1 accent-[var(--color-accent)]"
						/>
						<span className="w-9">{fmtTime(time.duration)}</span>
					</div>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-3 whitespace-nowrap">
				{videoId && (
					<a className="text-xs text-muted hover:text-zinc-100" href={`https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noreferrer">
						Abrir ↗
					</a>
				)}
				<Button variant="ghost" onClick={stop} title="Cerrar reproductor">
					✕
				</Button>
			</div>
		</div>
	)
}

/** Small round play button for track rows. */
export function PlayButton({ onClick, active }: { onClick: () => void; active?: boolean }) {
	return (
		<button
			type="button"
			onClick={onClick}
			title="Escuchar"
			className={
				'inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] transition-colors ' +
				(active ? 'bg-accent text-ink' : 'bg-zinc-800 text-zinc-200 hover:bg-accent hover:text-ink')
			}
		>
			▶
		</button>
	)
}
