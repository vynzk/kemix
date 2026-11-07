import type { AccountIdentity, SourcePlaylist, SourceService, SourceTrack, StreamPreview } from '../types'

/** Imports a user's playlists from a streaming service, and can search its catalog and create playlists in it. */
export interface SourceConnector {
	readonly service: SourceService
	/** Who the connector is signed in as, so the user can check it's the right account. */
	identity(): Promise<AccountIdentity>
	listPlaylists(): Promise<SourcePlaylist[]>
	getPlaylistTracks(playlistId: string): Promise<SourceTrack[]>
	search(query: string, limit: number): Promise<SourceTrack[]>
	/** Create a playlist in the user's account with these tracks (service ids, in order). Returns its id. */
	createPlaylist(name: string, trackIds: string[]): Promise<string>
	/** Audio to listen to a track (service id) in the app, if the service gives one. */
	stream?(trackId: string): Promise<StreamPreview | null>
}
