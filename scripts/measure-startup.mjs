import { _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const appRoot = path.resolve(import.meta.dirname, '..')
const projectPath = await mkdtemp(path.join(os.tmpdir(), 'coscribe-perf-project-'))
const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'coscribe-perf-user-data-'))
let electronApp

try {
  await writeFile(path.join(projectPath, 'README.md'), '# Startup benchmark\n\nA small Markdown project.\n')
  electronApp = await electron.launch({
    args: [appRoot, '--project', projectPath],
    env: { ...process.env, NODE_ENV: 'test', COSCRIBE_USER_DATA_DIR: userDataPath }
  })
  const page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.coscribe))
  await page.waitForTimeout(1_500)

  const metrics = await electronApp.evaluate(({ app }) => app.getAppMetrics().map((metric) => ({
    type: metric.type,
    workingSetKb: metric.memory.workingSetSize,
    peakWorkingSetKb: metric.memory.peakWorkingSetSize
  })))
  const workingSetKb = metrics.reduce((total, metric) => total + metric.workingSetKb, 0)
  process.stdout.write(`${JSON.stringify({ workingSetKb, metrics }, null, 2)}\n`)
} finally {
  await electronApp?.close().catch(() => undefined)
  await rm(projectPath, { recursive: true, force: true })
  await rm(userDataPath, { recursive: true, force: true })
}
