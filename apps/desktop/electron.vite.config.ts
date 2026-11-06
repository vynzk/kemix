import { defineConfig } from 'electron-vite'

export default defineConfig({
	main: {
		build: {
			// Our own workspace packages are TypeScript sources: bundle them. Everything else stays in node_modules.
			externalizeDeps: { exclude: ['@kemix/core', '@kemix/server'] },
			rolldownOptions: { input: { main: 'src/main.ts' } }
		}
	}
})
