import { chmod, readdir } from 'node:fs/promises'
import path from 'node:path'

const nodePtyRoot = path.resolve(import.meta.dirname, '..', 'node_modules', 'node-pty')
const candidates = [path.join(nodePtyRoot, 'build', 'Release', 'spawn-helper')]

try {
  for (const name of await readdir(path.join(nodePtyRoot, 'prebuilds'))) {
    candidates.push(path.join(nodePtyRoot, 'prebuilds', name, 'spawn-helper'))
  }
} catch {
  // node-pty may have been built from source without a prebuilds directory.
}

let updated = 0
for (const helper of candidates) {
  try {
    await chmod(helper, 0o755)
    updated += 1
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

if (process.platform !== 'win32' && updated === 0) {
  throw new Error('node-pty spawn-helper was not found after dependency installation.')
}

if (updated > 0) {
  process.stdout.write(`Prepared ${updated} node-pty spawn-helper executable${updated === 1 ? '' : 's'}.\n`)
}
