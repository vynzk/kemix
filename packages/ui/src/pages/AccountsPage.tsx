import { useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AccountInfo, SourceService, YtMusicAccount } from '@kemix/core'
import { api } from '../lib/api'
import { SERVICE_COLOR, SERVICE_LABEL } from '../lib/format'
import { Button, ErrorText, Field, Input, PageHeader } from '../components/ui'

export function AccountsPage() {
	const state = useQuery({ queryKey: ['state'], queryFn: api.state })
	const accounts = new Map(state.data?.accounts.map((a) => [a.service, a]))
	const get = (s: SourceService): AccountInfo => accounts.get(s) ?? { service: s, status: 'disconnected' }

	return (
		<div>
			<PageHeader title="Cuentas">
				Qobuz y Deezer sirven para importar playlists <b>y</b> para descargar. Spotify y YouTube Music solo para importar.
			</PageHeader>
			<div className="grid gap-4 p-8 xl:grid-cols-2">
				<AccountCard account={get('qobuz')} role="Importar + descargar (FLAC hasta 24-bit)">
					<QobuzForm browserLogin={state.data?.browserLogin ?? false} />
				</AccountCard>
				<AccountCard account={get('deezer')} role="Importar + descargar (FLAC 16-bit)">
					<DeezerForm />
				</AccountCard>
				<AccountCard account={get('spotify')} role="Solo importar playlists">
					<SpotifyForm redirectUri={state.data?.spotifyRedirectUri ?? ''} clientId={state.data?.settings.spotifyClientId ?? ''} />
				</AccountCard>
				<AccountCard account={get('ytmusic')} role="Solo importar playlists (no oficial)" connectedExtra={<YtSwitchAccount />}>
					<YtMusicForm />
				</AccountCard>
			</div>
		</div>
	)
}

function AccountCard({
	account,
	role,
	connectedExtra,
	children
}: {
	account: AccountInfo
	role: string
	/** Extra controls shown while connected (e.g. switching Google account). */
	connectedExtra?: ReactNode
	children: ReactNode
}) {
	const qc = useQueryClient()
	const [editing, setEditing] = useState(false)
	const disconnect = useMutation({
		mutationFn: () => api.disconnect(account.service),
		onSettled: () => qc.invalidateQueries({ queryKey: ['state'] })
	})
	const connected = account.status === 'connected'
	const showForm = !connected || editing

	return (
		<section className="rounded-xl border border-line bg-panel p-5">
			<header className="flex items-start justify-between gap-4">
				<div>
					<h2 className="flex items-center gap-2 font-semibold">
						<span className="h-2.5 w-2.5 rounded-full" style={{ background: SERVICE_COLOR[account.service] }} />
						{SERVICE_LABEL[account.service]}
					</h2>
					<p className="mt-0.5 text-xs text-muted">{role}</p>
				</div>
				{connected ? (
					<div className="text-right">
						<span className="rounded bg-emerald-950 px-2 py-0.5 text-xs text-emerald-300">
							Conectado{account.displayName ? ` · ${account.displayName}` : ''}
						</span>
						<p className="mt-1 text-xs text-zinc-300 select-all">
							{account.email ?? (
								<span className="text-muted">
									{account.service === 'spotify' ? 'Correo no disponible: reconecta para verlo' : 'Correo no disponible'}
								</span>
							)}
						</p>
					</div>
				) : account.status === 'error' ? (
					<span className="rounded bg-red-950 px-2 py-0.5 text-xs text-red-300">Requiere atención</span>
				) : (
					<span className="text-xs text-muted">No conectado</span>
				)}
			</header>
			{account.status === 'error' && account.error && (
				<p className="mt-3 rounded-md bg-red-950/40 px-3 py-2 text-xs whitespace-pre-wrap text-red-300">{account.error}</p>
			)}
			{connected && (
				<div className="mt-4 flex gap-2">
					<Button variant="ghost" onClick={() => setEditing((e) => !e)}>
						{editing ? 'Cancelar' : 'Cambiar credenciales'}
					</Button>
					<Button variant="danger" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
						Desconectar
					</Button>
				</div>
			)}
			{connected && !editing && connectedExtra && <div className="mt-4">{connectedExtra}</div>}
			{showForm && <div className="mt-4">{children}</div>}
		</section>
	)
}

function useConnect<T>(fn: (input: T) => Promise<unknown>) {
	const qc = useQueryClient()
	return useMutation({
		mutationFn: fn,
		onSettled: () => qc.invalidateQueries({ queryKey: ['state'] })
	})
}

function QobuzForm({ browserLogin }: { browserLogin: boolean }) {
	const qc = useQueryClient()
	const inBrowser = useMutation({
		mutationFn: api.connectQobuzInBrowser,
		onSettled: () => qc.invalidateQueries({ queryKey: ['state'] })
	})
	const [showManual, setShowManual] = useState(!browserLogin)
	if (browserLogin && !showManual) {
		return (
			<div className="space-y-3">
				<p className="text-xs text-muted">
					Se abrirá play.qobuz.com en una ventana. Inicia sesión como siempre (con email y contraseña es lo más
					fiable; Google a veces bloquea su login dentro de apps). Kemix toma la sesión y cierra la ventana solo.
				</p>
				<ErrorText error={inBrowser.error} />
				<div className="flex items-center gap-3">
					<Button variant="primary" onClick={() => inBrowser.mutate()} disabled={inBrowser.isPending}>
						{inBrowser.isPending ? 'Esperando a que inicies sesión…' : 'Iniciar sesión en Qobuz'}
					</Button>
					<button type="button" className="text-xs text-muted underline" onClick={() => setShowManual(true)}>
						Otros métodos
					</button>
				</div>
			</div>
		)
	}
	return <QobuzManualForm onBack={browserLogin ? () => setShowManual(false) : undefined} />
}

function QobuzManualForm({ onBack }: { onBack?: () => void }) {
	const [mode, setMode] = useState<'password' | 'session'>('password')
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [session, setSession] = useState('')
	const [appId, setAppId] = useState('')
	const [appSecret, setAppSecret] = useState('')
	const [advanced, setAdvanced] = useState(false)
	const connect = useConnect(api.connectQobuz)
	const submit = (e: FormEvent) => {
		e.preventDefault()
		const app = { appId: appId || undefined, appSecret: appSecret || undefined }
		connect.mutate(mode === 'session' ? { session, ...app } : { email, password, ...app })
	}
	const ready = mode === 'session' ? session.trim().length >= 20 : !!email && !!password
	return (
		<form className="space-y-3" onSubmit={submit}>
			<div className="flex gap-1 rounded-md bg-ink p-1 text-xs">
				{(
					[
						['password', 'Email y contraseña'],
						['session', 'Sesión del navegador']
					] as const
				).map(([value, label]) => (
					<button
						key={value}
						type="button"
						onClick={() => setMode(value)}
						className={`flex-1 rounded px-2 py-1 ${mode === value ? 'bg-zinc-800 text-zinc-100' : 'text-muted hover:text-zinc-200'}`}
					>
						{label}
					</button>
				))}
			</div>
			{mode === 'password' ? (
				<>
					<Field label="Email">
						<Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
					</Field>
					<Field label="Contraseña">
						<Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
					</Field>
				</>
			) : (
				<>
					<ol className="list-decimal space-y-1 pl-5 text-xs text-muted">
						<li>
							Abre <b>play.qobuz.com</b> con tu sesión iniciada, pulsa <b>F12</b> y ve a la pestaña <b>Network</b> (Red).
						</li>
						<li>
							Recarga la página (F5) y escribe <code>api.json</code> en el filtro de arriba.
						</li>
						<li>
							Haz clic en cualquier petición de la lista → <b>Headers</b> → baja a <b>Request Headers</b> y busca{' '}
							<code>x-user-auth-token</code>.
						</li>
						<li>
							Copia su valor (o la petición entera con clic derecho → Copy → Copy as cURL) y pégalo aquí.
						</li>
					</ol>
					<Field label="Sesión de Qobuz">
						<textarea
							value={session}
							onChange={(e) => setSession(e.target.value)}
							rows={4}
							placeholder="Valor de x-user-auth-token, o la petición copiada como cURL"
							className="w-full rounded-md border border-line bg-ink px-3 py-1.5 font-mono text-xs focus:border-accent/60 focus:outline-none"
						/>
					</Field>
					<label className="inline-block cursor-pointer rounded-md border border-line px-3 py-1.5 text-sm hover:bg-zinc-800">
						Cargar archivo…
						<input
							type="file"
							accept=".txt,.json"
							className="hidden"
							onChange={async (e) => {
								const file = e.target.files?.[0]
								if (file) setSession(await file.text())
								e.target.value = ''
							}}
						/>
					</label>
				</>
			)}
			<div>
				<button type="button" className="text-xs text-muted underline" onClick={() => setAdvanced((a) => !a)}>
					{advanced ? 'Ocultar opciones avanzadas' : 'Opciones avanzadas'}
				</button>
			</div>
			{advanced && (
				<div className="space-y-3 rounded-md border border-line p-3">
					<Field label="App ID" hint="Vacío = se obtiene automáticamente de play.qobuz.com">
						<Input value={appId} onChange={(e) => setAppId(e.target.value)} />
					</Field>
					<Field label="App secret">
						<Input value={appSecret} onChange={(e) => setAppSecret(e.target.value)} />
					</Field>
				</div>
			)}
			<ErrorText error={connect.error} />
			<div className="flex items-center gap-3">
				<Button variant="primary" type="submit" disabled={connect.isPending || !ready}>
					{connect.isPending ? 'Conectando…' : 'Conectar Qobuz'}
				</Button>
				{onBack && (
					<button type="button" className="text-xs text-muted underline" onClick={onBack}>
						Volver a iniciar sesión en ventana
					</button>
				)}
			</div>
		</form>
	)
}

function DeezerForm() {
	const [arl, setArl] = useState('')
	const connect = useConnect(api.connectDeezer)
	return (
		<form
			className="space-y-3"
			onSubmit={(e) => {
				e.preventDefault()
				connect.mutate(arl)
			}}
		>
			<Field
				label="Cookie ARL"
				hint={
					<>
						Inicia sesión en deezer.com → DevTools (F12) → Application → Cookies → <code>arl</code>. Caduca cada pocos meses.
					</>
				}
			>
				<Input type="password" value={arl} onChange={(e) => setArl(e.target.value)} />
			</Field>
			<ErrorText error={connect.error} />
			<Button variant="primary" type="submit" disabled={connect.isPending || arl.trim().length < 50}>
				{connect.isPending ? 'Conectando…' : 'Conectar Deezer'}
			</Button>
		</form>
	)
}

function SpotifyForm({ redirectUri, clientId: savedClientId }: { redirectUri: string; clientId: string }) {
	const qc = useQueryClient()
	const [clientId, setClientId] = useState(savedClientId)
	const start = useMutation({
		mutationFn: async () => {
			if (clientId !== savedClientId) {
				await api.updateSettings({ spotifyClientId: clientId })
				await qc.invalidateQueries({ queryKey: ['state'] })
			}
			const { url } = await api.startSpotify()
			window.open(url, '_blank')
		}
	})
	return (
		<div className="space-y-3">
			<ol className="list-decimal space-y-1 pl-5 text-xs text-muted">
				<li>
					Crea una app en <span className="text-zinc-300">developer.spotify.com/dashboard</span> (tipo Web API).
				</li>
				<li>
					Añade este Redirect URI: <code className="text-zinc-300 select-all">{redirectUri}</code>
				</li>
				<li>Copia el Client ID aquí y pulsa Conectar; se abrirá el navegador para autorizar.</li>
			</ol>
			<Field label="Client ID">
				<Input value={clientId} onChange={(e) => setClientId(e.target.value.trim())} />
			</Field>
			<ErrorText error={start.error} />
			<Button variant="primary" onClick={() => start.mutate()} disabled={start.isPending || !clientId}>
				Conectar Spotify
			</Button>
		</div>
	)
}

function YtMusicForm() {
	const qc = useQueryClient()
	const [cookie, setCookie] = useState('')
	const [choices, setChoices] = useState<YtMusicAccount[] | null>(null)
	const connect = useMutation({
		mutationFn: api.connectYtMusic,
		onSuccess: (res) => setChoices(res.status === 'choose' ? res.accounts : null),
		onSettled: () => qc.invalidateQueries({ queryKey: ['state'] })
	})

	if (choices) {
		return (
			<AccountPicker
				accounts={choices}
				pending={connect.isPending}
				error={connect.error}
				onPick={(accountIndex) => connect.mutate({ cookie, accountIndex })}
				onCancel={() => setChoices(null)}
			/>
		)
	}

	return (
		<form
			className="space-y-3"
			onSubmit={(e) => {
				e.preventDefault()
				connect.mutate({ cookie })
			}}
		>
			<Field
				label="Cookies de music.youtube.com"
				hint="Con la sesión iniciada en music.youtube.com, exporta las cookies con una extensión (p. ej. Get cookies.txt) y carga el archivo, o pega su contenido. Si tienes varias cuentas de Google abiertas, podrás elegir cuál usar."
			>
				<textarea
					value={cookie}
					onChange={(e) => setCookie(e.target.value)}
					rows={3}
					placeholder="Pega aquí el contenido de cookies.txt o el header cookie"
					className="w-full rounded-md border border-line bg-ink px-3 py-1.5 font-mono text-xs focus:border-accent/60 focus:outline-none"
				/>
			</Field>
			<ErrorText error={connect.error} />
			<div className="flex items-center gap-2">
				<Button variant="primary" type="submit" disabled={connect.isPending || cookie.trim().length < 20}>
					{connect.isPending ? 'Conectando…' : 'Conectar YouTube Music'}
				</Button>
				<label className="cursor-pointer rounded-md border border-line px-3 py-1.5 text-sm hover:bg-zinc-800">
					Cargar archivo…
					<input
						type="file"
						accept=".txt,.json"
						className="hidden"
						onChange={async (e) => {
							const file = e.target.files?.[0]
							if (file) setCookie(await file.text())
							e.target.value = ''
						}}
					/>
				</label>
			</div>
		</form>
	)
}

/** Switch to another Google account covered by the stored cookies, without exporting them again. */
function YtSwitchAccount() {
	const qc = useQueryClient()
	const [choices, setChoices] = useState<YtMusicAccount[] | null>(null)
	const connect = useMutation({
		mutationFn: api.connectYtMusic,
		onSuccess: (res) => setChoices(res.status === 'choose' ? res.accounts : null),
		onSettled: () => qc.invalidateQueries({ queryKey: ['state'] })
	})
	if (choices) {
		return (
			<AccountPicker
				accounts={choices}
				pending={connect.isPending}
				error={connect.error}
				onPick={(accountIndex) => connect.mutate({ accountIndex })}
				onCancel={() => setChoices(null)}
			/>
		)
	}
	return (
		<div className="space-y-2">
			<Button variant="ghost" onClick={() => connect.mutate({})} disabled={connect.isPending}>
				{connect.isPending ? 'Buscando cuentas…' : 'Cambiar de cuenta de Google'}
			</Button>
			<ErrorText error={connect.error} />
		</div>
	)
}

function AccountPicker({
	accounts,
	pending,
	error,
	onPick,
	onCancel
}: {
	accounts: YtMusicAccount[]
	pending: boolean
	error: unknown
	onPick: (index: number) => void
	onCancel: () => void
}) {
	return (
		<div className="space-y-3">
			<p className="text-sm">
				{accounts.length > 1
					? 'Estas cookies tienen varias cuentas de Google. ¿Cuál quieres usar?'
					: 'Solo hay una cuenta de Google en estas cookies.'}
			</p>
			<ul className="space-y-1">
				{accounts.map((a) => (
					<li key={a.index}>
						<button
							disabled={pending}
							onClick={() => onPick(a.index)}
							className="flex w-full items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-left hover:border-accent/60 hover:bg-zinc-900 disabled:opacity-50"
						>
							<span className="min-w-0">
								<span className="block truncate text-sm">{a.name}</span>
								<span className="block truncate text-xs text-muted">{a.email ?? 'Correo no disponible'}</span>
							</span>
							<span className="text-xs text-muted">Usar</span>
						</button>
					</li>
				))}
			</ul>
			<ErrorText error={error} />
			<Button variant="ghost" onClick={onCancel} disabled={pending}>
				Cancelar
			</Button>
		</div>
	)
}
