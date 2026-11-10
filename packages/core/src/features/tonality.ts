import type { MusicalKey } from '../types'
import { stft } from './dsp'

const FRAME = 4096
const HOP = 2048
const MIN_HZ = 50
const MAX_HZ = 2000
/** Pitch-class resolution while collecting: 10 cents, so the tuning can be estimated before folding to 12 bins. */
const FINE = 120
/** Peaks quieter than this fraction of the frame's loudest one are ignored (−40 dB). */
const PEAK_FLOOR = 0.01
/** Frames quieter than this (peak magnitude) are silence. */
const SILENCE = 1e-3
/** Below this correlation the chroma looks like no key at all (drums only, noise). */
const MIN_CORRELATION = 0.35

/**
 * Key profiles (how much each scale degree weighs in major and minor), Ibrahim Sha'ath's from KeyFinder, which were
 * derived from recordings rather than scores. On Deezer previews of 30 songs with well-known keys they got 18 right
 * against 12–13 for Temperley's or Krumhansl's, mostly by mistaking fewer minor keys for their relative major.
 * Kept in one place so another set can be tried by swapping these two arrays.
 */
const MAJOR_PROFILE = [7.239, 3.5035, 3.5845, 2.8451, 5.8192, 4.5582, 2.4468, 6.4, 3.3925, 3.6652, 2.8858, 3.5751]
const MINOR_PROFILE = [7.0051, 3.1443, 4.3646, 5.4997, 3.1101, 4.4737, 2.8881, 6.6902, 4.9523, 2.8734, 4.244, 3.9547]

export interface KeyEstimate {
	key: MusicalKey
	/** Correlation of the best key minus the runner-up's: near 0 is a coin toss. */
	confidence: number
	/** The 12-bin pitch-class profile the key was read from (C first), normalized to sum 1. */
	chroma: number[]
}

/**
 * Key of mono audio at `sampleRate`, or null if it doesn't sound tonal.
 *
 * 1. Each frame's spectral peaks between 50 Hz and 2 kHz, at their interpolated frequency, add their magnitude to a
 *    pitch-class histogram with 10-cent bins. Every frame is normalized, so quiet passages count as much as loud ones.
 * 2. The tuning is the offset (within ±50 cents of A = 440 Hz) that puts the most energy on semitone centers; the
 *    histogram folds into 12 pitch classes around it.
 * 3. The key is the one of the 24 (each profile rotated to each tonic) whose profile correlates best with them.
 */
export async function estimateKey(pcm: Float32Array, sampleRate: number, signal?: AbortSignal): Promise<KeyEstimate | null> {
	const fine = new Float64Array(FINE)
	const frameFine = new Float64Array(FINE)
	const binHz = sampleRate / FRAME
	const lo = Math.max(2, Math.floor(MIN_HZ / binHz))
	const hi = Math.min(FRAME / 2 - 1, Math.ceil(MAX_HZ / binHz))
	let voiced = 0

	await stft(
		pcm,
		FRAME,
		HOP,
		(mags) => {
			let loudest = 0
			for (let k = lo; k <= hi; k++) if (mags[k]! > loudest) loudest = mags[k]!
			if (loudest < SILENCE) return
			frameFine.fill(0)
			let total = 0
			for (let k = lo; k <= hi; k++) {
				const m = mags[k]!
				if (m < loudest * PEAK_FLOOR || m <= mags[k - 1]! || m < mags[k + 1]!) continue
				// Quadratic interpolation on the log magnitude gives the peak's frequency to a fraction of a bin.
				const a = Math.log(mags[k - 1]! + 1e-12)
				const b = Math.log(m + 1e-12)
				const c = Math.log(mags[k + 1]! + 1e-12)
				const denom = a - 2 * b + c
				const offset = denom < 0 ? (0.5 * (a - c)) / denom : 0
				const hz = (k + offset) * binHz
				// Position in the octave in 10-cent steps, 0 = C.
				const midi = 69 + 12 * Math.log2(hz / 440)
				const pos = ((((midi % 12) + 12) % 12) * FINE) / 12
				const i = Math.floor(pos)
				const frac = pos - i
				// Plain magnitude: compressing it (square root, log) let overtones and noise blur the scale.
				const weight = m
				frameFine[i % FINE] = frameFine[i % FINE]! + weight * (1 - frac)
				frameFine[(i + 1) % FINE] = frameFine[(i + 1) % FINE]! + weight * frac
				total += weight
			}
			if (!total) return
			for (let i = 0; i < FINE; i++) fine[i] = fine[i]! + frameFine[i]! / total
			voiced++
		},
		signal
	)
	if (!voiced) return null

	const chroma = foldChroma(fine)
	return keyFromChroma(chroma)
}

/** 120 bins (10 cents) into 12 pitch classes, centered on the tuning that fits them best. */
export function foldChroma(fine: ArrayLike<number>): number[] {
	const bins = fine.length
	const perSemitone = bins / 12
	const at = (i: number) => fine[((i % bins) + bins) % bins]!
	let bestShift = 0
	let bestEnergy = -Infinity
	for (let shift = -Math.floor(perSemitone / 2) + 1; shift <= Math.floor(perSemitone / 2); shift++) {
		let energy = 0
		for (let s = 0; s < 12; s++) {
			const center = s * perSemitone + shift
			energy += at(center) + 0.5 * (at(center - 1) + at(center + 1))
		}
		if (energy > bestEnergy) {
			bestEnergy = energy
			bestShift = shift
		}
	}
	const chroma = new Array<number>(12).fill(0)
	const halfWidth = Math.floor(perSemitone / 2)
	for (let s = 0; s < 12; s++) {
		const center = s * perSemitone + bestShift
		for (let d = -halfWidth; d < perSemitone - halfWidth; d++) chroma[s]! += at(center + d)
	}
	const sum = chroma.reduce((a, b) => a + b, 0)
	return sum ? chroma.map((v) => v / sum) : chroma
}

/** Best of the 24 keys for a 12-bin chroma (C first), by Pearson correlation with the rotated profiles. */
export function keyFromChroma(chroma: number[]): KeyEstimate | null {
	const scores: { key: MusicalKey; r: number }[] = []
	for (let tonic = 0; tonic < 12; tonic++) {
		scores.push({ key: { tonic, minor: false }, r: correlation(chroma, rotate(MAJOR_PROFILE, tonic)) })
		scores.push({ key: { tonic, minor: true }, r: correlation(chroma, rotate(MINOR_PROFILE, tonic)) })
	}
	scores.sort((a, b) => b.r - a.r)
	const [first, second] = scores
	if (!first || !second || !(first.r >= MIN_CORRELATION)) return null
	return { key: first.key, confidence: first.r - second.r, chroma }
}

/** The profile for a key on `tonic`: degree d of the scale lands on pitch class (tonic + d) mod 12. */
function rotate(profile: number[], tonic: number): number[] {
	return Array.from({ length: 12 }, (_, pc) => profile[(pc - tonic + 12) % 12]!)
}

function correlation(x: number[], y: number[]): number {
	const n = x.length
	const mx = x.reduce((a, b) => a + b, 0) / n
	const my = y.reduce((a, b) => a + b, 0) / n
	let sxy = 0
	let sxx = 0
	let syy = 0
	for (let i = 0; i < n; i++) {
		const dx = x[i]! - mx
		const dy = y[i]! - my
		sxy += dx * dy
		sxx += dx * dx
		syy += dy * dy
	}
	return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0
}
