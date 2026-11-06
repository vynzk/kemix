import type { AccountIdentity, SourcePlaylist, SourceService, SourceTrack } from '../types'

/** Imports a user's playlists from a streaming service. */
export interface SourceConnector {
	readonly service: SourceService
	/** Who the connector is signed in as, so the user can check it's the right account. */
	identity(): Promise<AccountIdentity>
	listPlaylists(): Promise<SourcePlaylist[]>
	getPlaylistTracks(playlistId: string): Promise<SourceTrack[]>
}
