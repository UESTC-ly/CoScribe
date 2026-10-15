import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

const appRoot = path.resolve(import.meta.dirname, '../..')
const packagedExecutable = process.env.COSCRIBE_E2E_EXECUTABLE
let application: ElectronApplication
let page: Page
let projectPath: string
let userDataPath: string

async function launch(): Promise<void> {
  application = await electron.launch({
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    args: packagedExecutable ? ['--project', projectPath] : [appRoot, '--project', projectPath],
    env: { ...process.env, NODE_ENV: 'test', COSCRIBE_USER_DATA_DIR: userDataPath }
  })
  page = await application.firstWindow()
  await page.waitForFunction(() => Boolean(window.coscribe))
  await expect(page.locator('.app-titlebar__project strong')).toHaveText(path.basename(projectPath))
}

test.beforeEach(async () => {
  projectPath = await mkdtemp(path.join(os.tmpdir(), 'coscribe-prediction-project-'))
  userDataPath = await mkdtemp(path.join(os.tmpdir(), 'coscribe-prediction-data-'))
  await writeFile(path.join(projectPath, 'README.md'), '# 上下文快照\n\n发送时记录文档和选区。')
  await launch()
})

test.afterEach(async () => {
  await application?.close().catch(() => undefined)
  await rm(projectPath, { recursive: true, force: true })
  await rm(userDataPath, { recursive: true, force: true })
})

for (const protocol of ['chat-completions', 'responses'] as const) {
  test(`streams and restores predictions through ${protocol}, then accepts, edits and sends`, async ({}, testInfo) => {
    type Message = { role: string; content: string }
    type Body = { messages?: Message[]; input?: Message[] }
    const bodies: Body[] = []
    const messages = (body: Body): Message[] => body.input ?? body.messages ?? []
    const prediction = '请给出一个保存和恢复上下文快照的例子。'
    const nextPrediction = '这个例子怎样处理未保存的修改？'
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      // Mimic gateways that forward input messages but ignore top-level instructions.
      const system = messages(bodies.at(-1)!)[0]
      const hasPredictionRules = system?.role === 'system' && system.content.includes('<coscribe_next_request>')
      const parts = [
        `PREDICTION_REPLY_${bodies.length}：快照保存了提问时的状态。\n`,
        ...(hasPredictionRules ? [
          '<coscribe_next_',
          'request>',
          bodies.length === 1 ? prediction : nextPrediction,
          '</coscribe_next_',
          'request>'
        ] : [])
      ]
      for (const content of parts) {
        const event = protocol === 'responses'
          ? { type: 'response.output_text.delta', delta: content }
          : { choices: [{ delta: { content } }] }
        response.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      response.end('data: [DONE]\n\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as AddressInfo).port
      await page.evaluate(async ({ port, protocol }) => {
        const settings = await window.coscribe.settings.get()
        await window.coscribe.settings.save({
          ...settings, autoTitle: false,
          aiProfiles: settings.aiProfiles.map((profile) => profile.id === settings.activeAiProfileId
            ? { ...profile, baseUrl: `http://127.0.0.1:${port}/v1`, apiProtocol: protocol, model: 'prediction-test' } : profile)
        })
      }, { port, protocol })
      await page.reload()
      const input = () => page.getByRole('textbox', { name: '向 AI 提问' })
      await input().fill('上下文快照有什么用？')
      await input().press('Enter')
      await expect(page.getByText('PREDICTION_REPLY_1：快照保存了提问时的状态。')).toBeVisible()
      await expect(page.getByRole('button', { name: '接受下一次请求预测' })).toBeVisible()
      await expect(input()).toHaveValue('')
      await expect(page.locator('.ai-composer__prediction')).toHaveText(prediction)
      await expect(page.locator('.ai-message__body').last()).not.toContainText('coscribe_next_request')
      await expect(page.locator('.ai-message__body').last()).not.toContainText(prediction)
      await input().press('Enter')
      expect(bodies).toHaveLength(1)

      await expect.poll(async () => {
        const sessions = JSON.parse(await readFile(path.join(projectPath, '.coscribe', 'sessions.json'), 'utf8')) as Array<{ messages: Array<{ nextRequest?: string }> }>
        return sessions.flatMap((session) => session.messages).some((message) => message.nextRequest === prediction)
      }).toBe(true)
      await application.close()
      await launch()
      await expect(page.locator('.ai-composer__prediction')).toHaveText(prediction)
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
      await page.screenshot({ path: testInfo.outputPath('next-request-light.png') })
      await page.locator('.ai-composer-wrap').screenshot({ path: testInfo.outputPath('next-request-composer.png') })
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
      await page.screenshot({ path: testInfo.outputPath('next-request-dark.png') })

      await input().click()
      await input().press('Tab')
      await expect(input()).toHaveValue(prediction)
      await expect(input()).toBeFocused()
      expect(bodies).toHaveLength(1)
      await input().press('End')
      await input().pressSequentially('请使用 TypeScript。')
      const accepted = `${prediction}请使用 TypeScript。`
      await input().press('Enter')
      await expect(page.getByText('PREDICTION_REPLY_2：快照保存了提问时的状态。')).toBeVisible()
      expect(bodies).toHaveLength(2)
      expect(messages(bodies[1]).at(-1)?.content).toContain(accepted)
      expect(messages(bodies[1]).filter((message) => message.role === 'assistant').at(-1)?.content).not.toContain(prediction)
      expect(messages(bodies[1]).filter((message) => message.role === 'system')).toHaveLength(1)
      await expect(page.locator('.ai-composer__prediction')).toHaveText(nextPrediction)
      await input().press('Escape')
      await expect(page.locator('.ai-composer__prediction')).toHaveCount(0)
      await expect(input()).toHaveValue('')
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
}
