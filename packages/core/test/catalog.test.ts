import { describe, expect, it } from 'vitest'
import { findInCatalog } from '../src/match/resolve'
import type { SourceTrack } from '../src/types'

const spotify: SourceTrack[] = [
	{ sourceId: 'sp1', title: 'Get Lucky (feat. Pharrell Williams)', artists: ['Daft Punk', 'Pharrell Williams'], durationMs: 248_000 },
	{ sourceId: 'sp2', title: 'Lose Yourself to Dance', artists: ['Daft Punk'], durationMs: 353_000 },
	{ sourceId: 'sp3', title: 'Instant Crush', artists: ['Daft Punk', 'Julian Casablancas'], durationMs: 337_000 }
]
const search = async (q: string) => spotify.filter((t) => q.toLowerCase().includes('daft punk'))

describe('findInCatalog', () => {
	it('finds a SoundCloud upload with a noisy title in a clean catalog', async () => {
		const upload: SourceTrack = {
			sourceId: '123',
			title: 'Daft Punk - Get Lucky ft. Pharrell Williams [FREE DOWNLOAD]',
			artists: ['Daft Punk'],
			durationMs: 249_000
		}
		expect((await findInCatalog(upload, search))?.sourceId).toBe('sp1')
	})

	it('is null when the catalog only has other songs by the artist', async () => {
		const other: SourceTrack = { sourceId: '9', title: 'Around the World', artists: ['Daft Punk'], durationMs: 429_000 }
		expect(await findInCatalog(other, search)).toBeNull()
	})

	it('throws when the service could not be searched at all', async () => {
		const down = async () => {
			throw new Error('sin conexión')
		}
		await expect(findInCatalog(spotify[0]!, down)).rejects.toThrow('sin conexión')
	})
})
