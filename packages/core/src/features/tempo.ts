import { chunkedLoop, stft } from './dsp'

const FRAME = 1024
const HOP = 256
const MIN_BPM = 50
const MAX_BPM = 220
/** Doubling a tempo is only considered up to here: above it, a doubled tempo is almost always hi-hats, not beats. */
const MAX_DOUBLED_BPM = 185
/** Multiples of the beat period the comb looks at. */
const COMB = 4
/** Prior on tempo: log-normal around this, one octave wide, to choose between a tempo and its half or double. */
const PRIOR_CENTER_BPM = 120
/** Below this the track has no steady pulse worth reporting (ambient, speech, noise). */
const MIN_CONFIDENCE = 0.08

export interface TempoEstimate {
	bpm: number
	/** 0–1: how strongly the onsets repeat at that period. */
	confidence: number
}

/**
 * Tempo of mono audio at `sampleRate`, or null if it has no steady beat.
 *
 * 1. Onset strength: spectral flux of the log-compressed magnitude spectrum, minus its local average.
 * 2. Autocorrelation of the onset strength. Each tempo between 50 and 220 BPM scores the autocorrelation at 1–4 beat
 *    periods (a comb), weighted by a prior around 120 BPM; the best one wins. A doubled tempo replaces it when its comb
 *    is as strong (events really happen on every faster beat: drum & bass at 174 rather than 87).
 * 3. Refinement: around that tempo, the period whose pulse train lines up best with the onsets over the whole track,
 *    which pins it down to a fraction of a BPM.
 */
export async function estimateTempo(pcm: Float32Array, sampleRate: number, signal?: AbortSignal): Promise<TempoEstimate | null> {
	const fps = sampleRate / HOP
	const env = await onsetEnvelope(pcm, signal)
	if (env.length < fps * 6) return null

	const lagOf = (bpm: number) => (60 * fps) / bpm
	const maxLag = Math.ceil(lagOf(MIN_BPM) * COMB) + 2
	const ac = await autocorrelation(env, Math.min(maxLag, env.length - 1), signal)
	if (!ac) return null
	const acAt = (lag: number) => {
		const i = Math.floor(lag)
		if (i + 1 >= ac.length) return 0
		const frac = lag - i
		return ac[i]! * (1 - frac) + ac[i + 1]! * frac
	}
	const comb = (bpm: number) => {
		let sum = 0
		for (let k = 1; k <= COMB; k++) sum += acAt(lagOf(bpm) * k)
		return sum / COMB
	}
	const prior = (bpm: number) => Math.exp(-0.5 * Math.log2(bpm / PRIOR_CENTER_BPM) ** 2)

	let best = MIN_BPM
	let bestScore = -Infinity
	for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.25) {
		const score = comb(bpm) * prior(bpm)
		if (score > bestScore) {
			bestScore = score
			best = bpm
		}
	}
	if (best * 2 <= MAX_DOUBLED_BPM && comb(best * 2) >= 0.9 * comb(best)) best *= 2

	const confidence = Math.max(0, Math.min(1, comb(best)))
	if (confidence < MIN_CONFIDENCE) return null
	const bpm = await refine(env, fps, best, signal)
	return { bpm: Math.round(bpm * 10) / 10, confidence }
}

/** Positive change of the log spectrum from frame to frame, with its running average removed. */
async function onsetEnvelope(pcm: Float32Array, signal?: AbortSignal): Promise<Float64Array> {
	const bins = FRAME / 2 + 1
	let prev = new Float64Array(bins)
	let cur = new Float64Array(bins)
	const flux: number[] = []
	await stft(
		pcm,
		FRAME,
		HOP,
		(mags, f) => {
			let sum = 0
			for (let k = 1; k < bins; k++) {
				cur[k] = Math.log1p(10 * mags[k]!)
				if (f > 0) sum += Math.max(0, cur[k]! - prev[k]!)
			}
			flux.push(sum)
			;[prev, cur] = [cur, prev]
		},
		signal
	)
	// Remove the local mean (about half a second) so loud sections don't count as one long onset.
	const n = flux.length
	const half = 8
	const env = new Float64Array(n)
	let windowSum = 0
	let lo = 0
	let hi = -1
	for (let t = 0; t < n; t++) {
		while (hi < Math.min(n - 1, t + half)) windowSum += flux[++hi]!
		while (lo < t - half) windowSum -= flux[lo++]!
		env[t] = Math.max(0, flux[t]! - windowSum / (hi - lo + 1))
	}
	return smooth(env)
}

/** Light Gaussian smoothing (σ ≈ 1 frame), so beats a little off the frame grid still line up. */
function smooth(x: Float64Array): Float64Array {
	const kernel = [0.054, 0.242, 0.399, 0.242, 0.054]
	const out = new Float64Array(x.length)
	for (let t = 0; t < x.length; t++) {
		let s = 0
		for (let j = -2; j <= 2; j++) {
			const i = t + j
			if (i >= 0 && i < x.length) s += x[i]! * kernel[j + 2]!
		}
		out[t] = s
	}
	return out
}

/** Autocorrelation for lags 0..maxLag, normalized so lag 0 is 1. Null for a silent envelope. */
async function autocorrelation(x: Float64Array, maxLag: number, signal?: AbortSignal): Promise<Float64Array | null> {
	const n = x.length
	let mean = 0
	for (let i = 0; i < n; i++) mean += x[i]!
	mean /= n
	const centered = new Float64Array(n)
	for (let i = 0; i < n; i++) centered[i] = x[i]! - mean
	const ac = new Float64Array(maxLag + 1)
	await chunkedLoop(
		maxLag + 1,
		(lag) => {
			let s = 0
			for (let i = 0; i + lag < n; i++) s += centered[i]! * centered[i + lag]!
			ac[lag] = s / (n - lag)
		},
		signal
	)
	if (!(ac[0]! > 0)) return null
	const zero = ac[0]!
	for (let i = 0; i <= maxLag; i++) ac[i] = ac[i]! / zero
	return ac
}

/**
 * The tempo within ±1.5% of `bpm` whose pulse train, at its best phase, collects the most onset strength. Over a whole
 * track a period off by 0.1% drifts by beats, so this is far finer than the autocorrelation's lag grid.
 */
async function refine(env: Float64Array, fps: number, bpm: number, signal?: AbortSignal): Promise<number> {
	const sample = (pos: number) => {
		const i = Math.floor(pos)
		const frac = pos - i
		return env[i]! * (1 - frac) + (env[i + 1] ?? 0) * frac
	}
	const pulse = (candidate: number) => {
		const period = (60 * fps) / candidate
		let best = 0
		for (let phase = 0; phase < period; phase += 0.25) {
			let sum = 0
			let count = 0
			for (let pos = phase; pos < env.length - 1; pos += period) {
				sum += sample(pos)
				count++
			}
			if (count && sum / count > best) best = sum / count
		}
		return best
	}
	const step = 0.05
	const candidates: number[] = []
	for (let c = bpm * 0.985; c <= bpm * 1.015; c += step) candidates.push(c)
	const scores = new Float64Array(candidates.length)
	await chunkedLoop(candidates.length, (i) => (scores[i] = pulse(candidates[i]!)), signal)
	let bestI = 0
	for (let i = 1; i < scores.length; i++) if (scores[i]! > scores[bestI]!) bestI = i
	// Parabolic interpolation between the neighbouring candidates.
	const a = scores[bestI - 1]
	const b = scores[bestI]!
	const c = scores[bestI + 1]
	if (a === undefined || c === undefined) return candidates[bestI]!
	const denom = a - 2 * b + c
	const offset = denom < 0 ? (0.5 * (a - c)) / denom : 0
	return candidates[bestI]! + Math.max(-0.5, Math.min(0.5, offset)) * step
}
