// Kemix · página de presentación. Mejora progresiva: sin JS la página se ve completa y los enlaces funcionan.

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
const REPO = 'vynzk/kemix'

/** Calls `fn` while `el` is on screen, and tells it when it isn't. */
function whileVisible(el, fn) {
	if (!el) return
	new IntersectionObserver(([entry]) => fn(entry.isIntersecting), { rootMargin: '80px' }).observe(el)
}

// ============================== Navegación ==============================

const nav = $('#nav')
const menuBtn = $('.menu-btn')
const navLinks = $$('#nav-links a')

const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8)
addEventListener('scroll', onScroll, { passive: true })
onScroll()

function setMenu(open) {
	nav.classList.toggle('open', open)
	menuBtn.setAttribute('aria-expanded', String(open))
	menuBtn.setAttribute('aria-label', open ? 'Cerrar menú' : 'Abrir menú')
}
menuBtn.addEventListener('click', () => setMenu(!nav.classList.contains('open')))
navLinks.forEach((a) => a.addEventListener('click', () => setMenu(false)))
addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && nav.classList.contains('open')) {
		setMenu(false)
		menuBtn.focus()
	}
})

// La sección que se está leyendo, marcada en el menú
const sections = new Map(navLinks.map((a) => [document.getElementById(a.hash.slice(1)), a]))
const spy = new IntersectionObserver(
	(entries) => {
		for (const e of entries) {
			if (!e.isIntersecting) continue
			navLinks.forEach((a) => a.removeAttribute('aria-current'))
			sections.get(e.target)?.setAttribute('aria-current', 'true')
		}
	},
	{ rootMargin: '-45% 0px -50% 0px' }
)
sections.forEach((_, section) => section && spy.observe(section))
new IntersectionObserver(([e]) => e.isIntersecting && navLinks.forEach((a) => a.removeAttribute('aria-current')), {
	rootMargin: '-45% 0px -50% 0px'
}).observe($('#top'))

// ============================== Aparición al hacer scroll ==============================

const revealer = new IntersectionObserver(
	(entries) => {
		let n = 0
		for (const e of entries) {
			if (!e.isIntersecting) continue
			// Los que entran juntos, escalonados
			e.target.style.setProperty('--d', `${n++ * 90}ms`)
			e.target.classList.add('in')
			revealer.unobserve(e.target)
		}
	},
	{ rootMargin: '0px 0px -8% 0px', threshold: 0.06 }
)
$$('[data-reveal]').forEach((el) => revealer.observe(el))

// ============================== Luz que sigue al cursor ==============================

for (const card of $$('.card')) {
	card.addEventListener('pointermove', (e) => {
		const r = card.getBoundingClientRect()
		card.style.setProperty('--mx', `${e.clientX - r.left}px`)
		card.style.setProperty('--my', `${e.clientY - r.top}px`)
	})
}

// ============================== Descargas ==============================

function detectOS() {
	const ua = navigator.userAgent
	const platform = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase()
	if (/android|iphone|ipad|ipod/i.test(ua)) return 'mobile'
	if (platform.startsWith('win') || /windows/i.test(ua)) return 'win'
	if (platform.includes('mac') || /mac os x/i.test(ua)) return 'mac'
	if (platform.includes('linux') || /linux|x11/i.test(ua)) return 'linux'
	return 'other'
}

const os = detectOS()
const primary = $('[data-dl="primary"]')
const primaryLabel = $('[data-dl-label]')
const primaryIcon = $('[data-os-icon]')

if (os === 'linux') {
	primaryLabel.textContent = 'Descargar para Linux'
	primaryIcon.setAttribute('href', '#i-linux')
	$('[data-dl="win"]').classList.replace('btn-primary', 'btn-ghost')
	$('[data-dl="appimage"]').classList.replace('btn-ghost', 'btn-primary')
} else if (os !== 'win') {
	primaryLabel.textContent = 'Descargar Kemix'
	primaryIcon.setAttribute('href', '#i-download')
	primary.href = '#descargar'
}
$$('.dl').forEach((card) => card.classList.toggle('is-os', card.dataset.os === os))

/** The latest release, cached for an hour (the GitHub API allows 60 requests per hour without a token). */
async function latestRelease() {
	const key = 'kemix:release'
	try {
		const cached = JSON.parse(sessionStorage.getItem(key))
		if (cached && Date.now() - cached.at < 3_600_000) return cached.release
	} catch {}
	const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
		headers: { Accept: 'application/vnd.github+json' }
	})
	if (!res.ok) throw new Error(`GitHub respondió ${res.status}`)
	const json = await res.json()
	const release = { tag: json.tag_name, assets: json.assets.map((a) => ({ name: a.name, url: a.browser_download_url })) }
	try {
		sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), release }))
	} catch {}
	return release
}

// Con la API, cada botón baja el archivo directo; sin ella, todos llevan a la página de la última versión.
latestRelease()
	.then(({ tag, assets }) => {
		const find = (re) => assets.find((a) => re.test(a.name))
		const files = { win: find(/\.exe$/i), appimage: find(/\.AppImage$/i), deb: find(/\.deb$/i) }
		for (const [kind, file] of Object.entries(files)) {
			if (file) $$(`[data-dl="${kind}"]`).forEach((a) => (a.href = file.url))
		}
		if (os === 'win' && files.win) primary.href = files.win.url
		if (os === 'linux' && files.appimage) primary.href = files.appimage.url
		if (tag) $$('[data-version]').forEach((el) => (el.textContent = tag))
		if (files.appimage) $('[data-file="appimage"]').textContent = files.appimage.name
		if (files.deb) $('[data-file="deb"]').textContent = `./${files.deb.name}`
	})
	.catch(() => {})

// ============================== Copiar comandos ==============================

for (const btn of $$('.copy')) {
	btn.addEventListener('click', async () => {
		const term = btn.closest('.term')
		let text
		if (term) {
			// Solo los comandos: sin el prompt ni los comentarios
			text = $('.term-body:not([hidden])', term)
				.textContent.split('\n')
				.map((l) => l.replace(/^\$\s*/, '').replace(/\s+#.*$/, '').trim())
				.filter((l) => l && !l.startsWith('#'))
				.join('\n')
		} else {
			text = $('code', btn.closest('.cmd')).textContent.trim()
		}
		try {
			await navigator.clipboard.writeText(text)
		} catch {
			return
		}
		const label = $('span', btn)
		const before = label?.textContent
		btn.classList.add('done')
		if (label) label.textContent = 'Copiado'
		setTimeout(() => {
			btn.classList.remove('done')
			if (label) label.textContent = before
		}, 1600)
	})
}

// ============================== Pestañas del terminal ==============================

const tabs = $$('.term-tabs [role="tab"]')
function selectTab(index) {
	tabs.forEach((tab, i) => {
		const on = i === index
		tab.setAttribute('aria-selected', String(on))
		tab.tabIndex = on ? 0 : -1
		document.getElementById(tab.getAttribute('aria-controls')).hidden = !on
	})
}
tabs.forEach((tab, i) => {
	tab.addEventListener('click', () => selectTab(i))
	tab.addEventListener('keydown', (e) => {
		if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
		e.preventDefault()
		const next = (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
		selectTab(next)
		tabs[next].focus()
	})
})

// ============================== Maqueta: inclinación al hacer scroll ==============================

const shot = $('#shot')
const shotScale = $('.shot-scale')
if (shot && !reduceMotion) {
	let ticking = false
	const tilt = () => {
		ticking = false
		const r = shot.getBoundingClientRect()
		const progress = Math.min(Math.max((innerHeight - r.top) / (innerHeight * 0.8), 0), 1)
		shotScale.style.setProperty('--tilt', (1 - progress).toFixed(3))
	}
	addEventListener(
		'scroll',
		() => {
			if (!ticking) {
				ticking = true
				requestAnimationFrame(tilt)
			}
		},
		{ passive: true }
	)
	addEventListener('resize', tilt)
	tilt()
}

// ============================== Maqueta: la cola de descargas en marcha ==============================

const app = $('.app')
if (app && !reduceMotion) {
	const rows = $$('tr[data-anim]', app)
	const initial = rows.map((r) => r.dataset.anim)
	const LABEL = { queued: 'En cola', matching: 'Buscando', downloading: 'Bajando', done: 'Listo' }
	// [fila, estado]: hasta 3 descargas a la vez, como la cola de Kemix
	const STEPS = [
		[2, 'downloading'],
		[0, 'done'],
		[3, 'matching'],
		[3, 'downloading'],
		[1, 'done'],
		[2, 'done'],
		[3, 'done']
	]
	const doneBefore = Number($('[data-live="done"]', app).textContent)
	const live = (name) => $(`[data-live="${name}"]`, app)

	const render = (row, state) => {
		row.dataset.anim = state
		$('.c-st', row).innerHTML = `<span class="st st-${state}">${LABEL[state]}</span>`
		const { q, tone, svc } = row.dataset
		$('.c-q', row).innerHTML =
			state === 'done'
				? `<span class="t-${tone}">${q}</span><span class="z5"> · ${svc}</span>`
				: `<span class="mut">máx. <span class="t-${tone}">${q}</span></span>`
		row.classList.remove('flash')
		if (state === 'done') {
			void row.offsetWidth
			row.classList.add('flash')
		}
	}
	const counts = () => {
		const active = rows.filter((r) => r.dataset.anim !== 'done').length
		live('done').textContent = doneBefore + rows.length - active - initial.filter((s) => s === 'done').length
		live('active').textContent = active
		live('badge').textContent = active
		live('badge').hidden = active === 0
		live('active-wrap').hidden = active === 0
	}

	let visible = false
	let step = 0
	let timer = 0
	const next = () => {
		if (!visible) return
		if (step < STEPS.length) {
			const [row, state] = STEPS[step++]
			render(rows[row], state)
			counts()
			timer = setTimeout(next, 1500 + Math.random() * 800)
		} else {
			// Pausa con todo listo y vuelta a empezar
			timer = setTimeout(() => {
				rows.forEach((r, i) => render(r, initial[i]))
				step = 0
				counts()
				timer = setTimeout(next, 1800)
			}, 3600)
		}
	}
	whileVisible(app, (isVisible) => {
		visible = isVisible
		clearTimeout(timer)
		if (isVisible) timer = setTimeout(next, 1400)
	})

	// El reproductor avanza
	const time = live('time')
	const seek = live('seek')
	const total = 6 * 60 + 12
	let at = 102
	setInterval(() => {
		if (!visible) return
		at = at >= total ? 0 : at + 1
		time.textContent = `${Math.floor(at / 60)}:${String(at % 60).padStart(2, '0')}`
		seek.style.width = `${(at / total) * 100}%`
	}, 1000)
}

// ============================== Diagrama de servicios ==============================

const flow = $('#flow')
const flowSvg = flow && $('.flow-svg', flow)
function drawFlow() {
	if (!flowSvg || getComputedStyle(flowSvg).display === 'none') return
	const box = flow.getBoundingClientRect()
	const hub = $('.hub-disc', flow).getBoundingClientRect()
	const hubY = hub.top + hub.height / 2 - box.top
	const curve = (x1, y1, x2, y2) => {
		const dx = (x2 - x1) / 2
		return `M${x1.toFixed(1)} ${y1.toFixed(1)}C${(x1 + dx).toFixed(1)} ${y1.toFixed(1)} ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`
	}
	const line = (d, color, delay) =>
		`<path class="base" d="${d}"/><path class="pulse" d="${d}" pathLength="100" style="color:${color};animation-delay:${delay.toFixed(2)}s"/>`
	let svg = ''
	$$('.flow-src .chip', flow).forEach((chip, i) => {
		const r = chip.getBoundingClientRect()
		const d = curve(r.right - box.left, r.top + r.height / 2 - box.top, hub.left - box.left + 4, hubY)
		svg += line(d, chip.style.getPropertyValue('--c'), -i * 0.68)
	})
	$$('.flow-dst .chip', flow).forEach((chip, i) => {
		const r = chip.getBoundingClientRect()
		const d = curve(hub.right - box.left - 4, hubY, r.left - box.left, r.top + r.height / 2 - box.top)
		svg += line(d, chip.style.getPropertyValue('--c'), -1.7 - i * 0.68)
	})
	flowSvg.setAttribute('viewBox', `0 0 ${box.width.toFixed(1)} ${box.height.toFixed(1)}`)
	flowSvg.innerHTML = svg
}
if (flow) {
	new ResizeObserver(drawFlow).observe(flow)
	document.fonts?.ready.then(drawFlow)
}

// ============================== Calidad y formato (demo) ==============================
// Las mismas reglas que la app (packages/ui/src/lib/format.ts), para una cuenta sin límite de calidad.

const qdemo = $('#qdemo')
if (qdemo) {
	const flac = (bits, khz) => ({ codec: 'FLAC', lossless: true, bits, khz })
	const lossy = (codec, kbps) => ({ codec, lossless: false, kbps })
	const label = (q) => (q.lossless ? `${q.codec} ${q.bits}-bit/${q.khz} kHz` : `${q.codec} ${q.kbps} kbps`)
	const isHiRes = (q) => q.lossless && (q.bits > 16 || q.khz > 48)
	const tone = (q) => (!q.lossless || (q.from && !q.from.lossless) ? 't-amber' : isHiRes(q) ? 't-sky' : 't-emerald')

	const TRACKS = [
		{ service: 'qobuz', max: flac(24, 96) },
		{ service: 'qobuz', max: flac(24, 192) },
		{ service: 'deezer', max: flac(16, 44.1) },
		{ service: 'youtube', max: lossy('AAC', 128) }
	]
	const PRESETS = {
		flac: { level: 'max', format: 'original' },
		aiff: { level: 'max', format: 'aiff' },
		wav: { level: 'cd', format: 'wav' },
		mp3: { level: 'mp3', format: 'original' }
	}

	/** What a download comes out in (expectedQuality). */
	const expected = (track, level) => {
		const lossyService = track.service === 'youtube' || track.service === 'soundcloud'
		if (level === 'mp3') {
			// Qobuz y Deezer mandan su MP3 320; lo demás se convierte: a 320 si era sin pérdida, si no a 192
			if (!lossyService) return lossy('MP3', 320)
			return track.max.codec === 'MP3' ? track.max : lossy('MP3', track.max.lossless ? 320 : 192)
		}
		// Calidad CD: Deezer ya está ahí, y YouTube tiene una sola calidad
		if (level === 'cd' && !lossyService && track.service !== 'deezer' && isHiRes(track.max)) return flac(16, 44.1)
		return track.max
	}

	const cell = (track, preset) => {
		const q = expected(track, preset.level)
		const target = preset.format !== 'original' ? preset.format : preset.level === 'mp3' ? 'mp3' : null
		let html =
			label(q) !== label(track.max)
				? `<span class="${tone(q)}">${label(q)}</span><span class="z5"> (máx. ${label(track.max)})</span>`
				: `máx. <span class="${tone(track.max)}">${label(track.max)}</span>`
		if (preset.format !== 'original') {
			// AIFF/WAV guardan los kHz, y quedan en 24-bit solo si hay más de 16
			const out = { codec: preset.format.toUpperCase(), lossless: true, bits: q.lossless && q.bits > 16 ? 24 : 16, from: q }
			html += `<span class="z5"> → </span><span class="${tone(out)}">${out.codec}</span>`
		}
		const warn =
			target === 'aiff' || target === 'wav' ? !q.lossless : target === 'mp3' ? !q.lossless && q.kbps < 320 : false
		const warnText = target === 'mp3' ? 'Menos de 320 kbps' : 'Fuente con pérdida'
		if (warn) html += `<span class="warn">⚠ ${warnText}</span>`
		return { html, group: warn ? 'below' : !q.lossless ? 'lossy' : isHiRes(q) ? 'hires' : 'cd', warnText }
	}

	const GROUPS = [
		['below', null, 't-amber warn'],
		['hires', 'Hi-Res', 't-sky'],
		['cd', 'Calidad CD', 't-emerald'],
		['lossy', 'Con pérdida', 't-amber']
	]
	const cells = $$('.qq', qdemo)
	const summary = $('[data-q="summary"]', qdemo)
	const buttons = $$('[data-preset]', qdemo)

	const show = (name) => {
		buttons.forEach((b) => {
			b.setAttribute('aria-checked', String(b.dataset.preset === name))
			b.tabIndex = b.dataset.preset === name ? 0 : -1
		})
		const results = TRACKS.map((t) => cell(t, PRESETS[name]))
		results.forEach((r, i) => {
			cells[i].innerHTML = r.html
			cells[i].classList.remove('swap')
			void cells[i].offsetWidth
			cells[i].classList.add('swap')
		})
		const count = (g) => results.filter((r) => r.group === g).length
		const warned = results.find((r) => r.group === 'below')
		let html = GROUPS.filter(([g]) => count(g))
			.map(([g, text, cls]) => `<span class="${cls}">${g === 'below' ? `⚠ ${warned.warnText}` : text}: ${count(g)}</span>`)
			.join('')
		const ready = results.length - count('below')
		if (warned && ready) html += `<span class="sel">Seleccionar sin los con aviso (${ready})</span>`
		summary.innerHTML = html
	}

	buttons.forEach((b, i) => {
		b.addEventListener('click', () => show(b.dataset.preset))
		b.addEventListener('keydown', (e) => {
			const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
			if (!step) return
			e.preventDefault()
			const next = buttons[(i + step + buttons.length) % buttons.length]
			show(next.dataset.preset)
			next.focus()
		})
	})
	buttons.forEach((b) => (b.tabIndex = b.getAttribute('aria-checked') === 'true' ? 0 : -1))
}

// ============================== Rueda de Camelot ==============================
// Mismas fórmulas que la app: nombres como en las armaduras, Open Key, y el color de cada lugar de la rueda.

const wheel = $('#wheel')
if (wheel) {
	const MAJOR = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
	const MINOR = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B']
	const mod12 = (n) => ((n % 12) + 12) % 12

	const info = (key) => {
		const n = parseInt(key, 10)
		const minor = key.endsWith('A')
		const majorTonic = mod12(7 * (n - 8)) // 8B es C mayor; cada paso de la rueda, una quinta
		return {
			n,
			minor,
			name: minor ? `${MINOR[mod12(majorTonic - 3)]}m` : MAJOR[majorTonic],
			open: `${mod12(n - 8) + 1}${minor ? 'm' : 'd'}`,
			color: `hsl(${mod12(n + 3) * 30} 65% ${minor ? 30 : 38}%)`
		}
	}

	const paths = $$('.wheel-keys path', wheel)
	const texts = $$('.wheel-labels text', wheel)
	const keyEl = $('[data-w="key"]', wheel)
	const nameEl = $('[data-w="name"]', wheel)
	const openEl = $('[data-w="open"]', wheel)

	const select = (key, highlight = true) => {
		const { n, minor, name, open, color } = info(key)
		const ring = minor ? 'A' : 'B'
		// Las que mezclan bien: el mismo número en el otro anillo y las de al lado en el mismo
		const near = new Set([`${n}${minor ? 'B' : 'A'}`, `${(n % 12) + 1}${ring}`, `${((n + 10) % 12) + 1}${ring}`])
		for (const el of [...paths, ...texts]) {
			const k = el.dataset.k ?? el.textContent
			el.classList.toggle('sel', highlight && k === key)
			el.classList.toggle('near', highlight && near.has(k))
		}
		wheel.classList.toggle('has-sel', highlight)
		keyEl.textContent = key
		keyEl.style.setProperty('--c', color)
		nameEl.textContent = name
		openEl.textContent = open
	}

	let touched = false
	wheel.addEventListener('pointerover', (e) => {
		const key = e.target.closest('path[data-k]')?.dataset.k
		if (!key) return
		touched = true
		select(key)
	})
	wheel.addEventListener('pointerleave', () => wheel.classList.remove('has-sel'))

	// Mientras nadie la toca, la rueda recorre las claves sola
	if (!reduceMotion) {
		let visible = false
		let i = 0
		const ORDER = Array.from({ length: 12 }, (_, k) => `${mod12(7 + k) + 1}A`)
		setInterval(() => {
			if (!visible || touched) return
			i = (i + 1) % ORDER.length
			select(ORDER[i])
		}, 1800)
		whileVisible(wheel, (v) => (visible = v))
	}
}
