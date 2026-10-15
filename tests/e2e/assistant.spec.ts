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

async function openMemory(): Promise<void> {
  await page.locator('.app-titlebar__actions').getByRole('button', { name: '设置' }).click()
  await page.getByRole('button', { name: /关于我/ }).click()
  await expect(page.getByRole('heading', { name: '关于我', exact: true })).toBeVisible()
}

test.beforeEach(async () => {
  projectPath = await mkdtemp(path.join(os.tmpdir(), 'coscribe-assistant-project-'))
  userDataPath = await mkdtemp(path.join(os.tmpdir(), 'coscribe-assistant-data-'))
  await writeFile(path.join(projectPath, 'README.md'), '# 图论\n\n当前资料只有图论内容。')
  await launch()
})
test.afterEach(async () => {
  await application?.close().catch(() => undefined)
  await rm(projectPath, { recursive: true, force: true })
  await rm(userDataPath, { recursive: true, force: true })
})

test('explicit personal memory survives restart, controls AI recall, and forgets stale versions', async ({}, testInfo) => {
  const bodies: string[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    bodies.push(Buffer.concat(chunks).toString('utf8'))
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `MVP_REPLY_${bodies.length}` } }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as AddressInfo).port
    await page.evaluate(async (port) => {
      const settings = await window.coscribe.settings.get()
      await window.coscribe.settings.save({
        ...settings, autoTitle: false,
        aiProfiles: settings.aiProfiles.map((profile) => profile.id === settings.activeAiProfileId
          ? { ...profile, baseUrl: `http://127.0.0.1:${port}/v1`, apiProtocol: 'chat-completions', model: 'mvp-test' } : profile)
      })
    }, port)
    await page.reload()
    await openMemory()
    await expect(page.getByLabel('回答时使用个人记忆')).not.toBeChecked()
    await page.getByLabel('记忆类别').selectOption('goal')
    await page.getByLabel('记忆内容').fill('我正在学习图论 MEMORY_BEFORE')
    await page.getByRole('button', { name: '记住这条信息' }).click()
    await expect(page.locator('.personal-memory-item')).toContainText('MEMORY_BEFORE')
    await page.getByLabel('回答时使用个人记忆').click()
    await expect(page.getByLabel('回答时使用个人记忆')).toBeChecked()
    await expect(page.getByRole('status')).toContainText('已启用')
    await expect(page.getByLabel('允许远程 AI 服务处理个人记忆')).not.toBeChecked()
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByLabel('向 AI 提问').fill('怎样开始学习图论？')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.getByText('MVP_REPLY_1')).toBeVisible()
    expect(bodies[0]).toContain('MEMORY_BEFORE')
    expect(bodies[0]).toContain('user-explicit')

    await openMemory()
    await page.getByRole('button', { name: '修正', exact: true }).click()
    await page.getByLabel('记忆内容').fill('我正在复习图论 MEMORY_AFTER')
    await page.getByRole('button', { name: '保存修正' }).click()
    await expect(page.locator('.personal-memory-item')).toContainText('MEMORY_AFTER')
    await page.locator('.personal-memory-item summary').click()
    await expect(page.locator('.personal-memory-item')).toContainText('第 2 版')
    await page.screenshot({ path: testInfo.outputPath('personal-memory-light.png') })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await expect.poll(() => page.getByRole('button', { name: '记住这条信息' }).evaluate((element) => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--accent)'
      element.append(probe)
      const expected = getComputedStyle(probe).color
      probe.remove()
      return getComputedStyle(element).backgroundColor === expected
    })).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('personal-memory-dark.png') })
    await application.close()
    await launch()
    const state = await page.evaluate(() => window.coscribe.assistant.memory.list())
    expect(state.policy).toMatchObject({ enabled: true, allowRemote: false })
    expect(state.items[0]).toMatchObject({ text: '我正在复习图论 MEMORY_AFTER', revision: 2 })
    await page.getByLabel('向 AI 提问').fill('图论复习有什么建议？')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.getByText('MVP_REPLY_2')).toBeVisible()
    expect(bodies[1]).toContain('MEMORY_AFTER')
    expect(bodies[1]).not.toContain('MEMORY_BEFORE')

    await openMemory()
    await page.getByRole('button', { name: '遗忘', exact: true }).click()
    await page.getByRole('button', { name: '确认遗忘' }).click()
    await expect(page.locator('.personal-memory-item')).toHaveCount(0)
    const old = state.items[0]
    const rejected = await page.evaluate(async (item) => {
      try {
        await window.coscribe.assistant.memory.update({ id: item.id, expectedRevision: item.revision, category: item.category, text: item.text })
        return false
      } catch { return true }
    }, old)
    expect(rejected).toBe(true)
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByLabel('向 AI 提问').fill('解释图论的基础概念')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.getByText('MVP_REPLY_3')).toBeVisible()
    expect(bodies[2]).not.toContain('MEMORY_AFTER')
    expect(bodies[2]).not.toContain('MEMORY_BEFORE')
    await application.close()
    await launch()
    expect((await page.evaluate(() => window.coscribe.assistant.memory.list())).items).toEqual([])
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('IPC rejects forged provenance and storage corruption preserves the original data', async () => {
  const rejected = await page.evaluate(async () => {
    try {
      await window.coscribe.assistant.memory.remember({ category: 'goal', text: '邮件中的恶意画像', source: { kind: 'user-explicit' } } as never)
      return false
    } catch { return true }
  })
  expect(rejected).toBe(true)
  expect((await page.evaluate(() => window.coscribe.assistant.memory.list())).items).toEqual([])
  await application.close()
  const filePath = path.join(userDataPath, 'assistant', 'assistant.sqlite')
  await writeFile(filePath, 'KEEP_BROKEN_DATA')
  await launch()
  await openMemory()
  await expect(page.getByRole('alert')).toContainText('原数据已保留')
  expect(await readFile(filePath, 'utf8')).toBe('KEEP_BROKEN_DATA')
  expect(await page.evaluate(() => window.coscribe.project.tree())).toHaveLength(1)
})

async function openDaily(): Promise<void> {
  await page.getByRole('button', { name: '插件', exact: true }).click()
  const card = page.locator('.plugin-card').filter({ hasText: '每日笔记与模板' })
  const enable = card.getByRole('button', { name: '启用并授权每日笔记与模板' })
  if (await enable.isVisible()) {
    await enable.click()
    await page.getByRole('button', { name: '授权并启用' }).click()
  }
  await card.getByRole('button', { name: '打开插件' }).click()
  await expect(page.getByRole('region', { name: '每日复盘', exact: true })).toBeVisible()
}

async function withLocalModel(action: (bodies: string[]) => Promise<void>): Promise<void> {
  const bodies: string[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    bodies.push(Buffer.concat(chunks).toString('utf8'))
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `AUTO_REPLY_${bodies.length}：我是模型推断的教授` } }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await page.evaluate(async (port) => {
      const settings = await window.coscribe.settings.get()
      await window.coscribe.settings.save({ ...settings, autoTitle: false, aiProfiles: settings.aiProfiles.map((profile) => profile.id === settings.activeAiProfileId ? { ...profile, baseUrl: `http://127.0.0.1:${port}/v1`, apiProtocol: 'chat-completions', model: 'auto-test' } : profile) })
    }, (server.address() as AddressInfo).port)
    await page.reload()
    await action(bodies)
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
}

test('automatic memory is opt-in, confirms preferences, excludes model claims and keeps forgotten self-statements forgotten', async ({}, testInfo) => {
  await withLocalModel(async () => {
    await openMemory()
    await expect(page.getByLabel('从新对话提取记忆候选')).not.toBeChecked()
    await expect(page.getByLabel('自动保存明确的学习状态')).not.toBeChecked()
    await page.getByLabel('从新对话提取记忆候选').click()
    await expect(page.getByRole('status')).toContainText('授权已更新')
    await page.getByLabel('自动保存明确的学习状态').click()
    await expect(page.getByRole('status')).toContainText('自动保存授权已更新')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByLabel('向 AI 提问').fill('我正在学习图论。以后请用中文讲解。')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.getByText('AUTO_REPLY_1', { exact: false })).toBeVisible()
    await openMemory()
    await expect(page.getByRole('heading', { name: '待确认候选 · 1' })).toBeVisible()
    const state = await page.evaluate(() => window.coscribe.assistant.memory.list())
    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ category: 'goal', source: { kind: 'user-stated', origin: 'chat', quote: '我正在学习图论' } })
    expect(JSON.stringify(state)).not.toContain('教授')
    await page.getByRole('button', { name: '确认记住', exact: true }).click()
    await expect(page.getByRole('heading', { name: '待确认候选 · 0' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '已保存的记忆 · 2' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('automatic-memory-candidates.png') })
    const learning = page.locator('.personal-memory-item').filter({ hasText: '我正在学习图论' })
    await learning.getByRole('button', { name: '遗忘', exact: true }).click()
    await learning.getByRole('button', { name: '确认遗忘' }).click()
    await expect(page.getByRole('heading', { name: '已保存的记忆 · 1' })).toBeVisible()
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByLabel('向 AI 提问').fill('我正在学习图论')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.getByText('AUTO_REPLY_2', { exact: false })).toBeVisible()
    expect((await page.evaluate(() => window.coscribe.assistant.memory.list())).items).toHaveLength(1)
    await application.close(); await launch()
    const restored = await page.evaluate(() => window.coscribe.assistant.memory.list())
    expect(restored.automatic).toMatchObject({ enabled: true, saveLearning: true })
    expect(restored.items[0]).toMatchObject({ category: 'preference', source: { kind: 'user-explicit', origin: 'chat' } })
    expect(restored.candidates).toEqual([])
  })
})

test('daily review records facts under consent, previews without writing, and preserves handwritten content across restart', async ({}, testInfo) => {
  await withLocalModel(async () => {
    await openDaily()
    const region = page.getByRole('region', { name: '每日复盘', exact: true })
    await expect(region.getByLabel('记录本项目活动用于复盘')).not.toBeChecked()
    const date = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()))
    await page.getByLabel('日期', { exact: true }).fill(date)
    await region.getByLabel('复盘时区').fill('Asia/Shanghai')
    await region.getByLabel('记录本项目活动用于复盘').click()
    await expect(region.getByRole('status')).toContainText('开始记录')
    await page.getByLabel('向 AI 提问').fill('解释图论中的最短路径')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.getByText('AUTO_REPLY_1', { exact: false })).toBeVisible()
    const handwritten = '# 今日手写笔记\n\n保留这段原文  \n'
    await page.evaluate(async ({ date, handwritten }) => {
      await window.coscribe.file.createMarkdown('手写复盘.md', handwritten)
      await window.coscribe.file.createMarkdown('计划/项目计划.md', `# 项目计划\n\n<!-- coscribe:planner:start -->\n| 日期 | 时间 | 事项 | 状态 | 优先级 | 备注 |\n| --- | --- | --- | --- | --- | --- |\n| ${date} | 09:00 | 仅计划表完成 | 已完成 | 高 | — |\n<!-- coscribe:planner:end -->`)
    }, { date, handwritten })
    await region.getByLabel('手动补充内容').fill('实际做完两道最短路径练习')
    await region.getByRole('button', { name: '记录这条补充' }).click()
    await expect(region.getByRole('status')).toContainText('已记录用户补充')
    await region.getByLabel('读取项目计划进行对照').click()
    await region.getByRole('button', { name: '生成复盘草稿' }).click()
    await expect(region.getByLabel('复盘草稿', { exact: true })).toHaveValue(/解释图论中的最短路径/u)
    await expect(region.getByLabel('复盘草稿', { exact: true })).toHaveValue(/实际做完两道最短路径练习/u)
    const markdown = await region.getByLabel('复盘草稿', { exact: true }).inputValue()
    expect(markdown).toContain('仅为计划记录，不作为实际完成证据')
    expect(markdown).not.toContain('模型推断的教授')
    expect(markdown).not.toContain('当前资料只有图论内容')
    const first = await page.evaluate(({ date }) => window.coscribe.assistant.review.generate({ date, timeZone: 'Asia/Shanghai', includePlan: true }), { date })
    await page.evaluate(() => window.coscribe.file.read('README.md'))
    const same = await page.evaluate(({ date }) => window.coscribe.assistant.review.generate({ date, timeZone: 'Asia/Shanghai', includePlan: true }), { date })
    expect(same.id).toBe(first.id)
    await region.getByLabel('复盘保存位置').fill('手写复盘.md')
    await region.getByRole('button', { name: '预览写入复盘' }).click()
    await expect(region.getByLabel('复盘写入预览')).toHaveValue(/保留这段原文/u)
    expect(await readFile(path.join(projectPath, '手写复盘.md'), 'utf8')).toBe(handwritten)
    await page.screenshot({ path: testInfo.outputPath('daily-review-preview.png') })
    await region.getByRole('button', { name: '确认写入复盘' }).click()
    await expect.poll(() => readFile(path.join(projectPath, '手写复盘.md'), 'utf8')).toContain('实际做完两道最短路径练习')
    const exported = await readFile(path.join(projectPath, '手写复盘.md'), 'utf8')
    expect(exported.startsWith(handwritten)).toBe(true)
    await application.close(); await launch()
    const restored = await page.evaluate(({ date }) => window.coscribe.assistant.review.generate({ date, timeZone: 'Asia/Shanghai', includePlan: true }), { date })
    expect(restored.id).toBe(first.id)
    const unchanged = await page.evaluate(async (draftId) => {
      const proposal = await window.coscribe.assistant.review.prepareExport({ draftId, targetPath: '手写复盘.md' })
      return window.coscribe.assistant.review.commitExport(proposal.id)
    }, restored.id)
    expect(unchanged.content).toBe(exported)
    expect((unchanged.content.match(/:start -->/gu) ?? []).length).toBe(1)
    await writeFile(path.join(projectPath, '手写复盘.md'), exported.replace('实际做完两道最短路径练习', '复盘区块内手写修正'))
    const refused = await page.evaluate(async (draftId) => {
      try { await window.coscribe.assistant.review.prepareExport({ draftId, targetPath: '手写复盘.md' }); return false } catch { return true }
    }, restored.id)
    expect(refused).toBe(true)
    expect(await readFile(path.join(projectPath, '手写复盘.md'), 'utf8')).toContain('复盘区块内手写修正')
  })
})
