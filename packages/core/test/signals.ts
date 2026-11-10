import { ANALYSIS_RATE } from '../src/features/dsp'

/** Synthetic audio for the key and tempo tests, at the analysis sample rate. */
const SR = ANALYSIS_RATE

/** Deterministic noise, so the tests don't flake. */
export function rng(seed: number) {
	let s = seed >>> 0
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0
		return s / 2 ** 32 - 0.5
	}
}

/** A drum-machine-like pattern: a kick on every beat (low thump) and a hat between beats when `offbeats`. */
export function beat(bpm: number, seconds: number, opts: { offbeats?: boolean } = {}): Float32Array {
	const out = new Float32Array(Math.round(SR * seconds))
	const noise = rng(7)
	const period = (60 / bpm) * SR
	for (let n = 0; n * period < out.length; n++) {
		const start = Math.round(n * period)
		for (let i = 0; i < SR * 0.12 && start + i < out.length; i++) {
			const t = i / SR
			out[start + i]! += 0.8 * Math.sin(2 * Math.PI * (60 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 25)
		}
		if (opts.offbeats) {
			const hat = Math.round(start + period / 2)
			for (let i = 0; i < SR * 0.03 && hat + i < out.length; i++) out[hat + i]! += 0.2 * noise() * Math.exp(-(i / SR) * 120)
		}
	}
	return out
}

const NOTE: Record<string, number> = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 }

/** Chords (lists of note names), each held `seconds`, with harmonics and the root an octave down. */
export function chords(progression: string[][], seconds: number, repeats: number): Float32Array {
	const len = Math.round(SR * seconds)
	const out = new Float32Array(len * progression.length * repeats)
	let offset = 0
	for (let r = 0; r < repeats; r++) {
		for (const chord of progression) {
			const freqs = chord.map((n) => 220 * 2 ** ((NOTE[n]! - 9) / 12))
			freqs.push(freqs[0]! / 2)
			for (let i = 0; i < len; i++) {
				const t = i / SR
				let v = 0
				for (const f of freqs) for (let h = 1; h <= 4; h++) v += Math.sin(2 * Math.PI * f * h * t) / h
				out[offset + i] = 0.1 * v * Math.min(1, t * 50, (seconds - t) * 50)
			}
			offset += len
		}
	}
	return out
}

export function noise(seconds: number) {
	const r = rng(3)
	return Float32Array.from({ length: Math.round(SR * seconds) }, () => r() * 0.5)
}
