import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const packagedExecutable = process.env.COSCRIBE_E2E_EXECUTABLE

test('launches the packaged application and opens a project', async () => {
  test.skip(!packagedExecutable, 'This smoke test requires a packaged executable path.')

  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'coscribe-package-smoke-'))
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'coscribe-package-user-data-'))
  await writeFile(path.join(projectPath, 'README.md'), '# CoScribe smoke test\n')

  const app = await electron.launch({
    executablePath: packagedExecutable,
    args: ['--project', projectPath],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      COSCRIBE_USER_DATA_DIR: userDataPath,
      COSCRIBE_E2E_SCREENSHOT_SOURCE: 'app-window'
    }
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.coscribe))
    await expect(page).toHaveTitle('CoScribe')
    await expect(page.locator('.app-titlebar__project strong')).toHaveText(path.basename(projectPath))
  } finally {
    await app.close().catch(() => undefined)
    await rm(projectPath, { recursive: true, force: true })
    await rm(userDataPath, { recursive: true, force: true })
  }
})
