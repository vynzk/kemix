import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import type { DownloadStatus, MatchStatus, SourceService } from '@kemix/core'
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

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
	return (
		<label className="block space-y-1">
			<span className="text-xs font-medium tracking-wide text-muted uppercase">{label}</span>
			{children}
			{hint && <span className="block text-xs text-zinc-500">{hint}</span>}
		</label>
	)
}

export function ServiceDot({ service, withLabel }: { service: SourceService; withLabel?: boolean }) {
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
	return <p className="text-sm whitespace-pre-wrap text-red-300">{error instanceof Error ? error.message : String(error)}</p>
}

export function PageHeader({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }) {
	return (
		<header className="flex flex-wrap items-end justify-between gap-4 border-b border-line px-8 pt-8 pb-5">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
				{children && <div className="mt-1 text-sm text-muted">{children}</div>}
			</div>
			{actions && <div className="flex items-center gap-2">{actions}</div>}
		</header>
	)
}
