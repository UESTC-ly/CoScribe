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
  await writeFile(path.join(projectPath, 'main.py'), 'print("packaged IDE")\n')

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
    await page.setViewportSize({ width: 900, height: 700 })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.coscribe))
    await expect(page).toHaveTitle('CoScribe')
    await expect(page.locator('.app-titlebar__project strong')).toHaveText(path.basename(projectPath))
    expect(await page.evaluate(() => ({
      completeCode: 'completeCode' in window.coscribe.ai,
      cancelCodeCompletion: 'cancelCodeCompletion' in window.coscribe.ai,
      onCodeCompletionStream: 'onCodeCompletionStream' in window.coscribe.ai
    }))).toEqual({
      completeCode: false,
      cancelCodeCompletion: false,
      onCodeCompletionStream: false
    })
    await page.locator('.app-titlebar__actions').getByRole('button', { name: '设置' }).click()
    await page.getByRole('button', { name: /AI 行为/u }).click()
    await expect(page.getByText('启用 AI 代码补全')).toHaveCount(0)
    await expect(page.getByLabel('代码补全模型')).toHaveCount(0)
    await page.getByRole('button', { name: '取消' }).click()
    await page.getByRole('button', { name: 'IDE', exact: true }).click()
    await expect(page.getByRole('region', { name: 'IDE 工作区' })).toBeVisible()
    await expect(page.locator('.ai-workspace')).toBeVisible()
    await page.locator('.tree-row').filter({ hasText: 'main.py' }).dblclick()
    await expect(page.getByRole('region', { name: 'Python 代码编辑器' })).toBeVisible()
    await page.getByRole('button', { name: '打开终端', exact: true }).click()
    await expect(page.getByRole('button', { name: '配置 AI Shell', exact: true })).toBeVisible()
    await page.locator('.terminal-panel .xterm-screen').click()
    await page.keyboard.type('node -e "console.log(6*7)"')
    await page.keyboard.press('Enter')
    await expect(page.locator('.terminal-panel .xterm-rows')).toContainText('42', { timeout: 15_000 })
  } finally {
    await app.close().catch(() => undefined)
    await rm(projectPath, { recursive: true, force: true })
    await rm(userDataPath, { recursive: true, force: true })
  }
})
