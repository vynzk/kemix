import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './lib/api'
import { useLiveEvents } from './lib/events'
import { cx } from './lib/format'
import { PlayerBar } from './components/Player'
import { LibraryPage } from './pages/LibraryPage'
import { AccountsPage } from './pages/AccountsPage'
import { ReviewPage } from './pages/ReviewPage'
import { DownloadsPage } from './pages/DownloadsPage'
import { SettingsPage } from './pages/SettingsPage'
import { SearchPage } from './pages/SearchPage'
import { ExplorePage } from './pages/ExplorePage'
import { SpectrumPage, type SpectrumSource } from './pages/SpectrumPage'

type Page = 'library' | 'search' | 'explore' | 'review' | 'downloads' | 'spectrum' | 'accounts' | 'settings'

export function App() {
	const sync = useLiveEvents()
	const state = useQuery({ queryKey: ['state'], queryFn: api.state })
	const review = useQuery({ queryKey: ['review'], queryFn: api.review })
	const library = useQuery({ queryKey: ['library'], queryFn: api.library })

	const connected = state.data?.accounts.filter((a) => a.status === 'connected').length ?? 0
	const accountErrors = state.data?.accounts.filter((a) => a.status === 'error').length ?? 0
	const active = library.data?.playlists.reduce((n, p) => n + p.downloads.active, 0) ?? 0

	const [page, setPage] = useState<Page | null>(null)
	// Bumped to reopen the library straight on a playlist (e.g. one just created from Buscar).
	const [openPlaylist, setOpenPlaylist] = useState<{ id: number; nonce: number } | null>(null)
	// Lo último que se miró en Espectro: queda al ir y volver.
	const [spectrum, setSpectrum] = useState<SpectrumSource | null>(null)
	const showSpectrum = (downloadId: number, title: string) => {
		setSpectrum({ kind: 'download', id: downloadId, title })
		setPage('spectrum')
	}
	// First run: nothing connected → start on Accounts.
	const current: Page = page ?? (state.data && connected === 0 ? 'accounts' : 'library')

	const nav: { id: Page; label: string; badge?: number; alert?: boolean }[] = [
		{ id: 'library', label: 'Biblioteca' },
		{ id: 'search', label: 'Buscar' },
		{ id: 'explore', label: 'Explorar' },
		{ id: 'review', label: 'Revisión', badge: review.data?.length },
		{ id: 'downloads', label: 'Descargas', badge: active || undefined },
		{ id: 'spectrum', label: 'Espectro' },
		{ id: 'accounts', label: 'Cuentas', alert: accountErrors > 0 },
		{ id: 'settings', label: 'Ajustes' }
	]

	return (
		<div className="flex h-full">
			<nav className="flex w-52 shrink-0 flex-col border-r border-line bg-panel">
				<div className="px-5 pt-6 pb-8">
					<span className="text-lg font-bold tracking-tight">
						kemix<span className="text-accent">.</span>
					</span>
				</div>
				<ul className="space-y-0.5 px-2">
					{nav.map((item) => (
						<li key={item.id}>
							<button
								onClick={() => setPage(item.id)}
								className={cx(
									'flex w-full items-center justify-between rounded-md px-3 py-2 text-sm',
									current === item.id ? 'bg-zinc-800 text-zinc-50' : 'text-muted hover:text-zinc-100'
								)}
							>
								{item.label}
								{!!item.badge && (
									<span className="rounded-full bg-accent px-1.5 text-[11px] font-semibold text-ink">{item.badge}</span>
								)}
								{item.alert && <span className="h-2 w-2 rounded-full bg-red-400" />}
							</button>
						</li>
					))}
				</ul>
				<div className="mt-auto space-y-1 px-5 pb-5 text-xs text-muted">
					{sync.running && <p className="text-accent">{sync.message ?? 'Sincronizando…'}</p>}
					{!sync.running && sync.message && <p className="whitespace-pre-wrap">{sync.message}</p>}
					{sync.error && <p className="whitespace-pre-wrap text-red-300">{sync.error}</p>}
					<p>
						{connected} {connected === 1 ? 'cuenta conectada' : 'cuentas conectadas'}
					</p>
				</div>
			</nav>
			<div className="flex min-w-0 flex-1 flex-col">
				<main className="min-h-0 flex-1 overflow-y-auto">
					{current === 'library' && (
						<LibraryPage
							key={openPlaylist?.nonce ?? 0}
							initialPlaylist={openPlaylist?.id ?? null}
							syncing={sync.running}
							onGoToAccounts={() => setPage('accounts')}
							onSpectrum={showSpectrum}
						/>
					)}
					{current === 'search' && (
						<SearchPage
							onGoToAccounts={() => setPage('accounts')}
							onOpenPlaylist={(id) => {
								setOpenPlaylist({ id, nonce: Date.now() })
								setPage('library')
							}}
						/>
					)}
					{current === 'explore' && (
						<ExplorePage
							onOpenPlaylist={(id) => {
								setOpenPlaylist({ id, nonce: Date.now() })
								setPage('library')
							}}
						/>
					)}
					{current === 'review' && <ReviewPage />}
					{current === 'downloads' && <DownloadsPage onSpectrum={showSpectrum} />}
					{current === 'spectrum' && <SpectrumPage source={spectrum} onSource={setSpectrum} />}
					{current === 'accounts' && <AccountsPage />}
					{current === 'settings' && <SettingsPage />}
				</main>
				<PlayerBar />
			</div>
		</div>
	)
}
