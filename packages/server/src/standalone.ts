// Runs the backend as a plain Node server (dev:web, or a future hosted deployment).
import path from 'node:path'
import { Kemix, passphraseCipher } from '@kemix/core'
import { createServer } from './index'

const dataDir = path.resolve(process.env.KEMIX_DATA_DIR ?? '.kemix-data')
const secret = process.env.KEMIX_SECRET
if (!secret) console.warn('[kemix] KEMIX_SECRET no está definido: usando una clave de desarrollo para cifrar credenciales.')

const kemix = new Kemix({ dataDir, cipher: passphraseCipher(secret ?? 'kemix-dev-insecure') })
const port = Number(process.env.KEMIX_PORT ?? kemix.settings.get().port)
const app = await createServer({
	kemix,
	uiDir: process.env.KEMIX_UI_DIR,
	token: process.env.KEMIX_TOKEN,
	logger: true
})
kemix.start()
await app.listen({ host: process.env.KEMIX_HOST ?? '127.0.0.1', port })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, async () => {
		await app.close()
		kemix.close()
		process.exit(0)
	})
}
