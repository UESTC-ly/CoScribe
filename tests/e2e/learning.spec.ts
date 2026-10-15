import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { parseFlashcards } from '../../src/plugins/flashcards/flashcard-utils'

const appRoot = path.resolve(import.meta.dirname, '../..')
let application: ElectronApplication
let page: Page
let projectPath: string
let userDataPath: string
async function launch(): Promise<void> {
  application = await electron.launch({ args: [appRoot, '--project', projectPath], env: { ...process.env, NODE_ENV: 'test', COSCRIBE_USER_DATA_DIR: userDataPath } })
  page = await application.firstWindow()
  await page.waitForFunction(() => Boolean(window.coscribe))
  await expect(page.locator('.app-titlebar__project strong')).toHaveText(path.basename(projectPath))
}
async function openReview(): Promise<void> {
  const existing = page.getByRole('region', { name: '个人学习与复习', exact: true })
  if (await existing.isVisible()) {
    await existing.getByRole('button', { name: '刷新学习库' }).click()
    return
  }
  const pluginButton = page.getByRole('button', { name: '插件', exact: true })
  if (await pluginButton.getAttribute('aria-pressed') !== 'true') await pluginButton.click()
  const card = page.locator('.plugin-card').filter({ hasText: '闪卡与间隔复习' })
  if (await card.getByRole('button', { name: '启用并授权闪卡与间隔复习' }).count()) {
    await card.getByRole('button', { name: '启用并授权闪卡与间隔复习' }).click()
    await page.getByRole('button', { name: '授权并启用' }).click()
  }
  await card.getByRole('button', { name: /打开插件|正在使用/ }).click()
  await expect(page.getByRole('region', { name: '个人学习与复习', exact: true })).toBeVisible()
}
test.beforeEach(async () => {
  projectPath = await realpath(await mkdtemp(path.join(os.tmpdir(), 'coscribe-learning-project-')))
  userDataPath = await mkdtemp(path.join(os.tmpdir(), 'coscribe-learning-data-'))
  await writeFile(path.join(projectPath, 'README.md'), '# 图论\n\n最短路径可用于路由。')
  await launch()
})
test.afterEach(async () => {
  await application?.close().catch(() => undefined)
  await rm(projectPath, { recursive: true, force: true })
  await rm(userDataPath, { recursive: true, force: true })
})

test('reading source, distinct learning status, confirmed relationships and manual review survive restart', async ({ }, testInfo) => {
  await openReview()
  let region = page.getByRole('region', { name: '个人学习与复习', exact: true })
  await region.getByLabel('知识点名称').fill('最短路径')
  await region.getByLabel('所属领域').fill('图论')
  await region.getByRole('button', { name: '创建知识点', exact: true }).click()
  await expect(region.getByRole('status')).toContainText('已创建')
  await region.getByLabel('知识点名称').fill('矩阵乘法')
  await region.getByRole('button', { name: '创建知识点', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => window.coscribe.assistant.learning.inspect())).knowledge.length).toBe(2)
  await region.getByText('资料来源', { exact: true }).click()
  await region.getByLabel('来源类型').selectOption('selection')
  await region.getByLabel('来源文件路径').fill('README.md')
  await region.getByLabel('来源选区原文').fill('最短路径可用于路由。')
  await region.getByRole('button', { name: '关联资料来源', exact: true }).click()
  await expect(region.getByText(/来源可用/)).toBeVisible()
  await region.getByLabel('状态类别').selectOption('self-assessment')
  await region.getByLabel('学习状态', { exact: true }).selectOption('needs-practice')
  await region.getByLabel('用户自述依据').fill('目前还需要练习')
  await region.getByRole('button', { name: '记录用户自述' }).click()
  await expect(region.getByText('用户自评 · 需要练习')).toBeVisible()
  const before = await page.evaluate(() => window.coscribe.assistant.learning.inspect())
  await region.getByText('知识关联', { exact: true }).click()
  await region.getByLabel('关联知识点').selectOption(before.knowledge[1].id)
  await region.getByLabel('关系类型').selectOption('application')
  await region.getByLabel('关系说明').fill('比较两种表示方式')
  await region.getByLabel('来自模型建议', { exact: true }).check()
  await region.getByRole('button', { name: '保存关系建议' }).click()
  await expect(region.getByRole('button', { name: '确认关系' })).toBeVisible()
  await region.getByText('复习材料', { exact: true }).click()
  await region.getByLabel('复习问题').fill('如何结合图的表示求最短路径？')
  await region.getByLabel('参考答案').fill('先明确图的表示，再选合适的最短路径算法。')
  const relations = await page.evaluate(() => window.coscribe.assistant.learning.inspect())
  await region.getByLabel('使用的知识关联').selectOption(relations.relations[0].id)
  await region.getByLabel('题目来自模型建议').check()
  await region.getByRole('button', { name: '保存待确认题目' }).click()
  await expect(region.getByRole('button', { name: '确认题目并加入队列' })).toBeVisible()
  await region.getByRole('button', { name: '确认题目并加入队列' }).click()
  await expect(region.getByRole('alert')).toContainText('请先确认')
  await region.getByRole('button', { name: '确认关系', exact: true }).click()
  await region.getByRole('button', { name: '确认题目并加入队列' }).click()
  let queue = region.getByRole('region', { name: '今日到期队列' })
  await expect(queue.getByRole('heading', { name: '今日到期 · 1' })).toBeVisible()
  await queue.getByRole('button', { name: '显示答案' }).click()
  await queue.getByRole('button', { name: '记得', exact: true }).click()
  await expect(region.getByRole('status')).toContainText('复习反馈已保存')
  await expect(queue.getByRole('heading', { name: '今日到期 · 0' })).toBeVisible()
  const after = await page.evaluate(() => window.coscribe.assistant.learning.inspect())
  expect(after.events).toHaveLength(1)
  expect(after.records[0].value).toBe('needs-practice')
  expect(after.records.some((record) => record.knowledgeId === before.knowledge[1].id)).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('personal-learning-light.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.screenshot({ path: testInfo.outputPath('personal-learning-dark.png') })
  await application.close()
  await launch()
  expect(await page.evaluate(() => window.coscribe.assistant.learning.inspect())).toEqual(after)
  await rename(path.join(projectPath, 'README.md'), path.join(projectPath, '改名.md'))
  await openReview()
  region = page.getByRole('region', { name: '个人学习与复习', exact: true })
  queue = region.getByRole('region', { name: '今日到期队列' })
  await region.getByText('资料来源', { exact: true }).click()
  await expect(region.getByText(/来源失效/)).toBeVisible()
  await region.getByRole('button', { name: '重新关联来源', exact: true }).click()
  await region.getByLabel('来源文件路径').fill('改名.md')
  await region.getByRole('button', { name: '确认重新关联来源' }).click()
  await expect(region.getByText(/来源可用/)).toBeVisible()
  const relinked = await page.evaluate(() => window.coscribe.assistant.learning.inspect())
  expect(relinked.sources[0].id).toBe(after.sources[0].id)
  expect(relinked.events).toEqual(after.events)
  await region.getByText('复习材料', { exact: true }).click()
  await region.getByRole('button', { name: '手动复习' }).click()
  await expect(queue.getByRole('heading', { name: '手动复习' })).toBeVisible()
  await queue.getByRole('button', { name: '显示答案' }).click()
  await queue.getByRole('button', { name: '困难', exact: true }).click()
  expect((await page.evaluate(() => window.coscribe.assistant.learning.inspect())).events).toHaveLength(2)
})

test('legacy import, duplicate feedback, concurrent writes and revocation use the real IPC and worker', async () => {
  const content = 'Q:: 为什么需要检索？\nA:: 查找相关材料'
  const legacyPath = path.join(projectPath, '旧闪卡.md')
  const cardId = parseFlashcards(content, legacyPath)[0].id
  await writeFile(legacyPath, content)
  await mkdir(path.join(projectPath, '.coscribe'), { recursive: true })
  const oldData = JSON.stringify({ flashcards: { reviews: { [cardId]: { cardId, dueAt: 1, ease: 2.4, repetitions: 2, intervalDays: 6 }, orphan: { cardId: 'orphan', dueAt: 1, ease: 2.5, repetitions: 0, intervalDays: 0 } } } })
  await writeFile(path.join(projectPath, '.coscribe/plugin-data.json'), oldData)
  await openReview()
  const imported = await page.evaluate((legacyPath) => window.coscribe.assistant.learning.importLegacy({ expectedRevision: 0, paths: [legacyPath] }), legacyPath)
  expect(imported.imported).toBe(1)
  expect(imported.unmatchedReviewIds).toEqual(['orphan'])
  expect(imported.snapshot.materials[0].schedule.repetitions).toBe(2)
  expect(await readFile(path.join(projectPath, '.coscribe/plugin-data.json'), 'utf8')).toBe(oldData)
  const result = await page.evaluate(async (snapshot) => {
    const request = { op: 'review.submit' as const, materialId: snapshot.materials[0].id, grade: 'good' as const, submissionId: crypto.randomUUID(), expectedRevision: snapshot.revision }
    const first = await window.coscribe.assistant.learning.mutate(request)
    const second = await window.coscribe.assistant.learning.mutate(request)
    const changes = await Promise.allSettled([
      window.coscribe.assistant.learning.mutate({ op: 'knowledge.save', name: '并发一', domain: '', expectedRevision: first.revision }),
      window.coscribe.assistant.learning.mutate({ op: 'knowledge.save', name: '并发二', domain: '', expectedRevision: first.revision })
    ])
    return { first, second, statuses: changes.map((change) => change.status) }
  }, imported.snapshot)
  expect(result.second).toEqual(result.first)
  expect(result.first.events).toHaveLength(1)
  expect(result.statuses.filter((status) => status === 'fulfilled')).toHaveLength(1)
  await page.evaluate(async () => {
    const settings = await window.coscribe.settings.get()
    await window.coscribe.settings.save({ ...settings, enabledPlugins: settings.enabledPlugins.filter((id) => id !== 'flashcards'), pluginGrants: { ...settings.pluginGrants, flashcards: [] } })
  })
  const revoked = await page.evaluate(async () => {
    const data = await window.coscribe.assistant.learning.inspect()
    try {
      await window.coscribe.assistant.learning.list()
      return false
    } catch { return data.knowledge.length > 0 }
  })
  expect(revoked).toBe(true)
  await page.reload()
  await page.locator('.app-titlebar__actions').getByRole('button', { name: '设置' }).click()
  await page.getByRole('button', { name: /关于我/ }).click()
  const manager = page.getByRole('region', { name: '学习数据管理' })
  await manager.getByRole('button', { name: '删除知识点', exact: true }).click()
  await manager.getByRole('button', { name: '确认删除知识点' }).click()
  await expect(manager.getByRole('status')).toContainText('已删除知识点')
  expect((await page.evaluate(() => window.coscribe.assistant.learning.inspect())).events).toEqual([])
})

test('normal chat recalls current learning evidence under memory consent and immediately reflects correction and deletion', async () => {
  const bodies: string[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    bodies.push(Buffer.concat(chunks).toString('utf8'))
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `LEARNING_REPLY_${bodies.length}` } }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await page.evaluate(async (port) => {
      const settings = await window.coscribe.settings.get()
      await window.coscribe.settings.save({ ...settings, autoTitle: false, enabledPlugins: [...settings.enabledPlugins, 'flashcards'], pluginGrants: { ...settings.pluginGrants, flashcards: ['project:read', 'project:write', 'ai:request', 'learning:read', 'learning:write'] }, aiProfiles: settings.aiProfiles.map((profile) => profile.id === settings.activeAiProfileId ? { ...profile, baseUrl: `http://127.0.0.1:${port}/v1`, apiProtocol: 'chat-completions', model: 'learning-test' } : profile) })
      const point = await window.coscribe.assistant.learning.mutate({ op: 'knowledge.save', name: 'RAG_SENTINEL_KNOWLEDGE', domain: 'AI', expectedRevision: 0 })
      await window.coscribe.assistant.learning.mutate({ op: 'record.save', record: { knowledgeId: point.knowledge[0].id, kind: 'self-assessment', value: 'confident', note: '用户自己表示掌握' }, expectedRevision: point.revision })
    }, (server.address() as AddressInfo).port)
    await page.reload()
    const chat = async (index: number): Promise<void> => {
      await page.getByLabel('向 AI 提问').fill('讲解 RAG 检索')
      await page.getByRole('button', { name: '发送消息' }).click()
      await expect(page.getByText(`LEARNING_REPLY_${index}`, { exact: false })).toBeVisible()
    }
    await chat(1)
    expect(bodies[0]).not.toContain('userStatements')
    await page.evaluate(async () => {
      const memory = await window.coscribe.assistant.memory.list()
      await window.coscribe.assistant.memory.setPolicy({ enabled: true, allowRemote: false, expectedRevision: memory.policy.revision })
    })
    await chat(2)
    expect(bodies[1]).toContain('RAG_SENTINEL_KNOWLEDGE')
    expect(bodies[1]).toContain('confident')
    await page.evaluate(async () => {
      const data = await window.coscribe.assistant.learning.inspect()
      await window.coscribe.assistant.learning.correct({ op: 'record.save', id: data.records[0].id, record: { knowledgeId: data.knowledge[0].id, kind: 'self-assessment', value: 'needs-practice', note: '用户纠正' }, expectedRevision: data.revision })
    })
    await chat(3)
    expect(bodies[2]).toContain('needs-practice')
    expect(bodies[2]).not.toContain('confident')
    await page.evaluate(async () => {
      const data = await window.coscribe.assistant.learning.inspect()
      await window.coscribe.assistant.learning.correct({ op: 'record.delete', id: data.records[0].id, expectedRevision: data.revision })
    })
    await chat(4)
    expect(bodies[3]).not.toContain('userStatements')
    expect(bodies[3]).not.toContain('RAG_SENTINEL_KNOWLEDGE')
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})
