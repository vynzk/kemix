import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const apiTarget = `http://127.0.0.1:${process.env.KEMIX_PORT ?? 47800}`

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		port: 5180,
		strictPort: true,
		proxy: { '/api': { target: apiTarget, changeOrigin: false } }
	},
	build: { outDir: 'dist', emptyOutDir: true }
})
