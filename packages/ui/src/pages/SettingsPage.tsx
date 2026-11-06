import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Settings, TargetService } from '@kemix/core'
import { api } from '../lib/api'
import { SERVICE_LABEL } from '../lib/format'
import { Button, ErrorText, Field, Input, PageHeader } from '../components/ui'

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
	const swapPriority = () => set('servicePriority', [...draft.servicePriority].reverse() as TargetService[])

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
				<Field label="Prioridad de servicios de descarga" hint="Se busca primero en el de arriba. Qobuz descarga siempre la máxima calidad disponible.">
					<div className="flex items-center gap-3">
						<ol className="flex-1 space-y-1">
							{draft.servicePriority.map((s, i) => (
								<li key={s} className="rounded-md border border-line px-3 py-1.5 text-sm">
									{i + 1}. {SERVICE_LABEL[s]}
								</li>
							))}
						</ol>
						<Button type="button" onClick={swapPriority}>
							⇅ Invertir
						</Button>
					</div>
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
