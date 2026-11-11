import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { DownloadService } from '@kemix/core'
import { api } from '../lib/api'
import { useDownloadProviders, useDownloadQualities } from '../lib/hooks'
import {
	LOSSY_TAG,
	SERVICE_LABEL,
	findPreset,
	fitPreset,
	groupPresets,
	isLossy,
	presetKey,
	presetOptions,
	type DownloadPreset
} from '../lib/format'

/**
 * Desde dónde, y en qué calidad y formato, bajar: lo mismo en una playlist, en Buscar, en la pestaña de Soulseek y en
 * Explorar. Con `fixed` el proveedor no se elige (Soulseek, SoundCloud): solo la calidad y el formato.
 */
export function useDownloadChoice(fixed?: DownloadService) {
	const state = useQuery({ queryKey: ['state'], queryFn: api.state })
	const providers = useDownloadProviders()
	const accountQualities = useDownloadQualities().data
	/** '' = automático, en el orden de prioridad de Ajustes. */
	const [picked, setProvider] = useState<DownloadService | ''>('')
	/** null = sin tocar: la calidad y el formato de Ajustes. */
	const [presetPick, setPresetPick] = useState<DownloadPreset | null>(null)
	const settings = state.data?.settings
	const provider: DownloadService | '' = fixed ?? picked
	const wanted = presetPick ?? findPreset(settings?.downloadQuality ?? 'max', settings?.outputFormat ?? 'original')
	/** Con un proveedor elegido, solo lo que da él (y la cuenta en él); la elección se guarda para «Automático». */
	const presetFor = (s: DownloadService) => fitPreset(s, wanted, accountQualities?.[s])
	const preset = provider ? presetFor(provider) : wanted
	const options = presetOptions(provider || undefined, provider ? accountQualities?.[provider] : undefined)
	return {
		provider,
		setProvider,
		providers,
		preset,
		setPresetPick,
		presetFor,
		options,
		accountQualities,
		fixed: !!fixed,
		/** Lo que se manda al servidor al bajar. */
		request: { provider: provider || null, quality: preset.level, format: preset.format }
	}
}

export type DownloadChoice = ReturnType<typeof useDownloadChoice>

export function Control({ label, children }: { label: string; children: ReactNode }) {
	return (
		<label className="flex flex-col gap-1">
			<span className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</span>
			{children}
		</label>
	)
}

/** Los selects «Descargar desde» (salvo con proveedor fijo) y «Calidad y formato». */
export function DownloadPicker({ choice }: { choice: DownloadChoice }) {
	const { provider, providers, preset, options, accountQualities } = choice
	return (
		<>
			{!choice.fixed && (
				<Control label="Descargar desde">
					<select
						value={provider}
						onChange={(e) => choice.setProvider(e.target.value as DownloadService | '')}
						className="rounded-md border border-line bg-ink px-2 py-1.5 text-sm"
						title="Servicio del que se bajan los temas. Automático: el primero que lo tenga, en el orden de Ajustes."
					>
						<option value="">Automático</option>
						{providers.map((s) => (
							<option key={s} value={s}>
								{SERVICE_LABEL[s]}
								{isLossy(s) ? ` (${LOSSY_TAG[s]})` : ''}
							</option>
						))}
					</select>
				</Control>
			)}
			<Control label="Calidad y formato">
				<select
					value={presetKey(preset)}
					onChange={(e) => choice.setPresetPick(options.find((o) => presetKey(o) === e.target.value) ?? null)}
					className="rounded-md border border-line bg-ink px-2 py-1.5 text-sm"
					title={`${provider ? `Lo que da ${SERVICE_LABEL[provider]}${!isLossy(provider) && accountQualities?.[provider] ? ' con tu cuenta' : ''}. ` : ''}Calidad máxima a bajar y formato del archivo. Si un tema no llega a esa calidad, se baja en la mejor que tenga. AIFF, WAV y MP3 se convierten al terminar de bajar, con tags y carátula. No cambia los temas ya descargados.`}
				>
					{groupPresets(options).map(([group, list]) => (
						<optgroup key={group} label={group}>
							{list.map((o) => (
								<option key={presetKey(o)} value={presetKey(o)}>
									{o.label}
								</option>
							))}
						</optgroup>
					))}
				</select>
			</Control>
		</>
	)
}
