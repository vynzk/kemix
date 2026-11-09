import { describe, expect, it } from 'vitest'
import { ffmpegAsset, mp3Args } from '../src/download/ffmpeg'

describe('ffmpegAsset', () => {
	it('picks the static build for each platform', () => {
		expect(ffmpegAsset('win32', 'x64')?.url).toMatch(/\/ffmpeg-win32-x64\.gz$/)
		// Windows on ARM runs the x64 build.
		expect(ffmpegAsset('win32', 'arm64')?.url).toMatch(/\/ffmpeg-win32-x64\.gz$/)
		expect(ffmpegAsset('linux', 'x64')?.url).toMatch(/\/ffmpeg-linux-x64\.gz$/)
		expect(ffmpegAsset('linux', 'arm64')?.sha256).toMatch(/^[a-f0-9]{64}$/)
		expect(ffmpegAsset('win32', 'ia32')).toBeNull()
		expect(ffmpegAsset('freebsd', 'x64')).toBeNull()
	})
})

describe('mp3Args', () => {
	it('writes a constant-bitrate 44.1 kHz stereo MP3, audio only', () => {
		const args = mp3Args('in.flac', 'out.part', true)
		expect(args.slice(-2)).toEqual(['mp3', 'out.part'])
		expect(args.join(' ')).toContain('-i in.flac')
		expect(args.join(' ')).toContain('-c:a libmp3lame -b:a 320k -ar 44100 -ac 2')
		expect(args).toContain('-vn')
		// Lossy sources don't gain anything from 320 kbps.
		expect(mp3Args('in.m4a', 'out.part', false).join(' ')).toContain('-b:a 192k')
	})
})
