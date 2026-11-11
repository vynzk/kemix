import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'
import type { AccountService, DownloadStatus, FreeDownload, MatchStatus } from '@kemix/core'
import { SERVICE_COLOR, SERVICE_LABEL, cx } from '../lib/format'

export function Button({
	variant = 'default',
	className,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' | 'danger' }) {
	return (
		<button
			{...props}
			className={cx(
				'inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
				'disabled:cursor-not-allowed disabled:opacity-40',
				variant === 'primary' && 'bg-accent text-ink hover:brightness-110',
				variant === 'default' && 'border border-line bg-panel hover:bg-zinc-800',
				variant === 'ghost' && 'text-muted hover:bg-zinc-800 hover:text-zinc-100',
				variant === 'danger' && 'border border-red-900/60 text-red-300 hover:bg-red-950/50',
				className
			)}
		/>
	)
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
	return (
		<input
			{...props}
			className={cx(
				'w-full rounded-md border border-line bg-ink px-3 py-1.5 text-sm placeholder:text-zinc-600',
				'focus:border-accent/60 focus:outline-none',
				className
			)}
		/>
	)
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
	return (
		<select
			{...props}
			className={cx('max-w-full rounded-md border border-line bg-ink px-2 py-1.5 text-sm focus:border-accent/60 focus:outline-none', className)}
		/>
	)
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
	return (
		<label className="block space-y-1">
			<span className="text-xs font-medium tracking-wide text-muted uppercase">{label}</span>
			{children}
			{hint && <span className="block text-xs text-zinc-500">{hint}</span>}
		</label>
	)
}

/**
 * Un tema de SoundCloud que se baja gratis: enlace a su descarga, que se abre en el navegador. No se muestra calidad:
 * no se sabe hasta bajarlo.
 */
export function FreeDownloadLink({ fd, className }: { fd: FreeDownload; className?: string }) {
	return (
		<a
			href={fd.url}
			target="_blank"
			rel="noreferrer"
			onClick={(e) => e.stopPropagation()}
			title={
				fd.kind === 'soundcloud'
					? 'SoundCloud deja bajar el archivo que subió el artista: ábrelo y usa «Descargar archivo». Kemix también lo baja. La calidad se sabe al bajarlo.'
					: 'El artista dejó un enlace de descarga gratis (puede pedir seguirlo, un like o un email). Kemix no puede bajar desde ahí: ábrelo en el navegador.'
			}
			className={cx(
				'inline-flex items-center gap-1 rounded bg-emerald-950 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-emerald-300 hover:bg-emerald-900',
				className
			)}
		>
			⬇ Descarga gratis ↗
		</a>
	)
}

export function ServiceDot({ service, withLabel }: { service: AccountService | 'local'; withLabel?: boolean }) {
	return (
		<span className="inline-flex items-center gap-1.5 text-xs text-muted">
			<span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SERVICE_COLOR[service] }} />
			{withLabel && SERVICE_LABEL[service]}
		</span>
	)
}

const STATUS: Record<DownloadStatus, { label: string; cls: string }> = {
	queued: { label: 'En cola', cls: 'text-zinc-400 bg-zinc-800' },
	matching: { label: 'Buscando', cls: 'text-sky-300 bg-sky-950' },
	downloading: { label: 'Bajando', cls: 'text-accent bg-lime-950' },
	done: { label: 'Listo', cls: 'text-emerald-300 bg-emerald-950' },
	needs_review: { label: 'Revisar', cls: 'text-amber-300 bg-amber-950' },
	error: { label: 'Error', cls: 'text-red-300 bg-red-950' },
	skipped: { label: 'Omitido', cls: 'text-zinc-500 bg-zinc-900' }
}

export function StatusPill({ status, title }: { status: DownloadStatus; title?: string }) {
	const s = STATUS[status]
	return (
		<span title={title} className={cx('rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap', s.cls)}>
			{s.label}
		</span>
	)
}

/**
 * Deletes a download. A finished one also deletes its file, so that asks for a second click.
 * `onHover`: hidden until the surrounding `group` row is hovered (it stays visible while asking to confirm).
 */
export function RemoveDownloadButton({
	status,
	pending,
	onRemove,
	onHover
}: {
	status: DownloadStatus
	pending: boolean
	onRemove: () => void
	onHover?: boolean
}) {
	const [confirming, setConfirming] = useState(false)
	useEffect(() => {
		if (!confirming) return
		const t = setTimeout(() => setConfirming(false), 4000)
		return () => clearTimeout(t)
	}, [confirming])

	const hasFile = status === 'done'
	const title = hasFile
		? 'Borra el archivo del disco y lo quita de la lista de descargas'
		: ['queued', 'matching', 'downloading'].includes(status)
			? 'Detiene la descarga y la quita de la lista'
			: 'La quita de la lista de descargas'
	return (
		<button
			title={title}
			disabled={pending}
			onClick={() => {
				if (hasFile && !confirming) return setConfirming(true)
				setConfirming(false)
				onRemove()
			}}
			className={cx(
				'rounded px-1.5 py-0.5 text-xs whitespace-nowrap transition-colors disabled:opacity-40',
				confirming ? 'bg-red-950 font-medium text-red-300' : 'text-zinc-500 hover:bg-zinc-800 hover:text-red-300',
				onHover && !confirming && !pending && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
			)}
		>
			{pending ? 'Eliminando…' : confirming ? '¿Borrar archivo?' : 'Eliminar'}
		</button>
	)
}

const MATCH_LABEL: Record<MatchStatus, string> = {
	auto: 'Auto',
	accepted: 'Elegido',
	pending: 'Dudoso',
	notfound: 'No encontrado',
	skipped: 'Omitido'
}

export function MatchLabel({ status, confidence }: { status: MatchStatus; confidence: number | null }) {
	return (
		<span className="text-xs text-muted">
			{MATCH_LABEL[status]}
			{confidence !== null && status !== 'skipped' && ` · ${Math.round(confidence * 100)}%`}
		</span>
	)
}

export function Cover({ url, size = 40, className }: { url?: string | null; size?: number; className?: string }) {
	return url ? (
		<img
			src={url}
			alt=""
			loading="lazy"
			referrerPolicy="no-referrer"
			className={cx('shrink-0 rounded object-cover', className)}
			style={{ width: size, height: size }}
		/>
	) : (
		<div className={cx('shrink-0 rounded bg-zinc-800', className)} style={{ width: size, height: size }} />
	)
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
	return (
		<div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
			<p className="font-medium">{title}</p>
			{children && <div className="max-w-md text-sm text-muted">{children}</div>}
		</div>
	)
}

export function ErrorText({ error }: { error: unknown }) {
	if (!error) return null
	// Errors often carry URLs or tokens with no spaces: let them wrap instead of widening the page.
	return (
		<p className="text-sm whitespace-pre-wrap wrap-anywhere text-red-300">
			{error instanceof Error ? error.message : String(error)}
		</p>
	)
}

export function PageHeader({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }) {
	return (
		<header className="flex flex-wrap items-end justify-between gap-4 border-b border-line px-8 pt-8 pb-5">
			<div className="min-w-0">
				<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
				{children && <div className="mt-1 text-sm text-muted">{children}</div>}
			</div>
			{actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
		</header>
	)
}
