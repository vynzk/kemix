/**
 * Small DSP toolkit for key and tempo detection: an in-place radix-2 FFT and a short-time magnitude spectrum that
 * hands each frame to a callback. The core runs in Electron's main process, so long loops give the event loop a turn
 * every few milliseconds instead of freezing the app.
 */

/** Sample rate the analysis works at: plenty for onsets and for pitches up to a few kHz, and 4× less work than 44.1 kHz. */
export const ANALYSIS_RATE = 11025

/** How long a loop may run before letting the event loop handle other work. */
const SLICE_MS = 12

export const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Runs `step(i)` for i in [0, n), pausing every few milliseconds. Stops (throwing) if `signal` is aborted. */
export async function chunkedLoop(n: number, step: (i: number) => void, signal?: AbortSignal) {
	let sliceStart = performance.now()
	for (let i = 0; i < n; i++) {
		step(i)
		if ((i & 15) === 15 && performance.now() - sliceStart > SLICE_MS) {
			await yieldToLoop()
			signal?.throwIfAborted()
			sliceStart = performance.now()
		}
	}
}

interface FftTables {
	cos: Float64Array
	sin: Float64Array
	rev: Uint32Array
}

const tables = new Map<number, FftTables>()

function fftTables(n: number): FftTables {
	let t = tables.get(n)
	if (t) return t
	const cos = new Float64Array(n / 2)
	const sin = new Float64Array(n / 2)
	for (let i = 0; i < n / 2; i++) {
		cos[i] = Math.cos((2 * Math.PI * i) / n)
		sin[i] = -Math.sin((2 * Math.PI * i) / n)
	}
	const bits = Math.log2(n)
	const rev = new Uint32Array(n)
	for (let i = 0; i < n; i++) {
		let r = 0
		for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
		rev[i] = r
	}
	t = { cos, sin, rev }
	tables.set(n, t)
	return t
}

/** In-place complex FFT. `re` and `im` have the same power-of-two length. */
export function fft(re: Float64Array, im: Float64Array) {
	const n = re.length
	if (n & (n - 1)) throw new Error('FFT size must be a power of two')
	const { cos, sin, rev } = fftTables(n)
	for (let i = 0; i < n; i++) {
		const j = rev[i]!
		if (j > i) {
			let tmp = re[i]!
			re[i] = re[j]!
			re[j] = tmp
			tmp = im[i]!
			im[i] = im[j]!
			im[j] = tmp
		}
	}
	for (let size = 2; size <= n; size <<= 1) {
		const half = size >> 1
		const step = n / size
		for (let start = 0; start < n; start += size) {
			for (let k = 0; k < half; k++) {
				const wr = cos[k * step]!
				const wi = sin[k * step]!
				const a = start + k
				const b = a + half
				const xr = re[b]! * wr - im[b]! * wi
				const xi = re[b]! * wi + im[b]! * wr
				re[b] = re[a]! - xr
				im[b] = im[a]! - xi
				re[a] = re[a]! + xr
				im[a] = im[a]! + xi
			}
		}
	}
}

export function hann(n: number): Float64Array {
	const w = new Float64Array(n)
	for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
	return w
}

/**
 * Magnitude spectrum of each frame of `pcm` (Hann window of `size` samples, every `hop` samples), passed to `onFrame`
 * as `size / 2 + 1` bins. The array is reused between frames: copy what you keep.
 * Returns the number of frames.
 */
export async function stft(
	pcm: Float32Array,
	size: number,
	hop: number,
	onFrame: (mags: Float64Array, index: number) => void,
	signal?: AbortSignal
): Promise<number> {
	const window = hann(size)
	const re = new Float64Array(size)
	const im = new Float64Array(size)
	const mags = new Float64Array(size / 2 + 1)
	const frames = pcm.length >= size ? Math.floor((pcm.length - size) / hop) + 1 : 0
	await chunkedLoop(
		frames,
		(f) => {
			const offset = f * hop
			for (let i = 0; i < size; i++) re[i] = pcm[offset + i]! * window[i]!
			im.fill(0)
			fft(re, im)
			for (let k = 0; k <= size / 2; k++) mags[k] = Math.hypot(re[k]!, im[k]!)
			onFrame(mags, f)
		},
		signal
	)
	return frames
}
