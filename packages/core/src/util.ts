export const now = () => Date.now()

export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message
	return String(err)
}

export async function fetchJson<T>(url: string | URL, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init)
	const text = await res.text()
	if (!res.ok) {
		throw new HttpError(res.status, `${res.status} ${res.statusText} — ${text.slice(0, 300)}`)
	}
	return (text ? JSON.parse(text) : null) as T
}

export class HttpError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message)
	}
}

/** The service no longer accepts the stored session (expired or revoked cookies/token): the user has to reconnect. */
export class SessionExpiredError extends Error {}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Pick the largest image from a list of {url,width}. */
export function largest<T extends { url: string; width?: number | null }>(images: T[] | undefined | null): string | undefined {
	if (!images?.length) return undefined
	return [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]!.url
}
