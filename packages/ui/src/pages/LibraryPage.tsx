import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
	DndContext,
	DragOverlay,
	PointerSensor,
	useDraggable,
	useDroppable,
	useSensor,
	useSensors,
	type DragEndEvent,
	type DragStartEvent
} from '@dnd-kit/core'
import type { Folder, PlaylistSummary, SourceService } from '@kemix/core'
import { api } from '../lib/api'
import { SERVICE_LABEL, cx } from '../lib/format'
import { Button, Cover, Empty, ErrorText, Input, ServiceDot } from '../components/ui'
import { PlaylistDetailView } from './PlaylistDetail'

/** Sidebar selection: all playlists, unfiled ones, or a folder. */
type Selection = { kind: 'all' } | { kind: 'unfiled' } | { kind: 'folder'; id: number }

type DragData = { type: 'playlist'; playlist: PlaylistSummary } | { type: 'folder'; folder: Folder }

export function LibraryPage({
	syncing,
	onGoToAccounts,
	initialPlaylist = null
}: {
	syncing: boolean
	onGoToAccounts: () => void
	initialPlaylist?: number | null
}) {
	const qc = useQueryClient()
	const library = useQuery({ queryKey: ['library'], queryFn: api.library })
	const [selection, setSelection] = useState<Selection>({ kind: 'all' })
	const [openPlaylist, setOpenPlaylist] = useState<number | null>(initialPlaylist)
	const [filter, setFilter] = useState('')
	const [serviceFilter, setServiceFilter] = useState<SourceService | 'all'>('all')
	const [dragging, setDragging] = useState<DragData | null>(null)

	const refresh = () => qc.invalidateQueries({ queryKey: ['library'] })
	const sync = useMutation({ mutationFn: api.sync })
	const move = useMutation({
		mutationFn: ({ id, folderId }: { id: number; folderId: number | null }) => api.movePlaylist(id, folderId),
		onSettled: refresh
	})
	const moveFolder = useMutation({
		mutationFn: ({ id, parentId }: { id: number; parentId: number | null }) => api.updateFolder(id, { parentId }),
		onSettled: refresh
	})

	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
	const folders = library.data?.folders ?? []
	const playlists = library.data?.playlists ?? []

	const visible = useMemo(() => {
		const q = filter.trim().toLowerCase()
		return playlists.filter((p) => {
			if (selection.kind === 'unfiled' && p.folderId !== null) return false
			if (selection.kind === 'folder' && p.folderId !== selection.id) return false
			if (serviceFilter !== 'all' && p.source !== serviceFilter) return false
			if (q && !p.name.toLowerCase().includes(q) && !(p.owner ?? '').toLowerCase().includes(q)) return false
			return true
		})
	}, [playlists, selection, filter, serviceFilter])

	const onDragStart = (e: DragStartEvent) => setDragging(e.active.data.current as DragData)
	const onDragEnd = (e: DragEndEvent) => {
		setDragging(null)
		const data = e.active.data.current as DragData | undefined
		const target = e.over?.data.current as { folderId: number | null } | undefined
		if (!data || !target) return
		if (data.type === 'playlist' && data.playlist.folderId !== target.folderId) {
			move.mutate({ id: data.playlist.id, folderId: target.folderId })
		}
		if (data.type === 'folder' && data.folder.id !== target.folderId && data.folder.parentId !== target.folderId) {
			moveFolder.mutate({ id: data.folder.id, parentId: target.folderId })
		}
	}

	if (openPlaylist !== null) {
		return <PlaylistDetailView id={openPlaylist} onBack={() => setOpenPlaylist(null)} />
	}

	const selectedFolder = selection.kind === 'folder' ? folders.find((f) => f.id === selection.id) : undefined
	const title = selection.kind === 'all' ? 'Todas las playlists' : selection.kind === 'unfiled' ? 'Sin carpeta' : selectedFolder?.name ?? ''
	const sources = [...new Set(playlists.map((p) => p.source))]

	return (
		<DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
			<div className="flex h-full">
				<FolderSidebar
					folders={folders}
					playlists={playlists}
					selection={selection}
					onSelect={setSelection}
				/>
				<section className="min-w-0 flex-1 overflow-y-auto">
					<header className="flex flex-wrap items-center gap-3 border-b border-line px-8 pt-8 pb-5">
						<h1 className="mr-auto text-2xl font-semibold tracking-tight">{title}</h1>
						<Input
							placeholder="Filtrar…"
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							className="w-48"
						/>
						{sources.length > 1 && (
							<select
								value={serviceFilter}
								onChange={(e) => setServiceFilter(e.target.value as SourceService | 'all')}
								className="rounded-md border border-line bg-ink px-2 py-1.5 text-sm"
							>
								<option value="all">Todos los servicios</option>
								{sources.map((s) => (
									<option key={s} value={s}>
										{SERVICE_LABEL[s]}
									</option>
								))}
							</select>
						)}
						<Button onClick={() => sync.mutate()} disabled={syncing || sync.isPending}>
							{syncing ? 'Sincronizando…' : 'Sincronizar'}
						</Button>
					</header>
					<ErrorText error={sync.error ?? move.error ?? moveFolder.error} />
					{library.isLoading ? null : playlists.length === 0 ? (
						<Empty title="Aún no hay playlists">
							Conecta tus cuentas y pulsa <b>Sincronizar</b> para traer tus playlists.{' '}
							<button className="text-accent underline" onClick={onGoToAccounts}>
								Ir a Cuentas
							</button>
						</Empty>
					) : visible.length === 0 ? (
						<Empty title="Nada por aquí">
							{selection.kind === 'folder' ? 'Arrastra playlists a esta carpeta desde "Todas".' : 'Ninguna playlist coincide con el filtro.'}
						</Empty>
					) : (
						<ul className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4 p-8">
							{visible.map((p) => (
								<PlaylistCard key={p.id} playlist={p} onOpen={() => setOpenPlaylist(p.id)} />
							))}
						</ul>
					)}
				</section>
			</div>
			<DragOverlay dropAnimation={null}>
				{dragging && (
					<div className="rounded-md border border-accent/50 bg-panel px-3 py-2 text-sm shadow-xl">
						{dragging.type === 'playlist' ? dragging.playlist.name : `📁 ${dragging.folder.name}`}
					</div>
				)}
			</DragOverlay>
		</DndContext>
	)
}

function PlaylistCard({ playlist: p, onOpen }: { playlist: PlaylistSummary; onOpen: () => void }) {
	const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
		id: `playlist:${p.id}`,
		data: { type: 'playlist', playlist: p } satisfies DragData
	})
	const d = p.downloads
	const pct = d.total ? Math.round((d.done / d.total) * 100) : 0
	return (
		<li
			ref={setNodeRef}
			{...listeners}
			{...attributes}
			onClick={onOpen}
			className={cx(
				'group cursor-pointer rounded-lg border border-transparent p-2 transition-colors hover:border-line hover:bg-panel',
				isDragging && 'opacity-40'
			)}
		>
			<Cover url={p.coverUrl} size={164} className="aspect-square h-auto! w-full! rounded-md" />
			<div className="mt-2 space-y-1">
				<p className="truncate text-sm font-medium" title={p.name}>
					{p.name}
				</p>
				<div className="flex items-center justify-between gap-2">
					<ServiceDot service={p.source} withLabel />
					<span className="text-xs text-muted">{p.trackCount ?? '?'} temas</span>
				</div>
				{p.removed && <p className="text-xs text-amber-400">Ya no está en {SERVICE_LABEL[p.source]}</p>}
				{d.total > 0 && (
					<div className="space-y-1 pt-1">
						<div className="h-1 overflow-hidden rounded bg-zinc-800">
							<div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
						</div>
						<p className="text-[11px] text-muted">
							{d.done}/{d.total} descargados
							{d.review > 0 && <span className="text-amber-300"> · {d.review} por revisar</span>}
							{d.error > 0 && <span className="text-red-300"> · {d.error} con error</span>}
						</p>
					</div>
				)}
			</div>
		</li>
	)
}

// ---------------- folder sidebar ----------------

function FolderSidebar({
	folders,
	playlists,
	selection,
	onSelect
}: {
	folders: Folder[]
	playlists: PlaylistSummary[]
	selection: Selection
	onSelect: (s: Selection) => void
}) {
	const qc = useQueryClient()
	const [creatingIn, setCreatingIn] = useState<number | null | undefined>(undefined)
	const refresh = () => qc.invalidateQueries({ queryKey: ['library'] })
	const create = useMutation({
		mutationFn: ({ name, parentId }: { name: string; parentId: number | null }) => api.createFolder(name, parentId),
		onSuccess: (f) => onSelect({ kind: 'folder', id: f.id }),
		onSettled: () => {
			setCreatingIn(undefined)
			refresh()
		}
	})

	const counts = useMemo(() => {
		const m = new Map<number | null, number>()
		for (const p of playlists) m.set(p.folderId, (m.get(p.folderId) ?? 0) + 1)
		return m
	}, [playlists])

	const children = (parentId: number | null) => folders.filter((f) => f.parentId === parentId)

	return (
		<aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-line py-6">
			<div className="space-y-0.5 px-2">
				<SidebarItem active={selection.kind === 'all'} onClick={() => onSelect({ kind: 'all' })} count={playlists.length}>
					Todas
				</SidebarItem>
				<DropZone folderId={null}>
					<SidebarItem
						active={selection.kind === 'unfiled'}
						onClick={() => onSelect({ kind: 'unfiled' })}
						count={counts.get(null) ?? 0}
					>
						Sin carpeta
					</SidebarItem>
				</DropZone>
			</div>
			<div className="mt-6 flex items-center justify-between px-4 pb-2">
				<span className="text-xs font-medium tracking-wide text-muted uppercase">Carpetas</span>
				<button className="text-lg leading-none text-muted hover:text-accent" title="Nueva carpeta" onClick={() => setCreatingIn(null)}>
					+
				</button>
			</div>
			<div className="space-y-0.5 px-2">
				{creatingIn === null && (
					<NewFolderInput onDone={(name) => (name ? create.mutate({ name, parentId: null }) : setCreatingIn(undefined))} />
				)}
				{children(null).map((f) => (
					<FolderNode
						key={f.id}
						folder={f}
						depth={0}
						childrenOf={children}
						counts={counts}
						selection={selection}
						onSelect={onSelect}
						creatingIn={creatingIn}
						onCreateIn={setCreatingIn}
						onCreate={(name, parentId) => (name ? create.mutate({ name, parentId }) : setCreatingIn(undefined))}
					/>
				))}
				{folders.length === 0 && creatingIn === undefined && (
					<p className="px-3 py-2 text-xs text-zinc-600">Crea carpetas y arrastra playlists dentro para organizarlas.</p>
				)}
			</div>
		</aside>
	)
}

function FolderNode({
	folder,
	depth,
	childrenOf,
	counts,
	selection,
	onSelect,
	creatingIn,
	onCreateIn,
	onCreate
}: {
	folder: Folder
	depth: number
	childrenOf: (id: number | null) => Folder[]
	counts: Map<number | null, number>
	selection: Selection
	onSelect: (s: Selection) => void
	creatingIn: number | null | undefined
	onCreateIn: (id: number | null | undefined) => void
	onCreate: (name: string, parentId: number | null) => void
}) {
	const qc = useQueryClient()
	const [renaming, setRenaming] = useState(false)
	const [menu, setMenu] = useState(false)
	const refresh = () => qc.invalidateQueries({ queryKey: ['library'] })
	const rename = useMutation({ mutationFn: (name: string) => api.updateFolder(folder.id, { name }), onSettled: refresh })
	const remove = useMutation({
		mutationFn: () => api.deleteFolder(folder.id),
		onSuccess: () => selection.kind === 'folder' && selection.id === folder.id && onSelect({ kind: 'all' }),
		onSettled: refresh
	})
	const drag = useDraggable({ id: `folder:${folder.id}`, data: { type: 'folder', folder } satisfies DragData })
	const kids = childrenOf(folder.id)
	const active = selection.kind === 'folder' && selection.id === folder.id

	return (
		<div>
			<DropZone folderId={folder.id}>
				<div
					ref={drag.setNodeRef}
					{...drag.listeners}
					{...drag.attributes}
					className={cx('group relative', drag.isDragging && 'opacity-40')}
					style={{ paddingLeft: depth * 14 }}
				>
					{renaming ? (
						<NewFolderInput
							initial={folder.name}
							onDone={(name) => {
								setRenaming(false)
								if (name && name !== folder.name) rename.mutate(name)
							}}
						/>
					) : (
						<SidebarItem active={active} onClick={() => onSelect({ kind: 'folder', id: folder.id })} count={counts.get(folder.id) ?? 0}>
							<span className="truncate">{folder.name}</span>
						</SidebarItem>
					)}
					{!renaming && (
						<button
							className="absolute top-1/2 right-8 hidden -translate-y-1/2 px-1 text-muted group-hover:block hover:text-zinc-100"
							onClick={(e) => {
								e.stopPropagation()
								setMenu((m) => !m)
							}}
							onPointerDown={(e) => e.stopPropagation()}
						>
							⋯
						</button>
					)}
					{menu && (
						<div
							className="absolute top-full right-2 z-20 w-40 rounded-md border border-line bg-panel py-1 text-sm shadow-xl"
							onPointerDown={(e) => e.stopPropagation()}
							onMouseLeave={() => setMenu(false)}
						>
							<MenuItem onClick={() => (setMenu(false), onCreateIn(folder.id))}>Nueva subcarpeta</MenuItem>
							<MenuItem onClick={() => (setMenu(false), setRenaming(true))}>Renombrar</MenuItem>
							<MenuItem danger onClick={() => (setMenu(false), remove.mutate())}>
								Eliminar carpeta
							</MenuItem>
						</div>
					)}
				</div>
			</DropZone>
			{creatingIn === folder.id && (
				<div style={{ paddingLeft: (depth + 1) * 14 }}>
					<NewFolderInput onDone={(name) => onCreate(name, folder.id)} />
				</div>
			)}
			{kids.map((k) => (
				<FolderNode
					key={k.id}
					folder={k}
					depth={depth + 1}
					childrenOf={childrenOf}
					counts={counts}
					selection={selection}
					onSelect={onSelect}
					creatingIn={creatingIn}
					onCreateIn={onCreateIn}
					onCreate={onCreate}
				/>
			))}
		</div>
	)
}

function DropZone({ folderId, children }: { folderId: number | null; children: ReactNode }) {
	const { setNodeRef, isOver } = useDroppable({ id: `drop:${folderId ?? 'root'}`, data: { folderId } })
	return (
		<div ref={setNodeRef} className={cx('rounded-md', isOver && 'ring-1 ring-accent ring-inset')}>
			{children}
		</div>
	)
}

function SidebarItem({
	active,
	onClick,
	count,
	children
}: {
	active: boolean
	onClick: () => void
	count: number
	children: ReactNode
}) {
	return (
		<button
			onClick={onClick}
			className={cx(
				'flex w-full items-center justify-between gap-2 rounded-md px-3 py-1.5 text-left text-sm',
				active ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-300 hover:bg-zinc-900'
			)}
		>
			<span className="flex min-w-0 items-center gap-2">{children}</span>
			<span className="text-xs text-muted">{count}</span>
		</button>
	)
}

function MenuItem({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: ReactNode }) {
	return (
		<button
			onClick={onClick}
			className={cx('block w-full px-3 py-1.5 text-left hover:bg-zinc-800', danger && 'text-red-300')}
		>
			{children}
		</button>
	)
}

function NewFolderInput({ initial = '', onDone }: { initial?: string; onDone: (name: string) => void }) {
	const [value, setValue] = useState(initial)
	// Enter submits and unmounts the input, which can also fire blur: only report once.
	const done = useRef(false)
	const finish = (name: string) => {
		if (done.current) return
		done.current = true
		onDone(name)
	}
	return (
		<Input
			autoFocus
			value={value}
			placeholder="Nombre de la carpeta"
			onChange={(e) => setValue(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === 'Enter') finish(value.trim())
				if (e.key === 'Escape') finish('')
			}}
			onBlur={() => finish(value.trim())}
			onPointerDown={(e) => e.stopPropagation()}
			className="my-0.5 py-1"
		/>
	)
}
