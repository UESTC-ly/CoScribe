import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

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
async function openResearch(): Promise<void> {
  const pluginButton = page.getByRole('button', { name: '插件', exact: true })
  if (await pluginButton.getAttribute('aria-pressed') !== 'true') await pluginButton.click()
  const card = page.locator('.plugin-card').filter({ has: page.locator('header strong').getByText('文献与引用', { exact: true }) })
  await card.getByRole('button', { name: '打开插件' }).click()
  await expect(page.getByLabel('研究主题')).toBeVisible()
}
async function fixtures(): Promise<void> {
  await application.evaluate(() => {
    const actual = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.includes('127.0.0.1:43210/v1/chat/completions')) {
        const body = JSON.parse(String(init?.body))
        if (body.tools) throw new Error('Research must not expose model tools')
        const payload = JSON.parse(body.messages.at(-1).content)
        const result = payload.evidence
          ? { claims: [{ heading: '主要发现', text: '模型基于摘要生成了结论。', evidenceId: payload.evidence[0].id, quote: payload.evidence[0].text.slice(0, 45) }], questions: ['需要核对全文中的实验条件。'] }
          : { queries: ['graph drug discovery'] }
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }))
      }
      if (url.includes('export.arxiv.org/api/query')) return new Response('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2601.01234v1</id><title>Research E2E Paper</title><author><name>Ada Smith</name></author><published>2026-01-02</published><summary>Graph models predict molecular properties with limited experimental evidence.</summary></entry></feed>')
      if (url.includes('api.crossref.org/works?')) return new Response(JSON.stringify({ message: { items: [{ title: ['Crossref E2E Paper'], DOI: '10.1000/e2e', abstract: '<jats:p>Crossref abstract evidence.</jats:p>' }] } }))
      if (url.includes('api.github.com/search/repositories')) return new Response(JSON.stringify({ items: [{ full_name: 'e2e/graph-research', html_url: 'https://github.com/e2e/graph-research', description: 'Repository description', language: 'Python' }] }))
      if (url.includes('api.github.com/repos/e2e/graph-research/readme')) return new Response(JSON.stringify({ encoding: 'base64', sha: 'a'.repeat(40), content: Buffer.from('# Graph Research\n\nRepository authors claim graph modeling support.').toString('base64') }))
      if (url.includes('arxiv.org/pdf/')) return new Response('PDF endpoint unavailable', { status: 503 })
      return actual(input, init)
    }
  })
}
test.beforeEach(async () => {
  projectPath = await mkdtemp(path.join(os.tmpdir(), 'coscribe-research-e2e-'))
  userDataPath = await mkdtemp(path.join(os.tmpdir(), 'coscribe-research-data-'))
  await writeFile(path.join(projectPath, 'README.md'), '# User notes\n\nKeep handwritten notes intact.\n')
  await launch()
  await page.evaluate(async () => {
    const settings = await window.coscribe.settings.get()
    await window.coscribe.settings.save({ ...settings, enabledPlugins: [...new Set([...settings.enabledPlugins, 'references'])], pluginGrants: { ...settings.pluginGrants, references: ['project:read', 'project:write', 'network:read', 'ai:request'] } })
  })
  await page.reload()
  await fixtures()
  await openResearch()
})
test.afterEach(async () => {
  await application?.close().catch(() => undefined)
  await rm(projectPath, { recursive: true, force: true })
  await rm(userDataPath, { recursive: true, force: true })
})

test('searches papers and repositories, imports partial downloads, previews and confirms a review, and restores records', async ({}, testInfo) => {
  test.setTimeout(90_000)
  await page.getByLabel('研究主题').fill('graph drug discovery')
  await page.getByRole('button', { name: '开始研究', exact: true }).click()
  const panel = page.locator('.auto-research-panel')
  await expect(panel.getByRole('status').first()).toContainText('候选已就绪')
  await expect(panel.locator('.auto-research-candidates article')).toHaveCount(3)
  for (const article of await panel.locator('.auto-research-candidates article').all()) await article.getByRole('checkbox').check()
  await page.getByRole('button', { name: '导入选中资料' }).click()
  await expect(panel.getByRole('status').first()).toContainText('导入任务结束')
  await expect(panel).toContainText('下载失败；仍可导入元数据')
  await expect(panel).toContainText('README 快照已导入')
  await expect(page.locator('.research-list-items')).toContainText('Research E2E Paper')
  await expect(page.locator('.research-list-items')).toContainText('e2e/graph-research')
  await page.getByRole('button', { name: '预览主题综述' }).click()
  await expect(page.getByLabel('研究草稿内容')).toHaveValue(/graph drug discovery/u)
  await expect(page.getByLabel('研究草稿内容')).toHaveValue(/摘要/u)
  const before = await page.evaluate(() => window.coscribe.project.tree())
  expect(JSON.stringify(before)).not.toContain('综述-')
  await page.screenshot({ path: testInfo.outputPath('auto-research-preview.png') })
  await page.getByRole('button', { name: '确认保存草稿' }).click()
  await expect(page.getByLabel('研究草稿内容')).toHaveCount(0)
  const runs = await page.evaluate(() => window.coscribe.research.list())
  expect(runs[0].candidates.filter((candidate) => candidate.imported)).toHaveLength(3)
  expect(await readFile(runs[0].logPath!, 'utf8')).toContain('auto-research-v1')
  expect(await readFile(path.join(projectPath, 'README.md'), 'utf8')).toContain('Keep handwritten notes intact.')
  await application.close()
  await launch()
  await openResearch()
  await expect(page.locator('.auto-research-panel').getByRole('status').first()).toContainText('导入任务结束')
  await expect(page.locator('.auto-research-panel .auto-research-candidates article')).toHaveCount(3)
})

test('blocks missing network grants and rejects manufactured draft IDs through narrow IPC', async () => {
  await expect(page.evaluate(() => window.coscribe.research.confirm('forged'))).rejects.toThrow('过期')
  await page.evaluate(async () => {
    const settings = await window.coscribe.settings.get()
    await window.coscribe.settings.save({ ...settings, pluginGrants: { ...settings.pluginGrants, references: ['project:read', 'project:write'] } })
  })
  await expect(page.evaluate(() => window.coscribe.research.start({ topic: 'graph research', sources: ['arxiv'], limit: 3, useAi: false }))).rejects.toThrow('授权')
  await page.reload()
  await openResearch()
  await page.getByLabel('研究主题').fill('graph research')
  await expect(page.getByRole('button', { name: '开始研究' })).toBeDisabled()
})


test('uses AI planning and generates a grounded note with verified abstract quotes', async () => {
  await page.evaluate(async () => {
    const settings = await window.coscribe.settings.get()
    await window.coscribe.settings.save({ ...settings, aiProfiles: settings.aiProfiles.map((profile) => profile.id === settings.activeAiProfileId ? { ...profile, provider: 'openai', baseUrl: 'http://127.0.0.1:43210/v1', apiProtocol: 'chat-completions', model: 'research-e2e' } : profile) })
  })
  await page.reload()
  await openResearch()
  await page.getByLabel('Crossref 文献', { exact: true }).uncheck()
  await page.getByLabel('GitHub 仓库', { exact: true }).uncheck()
  await page.getByLabel('用已配置 AI 规划检索词并生成草稿').check()
  await page.getByLabel('研究主题').fill('图神经网络用于药物发现')
  await page.getByRole('button', { name: '开始研究', exact: true }).click()
  const panel = page.locator('.auto-research-panel')
  await expect(panel.getByRole('status').first()).toContainText('候选已就绪')
  await expect(panel).toContainText('检索词：graph drug discovery')
  await panel.locator('.auto-research-candidates article').getByRole('checkbox').check()
  await page.getByRole('button', { name: '导入选中资料' }).click()
  await expect(panel.getByRole('status').first()).toContainText('导入任务结束')
  await page.getByRole('button', { name: '预览文献笔记' }).click()
  await expect(page.getByLabel('研究草稿内容')).toHaveValue(/模型基于摘要生成了结论/u)
  await expect(page.getByLabel('研究草稿内容')).toHaveValue(/Graph models predict molecular properties/u)
  await page.getByRole('button', { name: '确认保存草稿' }).click()
  await expect(page.getByLabel('研究草稿内容')).toHaveCount(0)
  const [run] = await page.evaluate(() => window.coscribe.research.list())
  expect(run.artifacts).toHaveLength(1)
  expect(await readFile(run.artifacts![0].path, 'utf8')).toContain('模型基于摘要生成了结论')
})

test('downloads a real PDF and labels only its first eight pages as note evidence', async () => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count 9 /Kids [${Array.from({ length: 9 }, (_, index) => `${4 + index * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  for (let index = 0; index < 9; index += 1) {
    const stream = `BT /F1 12 Tf 72 720 Td (PDF page ${index + 1} graph evidence.) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
  }
  let document = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(document)); document += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(document)
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  await application.evaluate((_electron, base64) => {
    const actual = globalThis.fetch
    globalThis.fetch = async (input, init) => String(input).includes('arxiv.org/pdf/') ? new Response(Buffer.from(base64, 'base64')) : actual(input, init)
  }, Buffer.from(document).toString('base64'))
  const run = await page.evaluate(() => window.coscribe.research.start({ topic: 'graph research', sources: ['arxiv'], limit: 1, useAi: false }))
  await expect.poll(async () => (await page.evaluate((id) => window.coscribe.research.get(id), run.id)).status).toBe('ready')
  const ready = await page.evaluate((id) => window.coscribe.research.get(id), run.id)
  await page.evaluate(({ id, candidateId }) => window.coscribe.research.import(id, [candidateId], true), { id: run.id, candidateId: ready.candidates[0].id })
  await expect.poll(async () => (await page.evaluate((id) => window.coscribe.research.get(id), run.id)).status).toBe('completed')
  const draft = await page.evaluate(({ id, candidateId }) => window.coscribe.research.draft(id, [candidateId], 'note', false), { id: run.id, candidateId: ready.candidates[0].id })
  expect(draft.content).toContain('PDF 共 9 页')
  expect(draft.content).toContain('PDF page 8 graph evidence.')
  expect(draft.content).not.toContain('PDF page 9 graph evidence.')
  const imported = await page.evaluate((id) => window.coscribe.research.get(id), run.id)
  expect(imported.candidates[0].reference.pdfPath).toBeTruthy()
  expect((await readFile(imported.candidates[0].reference.pdfPath!)).subarray(0, 5).toString()).toBe('%PDF-')
  const lastPage = await page.evaluate((pdfPath) => window.coscribe.pdf.pageText(pdfPath, 9), imported.candidates[0].reference.pdfPath!)
  expect(lastPage.text).toContain('PDF page 9 graph evidence.')
})
