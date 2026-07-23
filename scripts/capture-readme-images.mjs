import { _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'docs', 'images')
const projectPath = await mkdtemp(path.join(tmpdir(), 'coscribe-readme-project-'))
const userDataPath = await mkdtemp(path.join(tmpdir(), 'coscribe-readme-user-'))

await mkdir(output, { recursive: true })
await copyFile(
  path.join(root, 'resources', 'guide', 'CoScribe 使用指南.md'),
  path.join(projectPath, 'CoScribe 使用指南.md')
)
await writeFile(path.join(projectPath, 'OCR 示例.svg'), [
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="480" viewBox="0 0 1200 480">',
  '<rect width="1200" height="480" fill="white"/>',
  '<text x="70" y="190" fill="#17191f" font-family="Arial, sans-serif" font-size="82" font-weight="700">COSCRIBE OCR</text>',
  '<text x="70" y="310" fill="#50545f" font-family="Arial, sans-serif" font-size="54">LOCAL · PRIVATE · SEARCHABLE</text>',
  '</svg>'
].join(''))
await copyFile(path.join(root, 'tests', 'fixtures', 'coscribe-pptx-sample.pptx'), path.join(projectPath, 'CoScribe 演示.pptx'))

const server = createServer(async (request, response) => {
  if (request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end([
      '<!doctype html><html><head><title>Knowledge Research · CoScribe</title>',
      '<style>',
      'body{margin:0;font:16px/1.7 system-ui;color:#20232a;background:#f7f8fa}',
      'main{max-width:860px;margin:0 auto;padding:58px 70px 90px;background:white;min-height:100vh}',
      '.tag{color:#6654b8;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:12px}',
      'h1{font-size:42px;line-height:1.14;margin:12px 0 22px;color:#15161a}',
      'h2{margin-top:38px;border-bottom:1px solid #e3e5e9;padding-bottom:8px}',
      'blockquote{margin:28px 0;padding:14px 20px;border-left:3px solid #7c67d3;background:#f3f1fb}',
      '</style></head><body><main><div class="tag">Research source</div>',
      '<h1>How durable notes turn reading into reusable knowledge</h1>',
      '<p>Good research software keeps the original source visible while helping readers extract evidence, ask focused questions, and save durable local notes.</p>',
      '<blockquote>Select a passage, send the article to AI, or preserve the original layout as PDF.</blockquote>',
      '<h2>Local-first workflow</h2>',
      '<p>The project folder remains the source of truth. Markdown clippings include the original URL and capture time.</p>',
      '</main></body></html>'
    ].join(''))
    return
  }
  for await (const _chunk of request) {
    // Consume request.
  }
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: [
          '这份文档的核心流程可以归纳为三步：',
          '',
          '1. **保留原始资料**：项目文件始终是事实来源。',
          '2. **固定发送上下文**：选区、当前文档和项目范围明确区分。',
          '3. **沉淀本地笔记**：普通写入先预览，明确的“整理笔记”动作直接保存。',
          '',
          '```typescript',
          "const workflow = ['阅读', '提问', '沉淀']",
          '```'
        ].join('\n')
      }]
    }]
  }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

let app
try {
  app = await electron.launch({
    args: [root, '--project', projectPath],
    env: { ...process.env, NODE_ENV: 'test', COSCRIBE_USER_DATA_DIR: userDataPath }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.coscribe))
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(1600, 1000)
    window.center()
  })
  await page.evaluate(async (baseUrl) => {
    const current = await window.coscribe.settings.get()
    await window.coscribe.settings.save({ ...current, baseUrl, model: 'local-readme-model', apiProtocol: 'responses', theme: 'light' })
  }, `http://127.0.0.1:${port}`)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.coscribe))

  await page.locator('.tree-row').filter({ hasText: 'CoScribe 使用指南.md' }).click()
  await page.locator('.vk-mermaid-svg svg').waitFor({ state: 'visible', timeout: 15_000 })
  await page.getByLabel('向 AI 提问').fill('用三点总结当前文档，并保留关键术语。')
  await page.getByRole('button', { name: '发送消息' }).click()
  await page.getByText('这份文档的核心流程可以归纳为三步：').waitFor({ state: 'visible' })
  await page.locator('.vk-mermaid-svg svg').waitFor({ state: 'visible', timeout: 15_000 })
  await page.screenshot({ path: path.join(output, 'workspace-overview.png') })

  const preview = page.getByLabel('Markdown 预览')
  const selectionLine = preview.locator('blockquote').first()
  await selectionLine.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.getByLabel('基于').selectOption('selection')
  const selectionCard = page.getByRole('region', { name: '已捕获的 AI 选中内容' })
  await selectionCard.waitFor({ state: 'visible' })
  await page.getByLabel('向 AI 提问').focus()
  await page.screenshot({ path: path.join(output, 'selection-context.png') })
  await selectionCard.getByRole('button', { name: '清除选中内容' }).click()

  await page.getByRole('button', { name: '收起 AI 侧栏' }).click()
  await page.screenshot({ path: path.join(output, 'markdown-mermaid-code.png') })

  await page.locator('.tree-row').filter({ hasText: 'CoScribe 演示.pptx' }).click()
  await page.locator('.vk-pptx-slide svg').waitFor({ state: 'visible', timeout: 15_000 })
  await page.screenshot({ path: path.join(output, 'pptx-reader.png') })

  await page.locator('.tree-row').filter({ hasText: 'OCR 示例.svg' }).click()
  await page.getByRole('button', { name: '本地文字识别' }).click()
  await page.locator('.vk-ocr-text').waitFor({ state: 'visible', timeout: 90_000 })
  await page.screenshot({ path: path.join(output, 'local-ocr.png') })

  await page.getByRole('button', { name: '插件', exact: true }).click()
  const referencesCard = page.locator('.plugin-card').filter({ hasText: '文献与引用' })
  await referencesCard.getByRole('button', { name: '启用并授权文献与引用' }).click()
  await page.getByRole('button', { name: '授权并启用' }).click()
  await referencesCard.getByRole('button', { name: '打开插件' }).click()
  await page.getByRole('region', { name: '文献与引用插件' }).waitFor({ state: 'visible' })
  await page.getByLabel('题名').fill('Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks')
  await page.getByLabel('citekey').fill('Lewis2020RAG')
  await page.getByLabel('作者（分号分隔）').fill('Patrick Lewis; Ethan Perez')
  await page.getByLabel('年份').fill('2020')
  await page.getByLabel('标签').fill('RAG, retrieval')
  await page.getByRole('button', { name: '加入文献库' }).click()
  await page.getByText('文献元数据已保存在当前项目。').waitFor({ state: 'visible' })
  await page.screenshot({ path: path.join(output, 'references-workspace.png') })

  await page.getByRole('button', { name: '资料浏览器', exact: true }).click()
  await page.getByLabel('网址或搜索内容').fill(`http://127.0.0.1:${port}/article`)
  await page.getByLabel('网址或搜索内容').press('Enter')
  await page.locator('.research-browser__tabbar strong').filter({ hasText: 'Knowledge Research' }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '打开 AI 侧栏' }).click()
  await page.getByRole('button', { name: '发送网页正文到 AI' }).click()
  await page.getByLabel('当前 AI 上下文').filter({ hasText: 'Knowledge Research' }).waitFor({ state: 'visible' })

  const windowBounds = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.show()
    window.focus()
    return window.getBounds()
  })
  const browserScreenshot = path.join(output, 'research-browser.png')
  const captureElectronWindow = async () => {
    const composite = await app.evaluate(async ({ desktopCapturer }) => {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 1600, height: 1000 },
        fetchWindowIcons: false
      })
      const source = sources.find((candidate) => /CoScribe/iu.test(candidate.name))
      return source?.thumbnail.isEmpty() ? '' : source?.thumbnail.toPNG().toString('base64') ?? ''
    })
    if (!composite) return false
    await writeFile(browserScreenshot, Buffer.from(composite, 'base64'))
    return true
  }
  if (process.platform === 'darwin') {
    const nativeCaptureSucceeded = await new Promise((resolve) => execFile(
      '/usr/sbin/screencapture',
      ['-x', `-R${windowBounds.x},${windowBounds.y},${windowBounds.width},${windowBounds.height}`, browserScreenshot],
      (error) => resolve(!error)
    ))
    if (!nativeCaptureSucceeded && !(await captureElectronWindow())) await page.screenshot({ path: browserScreenshot })
  } else if (!(await captureElectronWindow())) {
    await page.screenshot({ path: browserScreenshot })
  }

  const images = [
    'workspace-overview.png',
    'selection-context.png',
    'markdown-mermaid-code.png',
    'pptx-reader.png',
    'local-ocr.png',
    'references-workspace.png',
    'research-browser.png'
  ]
  for (const image of images) {
    const bytes = await readFile(path.join(output, image))
    if (bytes.length < 10_000) throw new Error(`README screenshot is unexpectedly small: ${image}`)
  }
  console.log(`Captured ${images.length} README screenshots in ${output}`)
} finally {
  await app?.close().catch(() => undefined)
  await new Promise((resolve) => server.close(() => resolve()))
  await rm(projectPath, { recursive: true, force: true })
  await rm(userDataPath, { recursive: true, force: true })
}
