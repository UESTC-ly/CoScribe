import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

const appRoot = path.resolve(import.meta.dirname, '../..')
const packagedExecutable = process.env.COSCRIBE_E2E_EXECUTABLE
const speechTestWav = process.env.COSCRIBE_ASR_TEST_WAV

let electronApp: ElectronApplication
let page: Page
let projectPath: string
let userDataPath: string

function pcm16WavPayload(source: Buffer): { sampleRate: number; channels: number; pcmBase64: string } {
  if (source.toString('ascii', 0, 4) !== 'RIFF' || source.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('ASR fixture is not a RIFF/WAVE file')
  }
  let offset = 12
  let audioFormat = 0
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let pcm: Buffer | null = null
  while (offset + 8 <= source.length) {
    const chunkId = source.toString('ascii', offset, offset + 4)
    const chunkSize = source.readUInt32LE(offset + 4)
    const body = offset + 8
    if (body + chunkSize > source.length) break
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      audioFormat = source.readUInt16LE(body)
      channels = source.readUInt16LE(body + 2)
      sampleRate = source.readUInt32LE(body + 4)
      bitsPerSample = source.readUInt16LE(body + 14)
    } else if (chunkId === 'data') {
      pcm = source.subarray(body, body + chunkSize)
    }
    offset = body + chunkSize + (chunkSize % 2)
  }
  if (audioFormat !== 1 || bitsPerSample !== 16 || channels < 1 || !sampleRate || !pcm) {
    throw new Error('ASR fixture must use 16-bit PCM audio')
  }
  return { sampleRate, channels, pcmBase64: pcm.toString('base64') }
}

async function launchProject(): Promise<void> {
  electronApp = await electron.launch({
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    args: packagedExecutable ? ['--project', projectPath] : [appRoot, '--project', projectPath],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      COSCRIBE_USER_DATA_DIR: userDataPath,
      COSCRIBE_E2E_SCREENSHOT_SOURCE: process.env.COSCRIBE_E2E_SCREENSHOT_SOURCE === 'real-screen' ? '' : 'app-window'
    }
  })
  page = await electronApp.firstWindow()
  page.on('console', (message) => {
    if (message.type() === 'error') process.stderr.write(`[renderer console] ${message.text()}\n`)
  })
  page.on('pageerror', (reason) => process.stderr.write(`[renderer error] ${reason.message}\n`))
  page.on('crash', () => process.stderr.write('[renderer crash]\n'))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.coscribe))
}

async function enableAndOpenPlugin(name: string, regionName: string): Promise<void> {
  await page.getByRole('button', { name: '插件', exact: true }).click()
  const card = page.locator('.plugin-card').filter({ has: page.locator('header strong').getByText(name, { exact: true }) })
  await card.scrollIntoViewIfNeeded()
  const open = card.locator('.plugin-card__open')
  if (!(await open.isEnabled())) {
    await card.getByRole('button', { name: `启用并授权${name}` }).click()
    await expect(page.getByRole('dialog')).toContainText(name)
    await page.getByRole('button', { name: '授权并启用' }).click()
  }
  await open.click()
  await expect(page.getByRole('region', { name: regionName })).toBeVisible()
}

test.beforeEach(async () => {
  projectPath = await mkdtemp(path.join(os.tmpdir(), 'coscribe-e2e-'))
  userDataPath = await mkdtemp(path.join(os.tmpdir(), 'coscribe-user-data-'))
  await writeFile(path.join(projectPath, 'README.md'), [
    '# FastAPI 学习',
    '',
    '## 路由',
    '',
    'E2E_SENTINEL 路由把请求映射到处理函数。',
    '',
    '## 依赖注入',
    '',
    '依赖项可以被复用。',
    '',
    '## 一个用于验证大纲宽度可调且标题能够完整显示的较长章节',
    '',
    '大纲宽度应该可以按需调整。'
  ].join('\n'))
  await writeFile(path.join(projectPath, '资料.txt'), '本地项目中的普通文本文件。\n')
  await copyFile(
    path.join(appRoot, 'node_modules', 'mammoth', 'test', 'test-data', 'single-paragraph.docx'),
    path.join(projectPath, '示例文档.docx')
  )
  await copyFile(
    path.join(appRoot, 'tests', 'fixtures', 'coscribe-pptx-sample.pptx'),
    path.join(projectPath, '示例演示.pptx')
  )
  await writeFile(path.join(projectPath, 'OCR测试.svg'), [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="420" viewBox="0 0 1200 420">',
    '<rect width="1200" height="420" fill="white"/>',
    '<text x="70" y="180" fill="black" font-family="Arial, sans-serif" font-size="86" font-weight="700">COSCRIBE OCR TEST</text>',
    '<text x="70" y="300" fill="black" font-family="Arial, sans-serif" font-size="66">LOCAL 2026</text>',
    '</svg>'
  ].join(''))
  await mkdir(path.join(projectPath, '教程', '章节'), { recursive: true })
  await writeFile(path.join(projectPath, '教程', '章节', '流程.md'), [
    '# 流程',
    '',
    '```mermaid',
    'graph TD',
    '  A[开始] --> B[完成]',
    '```',
    '',
    '```typescript',
    'const answer: number = 42',
    '```',
    '',
  ].join('\n'))
  await mkdir(path.join(projectPath, '.venv', 'lib'), { recursive: true })
  await writeFile(path.join(projectPath, '.venv', 'lib', 'dependency.py'), 'IGNORED_DEPENDENCY = True\n')
  await mkdir(path.join(projectPath, '.git'), { recursive: true })
  await writeFile(path.join(projectPath, '.git', 'config'), '[core]\nrepositoryformatversion = 0\n')
  await launchProject()
})

test.afterEach(async () => {
  await electronApp?.close().catch(() => undefined)
  await rm(projectPath, { recursive: true, force: true })
  await rm(userDataPath, { recursive: true, force: true })
})

test('opens a real local project, searches content, and creates a standard Markdown file', async ({}, testInfo) => {
  await expect(page).toHaveTitle('CoScribe')
  await expect(page.locator('.app-titlebar__project strong')).toHaveText(path.basename(projectPath))
  await expect(page.locator('.tree-row').filter({ hasText: 'README.md' })).toBeVisible()
  await expect(page.locator('.tree-row').filter({ hasText: '教程' })).toBeVisible()
  await expect(page.locator('.tree-row').filter({ hasText: '.venv' })).toHaveCount(0)
  await expect(page.locator('.tree-row').filter({ hasText: '.git' })).toHaveCount(0)

  await expect(page.locator('.tree-row').filter({ hasText: '章节' })).toBeVisible()
  await page.locator('.tree-row').filter({ hasText: '章节' }).click()
  await expect(page.locator('.tree-row').filter({ hasText: '流程.md' })).toBeVisible()

  await page.locator('.tree-row').filter({ hasText: 'README.md' }).click()
  await expect(page.getByLabel('README.md Markdown 编辑器')).toBeVisible()
  await expect(page.getByLabel('Markdown 预览')).toContainText('FastAPI 学习')
  await expect(page.getByRole('button', { name: '预览', exact: true })).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByLabel('搜索当前项目').fill('E2E_SENTINEL')
  await page.getByLabel('搜索当前项目').press('Enter')
  await expect(page.locator('.search-result').filter({ hasText: 'README.md' })).toBeVisible()
  await expect(page.locator('.search-result')).toContainText('E2E_SENTINEL')

  await page.getByRole('button', { name: '文件', exact: true }).click()
  await page.getByRole('button', { name: '新建 Markdown' }).click()
  await page.getByLabel('文件路径').fill('第一篇学习笔记.md')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  const notePath = path.join(projectPath, '第一篇学习笔记.md')
  await expect.poll(async () => access(notePath).then(() => true).catch(() => false)).toBe(true)
  await expect(page.getByLabel('第一篇学习笔记.md Markdown 编辑器')).toBeVisible()

  await page.getByRole('button', { name: '编辑', exact: true }).click()
  const editor = page.locator('.cm-content').last()
  await editor.click()
  await editor.fill('# 第一篇笔记\n\n这是可被其他软件打开的标准 Markdown。')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(async () => readFile(notePath, 'utf8')).toContain('标准 Markdown')
  await page.screenshot({ path: testInfo.outputPath('workspace.png') })
})

test('grants a built-in plugin explicitly and creates a templated daily note', async ({}, testInfo) => {
  await page.getByRole('button', { name: '插件', exact: true }).click()
  const dailyCard = page.locator('.plugin-card').filter({ hasText: '每日笔记与模板' })
  await expect(dailyCard).toBeVisible()
  await expect(dailyCard.getByText('读取当前项目文件')).toBeVisible()
  await dailyCard.getByRole('button', { name: '启用并授权每日笔记与模板' }).click()
  await expect(page.getByRole('dialog').getByText(/这个内置插件将获得：读取当前项目文件；创建或修改当前项目文件/u)).toBeVisible()
  await page.getByRole('button', { name: '授权并启用' }).click()
  await expect(dailyCard.getByRole('button', { name: '打开插件' })).toBeEnabled()
  await dailyCard.getByRole('button', { name: '打开插件' }).click()

  await expect(page.getByRole('region', { name: '每日笔记与模板插件' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('daily-notes-workspace.png') })
  await page.getByLabel('日期').fill('2026-07-23')
  await page.getByRole('button', { name: '创建或打开' }).click()
  const dailyPath = path.join(projectPath, '每日笔记', '2026-07-23.md')
  await expect.poll(async () => readFile(dailyPath, 'utf8').catch(() => '')).toContain('# 2026-07-23')
  await expect(page.getByLabel('2026-07-23.md Markdown 编辑器')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('daily-notes-plugin.png') })
})

test('lazy-loads flashcard, backlink, and diagnostics plugin views after explicit grants', async ({}, testInfo) => {
  await page.getByRole('button', { name: '插件', exact: true }).click()
  const openPlugin = async (name: string, regionName: string): Promise<void> => {
    const card = page.locator('.plugin-card').filter({ hasText: name })
    await card.getByRole('button', { name: `启用并授权${name}` }).click()
    await expect(page.getByRole('dialog')).toContainText(name)
    await page.getByRole('button', { name: '授权并启用' }).click()
    await card.getByRole('button', { name: '打开插件' }).click()
    await expect(page.getByRole('region', { name: regionName })).toBeVisible()
  }

  await openPlugin('闪卡与间隔复习', '闪卡与间隔复习插件')
  await page.screenshot({ path: testInfo.outputPath('flashcards-workspace.png') })
  await openPlugin('双向链接', '双向链接插件')
  await expect(page.getByText('Markdown 笔记')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('backlinks-workspace.png') })
  await openPlugin('性能诊断', '性能诊断插件')
  await expect(page.getByText('进程资源')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('diagnostics-workspace.png') })
})

test('manages a reference and persists a Markdown literature review matrix', async ({}, testInfo) => {
  test.setTimeout(90_000)
  await enableAndOpenPlugin('文献与引用', '文献与引用插件')
  await page.getByLabel('题名').fill('Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks')
  await page.getByLabel('citekey').fill('Lewis2020RAG')
  await page.getByLabel('作者（分号分隔）').fill('Patrick Lewis; Ethan Perez')
  await page.getByLabel('年份').fill('2020')
  await page.getByLabel('标签').fill('RAG, retrieval')
  await page.getByRole('button', { name: '加入文献库' }).click()
  await expect(page.getByText('文献元数据已保存在当前项目。')).toBeVisible()
  await expect(page.locator('.research-list-items')).toContainText('Lewis2020RAG')
  await page.screenshot({ path: testInfo.outputPath('references-workspace.png') })

  await enableAndOpenPlugin('文献综述矩阵', '文献综述矩阵插件')
  const matrix = page.locator('.matrix-table')
  await expect(matrix).toContainText('Retrieval-Augmented Generation')
  await page.getByLabel(/Retrieval-Augmented Generation.*研究问题/u).fill('如何结合参数化与非参数化知识？')
  await page.getByLabel(/Retrieval-Augmented Generation.*阅读状态/u).selectOption('reading')
  await page.getByRole('button', { name: '保存矩阵' }).click()
  const matrixPath = path.join(projectPath, '研究', '文献综述矩阵.md')
  await expect.poll(async () => readFile(matrixPath, 'utf8').catch(() => '')).toContain('如何结合参数化与非参数化知识？')
  await expect.poll(async () => readFile(matrixPath, 'utf8').catch(() => '')).toContain('<!-- coscribe:literature-matrix:start -->')
  await page.screenshot({ path: testInfo.outputPath('literature-review-matrix.png') })
})

test('discovers and explicitly invokes a local stdio MCP server', async ({}, testInfo) => {
  await enableAndOpenPlugin('MCP 连接器', 'MCP 连接器插件')
  await page.getByLabel('名称').fill('E2E MCP')
  await page.getByLabel('启动命令（不经过 shell）').fill(process.execPath)
  await page.getByLabel('参数（每行一个）').fill(path.join(appRoot, 'tests', 'fixtures', 'mcp-server.mjs'))
  await page.getByLabel('环境变量 JSON').fill('{}')
  await page.getByRole('button', { name: '保存配置' }).click()
  await expect(page.getByText(/MCP 配置已用系统安全存储加密保存/u)).toBeVisible()
  await page.getByRole('button', { name: '发现能力' }).click()
  await expect(page.getByText(/已按需连接/u)).toBeVisible()
  await expect(page.locator('.mcp-invoke-card')).toContainText('1 工具')
  await page.getByLabel('参数 JSON').fill('{"message":"MCP_E2E_SENTINEL"}')
  await page.getByRole('button', { name: '明确调用一次' }).click()
  await expect(page.locator('.mcp-result')).toContainText('MCP_E2E_SENTINEL')
  await page.screenshot({ path: testInfo.outputPath('mcp-explicit-call.png') })
})

test('creates a safe local Git snapshot without staging secrets', async ({}, testInfo) => {
  await writeFile(path.join(projectPath, '.env'), 'SECRET_MUST_STAY_UNTRACKED=true\n')
  await enableAndOpenPlugin('Git 快照', 'Git 快照插件')
  await expect(page.locator('.git-safety-strip')).toContainText('.env')
  await page.getByLabel('快照说明').fill('E2E research checkpoint')
  await page.getByRole('button', { name: '创建本地快照' }).click()
  await expect(page.getByText(/已创建本地快照/u)).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.git-history-card')).toContainText('E2E research checkpoint')
  const tracked = await new Promise<string>((resolve, reject) => {
    execFile('git', ['-C', projectPath, 'ls-files'], (error, stdout) => error ? reject(error) : resolve(stdout))
  })
  expect(tracked).not.toContain('.env')
  await page.screenshot({ path: testInfo.outputPath('git-snapshot.png') })
})

test('tracks a webpage and writes only changed Markdown snapshots', async ({}, testInfo) => {
  let version = 1
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ETag: `v${version}` })
    response.end(`<html><title>Tracked Research</title><body><article><h1>Finding</h1><p>WEB_TRACKER_VERSION_${version}</p></article></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as AddressInfo).port
    await enableAndOpenPlugin('网页资料跟踪', '网页资料持续跟踪插件')
    await page.getByLabel('网页地址').fill(`http://127.0.0.1:${port}/paper`)
    await page.getByLabel('名称（可选）').fill('研究追踪')
    await page.getByRole('button', { name: '加入跟踪' }).click()
    await page.getByRole('button', { name: '立即检查' }).click()
    await expect(page.getByText(/检查完成：1 项有变化/u)).toBeVisible()
    const snapshotsRoot = path.join(projectPath, '研究', '网页跟踪', 'Tracked Research')
    await expect.poll(async () => (await import('node:fs/promises')).readdir(snapshotsRoot).then((files) => files.length).catch(() => 0)).toBe(1)
    await page.getByRole('button', { name: '立即检查' }).click()
    await expect(page.getByText(/检查完成：0 项有变化/u)).toBeVisible()
    await expect.poll(async () => (await import('node:fs/promises')).readdir(snapshotsRoot).then((files) => files.length)).toBe(1)
    version = 2
    await page.getByRole('button', { name: '立即检查' }).click()
    await expect(page.getByText(/检查完成：1 项有变化/u)).toBeVisible()
    await expect.poll(async () => (await import('node:fs/promises')).readdir(snapshotsRoot).then((files) => files.length)).toBe(2)
    await page.screenshot({ path: testInfo.outputPath('web-tracker.png') })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('renders Mermaid fenced blocks in Markdown preview', async ({}, testInfo) => {
  await page.locator('.tree-row').filter({ hasText: '章节' }).click()
  await page.locator('.tree-row').filter({ hasText: '流程.md' }).click()
  await expect(page.getByLabel('流程.md Markdown 编辑器')).toBeVisible()
  await page.getByRole('button', { name: '预览', exact: true }).click()
  await expect(page.locator('.vk-mermaid-svg svg')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.vk-mermaid-error')).toHaveCount(0)
  const codeBlock = page.getByRole('region', { name: 'TypeScript 代码块' })
  await expect(codeBlock).toBeVisible()
  await expect(codeBlock.locator('.hljs-keyword')).toHaveText('const')
  await expect(codeBlock.locator('.hljs-number')).toHaveText('42')
  const lightCodeBackground = await codeBlock.locator('pre').evaluate(
    (element) => window.getComputedStyle(element).backgroundColor,
  )
  const lightSvg = await page.locator('.vk-mermaid-svg svg').evaluate((element) => element.outerHTML)
  await page.screenshot({ path: testInfo.outputPath('mermaid-preview.png') })

  await page.locator('.app-titlebar__actions').getByRole('button', { name: '设置' }).click()
  await page.getByLabel('主题').selectOption('dark')
  await page.getByRole('button', { name: '保存设置' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect.poll(async () => page.locator('.vk-mermaid-svg svg').evaluate((element) => element.outerHTML)).not.toBe(lightSvg)
  await expect(page.locator('.vk-mermaid-error')).toHaveCount(0)
  await expect(codeBlock.locator('.hljs-keyword')).toHaveText('const')
  await expect.poll(async () => codeBlock.locator('pre').evaluate(
    (element) => window.getComputedStyle(element).backgroundColor,
  )).not.toBe(lightCodeBackground)
  await page.screenshot({ path: testInfo.outputPath('mermaid-preview-dark.png') })
})

test('keeps selected Markdown visibly attached to the AI composer after focus moves', async ({}, testInfo) => {
  await page.locator('.tree-row').filter({ hasText: 'README.md' }).click()
  const preview = page.getByLabel('Markdown 预览')
  const paragraph = preview.getByText('E2E_SENTINEL 路由把请求映射到处理函数。')
  await paragraph.evaluate((element) => {
    const text = element.firstChild
    if (!text) throw new Error('Selection fixture text node is missing')
    const range = document.createRange()
    range.selectNodeContents(text)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })

  await page.getByLabel('基于').selectOption('selection')
  const card = page.getByRole('region', { name: '已捕获的 AI 选中内容' })
  await expect(card).toContainText('E2E_SENTINEL 路由把请求映射到处理函数。')
  await page.getByLabel('基于').focus()
  await expect(card).toBeVisible()
  await expect(preview).toHaveAttribute('data-ai-context-selection', 'true')
  await expect.poll(async () => page.evaluate(() => {
    const registry = (CSS as typeof CSS & { highlights?: Map<string, unknown> }).highlights
    return Boolean(registry?.has('coscribe-ai-context-selection'))
  })).toBe(true)
  await expect(card.getByRole('button', { name: '将选中内容加入输入框' })).toHaveAttribute('title', /⌘⇧K/u)

  await card.getByRole('button', { name: '定位选中内容' }).click()
  await expect(preview).toHaveClass(/is-revealing-ai-selection/u)
  await page.screenshot({ path: testInfo.outputPath('persistent-ai-selection.png') })

  await card.getByRole('button', { name: '清除选中内容' }).click()
  await expect(card).toHaveCount(0)
  await expect(preview).not.toHaveAttribute('data-ai-context-selection')
})

test('opens DOCX files as a local semantic document', async () => {
  await page.locator('.tree-row').filter({ hasText: '示例文档.docx' }).click()

  await expect(page.getByLabel('示例文档.docx DOCX 阅读器')).toBeVisible()
  await expect(page.locator('.vk-docx-page')).toContainText('Walking on imported air')
  await expect(page.getByRole('button', { name: '复制正文' })).toBeVisible()
})

test('renders PPTX slides locally and searches extracted slide text', async () => {
  await page.locator('.tree-row').filter({ hasText: '示例演示.pptx' }).click()
  const viewer = page.getByLabel('示例演示.pptx PowerPoint 阅读器')
  await expect(viewer).toBeVisible()
  await expect(viewer.locator('.vk-pptx-slide svg')).toBeVisible({ timeout: 15_000 })
  await expect(viewer.locator('.vk-pptx-slide')).toContainText('CoScribe 可以直接阅读 PPTX')
  await expect(viewer.locator('.vk-pptx-page')).toHaveText('1 / 1')

  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByLabel('搜索当前项目').fill('PPTX_TEXT_SENTINEL')
  await page.getByLabel('搜索当前项目').press('Enter')
  await expect(page.locator('.search-result').filter({ hasText: '示例演示.pptx' })).toContainText('PPTX_TEXT_SENTINEL')
})

test('browses an original isolated webpage and saves complete MHTML, semantic Markdown, and PDF', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const server = createServer((request, response) => {
    if (request.url === '/pixel.png') {
      response.writeHead(200, { 'Content-Type': 'image/png' })
      response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end([
      '<!doctype html>',
      '<html><head><title>Isolated Research Page</title>',
      '<style>body{font-family:system-ui;background:rgb(245,250,248)} article{max-width:720px;margin:40px auto} h1{color:rgb(20,90,70)}</style>',
      '</head><body><article>',
      '<h1>Original Web Layout</h1>',
      '<p id="selection">WEB_SELECTION_SENTINEL remains in the live Chromium page.</p>',
      '<h2>Research finding</h2>',
      '<p>WEB_ARTICLE_SENTINEL is extracted from the semantic article body.</p>',
      '<p><a href="/a_(b)?q=x">WEB_LINK_[LABEL]</a><a href="javascript:alert(1)">UNSAFE_LINK_LABEL</a></p>',
      '<img src="/pixel.png" alt="WEB_IMAGE_[ALT]">',
      '<pre><code class="language-js">const ticks = "```";</code></pre>',
      `<p>${'archive body '.repeat(18_000)}</p>`,
      '<p>WEB_ARCHIVE_TAIL_SENTINEL</p>',
      '</article></body></html>'
    ].join(''))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  try {
    const port = (server.address() as AddressInfo).port
    const url = `http://127.0.0.1:${port}/article`
    await page.getByRole('button', { name: '资料浏览器', exact: true }).click()
    await expect(page.getByRole('region', { name: '资料浏览器' })).toBeVisible()
    await page.getByLabel('网址或搜索内容').fill(url)
    await page.getByLabel('网址或搜索内容').press('Enter')

    await expect.poll(async () => electronApp.evaluate(({ webContents }, expectedUrl) => {
      return webContents.getAllWebContents().some((contents) => contents.getURL() === expectedUrl && !contents.isLoading())
    }, url)).toBe(true)
    await expect(page.locator('.research-browser__tabbar strong')).toHaveText('Isolated Research Page')

    const nativeBounds = await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return window.contentView.children.map((child) => child.getBounds()).find((bounds) => bounds.width > 0 && bounds.height > 0)
    })
    expect(nativeBounds?.width).toBeGreaterThan(0)
    expect(nativeBounds?.height).toBeGreaterThan(0)

    const navigationSeparator = page.getByRole('separator', { name: '调整项目导航宽度' })
    const navigationBox = await navigationSeparator.boundingBox()
    if (!navigationBox) throw new Error('Project navigation resize separator is not visible')
    await navigationSeparator.dispatchEvent('pointerdown', {
      button: 0,
      buttons: 1,
      clientX: navigationBox.x + navigationBox.width / 2,
      clientY: navigationBox.y + 120,
      pointerId: 81,
      pointerType: 'mouse'
    })
    await expect.poll(async () => electronApp.evaluate(({ BrowserWindow }) => {
      const child = BrowserWindow.getAllWindows()[0].contentView.children.find((candidate) => {
        const bounds = candidate.getBounds()
        return bounds.width > 0 && bounds.height > 0
      })
      return child?.getVisible()
    })).toBe(false)
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', {
      pointerId: 81,
      pointerType: 'mouse'
    })))
    await expect(page.locator('.app-shell')).not.toHaveClass(/is-panel-resizing/u)
    await expect.poll(async () => electronApp.evaluate(({ BrowserWindow }) => {
      const child = BrowserWindow.getAllWindows()[0].contentView.children.find((candidate) => {
        const bounds = candidate.getBounds()
        return bounds.width > 0 && bounds.height > 0
      })
      return child?.getVisible()
    })).toBe(true)

    const isolation = await electronApp.evaluate(async ({ webContents }, expectedUrl) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === expectedUrl)
      if (!contents) throw new Error('research WebContents not found')
      return contents.executeJavaScript(`({
        processType: typeof process,
        requireType: typeof require,
        coscribeType: typeof window.coscribe,
        heading: document.querySelector('h1')?.textContent,
        headingColor: getComputedStyle(document.querySelector('h1')).color,
        background: getComputedStyle(document.body).backgroundColor
      })`)
    }, url)
    expect(isolation).toEqual({
      processType: 'undefined',
      requireType: 'undefined',
      coscribeType: 'undefined',
      heading: 'Original Web Layout',
      headingColor: 'rgb(20, 90, 70)',
      background: 'rgb(245, 250, 248)'
    })

    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 760))
    await expect.poll(async () => {
      const ai = await page.locator('.ai-workspace').boundingBox()
      const navigator = await page.locator('.project-navigator').boundingBox()
      const browserBounds = await electronApp.evaluate(({ BrowserWindow }) => (
        BrowserWindow.getAllWindows()[0].contentView.children
          .map((child) => child.getBounds())
          .find((bounds) => bounds.width > 0 && bounds.height > 0)
      ))
      return Boolean(
        ai && navigator && browserBounds &&
        browserBounds.width > 0 && browserBounds.height > 0 &&
        browserBounds.x >= Math.floor(navigator.x + navigator.width) - 1 &&
        browserBounds.x + browserBounds.width <= Math.ceil(ai.x) + 1
      )
    }).toBe(true)
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920))

    await electronApp.evaluate(async ({ webContents }, expectedUrl) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === expectedUrl)
      if (!contents) throw new Error('research WebContents not found')
      await contents.executeJavaScript(`(() => {
        const node = document.querySelector('#selection').firstChild
        const range = document.createRange()
        range.selectNodeContents(node)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
      })()`)
      contents.focus()
      contents.sendInputEvent({
        type: 'keyDown',
        keyCode: 'K',
        modifiers: [process.platform === 'darwin' ? 'meta' : 'control', 'shift']
      })
    }, url)
    await expect(page.getByLabel('向 AI 提问')).toContainText('WEB_SELECTION_SENTINEL')
    await expect(page.getByLabel('基于')).toHaveValue('selection')
    await expect(page.getByLabel('当前 AI 上下文')).toContainText('Isolated Research Page')

    await page.getByRole('button', { name: '保存完整网页归档' }).click()
    const archivePath = path.join(projectPath, '资料剪藏', 'Isolated Research Page.mhtml')
    await expect.poll(async () => access(archivePath).then(() => true).catch(() => false)).toBe(true)
    const archive = await readFile(archivePath, 'latin1')
    expect(archive).toMatch(/^From: <Saved by Blink>/u)
    expect(archive).toContain(`Snapshot-Content-Location: ${url}`)
    expect(archive).toContain('WEB_ARTICLE_SENTINEL')
    expect(archive).toContain('body { font-family: system-ui;')
    expect(archive).toContain('Content-Type: multipart/related;')
    expect(archive).toContain('WEB_ARCHIVE_TAIL_SENTINEL')
    expect(archive).toContain('Original Web Layout')

    await page.locator('.tree-row').filter({ hasText: '资料剪藏' }).click()
    await page.locator('.tree-row').filter({ hasText: 'Isolated Research Page.mhtml' }).click()
    await expect(page.getByText('这是由 Chromium 保存的完整网页归档')).toBeVisible()
    await expect(page.getByRole('button', { name: '使用其他应用打开' })).toBeVisible()
    await page.getByRole('button', { name: '资料浏览器', exact: true }).click()
    await expect(page.locator('.research-browser__tabbar strong')).toHaveText('Isolated Research Page')

    await page.getByRole('button', { name: '保存网页为 Markdown' }).click()
    const markdownPath = path.join(projectPath, '资料剪藏', 'Isolated Research Page.md')
    await expect.poll(async () => readFile(markdownPath, 'utf8').catch(() => '')).toContain('WEB\\_ARTICLE\\_SENTINEL')
    const markdown = await readFile(markdownPath, 'utf8')
    expect(markdown).toContain(`> 来源：[${url}](<${url}>)`)
    expect(markdown).toContain('[WEB\\_LINK\\_\\[LABEL\\]](<')
    expect(markdown).not.toContain('javascript:alert')
    expect(markdown).toContain('````js\nconst ticks = "```";\n````')
    expect(markdown).not.toContain('WEB_ARCHIVE_TAIL_SENTINEL')

    await page.getByRole('button', { name: '保存原网页为 PDF' }).click()
    const pdfPath = path.join(projectPath, '资料剪藏', 'Isolated Research Page.pdf')
    await expect.poll(async () => access(pdfPath).then(() => true).catch(() => false)).toBe(true)
    const pdf = await readFile(pdfPath)
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(1_000)

    await page.screenshot({ path: testInfo.outputPath('research-browser.png') })

    const secondProject = path.join(projectPath, 'project-b')
    await mkdir(secondProject)
    await page.evaluate((nextProject) => window.coscribe.project.openPath(nextProject), secondProject)
    await expect.poll(async () => electronApp.evaluate(({ webContents }, previousUrl) => (
      webContents.getAllWebContents().some((contents) => contents.getURL() === previousUrl)
    ), url)).toBe(false)
    const saveAfterSwitch = await page.evaluate(() => window.coscribe.browser.saveArchive().then(
      () => 'saved',
      (error: unknown) => error instanceof Error ? error.message : String(error)
    ))
    expect(saveAfterSwitch).toContain('请先打开一个网页')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('copies selected document text into the AI composer with a shortcut', async () => {
  await page.locator('.tree-row').filter({ hasText: 'README.md' }).click()
  const paragraph = page.locator('.vk-markdown-preview p').filter({ hasText: 'E2E_SENTINEL' })
  await expect(paragraph).toBeVisible()
  await paragraph.evaluate((element) => {
    const textNode = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)
    if (!textNode) throw new Error('Markdown paragraph has no text node')
    const text = textNode.textContent ?? ''
    const start = text.indexOf('E2E_SENTINEL')
    const range = document.createRange()
    range.setStart(textNode, start)
    range.setEnd(textNode, start + 'E2E_SENTINEL 路由'.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+K' : 'Control+Shift+K')
  await expect(page.getByLabel('向 AI 提问')).toHaveValue('E2E_SENTINEL 路由')
  await expect(page.getByLabel('基于')).toHaveValue('selection')
})

test('persists transparent project memory and the editable system prompt', async () => {
  await page.getByRole('button', { name: '记忆', exact: true }).click()
  const memoryEditor = page.getByLabel('项目记忆 Markdown')
  await expect(memoryEditor).toHaveValue(/CoScribe Project Memory/u)
  await memoryEditor.fill([
    '# CoScribe Project Memory',
    '',
    '## 稳定约定',
    '',
    '- 所有计划都使用普通 Markdown。',
    '- 技术解释先给结论，再给依据。'
  ].join('\n'))
  await page.getByRole('button', { name: '保存记忆' }).click()
  await expect.poll(async () => readFile(path.join(projectPath, 'COSCRIBE.md'), 'utf8').catch(() => '')).toContain('技术解释先给结论')
  await expect(page.getByText('已写入项目')).toBeVisible()

  await page.locator('.app-titlebar__actions').getByRole('button', { name: '设置' }).click()
  await page.getByLabel('自定义系统提示词').fill('回答时先给结论；关键术语保留英文原文。')
  await page.getByRole('button', { name: '保存设置' }).click()
  await page.locator('.app-titlebar__actions').getByRole('button', { name: '设置' }).click()
  await expect(page.getByLabel('自定义系统提示词')).toHaveValue('回答时先给结论；关键术语保留英文原文。')
  await page.getByRole('button', { name: '取消' }).click()
})

test('opens the trusted planner plugin and stores schedule data as Markdown', async ({}, testInfo) => {
  await page.getByRole('button', { name: '插件', exact: true }).click()
  await expect(page.getByText('可信内置插件')).toBeVisible()
  await expect(page.getByText('当前版本不下载或执行第三方代码')).toBeVisible()
  await page.getByRole('button', { name: '补充授权计划与日程' }).click()
  await expect(page.getByRole('dialog')).toContainText('写入 macOS 日历或提醒事项')
  await page.getByRole('button', { name: '授权并启用' }).click()
  await page.getByRole('button', { name: '打开插件' }).click()

  const planner = page.getByRole('region', { name: '计划与日程插件' })
  await expect(planner).toBeVisible()
  const plannerPath = path.join(projectPath, '计划', '项目计划.md')
  await expect.poll(async () => readFile(plannerPath, 'utf8').catch(() => '')).toContain('coscribe:planner:start')

  await planner.getByLabel('事项', { exact: true }).fill('完成 v2.1.0 本地体验验收')
  await planner.getByLabel('时间', { exact: true }).fill('10:30')
  await planner.getByLabel('优先级').selectOption('高')
  await planner.getByLabel('备注').fill('检查语音、记忆与插件性能')
  await planner.getByRole('button', { name: '加入日程' }).click()

  await expect(planner.getByText('完成 v2.1.0 本地体验验收')).toBeVisible()
  await expect(planner.getByRole('button', { name: '将 完成 v2.1.0 本地体验验收 同步到日历' })).toBeEnabled()
  await expect.poll(async () => readFile(plannerPath, 'utf8')).toContain('| 10:30 | 完成 v2.1.0 本地体验验收 | 待办 | 高 | 检查语音、记忆与插件性能 |')
  await planner.screenshot({ path: testInfo.outputPath('planner-plugin.png') })

  await planner.getByRole('button', { name: /编辑 Markdown/u }).click()
  await expect(page.getByLabel('项目计划.md Markdown 编辑器')).toBeVisible()
  await expect(page.getByLabel('Markdown 预览')).toContainText('完成 v2.1.0 本地体验验收')
})

test('decodes streaming speech through the isolated native ASR process', async () => {
  test.skip(!speechTestWav, 'Set COSCRIBE_ASR_TEST_WAV to a 16-bit PCM WAV fixture for the native ASR integration test.')
  test.setTimeout(90_000)
  const payload = pcm16WavPayload(await readFile(speechTestWav!))
  await expect(page.getByRole('button', { name: '开始语音输入' })).toBeVisible()

  const transcript = await page.evaluate(async (fixture) => {
    const binary = atob(fixture.pcmBase64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const view = new DataView(bytes.buffer)
    const frameBytes = fixture.channels * 2
    const samples = new Float32Array(Math.floor(bytes.byteLength / frameBytes))
    for (let frame = 0; frame < samples.length; frame += 1) {
      let sum = 0
      for (let channel = 0; channel < fixture.channels; channel += 1) {
        sum += view.getInt16(frame * frameBytes + channel * 2, true) / 32_768
      }
      samples[frame] = sum / fixture.channels
    }

    const requestId = `speech-e2e-${crypto.randomUUID()}`
    return new Promise<string>((resolve, reject) => {
      let latest = ''
      let settled = false
      let timeout = 0
      let unsubscribe = (): void => undefined
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        window.clearTimeout(timeout)
        unsubscribe()
        callback()
      }
      unsubscribe = window.coscribe.speech.onEvent((event) => {
        if (event.requestId !== requestId) return
        if (event.type === 'transcript') latest = event.text
        else if (event.type === 'error') finish(() => reject(new Error(event.message)))
        else if (event.type === 'stopped') finish(() => resolve(latest))
      })
      timeout = window.setTimeout(() => finish(() => reject(new Error('native ASR E2E timed out'))), 75_000)

      void (async () => {
        try {
          const status = await window.coscribe.speech.status()
          if (!status.available) throw new Error(status.reason ?? 'native ASR unavailable')
          await window.coscribe.speech.start(requestId, fixture.sampleRate)
          for (let offset = 0; offset < samples.length; offset += 3_200) {
            window.coscribe.speech.audio(requestId, samples.slice(offset, offset + 3_200))
            if (offset % 32_000 === 0) await new Promise((resume) => window.setTimeout(resume, 1))
          }
          await new Promise((resume) => window.setTimeout(resume, 120))
          await window.coscribe.speech.stop(requestId)
        } catch (reason) {
          finish(() => reject(reason))
        }
      })()
    })
  }, payload)

  expect(transcript).toContain('MONDAY')
  expect(transcript).toContain('星期三')
})

test('drag-selects a screenshot region and adds the crop to chat attachments', async ({}, testInfo) => {
  await page.locator('.tree-row').filter({ hasText: 'README.md' }).click()
  await expect(page.getByLabel('README.md Markdown 编辑器')).toBeVisible()
  const selectorWindow = electronApp.waitForEvent('window')
  await page.getByRole('button', { name: '截图', exact: true }).click()
  const selector = await selectorWindow
  await selector.waitForLoadState('domcontentloaded')
  await expect(selector.locator('#shade')).toBeVisible()
  await expect(selector.locator('#screen')).toHaveAttribute('src', /^data:image\/jpeg;base64,/u)
  await expect.poll(async () => electronApp.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().startsWith('coscribe-app:'))
    return Boolean(main?.isVisible())
  })).toBe(true)

  const closed = selector.waitForEvent('close')
  await selector.mouse.move(700, 250)
  await selector.mouse.down()
  await selector.mouse.move(1_120, 600, { steps: 5 })
  await selector.screenshot({ path: testInfo.outputPath('screenshot-roi-selector.png') })
  await selector.mouse.up()
  await closed

  const attachment = page.getByRole('img', { name: /CoScribe-screenshot-/u })
  await expect(attachment).toBeVisible()
  const source = await attachment.getAttribute('src')
  expect(source).toMatch(/^data:image\/jpeg;base64,/u)
  const attachmentStats = await electronApp.evaluate(({ nativeImage }, dataUrl) => {
    const image = nativeImage.createFromDataURL(dataUrl)
    const size = image.getSize()
    const bitmap = image.toBitmap()
    let ink = 0
    let samples = 0
    for (let offset = 0; offset + 3 < bitmap.length; offset += 4 * 23) {
      samples += 1
      if (bitmap[offset] < 220 || bitmap[offset + 1] < 220 || bitmap[offset + 2] < 220) ink += 1
    }
    return { size, inkRatio: samples ? ink / samples : 0 }
  }, source!)
  expect(attachmentStats.size.width).toBeGreaterThan(200)
  expect(attachmentStats.size.height).toBeGreaterThan(150)
  expect(attachmentStats.inkRatio).toBeGreaterThan(0.01)
})

test('runs bundled local OCR from the packaged renderer origin', async () => {
  test.setTimeout(120_000)
  await page.locator('.tree-row').filter({ hasText: 'OCR测试.svg' }).click()
  await expect(page.getByLabel('OCR测试.svg 图片查看器')).toBeVisible()
  await page.getByRole('button', { name: '本地文字识别' }).click()

  const panel = page.getByLabel('OCR 识别结果')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.vk-ocr-state')).toBeVisible()
  await expect(panel.locator('.vk-ocr-state')).toHaveCount(0, { timeout: 90_000 })
  await expect(panel.locator('.vk-ocr-error')).toHaveCount(0)
  await expect(panel.locator('.vk-ocr-text')).toContainText(/(?:COSCRIBE|OCR TEST)/iu, { timeout: 90_000 })
})

test('keeps the file tree when optional project metadata cannot be read', async () => {
  await electronApp.close()
  await rm(path.join(projectPath, '.vibeknowledge', 'sessions.json'), { force: true })
  await mkdir(path.join(projectPath, '.vibeknowledge', 'sessions.json'))
  await launchProject()
  await expect(page.locator('.tree-row').filter({ hasText: 'README.md' })).toBeVisible()
  await expect(page.locator('[role="alert"]')).toContainText('会话历史无法恢复')
})

test('expands the AI workspace beyond the old cap without reverse-drag dead space', async ({}, testInfo) => {
  const panel = page.locator('.ai-workspace')
  const separator = page.getByRole('separator', { name: '调整 AI 面板宽度' })
  const dragSeparator = async (deltaX: number): Promise<void> => {
    const box = await separator.boundingBox()
    if (!box) throw new Error('AI resize separator is not visible')
    const x = box.x + box.width / 2
    const y = box.y + Math.min(120, box.height / 2)
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + deltaX, y, { steps: 8 })
    await page.mouse.up()
  }

  await dragSeparator(-460)
  const expandedWidth = await panel.evaluate((element) => element.getBoundingClientRect().width)
  expect(expandedWidth).toBeGreaterThan(560)
  await page.screenshot({ path: testInfo.outputPath('expanded-ai-workspace.png') })

  await dragSeparator(-500)
  const maximumWidth = Number(await separator.getAttribute('aria-valuemax'))
  const cappedWidth = await panel.evaluate((element) => element.getBoundingClientRect().width)
  expect(Math.round(cappedWidth)).toBe(maximumWidth)

  await dragSeparator(40)
  const reversedWidth = await panel.evaluate((element) => element.getBoundingClientRect().width)
  expect(reversedWidth).toBeLessThan(cappedWidth - 20)

  await separator.focus()
  await page.keyboard.press('Home')
  await expect(separator).toHaveAttribute('aria-valuenow', '360')
  await expect.poll(async () => panel.evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(360)
})

test('cleans up cancelled project-navigation drags without leaving a black window', async () => {
  await page.locator('.tree-row').filter({ hasText: 'README.md' }).click()
  const separator = page.getByRole('separator', { name: '调整项目导航宽度' })
  const box = await separator.boundingBox()
  if (!box) throw new Error('Project navigation resize separator is not visible')

  await separator.dispatchEvent('pointerdown', {
    button: 0,
    buttons: 1,
    clientX: box.x + box.width / 2,
    clientY: box.y + 120,
    pointerId: 71,
    pointerType: 'mouse'
  })
  await expect(page.locator('.app-shell')).toHaveClass(/is-panel-resizing/u)
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', {
    pointerId: 71,
    pointerType: 'mouse'
  })))
  await expect(page.locator('.app-shell')).not.toHaveClass(/is-panel-resizing/u)

  for (let index = 0; index < 12; index += 1) {
    const current = await separator.boundingBox()
    if (!current) throw new Error('Project navigation resize separator disappeared')
    const x = current.x + current.width / 2
    const y = current.y + 120
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + (index % 2 === 0 ? 120 : -120), y, { steps: 3 })
    await page.mouse.up()
  }

  const rendered = await electronApp.evaluate(async ({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().startsWith('coscribe-app:'))
    if (!main) return { empty: true, visible: false, nonBlackRatio: 0 }
    const image = await main.webContents.capturePage()
    const bitmap = image.toBitmap()
    let nonBlack = 0
    let samples = 0
    for (let offset = 0; offset + 3 < bitmap.length; offset += 4 * 97) {
      samples += 1
      if (bitmap[offset] > 18 || bitmap[offset + 1] > 18 || bitmap[offset + 2] > 18) nonBlack += 1
    }
    return {
      empty: image.isEmpty(),
      visible: main.isVisible(),
      nonBlackRatio: samples ? nonBlack / samples : 0
    }
  })
  expect(rendered.empty).toBe(false)
  expect(rendered.visible).toBe(true)
  expect(rendered.nonBlackRatio).toBeGreaterThan(0.08)
  await expect(page.locator('.app-shell')).not.toHaveClass(/is-panel-resizing/u)
  await expect(page.getByLabel('README.md Markdown 编辑器')).toBeVisible()
})

test('resizes the Markdown outline and keeps narrow AI tools on one line', async ({}, testInfo) => {
  await page.locator('.tree-row').filter({ hasText: 'README.md' }).click()
  const outline = page.getByRole('complementary', { name: 'Markdown 大纲' })
  const outlineSeparator = page.getByRole('separator', { name: '调整 Markdown 大纲宽度' })
  const initialOutlineWidth = await outline.evaluate((element) => element.getBoundingClientRect().width)
  const outlineBox = await outlineSeparator.boundingBox()
  if (!outlineBox) throw new Error('Markdown outline resize separator is not visible')
  await page.mouse.move(outlineBox.x + outlineBox.width / 2, outlineBox.y + 140)
  await page.mouse.down()
  await page.mouse.move(outlineBox.x + 305, outlineBox.y + 140, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => outline.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(initialOutlineWidth + 250)

  const longHeading = outline.getByRole('button', { name: /一个用于验证大纲宽度可调/u }).locator('span')
  await expect.poll(async () => longHeading.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)

  const aiSeparator = page.getByRole('separator', { name: '调整 AI 面板宽度' })
  const aiBox = await aiSeparator.boundingBox()
  if (!aiBox) throw new Error('AI resize separator is not visible')
  await page.mouse.move(aiBox.x + aiBox.width / 2, aiBox.y + 120)
  await page.mouse.down()
  await page.mouse.move(aiBox.x + 800, aiBox.y + 120, { steps: 8 })
  await page.mouse.up()
  await expect(aiSeparator).toHaveAttribute('aria-valuenow', '300')

  const toolbar = page.locator('.ai-composer__toolbar')
  const toolButtons = toolbar.locator('.ai-composer__tool')
  await expect.poll(async () => toolbar.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(42)
  for (const button of await toolButtons.all()) {
    expect(await button.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(27)
    expect(await button.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('nowrap')
  }
  await page.screenshot({ path: testInfo.outputPath('resizable-outline-and-narrow-ai.png') })
})

test('keeps focus while entering a new project name character by character', async ({}, testInfo) => {
  await page.getByRole('button', { name: '返回首页' }).click()
  await expect(page.getByRole('button', { name: '新建项目' })).toBeVisible()
  await page.getByRole('button', { name: '新建项目' }).click()

  const input = page.getByLabel('项目名称')
  await expect(input).toBeFocused()
  await input.pressSequentially('FastAPI 学习项目', { delay: 20 })
  await expect(input).toHaveValue('FastAPI 学习项目')
  await expect(input).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('new-project-dialog.png') })
})

test('restores open tabs after a cold restart and keeps AI optional', async () => {
  await page.locator('.tree-row').filter({ hasText: 'README.md' }).click()
  await expect(page.getByLabel('README.md Markdown 编辑器')).toBeVisible()
  await expect(page.getByText('尚未配置 AI')).toBeVisible()
  await page.waitForTimeout(700)
  await electronApp.close()

  await launchProject()
  await expect(page.getByLabel('README.md Markdown 编辑器')).toBeVisible()
  await expect(page.locator('.editor-tab').filter({ hasText: 'README.md' })).toHaveClass(/is-active/)
})

test('switches the model and reasoning effort from the status bar and persists both', async ({}, testInfo) => {
  let trigger = page.getByRole('button', { name: /切换 AI 模型和思考强度/ })
  await expect(trigger).toContainText('gpt-5.6-terra')
  await expect(trigger).toContainText('Medium')

  await trigger.click()
  await page.getByRole('menuitemradio', { name: 'gpt-5.6-luna' }).click()
  await expect(trigger).toContainText('gpt-5.6-luna')

  await trigger.click()
  await page.getByRole('menuitemradio', { name: /More reasoning/ }).click()
  await expect(trigger).toContainText('Max')

  await trigger.click()
  await expect(page.getByRole('menu', { name: 'AI 模型和思考强度' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('model-switcher.png') })
  await page.keyboard.press('Escape')

  await page.locator('.app-titlebar__actions').getByRole('button', { name: '设置' }).click()
  await page.getByLabel('主题').selectOption('dark')
  await page.getByRole('button', { name: '保存设置' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await trigger.click()
  await page.screenshot({ path: testInfo.outputPath('model-switcher-dark.png') })
  await page.keyboard.press('Escape')

  await electronApp.close()
  await launchProject()
  trigger = page.getByRole('button', { name: /切换 AI 模型和思考强度/ })
  await expect(trigger).toContainText('gpt-5.6-luna')
  await expect(trigger).toContainText('Max')
})

test('keeps an AI-created note on preview until the user accepts it', async () => {
  let requestBody: Record<string, unknown> | null = null
  let requestPath: string | null = null
  const server = createServer(async (request, response) => {
    requestPath = request.url ?? null
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '笔记已经整理好，请先核对预览。' }]
        },
        {
          type: 'function_call',
          name: 'propose_markdown_operation',
          arguments: JSON.stringify({
            kind: 'create',
            targetPath: 'AI 生成笔记.md',
            proposedContent: '# AI 生成笔记\n\n这是经过用户确认后才落盘的内容。\n',
            summary: '根据当前学习会话创建笔记'
          })
        }
      ]
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  try {
    const port = (server.address() as AddressInfo).port
    await page.getByRole('button', { name: '配置', exact: true }).click()
    await page.getByLabel('服务地址').fill(`http://127.0.0.1:${port}`)
    await page.getByLabel('模型', { exact: true }).fill('local-e2e-model')
    await page.getByRole('button', { name: '保存设置' }).click()

    await page.getByLabel('向 AI 提问').fill('根据当前会话创建一份笔记')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.getByText('笔记已经整理好，请先核对预览。')).toBeVisible()
    await expect(page.getByLabel('创建 Markdown建议')).toBeVisible()

    const notePath = path.join(projectPath, 'AI 生成笔记.md')
    await expect.poll(async () => access(notePath).then(() => true).catch(() => false)).toBe(false)
    await page.getByRole('button', { name: '接受并写入' }).click()
    await expect.poll(async () => readFile(notePath, 'utf8').catch(() => '')).toContain('经过用户确认后才落盘')
    await expect(page.getByLabel('AI 生成笔记.md Markdown 编辑器')).toBeVisible()

    await page.getByRole('button', { name: 'AI 操作', exact: true }).click()
    const historyItem = page.locator('.operation-history__item').filter({ hasText: '根据当前学习会话创建笔记' })
    await expect(historyItem).toContainText('已应用')
    await historyItem.getByRole('button', { name: '撤销这次操作' }).click()
    await expect.poll(async () => access(notePath).then(() => true).catch(() => false)).toBe(false)
    await expect(historyItem).toContainText('已撤销')

    const capturedRequest = requestBody as Record<string, unknown> | null
    const input = capturedRequest?.['input']
    expect(Array.isArray(input)).toBe(true)
    expect(JSON.stringify(input)).toContain('根据当前会话创建一份笔记')
    expect(requestPath).toBe('/responses')
    expect(capturedRequest?.['messages']).toBeUndefined()
    expect(capturedRequest?.['reasoning']).toEqual({ effort: 'medium' })
    expect(JSON.stringify(capturedRequest?.['tools'])).toContain('propose_markdown_operation')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('writes a multi-file note project immediately after the explicit quick-note action', async () => {
  let requestCount = 0
  const requestBodies: Record<string, unknown>[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requestBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
    requestCount += 1
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(requestCount === 1
      ? {
          output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '这里有值得长期保留的学习结论。' }]
          }]
        }
      : {
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '已整理并保存多文件笔记。' }]
            },
            {
              type: 'function_call',
              name: 'propose_markdown_operation',
              arguments: JSON.stringify({
                operations: [
                  { kind: 'create', targetPath: '学习/API/index.md', proposedContent: '# 学习索引\n\n- [API 要点](api.md)\n' },
                  { kind: 'create', targetPath: '学习/API/api.md', proposedContent: '# API 要点\n\n自动保存的结构化内容。\n' }
                ],
                summary: '创建多文件学习笔记项目'
              })
            }
          ]
        }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  try {
    const port = (server.address() as AddressInfo).port
    await page.getByRole('button', { name: '配置', exact: true }).click()
    await page.getByLabel('服务地址').fill(`http://127.0.0.1:${port}`)
    await page.getByLabel('模型', { exact: true }).fill('local-e2e-model')
    await page.getByRole('button', { name: '保存设置' }).click()

    await page.locator('.tree-row').filter({ hasText: 'README.md' }).click()
    await expect(page.getByLabel('README.md Markdown 编辑器')).toBeVisible()
    const readmeBefore = await readFile(path.join(projectPath, 'README.md'), 'utf8')
    await page.getByLabel('向 AI 提问').fill('请解释今天的 API 学习内容')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.getByText('这里有值得长期保留的学习结论。')).toBeVisible()
    await page.getByRole('button', { name: '整理笔记', exact: true }).click()

    const indexPath = path.join(projectPath, '学习', 'API', 'index.md')
    const topicPath = path.join(projectPath, '学习', 'API', 'api.md')
    await expect.poll(async () => readFile(indexPath, 'utf8').catch(() => '')).toContain('[API 要点](api.md)')
    await expect.poll(async () => readFile(topicPath, 'utf8').catch(() => '')).toContain('自动保存的结构化内容')
    expect(await readFile(path.join(projectPath, 'README.md'), 'utf8')).toBe(readmeBefore)
    await expect(page.getByRole('button', { name: '接受并写入' })).toHaveCount(0)
    expect(requestCount).toBe(2)

    const organizationRequest = JSON.stringify(requestBodies[1])
    expect(organizationRequest).toContain('项目目录结构')
    expect(organizationRequest).toContain('README.md')
    expect(organizationRequest).toContain('自主选择')
    expect(organizationRequest).toContain('当前打开文档仅供参考')
    expect(organizationRequest).not.toContain('当前笔记写入目标：README.md')
    expect(organizationRequest).not.toContain('必须直接把该相对路径放入 operations 并使用 append')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('keeps current-document scope and gives note-taking the exact Markdown path', async () => {
  let requestBody: Record<string, unknown> | null = null
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '已把要点整理为当前笔记的追加预览。' }]
        },
        {
          type: 'function_call',
          name: 'propose_markdown_operation',
          arguments: JSON.stringify({
            kind: 'append',
            targetPath: 'README.md',
            proposedContent: '\n\n## AI 整理\n\n- 当前文档要点\n',
            summary: '追加当前文档学习要点'
          })
        }
      ]
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  try {
    const port = (server.address() as AddressInfo).port
    await page.getByRole('button', { name: '配置', exact: true }).click()
    await page.getByLabel('服务地址').fill(`http://127.0.0.1:${port}`)
    await page.getByLabel('模型', { exact: true }).fill('local-e2e-model')
    await page.getByRole('button', { name: '保存设置' }).click()

    await page.locator('.tree-row').filter({ hasText: 'README.md' }).click()
    await expect(page.getByLabel('README.md Markdown 编辑器')).toBeVisible()
    await page.getByLabel('基于').selectOption('document')
    await expect(page.getByLabel('当前 AI 上下文')).toContainText('README.md')
    await expect(page.getByLabel('当前 AI 上下文')).toContainText('完整文档')
    await expect(page.getByLabel('当前 AI 上下文')).not.toContainText('模型通用知识')

    await page.getByLabel('向 AI 提问').fill('请把刚才的要点记笔记')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.getByText('已把要点整理为当前笔记的追加预览。')).toBeVisible()
    await expect(page.getByLabel('追加内容建议')).toContainText('README.md')
    await expect(page.getByText('基于：README.md')).toBeVisible()
    await expect(page.getByText('基于：模型通用知识')).toHaveCount(0)

    const serialized = JSON.stringify(requestBody)
    expect(serialized).toContain('上下文范围：document')
    expect(serialized).toContain('当前文档项目内相对路径：README.md')
    expect(serialized).toContain('当前笔记写入目标：README.md')
    expect(serialized).toContain('必须直接把该相对路径放入 operations 并使用 append')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('uses an independent third-party GPT-Image 2 endpoint and renders the downloadable result', async ({}, testInfo) => {
  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  let requestBody: Record<string, unknown> | null = null
  let chatRequestBody: Record<string, unknown> | null = null
  let requestPath: string | null = null
  let authorization: string | null = null
  const server = createServer(async (request, response) => {
    const currentPath = request.url ?? null
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    if (currentPath === '/responses') {
      chatRequestBody = body
      response.end(JSON.stringify({
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '已读取生成图片的本地路径。' }]
        }]
      }))
      return
    }
    requestPath = currentPath
    authorization = request.headers.authorization ?? null
    requestBody = body
    response.end(JSON.stringify({ data: [{ b64_json: imageBase64 }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  try {
    const port = (server.address() as AddressInfo).port
    const endpoint = `http://127.0.0.1:${port}/third-party/v1/images/generations`
    await page.getByRole('button', { name: '配置', exact: true }).click()
    await page.getByLabel('服务地址').fill(`http://127.0.0.1:${port}`)
    await page.getByLabel('模型', { exact: true }).fill('local-e2e-model')
    await page.getByLabel('图片生成请求地址').fill(endpoint)
    await page.getByRole('textbox', { name: /图片 API Key/ }).fill('image-e2e-secret')
    await page.getByRole('button', { name: '保存设置' }).click()

    await page.locator('.ai-composer__tool').filter({ hasText: '生成图片' }).click()
    await page.getByLabel('图片尺寸').selectOption('1536x1024')
    await page.getByLabel('图片质量').selectOption('high')
    await page.getByLabel('向 AI 提问').fill('一张用于课程封面的极简知识网络图')
    await page.locator('.ai-composer__send').click()

    const generatedImages = page.getByLabel('生成的图片')
    await expect(generatedImages).toBeVisible()
    const image = generatedImages.getByRole('img')
    await expect(image).toBeVisible()
    await expect(image).toHaveAttribute('src', `data:image/png;base64,${imageBase64}`)
    const download = generatedImages.getByRole('link', { name: /^下载 gpt-image-2-/ })
    await expect(download).toBeVisible()
    await expect(download).toHaveAttribute('download', /^gpt-image-2-\d+-[a-f0-9]{8}\.png$/)
    await expect(download).toHaveAttribute('href', `data:image/png;base64,${imageBase64}`)
    const generatedFilename = await download.getAttribute('download')
    expect(generatedFilename).not.toBeNull()
    await expect.poll(async () => access(
      path.join(projectPath, 'assets', 'ai-images', generatedFilename!),
    ).then(() => true).catch(() => false)).toBe(true)

    expect(requestPath).toBe('/third-party/v1/images/generations')
    expect(authorization).toBe('Bearer image-e2e-secret')
    expect(requestBody).toMatchObject({
      model: 'gpt-image-2',
      prompt: '一张用于课程封面的极简知识网络图',
      size: '1536x1024',
      quality: 'high',
      output_format: 'jpeg',
      output_compression: 90,
      n: 1
    })

    await page.locator('.ai-composer__tool').filter({ hasText: '生成图片' }).click()
    await page.getByLabel('向 AI 提问').fill('把当前图片放到笔记中')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.getByText('已读取生成图片的本地路径。')).toBeVisible()
    const chatRequest = JSON.stringify(chatRequestBody)
    expect(chatRequest).toContain(`项目相对路径：assets/ai-images/${generatedFilename}`)
    expect(chatRequest).toContain(`Markdown 可用路径：/assets/ai-images/${generatedFilename}`)
    expect(chatRequest).toContain(`本机绝对路径：${path.join(await realpath(projectPath), 'assets', 'ai-images', generatedFilename!)}`)
    await generatedImages.screenshot({ path: testInfo.outputPath('third-party-gpt-image-2.png') })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('renders Mermaid diagrams and highlighted code in AI answers', async ({}, testInfo) => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the request before returning the mocked model response.
    }
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: [
            '这是执行流程：',
            '',
            '```mermaid',
            'graph LR',
            '  A[读取] --> B[高亮]',
            '```',
            '',
            '```typescript',
            'const answer: number = 42',
            '```'
          ].join('\n')
        }]
      }]
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  try {
    const port = (server.address() as AddressInfo).port
    await page.getByRole('button', { name: '配置', exact: true }).click()
    await page.getByLabel('服务地址').fill(`http://127.0.0.1:${port}`)
    await page.getByLabel('模型', { exact: true }).fill('local-e2e-model')
    await page.getByRole('button', { name: '保存设置' }).click()

    await page.getByLabel('向 AI 提问').fill('请给出流程图和代码')
    await page.getByRole('button', { name: '发送消息' }).click()

    const aiMessage = page.locator('.ai-message--assistant').last()
    await expect(aiMessage.locator('.vk-mermaid-svg svg')).toBeVisible({ timeout: 15_000 })
    await expect(aiMessage.locator('.vk-mermaid-error')).toHaveCount(0)
    const codeBlock = aiMessage.getByRole('region', { name: 'TypeScript 代码块' })
    await expect(codeBlock).toBeVisible()
    await expect(codeBlock.locator('.hljs-keyword')).toHaveText('const')
    await expect(codeBlock.locator('.hljs-number')).toHaveText('42')
    await page.screenshot({ path: testInfo.outputPath('ai-mermaid-and-code.png') })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
