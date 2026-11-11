// Hook PostToolUse (Write|Edit): tras cada edición pasa Biome al archivo (solo errores) y, si es .ts/.tsx, tsc en su
// workspace y en los que dependen de él. Devuelve los problemas a Claude. Si algo falla en el propio hook, no bloquea.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const biome = path.join(root, 'node_modules', '@biomejs', 'biome', 'bin', 'biome')

// Workspace → workspaces a revisar (él mismo y los que lo importan).
const AFFECTED = {
	'packages/core': ['packages/core', 'packages/server', 'packages/ui', 'apps/desktop'],
	'packages/server': ['packages/server', 'apps/desktop'],
	'packages/ui': ['packages/ui'],
	'apps/desktop': ['apps/desktop']
}

const run = (bin, args) => spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' })

function lint(file) {
	if (!fs.existsSync(biome)) return []
	const r = run(biome, [
		'lint',
		'--diagnostic-level=error',
		'--max-diagnostics=20',
		'--colors=off',
		'--files-ignore-unknown=true',
		'--no-errors-on-unmatched',
		file
	])
	return r.status === 0 ? [] : [`biome lint:\n${(r.stdout + r.stderr).trim()}`]
}

function typecheck(rel) {
	if (!/\.(ts|tsx|mts)$/.test(rel) || !fs.existsSync(tsc)) return []
	const ws = Object.keys(AFFECTED).find((w) => rel.startsWith(`${w}/`))
	// Los tests no entran en los tsconfig (include: src), así que no hay nada que revisar.
	if (!ws || rel.startsWith(`${ws}/test/`)) return []
	// Un error en core sale igual en cada workspace que lo importa: se muestra una sola vez.
	const errors = new Set()
	for (const project of AFFECTED[ws]) {
		const r = run(tsc, ['-p', project, '--pretty', 'false'])
		if (r.status === 0) continue
		for (const line of (r.stdout + r.stderr).split(/\r?\n/)) if (line.trim()) errors.add(line)
	}
	return errors.size ? [`tsc:\n${[...errors].join('\n')}`] : []
}

function main() {
	const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '') || '{}')
	const file = input.tool_input?.file_path ?? input.tool_response?.filePath
	if (!file) return
	const abs = path.resolve(file)
	const rel = path.relative(root, abs).split(path.sep).join('/')
	if (rel.startsWith('..') || path.isAbsolute(rel)) return

	const problems = [...lint(abs), ...typecheck(rel)]
	if (!problems.length) return

	const lines = problems.join('\n\n').split(/\r?\n/)
	const text = lines.length > 80 ? [...lines.slice(0, 80), `… (${lines.length - 80} líneas más)`].join('\n') : lines.join('\n')
	process.stdout.write(JSON.stringify({ decision: 'block', reason: `Problemas tras editar ${rel}:\n${text}` }))
}

try {
	main()
} catch {
	// Un fallo del hook no debe frenar la edición.
}
