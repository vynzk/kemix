import { describe, expect, it } from 'vitest'
import type { AudioQuality } from '@kemix/core'
import {
	DOWNLOAD_PRESETS,
	belowTarget,
	bpmLabel,
	camelot,
	camelotColor,
	conversionTarget,
	expectedQuality,
	findPreset,
	fitPreset,
	keyLabel,
	keyName,
	openKey,
	outputQuality,
	presetKey,
	presetOptions,
	sameTempo
} from '../src/lib/format'

const keys = (list: { level: string; format: string }[]) => list.map((p) => `${p.level}:${p.format}`)
const HIRES: AudioQuality = { codec: 'flac', lossless: true, bitDepth: 24, sampleRateHz: 192000 }
const HIRES_96: AudioQuality = { codec: 'flac', lossless: true, bitDepth: 24, sampleRateHz: 96000 }
const CD: AudioQuality = { codec: 'flac', lossless: true, bitDepth: 16, sampleRateHz: 44100 }
const MP3_128: AudioQuality = { codec: 'mp3', lossless: false, bitrateKbps: 128 }
const AAC_128: AudioQuality = { codec: 'aac', lossless: false, bitrateKbps: 128 }

describe('presetOptions', () => {
	it('offers every choice in automatic mode', () => {
		expect(presetOptions()).toBe(DOWNLOAD_PRESETS)
	})

	it('offers on Qobuz every level, and MP3 once (it has nothing below 320)', () => {
		const options = presetOptions('qobuz', HIRES)
		expect(keys(options)).toEqual([
			'max:original', 'hires96:original', 'cd:original',
			'max:aiff', 'hires96:aiff', 'cd:aiff',
			'max:wav', 'hires96:wav', 'cd:wav',
			'mp3_compat:original'
		])
		expect(options[0]!.label).toBe('Sin convertir · hasta FLAC 24-bit/192 kHz')
	})

	it("offers on Deezer one lossless level, the account's", () => {
		const options = presetOptions('deezer', CD)
		expect(keys(options)).toEqual(['max:original', 'max:aiff', 'max:wav', 'mp3_compat:original', 'mp3_128:original'])
		expect(options[0]!.label).toBe('Sin convertir · FLAC 16-bit/44.1 kHz')
	})

	it('offers on Soundeo its WAV (or AIFF, or WAV) and its MP3 320', () => {
		const WAV: AudioQuality = { codec: 'wav', lossless: true, bitDepth: 16, sampleRateHz: 44100 }
		for (const options of [presetOptions('soundeo', WAV), presetOptions('soundeo')]) {
			expect(keys(options)).toEqual(['max:original', 'max:aiff', 'max:wav', 'mp3_compat:original'])
			expect(options[0]!.label).toBe('Sin convertir · WAV 16-bit/44.1 kHz')
		}
		expect(expectedQuality(WAV, 'soundeo', 'mp3_compat', WAV)).toEqual({ codec: 'mp3', lossless: false, bitrateKbps: 320 })
		expect(expectedQuality(WAV, 'soundeo', 'cd', WAV)).toEqual(WAV)
	})

	it('en Soulseek, cada archivo es el que es: sin niveles, y "MP3 320" lo convierte', () => {
		for (const options of [presetOptions('soulseek', HIRES), presetOptions('soulseek')]) {
			expect(keys(options)).toEqual(['max:original', 'max:aiff', 'max:wav', 'mp3_compat:original'])
			expect(options[0]!.label).toBe('Sin convertir · el archivo tal cual (FLAC, MP3…)')
		}
		// La calidad es la del archivo elegido, no la de la cuenta.
		expect(expectedQuality(CD, 'soulseek', 'hires96', HIRES)).toEqual(CD)
		expect(expectedQuality(MP3_128, 'soulseek', 'max', HIRES)).toEqual(MP3_128)
		expect(expectedQuality(CD, 'soulseek', 'mp3_compat', HIRES)).toEqual({ codec: 'mp3', lossless: false, bitrateKbps: 320 })
		expect(expectedQuality(MP3_128, 'soulseek', 'mp3_compat', HIRES)).toEqual(MP3_128)
	})

	it('keeps converting to MP3 where the service only has other lossy audio', () => {
		expect(keys(presetOptions('youtube'))).toEqual(['max:original', 'max:aiff', 'max:wav', 'mp3_compat:original'])
		expect(presetOptions('youtube')[0]!.label).toBe('Sin convertir · AAC ~128 kbps (256 con Premium)')
		// A free Deezer account: its MP3 128 is what "sin convertir" already gives.
		expect(keys(presetOptions('deezer', MP3_128))).toEqual(['max:original', 'max:aiff', 'max:wav'])
	})
})

describe('fitPreset', () => {
	it('moves a choice to the one that gives the same on the service', () => {
		const aiff96 = findPreset('hires96', 'aiff')
		expect(presetKey(fitPreset('qobuz', aiff96, HIRES))).toBe('hires96:aiff')
		expect(presetKey(fitPreset('deezer', aiff96, CD))).toBe('max:aiff')
		expect(presetKey(fitPreset('qobuz', findPreset('mp3_128', 'original'), HIRES))).toBe('mp3_compat:original')
		expect(presetKey(fitPreset('youtube', findPreset('cd', 'original')))).toBe('max:original')
	})
})

describe('findPreset', () => {
	it('finds the closest choice for what settings hold', () => {
		expect(presetKey(findPreset('cd', 'wav'))).toBe('cd:wav')
		expect(presetKey(findPreset('mp3_compat', 'original'))).toBe('mp3_compat:original')
		// Plain MP3 320, from before the selector merged it with "MP3 compatible".
		expect(presetKey(findPreset('mp3_320', 'original'))).toBe('mp3_compat:original')
	})
})

describe('conversions', () => {
	it('knows what each choice converts to', () => {
		expect(conversionTarget('max', 'aiff')).toBe('aiff')
		expect(conversionTarget('cd', 'wav')).toBe('wav')
		expect(conversionTarget('mp3_compat', 'original')).toBe('mp3')
		expect(conversionTarget('max', 'original')).toBeNull()
	})

	it('keeps bit depth and sample rate in AIFF/WAV', () => {
		expect(outputQuality('aiff', HIRES_96)).toEqual({ codec: 'aiff', lossless: true, bitDepth: 24, sampleRateHz: 96000, convertedFrom: HIRES_96 })
		expect(outputQuality('wav', AAC_128)).toMatchObject({ codec: 'wav', bitDepth: 16, sampleRateHz: 44100 })
		expect(outputQuality('original', CD)).toBe(CD)
	})

	it('warns about lossy audio for AIFF/WAV and under 320 kbps for MP3', () => {
		expect(belowTarget('aiff', MP3_128)).toBe(true)
		expect(belowTarget('wav', AAC_128)).toBe(true)
		expect(belowTarget('aiff', CD)).toBe(false)
		// YouTube's AAC becomes a 192 kbps MP3; Qobuz sends its own MP3 320.
		expect(belowTarget('mp3', expectedQuality(AAC_128, 'youtube', 'mp3_compat'))).toBe(true)
		expect(belowTarget('mp3', expectedQuality(HIRES, 'qobuz', 'mp3_compat', HIRES))).toBe(false)
		expect(belowTarget(null, AAC_128)).toBe(false)
	})
})

describe('key and BPM', () => {
	const key = (tonic: number, minor: boolean) => ({ tonic, minor })

	it('shows the key in each notation, with the musical name beside Camelot and Open Key', () => {
		expect(keyLabel(key(9, true), 'camelot')).toEqual({ main: '8A', aside: 'Am' })
		expect(keyLabel(key(6, true), 'openkey')).toEqual({ main: '4m', aside: 'F♯m' })
		expect(keyLabel(key(10, false), 'musical')).toEqual({ main: 'B♭', aside: null })
	})

	it('spells keys as their signatures do', () => {
		expect([1, 3, 6, 8, 10].map((t) => keyName(key(t, false)))).toEqual(['D♭', 'E♭', 'F♯', 'A♭', 'B♭'])
		expect([1, 3, 6, 8, 10].map((t) => keyName(key(t, true)))).toEqual(['C♯m', 'E♭m', 'F♯m', 'G♯m', 'B♭m'])
	})

	it('agrees with the Camelot and Open Key wheels', () => {
		expect(camelot(key(0, false))).toBe('8B')
		expect(camelot(key(8, true))).toBe('1A')
		expect(camelot(key(1, true))).toBe('12A')
		expect(openKey(key(0, false))).toBe('1d')
		expect(openKey(key(9, true))).toBe('1m')
		expect(openKey(key(7, false))).toBe('2d')
	})

	it('colours relative keys alike, the minor ring darker', () => {
		expect(camelotColor(key(9, true))).toMatch(/^hsl\(\d+ 65% 30%\)$/)
		expect(camelotColor(key(0, false))).toMatch(/^hsl\(\d+ 65% 38%\)$/)
		const hue = (c: string) => c.match(/^hsl\((\d+)/)![1]
		expect(hue(camelotColor(key(9, true)))).toBe(hue(camelotColor(key(0, false))))
		expect(hue(camelotColor(key(7, false)))).not.toBe(hue(camelotColor(key(0, false))))
	})

	it('shows the BPM whole when it is, else with one decimal', () => {
		expect(bpmLabel(128)).toBe('128')
		expect(bpmLabel(127.96)).toBe('128')
		expect(bpmLabel(127.5)).toBe('127.5')
		expect(bpmLabel(null)).toBe('')
	})

	it('takes a tempo within 3%, or doubled or halved, as the same', () => {
		expect(sameTempo(124, 125)).toBe(true)
		expect(sameTempo(87, 174)).toBe(true)
		expect(sameTempo(174, 87)).toBe(true)
		expect(sameTempo(128, 124)).toBe(false)
		expect(sameTempo(140, 100)).toBe(false)
	})
})
