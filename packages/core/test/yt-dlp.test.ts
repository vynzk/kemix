import { describe, expect, it } from 'vitest'
import { parseSha256Sums, ytDlpAsset } from '../src/sources/yt-dlp'

describe('ytDlpAsset', () => {
	it('picks the standalone build for each platform', () => {
		expect(ytDlpAsset('win32', 'x64')).toBe('yt-dlp.exe')
		expect(ytDlpAsset('win32', 'arm64')).toBe('yt-dlp_arm64.exe')
		expect(ytDlpAsset('linux', 'x64')).toBe('yt-dlp_linux')
		expect(ytDlpAsset('linux', 'arm64')).toBe('yt-dlp_linux_aarch64')
		expect(ytDlpAsset('darwin', 'arm64')).toBe('yt-dlp_macos')
	})
	it('returns null where yt-dlp publishes no standalone build', () => {
		expect(ytDlpAsset('linux', 'ia32')).toBeNull()
		expect(ytDlpAsset('freebsd', 'x64')).toBeNull()
	})
})

describe('parseSha256Sums', () => {
	it('reads the release checksum file', () => {
		const a = 'e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3'
		const b = 'F5389D3698ECDE4EF06F4E6B1CE0294FE9AC1396228C8990B8D3416D6D177A7D'
		const sums = parseSha256Sums(`${a}  yt-dlp\r\n${b} *yt-dlp.exe\n\nnot a checksum line\n`)
		expect(sums.get('yt-dlp')).toBe(a)
		expect(sums.get('yt-dlp.exe')).toBe(b.toLowerCase())
		expect(sums.size).toBe(2)
	})
})
