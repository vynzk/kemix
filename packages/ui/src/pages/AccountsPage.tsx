import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AccountInfo, AudioQuality, DownloadService, SourceService, TargetService, YtMusicAccount } from '@kemix/core'
import { api } from '../lib/api'
import { useDownloadQualities } from '../lib/hooks'
import { SERVICE_COLOR, SERVICE_LABEL, cx, qualityLabel, qualityTone } from '../lib/format'
import { Button, ErrorText, Field, Input, PageHeader } from '../components/ui'

export function AccountsPage() {
	const state = useQuery({ queryKey: ['state'], queryFn: api.state })
	const accounts = new Map(state.data?.accounts.map((a) => [a.service, a]))
	const get = (s: SourceService): AccountInfo => accounts.get(s) ?? { service: s, status: 'disconnected' }
	const qualities = useDownloadQualities()
	const priority = state.data?.settings.servicePriority ?? []
	const download = (service: TargetService) => (
		<DownloadQuality
			service={service}
			connected={get(service).status === 'connected'}
			quality={qualities.data?.[service]}
			loading={qualities.isLoading}
			isDefault={priority[0] === service}
			priority={priority}
		/>
	)

	return (
		<div>
			<PageHeader title="Cuentas">
				Qobuz y Deezer sirven para importar playlists <b>y</b> para descargar. Spotify y YouTube Music importan playlists.
				SoundCloud importa tus playlists y Me gusta, y junto con YouTube sirve de respaldo para descargar lo que no está
				en Qobuz ni Deezer.
			</PageHeader>
			<div className="px-8 pt-8">
				<AccountsGuide connected={(s) => get(s).status === 'connected'} />
			</div>
			<div className="grid grid-cols-1 gap-4 p-8 xl:grid-cols-2">
				<AccountCard account={get('qobuz')} role="Importar + descargar" download={download('qobuz')}>
					<QobuzForm browserLogin={state.data?.browserLogin ?? false} />
				</AccountCard>
				<AccountCard account={get('deezer')} role="Importar + descargar" download={download('deezer')} beta>
					<DeezerForm />
				</AccountCard>
				<AccountCard
					account={get('spotify')}
					role="Importar playlists y crear nuevas"
					download={
						<div className="space-y-1.5 text-xs text-muted">
							<p>
								No descarga audio: sus temas se bajan desde Qobuz o Deezer y, si no están ahí, desde YouTube o
								SoundCloud cuando lo pides.
							</p>
							<p className="rounded-md bg-ink/50 px-2.5 py-1.5">
								<b className="text-zinc-300">Spotify Premium no cambia la calidad:</b> Kemix solo usa Spotify para leer y
								crear playlists. La calidad depende de la cuenta desde la que se baja cada tema: tu plan de Qobuz o
								Deezer, o YouTube Music Premium para el respaldo de YouTube.
							</p>
						</div>
					}
				>
					<SpotifyForm
						browserLogin={state.data?.browserLogin ?? false}
						redirectUri={state.data?.spotifyRedirectUri ?? ''}
						clientId={state.data?.settings.spotifyClientId ?? ''}
					/>
				</AccountCard>
				<AccountCard
					account={get('ytmusic')}
					role="Importar playlists (no oficial) + respaldo de descarga"
					connectedExtra={<YtSwitchAccount />}
					download={
						<div className="space-y-1.5 text-xs text-muted">
							<p>
								Descarga desde YouTube hasta{' '}
								<span className={qualityTone(qualities.data?.youtube ?? null)}>
									{qualities.data?.youtube ? qualityLabel(qualities.data.youtube) : 'AAC ~128 kbps'}
								</span>{' '}
								(con pérdida). Solo como respaldo y cuando lo pides; funciona sin esta cuenta.
							</p>
							<YtPremiumNote
								connected={get('ytmusic').status === 'connected'}
								premium={(qualities.data?.youtube?.bitrateKbps ?? 0) >= 256}
							/>
						</div>
					}
				>
					<YtMusicForm />
				</AccountCard>
				<AccountCard
					account={get('soundcloud')}
					role="Importar playlists y Me gusta + descargar"
					download={
						<SoundCloudDownloadNote
							connected={get('soundcloud').status === 'connected'}
							quality={qualities.data?.soundcloud}
						/>
					}
				>
					<SoundCloudForm browserLogin={state.data?.browserLogin ?? false} />
				</AccountCard>
				<ComingSoonCard name="Tidal" color="#e4e4e7" />
				<ComingSoonCard name="Soundeo" color="#f5a623" />
			</div>
		</div>
	)
}

/** The services, by what connecting them gives. */
const GUIDE: { service: SourceService; imports: boolean; downloads: string | null }[] = [
	{ service: 'qobuz', imports: true, downloads: 'FLAC hasta 24-bit/192 kHz' },
	{ service: 'deezer', imports: true, downloads: 'FLAC o MP3, según tu plan' },
	{ service: 'spotify', imports: true, downloads: null },
	{ service: 'ytmusic', imports: true, downloads: null },
	{ service: 'soundcloud', imports: true, downloads: 'La mejor de cada tema; con cuenta, originales y Go+' }
]

/** How accounts work: some only import playlists, others also download, and the more download accounts the better. */
function AccountsGuide({ connected }: { connected: (s: SourceService) => boolean }) {
	const downloaders = GUIDE.filter((g) => g.downloads)
	const ready = downloaders.filter((g) => connected(g.service)).length
	return (
		<details open={ready < downloaders.length} className="rounded-xl border border-line bg-panel/60 px-5 py-4 text-sm">
			<summary className="cursor-pointer font-medium select-none">
				Cómo funcionan las cuentas{' '}
				<span className={cx('ml-1 text-xs font-normal', ready ? 'text-emerald-300' : 'text-amber-300')}>
					{ready} de {downloaders.length} cuentas de descarga conectadas
				</span>
			</summary>
			<div className="mt-3 space-y-3 text-xs text-muted">
				<p>
					Cada cuenta que agregas sirve para algo distinto. Todas <b className="text-zinc-300">importan playlists</b>, pero
					solo algunas además <b className="text-zinc-300">permiten descargar</b> el audio:
				</p>
				<ul className="grid gap-1.5 sm:grid-cols-2">
					{GUIDE.map((g) => (
						<li key={g.service} className="flex items-center gap-2 rounded-md bg-ink/50 px-3 py-2">
							<span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SERVICE_COLOR[g.service] }} />
							<span className="font-medium text-zinc-200">{SERVICE_LABEL[g.service]}</span>
							{g.downloads ? (
								<span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[11px] text-emerald-300" title={g.downloads}>
									Importa + descarga
								</span>
							) : (
								<span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300">Solo importa</span>
							)}
							{connected(g.service) && <span className="ml-auto text-[11px] text-emerald-300">✓ conectada</span>}
						</li>
					))}
				</ul>
				<p>
					<b className="text-zinc-300">Conecta todas las cuentas de descarga que puedas.</b> Cada una es un catálogo más
					donde buscar: si un tema no está en una, Kemix lo intenta en la siguiente (el orden se elige en Ajustes →
					Prioridad de servicios, o con «Usar como predeterminado»). Así quedan menos temas sin descargar o en revisión.
					Lo que no esté en ninguna puede bajarse de YouTube o SoundCloud: funcionan sin cuenta, pero con la de
					SoundCloud conectada bajas los archivos originales y, con Go+, los temas completos en AAC 256.
				</p>
				<ol className="list-decimal space-y-1 pl-5">
					<li>
						Conecta el servicio donde tienes tus playlists (Spotify, YouTube Music, Qobuz, Deezer o SoundCloud) para
						importarlas.
					</li>
					<li>Conecta Qobuz y/o Deezer para poder descargar en buena calidad, aunque tus playlists estén en otro lado.</li>
					<li>
						Al descargar, elige la calidad. Si solo quieres que la canción suene en cualquier reproductor (auto, parlante,
						celular), usa <b className="text-zinc-300">MP3 compatible</b>.
					</li>
				</ol>
			</div>
		</details>
	)
}

/** What the account downloads at most, and whether it's the default downloader (first in the priority). */
function DownloadQuality(props: {
	service: TargetService
	connected: boolean
	quality?: AudioQuality
	loading: boolean
	isDefault: boolean
	priority: DownloadService[]
}) {
	const qc = useQueryClient()
	const makeDefault = useMutation({
		mutationFn: () =>
			api.updateSettings({ servicePriority: [props.service, ...props.priority.filter((s) => s !== props.service)] }),
		onSettled: () => qc.invalidateQueries({ queryKey: ['state'] })
	})
	const plans =
		props.service === 'qobuz'
			? 'FLAC hasta 24-bit/192 kHz (según el tema)'
			: 'FLAC 16-bit/44.1 kHz con HiFi, MP3 320 con Premium, MP3 128 gratis'

	if (!props.connected) return <p className="text-xs text-zinc-500">Al conectarla descarga en {plans}.</p>
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
			<span>
				Descarga hasta{' '}
				{props.quality ? (
					<span className={cx('font-medium', qualityTone(props.quality))}>{qualityLabel(props.quality)}</span>
				) : props.loading ? (
					'…'
				) : (
					<span title={plans}>calidad desconocida</span>
				)}
				{props.service === 'qobuz' && props.quality?.lossless && ' (según el tema)'}
			</span>
			{props.isDefault ? (
				<span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-200">Descargador predeterminado</span>
			) : (
				<button
					type="button"
					className="underline hover:text-zinc-100 disabled:opacity-40"
					disabled={makeDefault.isPending}
					onClick={() => makeDefault.mutate()}
				>
					Usar como predeterminado
				</button>
			)}
		</div>
	)
}

/** What SoundCloud downloads, and what connecting the account adds. */
function SoundCloudDownloadNote({ connected, quality }: { connected: boolean; quality?: AudioQuality }) {
	return (
		<div className="space-y-1.5 text-xs text-muted">
			<p>
				Descarga la mejor calidad que tenga cada tema, hasta{' '}
				<span className={qualityTone(quality ?? null)}>{quality ? qualityLabel(quality) : 'AAC 160 kbps'}</span> (con
				pérdida), o el <b className="text-zinc-300">archivo original</b> que subió el artista si permite descargarlo (a
				veces WAV o FLAC, sin pérdida). Como YouTube, es un respaldo: actívalo en Ajustes → Prioridad de servicios o
				elígelo a mano al bajar o revisar un tema.
			</p>
			<p className={connected ? 'text-emerald-300/90' : ''}>
				{connected
					? 'Con tu cuenta conectada, las descargas y búsquedas van con tu sesión: originales reservados a usuarios registrados y, si tienes Go+, AAC 256 y los temas Go+ completos.'
					: 'Funciona sin cuenta. Conéctala para importar tus playlists y Me gusta, bajar originales que SoundCloud reserva a usuarios registrados y, con Go+, AAC 256 y temas Go+ completos (sin cuenta solo traen 30 s y se descartan).'}
			</p>
		</div>
	)
}

function ComingSoonCard({ name, color }: { name: string; color: string }) {
	return (
		<section className="rounded-xl border border-dashed border-line bg-panel/50 p-5 opacity-70">
			<header className="flex items-start justify-between gap-4">
				<h2 className="flex items-center gap-2 font-semibold">
					<span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
					{name}
				</h2>
				<span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">Próximamente</span>
			</header>
			<p className="mt-3 text-xs text-muted">Todavía no se puede conectar. Llegará en una próxima versión.</p>
		</section>
	)
}

function AccountCard({
	account,
	role,
	beta,
	download,
	connectedExtra,
	children
}: {
	account: AccountInfo
	role: string
	/** Still in progress: shows a "Beta" badge next to the name. */
	beta?: boolean
	/** What this account can download, and at what quality. */
	download?: ReactNode
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
		<section className="min-w-0 rounded-xl border border-line bg-panel p-5">
			<header className="flex items-start justify-between gap-4">
				<div className="shrink-0">
					<h2 className="flex items-center gap-2 font-semibold">
						<span className="h-2.5 w-2.5 rounded-full" style={{ background: SERVICE_COLOR[account.service] }} />
						{SERVICE_LABEL[account.service]}
						{beta && (
							<span className="rounded bg-violet-950 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-violet-300 uppercase">
								Beta
							</span>
						)}
					</h2>
					<p className="mt-0.5 text-xs text-muted">{role}</p>
				</div>
				{connected ? (
					<div className="min-w-0 text-right wrap-anywhere">
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
			{download && <div className="mt-3 border-t border-line/60 pt-3">{download}</div>}
			{account.status === 'error' && account.error && (
				<p className="mt-3 rounded-md bg-red-950/40 px-3 py-2 text-xs whitespace-pre-wrap wrap-anywhere text-red-300">
					{account.error}
				</p>
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
	if (!browserLogin) {
		return <p className="text-xs text-muted">Qobuz se conecta desde la app de escritorio de Kemix.</p>
	}
	return (
		<div className="space-y-3">
			<p className="text-xs text-muted">
				Se abrirá play.qobuz.com en una ventana. Inicia sesión como siempre (con email y contraseña es lo más fiable;
				Google a veces bloquea su login dentro de apps). Kemix toma la sesión y cierra la ventana solo.
			</p>
			<ErrorText error={inBrowser.error} />
			<Button variant="primary" onClick={() => inBrowser.mutate()} disabled={inBrowser.isPending}>
				{inBrowser.isPending ? 'Esperando a que inicies sesión…' : 'Iniciar sesión en Qobuz'}
			</Button>
		</div>
	)
}

const COOKIES_EXTENSION_URL = 'https://github.com/kairi003/Get-cookies.txt-LOCALLY'

/**
 * Step-by-step guide to export cookies.txt from the browser and use it to connect.
 * `rotating`: the site renews its session cookies while it stays open in the browser (Google), which kills the copy
 * exported to Kemix within minutes or hours unless it's exported from a window that's closed right after.
 */
function CookiesGuide({ site, rotating }: { site: string; rotating?: boolean }) {
	return (
		<details className="rounded-md border border-line bg-ink/40 px-3 py-2 text-xs text-muted">
			<summary className="cursor-pointer text-zinc-300 select-none">¿Cómo obtengo el archivo cookies.txt?</summary>
			<ol className="mt-2 list-decimal space-y-1.5 pl-5">
				<li>
					Instala en Chrome, Edge o Firefox la extensión{' '}
					<a className="text-accent underline" href={COOKIES_EXTENSION_URL} target="_blank" rel="noreferrer">
						Get cookies.txt LOCALLY ↗
					</a>{' '}
					(los enlaces a cada tienda están en esa página). Usa la versión <b>LOCALLY</b>: no envía tus cookies a ningún
					servidor.
				</li>
				<li>
					Abre <b>{site}</b> en ese navegador e inicia sesión con tu cuenta.
				</li>
				<li>
					Con esa pestaña abierta, pulsa el icono de la extensión (en el menú de extensiones 🧩) y luego <b>Export</b>.
					Se descarga un archivo <code>.txt</code>.
				</li>
				<li>
					Aquí, pulsa <b>Cargar archivo…</b>, elige ese archivo y después <b>Conectar</b>.
				</li>
				<li>
					El archivo da acceso a tu cuenta: bórralo cuando termines y no lo compartas. Si la sesión caduca, repite estos
					pasos.
				</li>
			</ol>
			{rotating && (
				<p className="mt-2 rounded border border-amber-900/60 bg-amber-950/30 px-2 py-1.5 text-amber-200">
					<b>Para que no caduquen enseguida:</b> Google renueva estas cookies mientras {site} sigue abierto en el
					navegador, y la copia exportada deja de valer. Haz los pasos en una <b>ventana privada / de incógnito</b>{' '}
					(permite la extensión en modo incógnito) y ciérrala justo después de exportar, <b>sin cerrar sesión</b>.
				</p>
			)}
		</details>
	)
}

function SoundCloudForm({ browserLogin }: { browserLogin: boolean }) {
	const [cookie, setCookie] = useState('')
	const connect = useConnect(api.connectSoundCloud)
	const inBrowser = useConnect(api.connectSoundCloudInBrowser)
	return (
		<div className="space-y-3">
			{browserLogin && (
				<>
					<p className="text-xs text-muted">
						Se abrirá soundcloud.com en una ventana. Inicia sesión como siempre (email, Google o Apple); Kemix toma la
						sesión y cierra la ventana solo.
					</p>
					<ErrorText error={inBrowser.error} />
					<Button variant="primary" onClick={() => inBrowser.mutate()} disabled={inBrowser.isPending}>
						{inBrowser.isPending ? 'Esperando a que inicies sesión…' : 'Iniciar sesión en SoundCloud'}
					</Button>
				</>
			)}
			<details className="text-xs" open={!browserLogin}>
				<summary className="cursor-pointer text-muted select-none">
					{browserLogin ? 'O conecta con las cookies del navegador' : 'Conectar con las cookies del navegador'}
				</summary>
				<form
					className="mt-3 space-y-3"
					onSubmit={(e) => {
						e.preventDefault()
						connect.mutate(cookie)
					}}
				>
					<Field
						label="Cookies de soundcloud.com"
						hint={
							<>
								Con la sesión iniciada en soundcloud.com, exporta las cookies y carga el archivo; Kemix toma la cookie{' '}
								<code>oauth_token</code> sola. También puedes pegar solo su valor.
							</>
						}
					>
						<textarea
							value={cookie}
							onChange={(e) => setCookie(e.target.value)}
							rows={3}
							placeholder="Pega aquí el contenido de cookies.txt o el valor de oauth_token"
							className="w-full rounded-md border border-line bg-ink px-3 py-1.5 font-mono text-xs focus:border-accent/60 focus:outline-none"
						/>
					</Field>
					<CookiesGuide site="soundcloud.com" />
					<ErrorText error={connect.error} />
					<div className="flex items-center gap-2">
						<Button variant="primary" type="submit" disabled={connect.isPending || cookie.trim().length < 20}>
							{connect.isPending ? 'Conectando…' : 'Conectar SoundCloud'}
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
			</details>
		</div>
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
				label="Cookies de deezer.com"
				hint={
					<>
						Recomendado: con la sesión iniciada en deezer.com, exporta las cookies con una extensión (p. ej. Get
						cookies.txt) y carga el archivo; Kemix toma la cookie <code>arl</code> sola. También puedes pegar solo el
						valor de <code>arl</code> (DevTools → Application → Cookies). Caduca cada pocos meses.
					</>
				}
			>
				<textarea
					value={arl}
					onChange={(e) => setArl(e.target.value)}
					rows={3}
					placeholder="Pega aquí el contenido de cookies.txt o el valor de arl"
					className="w-full rounded-md border border-line bg-ink px-3 py-1.5 font-mono text-xs focus:border-accent/60 focus:outline-none"
				/>
			</Field>
			<CookiesGuide site="www.deezer.com" />
			<ErrorText error={connect.error} />
			<div className="flex items-center gap-2">
				<Button variant="primary" type="submit" disabled={connect.isPending || arl.trim().length < 50}>
					{connect.isPending ? 'Conectando…' : 'Conectar Deezer'}
				</Button>
				<label className="cursor-pointer rounded-md border border-line px-3 py-1.5 text-sm hover:bg-zinc-800">
					Cargar archivo…
					<input
						type="file"
						accept=".txt,.json"
						className="hidden"
						onChange={async (e) => {
							const file = e.target.files?.[0]
							if (file) setArl(await file.text())
							e.target.value = ''
						}}
					/>
				</label>
			</div>
		</form>
	)
}

function SpotifyForm({
	browserLogin,
	redirectUri,
	clientId: savedClientId
}: {
	browserLogin: boolean
	redirectUri: string
	clientId: string
}) {
	const qc = useQueryClient()
	const [mode, setMode] = useState<'web' | 'api'>(browserLogin ? 'web' : 'api')
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
	const web = useMutation({
		mutationFn: api.connectSpotifyWeb,
		onSettled: () => qc.invalidateQueries({ queryKey: ['state'] })
	})
	return (
		<div className="space-y-3">
			{browserLogin && (
				<div className="flex gap-1 rounded-md bg-ink p-1 text-xs">
					{(
						[
							['web', 'Cualquier cuenta (sin Premium)'],
							['api', 'Premium (Client ID)']
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
			)}
			{mode === 'web' ? (
				<>
					<p className="text-xs text-muted">
						Se abrirá open.spotify.com en una ventana: inicia sesión como siempre. Después la ventana se oculta unos segundos
						mientras Kemix lee tu biblioteca. Usa la sesión del reproductor web, así que funciona con cuentas gratis: carga
						tus playlists y tus Me gusta y permite buscar, pero no crear playlists en Spotify.
					</p>
					<ErrorText error={web.error} />
					<Button variant="primary" onClick={() => web.mutate()} disabled={web.isPending}>
						{web.isPending ? 'Esperando a que inicies sesión…' : 'Iniciar sesión en Spotify'}
					</Button>
				</>
			) : (
				<>
					<p className="rounded-md bg-amber-950/30 px-3 py-2 text-xs text-amber-300/90">
						Spotify solo abre su Web API a cuentas <b>Premium</b>. Si tu cuenta es gratis, Kemix te avisará al conectar
						{browserLogin ? '; usa «Cualquier cuenta (sin Premium)»' : ''}.
					</p>
					<SpotifyApiSteps redirectUri={redirectUri} />
					<Field label="Client ID">
						<Input value={clientId} onChange={(e) => setClientId(e.target.value.trim())} />
					</Field>
					<ErrorText error={start.error} />
					<Button variant="primary" onClick={() => start.mutate()} disabled={start.isPending || !clientId}>
						Conectar Spotify
					</Button>
				</>
			)}
		</div>
	)
}

function SpotifyApiSteps({ redirectUri }: { redirectUri: string }) {
	return (
		<ol className="list-decimal space-y-1 pl-5 text-xs text-muted">
			<li>
				Crea una app en <span className="text-zinc-300">developer.spotify.com/dashboard</span> (tipo Web API).
			</li>
			<li>
				Añade este Redirect URI: <code className="text-zinc-300 wrap-anywhere select-all">{redirectUri}</code>
			</li>
			<li>Copia el Client ID aquí y pulsa Conectar; se abrirá el navegador para autorizar.</li>
		</ol>
	)
}

/** What YouTube Music Premium does for downloads, worded for the account that's connected (or none). */
function YtPremiumNote({ connected, premium }: { connected: boolean; premium: boolean }) {
	if (connected && premium) {
		return (
			<p className="rounded-md bg-emerald-950/60 px-2.5 py-1.5 text-emerald-300">
				Tu cuenta tiene YouTube Music Premium: las descargas de YouTube suben de AAC ~128 a{' '}
				<b>AAC 256 kbps</b>, el doble de bitrate.
			</p>
		)
	}
	return (
		<p className="rounded-md bg-ink/50 px-2.5 py-1.5">
			<b className="text-zinc-300">Con YouTube Music Premium sube la calidad:</b> si la cuenta conectada es Premium,
			las descargas de YouTube salen en AAC 256 kbps en vez de ~128 (el doble de bitrate).{' '}
			{connected
				? 'La cuenta elegida no tiene Premium; si otra de tus cuentas de Google sí lo tiene, cámbiate a ella.'
				: 'Conectar la cuenta es opcional, pero sin ella se queda en ~128.'}
		</p>
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
			<CookiesGuide site="music.youtube.com" rotating />
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
