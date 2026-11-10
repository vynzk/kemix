import { describe, expect, it } from 'vitest'
import { ANALYSIS_RATE, fft } from '../src/features/dsp'
import { estimateTempo } from '../src/features/tempo'
import { estimateKey, foldChroma, keyFromChroma } from '../src/features/tonality'
import { keyTag } from '../src/features/key'
import { beat, chords, noise } from './signals'

const SR = ANALYSIS_RATE

describe('fft', () => {
	it('finds a pure tone in its bin', () => {
		const n = 1024
		const re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 37 * i) / n))
		const im = new Float64Array(n)
		fft(re, im)
		const mags = Array.from(re, (r, i) => Math.hypot(r, im[i]!))
		expect(mags.indexOf(Math.max(...mags.slice(0, n / 2)))).toBe(37)
		expect(mags[37]).toBeCloseTo(n / 2, 6)
	})
})

describe('estimateTempo', () => {
	it.each([90, 124, 128, 140])('finds %d BPM', async (bpm) => {
		const t = await estimateTempo(beat(bpm, 30), SR)
		expect(t).not.toBeNull()
		expect(Math.abs(t!.bpm - bpm)).toBeLessThanOrEqual(0.5)
	})

	it('reads a fast beat with every beat played as fast, not half', async () => {
		const t = await estimateTempo(beat(174, 30), SR)
		expect(Math.abs(t!.bpm - 174)).toBeLessThanOrEqual(0.5)
	})

	it('keeps a slow beat with off-beat hats at its own tempo', async () => {
		const t = await estimateTempo(beat(90, 30, { offbeats: true }), SR)
		expect(Math.abs(t!.bpm - 90)).toBeLessThanOrEqual(0.5)
	})

	it('is precise over a whole track', async () => {
		const t = await estimateTempo(beat(126.5, 180), SR)
		expect(Math.abs(t!.bpm - 126.5)).toBeLessThanOrEqual(0.15)
	})

	it('gives nothing for noise or silence', async () => {
		expect(await estimateTempo(noise(20), SR)).toBeNull()
		expect(await estimateTempo(new Float32Array(SR * 20), SR)).toBeNull()
	})
})

describe('estimateKey', () => {
	it('reads A minor from Am–Dm–E–Am', async () => {
		const k = await estimateKey(chords([['A', 'C', 'E'], ['D', 'F', 'A'], ['E', 'G#', 'B'], ['A', 'C', 'E']], 2, 3), SR)
		expect(k && keyTag(k.key)).toBe('Am')
	})

	it('reads C major from C–F–G–C', async () => {
		const k = await estimateKey(chords([['C', 'E', 'G'], ['F', 'A', 'C'], ['G', 'B', 'D'], ['C', 'E', 'G']], 2, 3), SR)
		expect(k && keyTag(k.key)).toBe('C')
	})

	it('reads F# minor from F#m–Bm–C#–F#m', async () => {
		const k = await estimateKey(
			chords([['F#', 'A', 'C#'], ['B', 'D', 'F#'], ['C#', 'F', 'G#'], ['F#', 'A', 'C#']], 2, 3),
			SR
		)
		expect(k && keyTag(k.key)).toBe('F#m')
	})

	it('copes with tuning off A = 440 Hz', async () => {
		// The same A minor, 30 cents sharp: resampling stretches every frequency by 2^(30/1200).
		const base = chords([['A', 'C', 'E'], ['D', 'F', 'A'], ['E', 'G#', 'B'], ['A', 'C', 'E']], 2, 3)
		const ratio = 2 ** (30 / 1200)
		const sharp = Float32Array.from({ length: Math.floor(base.length / ratio) }, (_, i) => base[Math.floor(i * ratio)]!)
		const k = await estimateKey(sharp, SR)
		expect(k && keyTag(k.key)).toBe('Am')
	})

	it('gives nothing for silence', async () => {
		expect(await estimateKey(new Float32Array(SR * 10), SR)).toBeNull()
	})

	it('finds no key in noise', async () => {
		expect(await estimateKey(noise(20), SR)).toBeNull()
	})
})

describe('chroma', () => {
	it('folds 10-cent bins around the best tuning', () => {
		const fine = new Array(120).fill(0)
		// Energy at C, E and G, all 20 cents sharp.
		for (const pc of [0, 4, 7]) fine[pc * 10 + 2] = 1
		const chroma = foldChroma(fine)
		expect(chroma[0]).toBeCloseTo(1 / 3)
		expect(chroma[4]).toBeCloseTo(1 / 3)
		expect(chroma[7]).toBeCloseTo(1 / 3)
	})

	it('picks the key whose profile matches', () => {
		// A minor scale with the tonic triad stressed.
		const chroma = [3, 0, 1, 0, 3, 1, 0, 0.5, 1, 4, 0, 1]
		expect(keyTag(keyFromChroma(chroma)!.key)).toBe('Am')
	})
})
