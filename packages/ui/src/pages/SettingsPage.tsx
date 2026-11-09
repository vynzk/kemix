import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DownloadService, Settings } from '@kemix/core'
import { api } from '../lib/api'
import { QUALITY_LEVEL_OPTIONS, SERVICE_LABEL } from '../lib/format'
import { Button, ErrorText, Field, Input, PageHeader } from '../components/ui'

/** Everything that can download; the UI keeps @kemix/core type-only, so the list lives here too. */
const ALL_DOWNLOADERS: DownloadService[] = ['qobuz', 'deezer', 'youtube']

export function SettingsPage() {
	const qc = useQueryClient()
	const state = useQuery({ queryKey: ['state'], queryFn: api.state })
	const [draft, setDraft] = useState<Settings | null>(null)
	useEffect(() => {
		if (state.data && !draft) setDraft(state.data.settings)
	}, [state.data, draft])
	const save = useMutation({
		mutationFn: (s: Settings) => api.updateSettings(s),
		onSuccess: (s) => {
			setDraft(s)
			qc.invalidateQueries({ queryKey: ['state'] })
		}
	})
	if (!draft) return null

	const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft({ ...draft, [key]: value })
	const priority = draft.servicePriority
	const disabled = ALL_DOWNLOADERS.filter((s) => !priority.includes(s))
	const move = (i: number, by: -1 | 1) => {
		const next = [...priority]
		;[next[i], next[i + by]] = [next[i + by]!, next[i]!]
		set('servicePriority', next)
	}
	const toggle = (s: DownloadService) =>
		set('servicePriority', priority.includes(s) ? priority.filter((x) => x !== s) : [...priority, s])

	return (
		<div>
			<PageHeader title="Ajustes" />
			<form
				className="max-w-xl space-y-6 p-8"
				onSubmit={(e) => {
					e.preventDefault()
					save.mutate(draft)
				}}
			>
				<Field label="Carpeta de descargas" hint="Cada playlist se guarda en su propia subcarpeta, con un .m3u8.">
					<Input value={draft.downloadDir} onChange={(e) => set('downloadDir', e.target.value)} />
				</Field>
				<Field
					label="Prioridad de servicios de descarga"
					hint="En modo automático se busca primero en el de arriba. YouTube (YT Music) es con pérdida (AAC ~128 kbps) y solo se usa si lo activas."
				>
					<ol className="space-y-1">
						{priority.map((s, i) => (
							<li key={s} className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-sm">
								<span className="flex-1">
									{i + 1}. {SERVICE_LABEL[s]}
									{s === 'youtube' && <span className="ml-1 text-xs text-amber-300/80">con pérdida</span>}
								</span>
								<Button type="button" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Subir">
									↑
								</Button>
								<Button
									type="button"
									variant="ghost"
									onClick={() => move(i, 1)}
									disabled={i === priority.length - 1}
									aria-label="Bajar"
								>
									↓
								</Button>
								<Button type="button" variant="ghost" onClick={() => toggle(s)} disabled={priority.length === 1}>
									Quitar
								</Button>
							</li>
						))}
						{disabled.map((s) => (
							<li
								key={s}
								className="flex items-center gap-2 rounded-md border border-dashed border-line px-3 py-1.5 text-sm text-muted"
							>
								<span className="flex-1">{SERVICE_LABEL[s]} (desactivado)</span>
								<Button type="button" variant="ghost" onClick={() => toggle(s)}>
									Añadir
								</Button>
							</li>
						))}
					</ol>
				</Field>
				<Field
					label="Calidad de descarga"
					hint={`${QUALITY_LEVEL_OPTIONS.find((o) => o.value === draft.downloadQuality)?.hint ?? ''} Si un tema no existe en esa calidad, se baja en la mejor que tenga por debajo. Cada playlist puede elegir otra al descargar. YouTube siempre es AAC ~128 kbps.`}
				>
					<select
						value={draft.downloadQuality}
						onChange={(e) => set('downloadQuality', e.target.value as Settings['downloadQuality'])}
						className="w-full rounded-md border border-line bg-ink px-3 py-2 text-sm"
					>
						{QUALITY_LEVEL_OPTIONS.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
				</Field>
				<Field label="Descargas simultáneas">
					<Input
						type="number"
						min={1}
						max={8}
						value={draft.concurrency}
						onChange={(e) => set('concurrency', Number(e.target.value))}
					/>
				</Field>
				<Field
					label={`Umbral de aceptación automática: ${Math.round(draft.autoAcceptThreshold * 100)}%`}
					hint="Coincidencias por debajo de este valor van a Revisión. Las coincidencias por ISRC se aceptan siempre."
				>
					<input
						type="range"
						min={0.5}
						max={1}
						step={0.01}
						value={draft.autoAcceptThreshold}
						onChange={(e) => set('autoAcceptThreshold', Number(e.target.value))}
						className="w-full accent-[var(--color-accent)]"
					/>
				</Field>
				<Field label="Puerto local" hint="Usado por la redirección OAuth de Spotify. Requiere reiniciar la app.">
					<Input type="number" value={draft.port} onChange={(e) => set('port', Number(e.target.value))} />
				</Field>
				<Field
					label="Ruta de yt-dlp (opcional)"
					hint="Solo para bajar desde YouTube los temas que no están en Qobuz/Deezer. Vacío: Kemix baja y mantiene al día su propia copia de yt-dlp la primera vez que la necesita."
				>
					<Input
						placeholder="C:\ruta\a\yt-dlp.exe"
						value={draft.ytDlpPath ?? ''}
						onChange={(e) => set('ytDlpPath', e.target.value)}
					/>
				</Field>
				<ErrorText error={save.error} />
				<div className="flex items-center gap-3">
					<Button variant="primary" type="submit" disabled={save.isPending}>
						Guardar
					</Button>
					{save.isSuccess && <span className="text-sm text-emerald-300">Guardado</span>}
				</div>
			</form>
		</div>
	)
}
