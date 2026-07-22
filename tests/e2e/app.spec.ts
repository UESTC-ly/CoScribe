import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

const appRoot = path.resolve(import.meta.dirname, '../..')
const packagedExecutable = process.env.COSCRIBE_E2E_EXECUTABLE

let electronApp: ElectronApplication
let page: Page
let projectPath: string
let userDataPath: string

async function launchProject(): Promise<void> {
  electronApp = await electron.launch({
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    args: packagedExecutable ? ['--project', projectPath] : [appRoot, '--project', projectPath],
    env: { ...process.env, NODE_ENV: 'test', COSCRIBE_USER_DATA_DIR: userDataPath }
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
    '依赖项可以被复用。'
  ].join('\n'))
  await writeFile(path.join(projectPath, '资料.txt'), '本地项目中的普通文本文件。\n')
  await copyFile(
    path.join(appRoot, 'node_modules', 'mammoth', 'test', 'test-data', 'single-paragraph.docx'),
    path.join(projectPath, '示例文档.docx')
  )
  await writeFile(path.join(projectPath, 'OCR测试.svg'), [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="420" viewBox="0 0 1200 420">',
    '<rect width="1200" height="420" fill="white"/>',
    '<text x="70" y="180" fill="black" font-family="Arial, sans-serif" font-size="86" font-weight="700">COSCRIBE OCR TEST</text>',
    '<text x="70" y="300" fill="black" font-family="Arial, sans-serif" font-size="66">LOCAL 2026</text>',
    '</svg>'
  ].join(''))
  await mkdir(path.join(projectPath, '教程', '章节'), { recursive: true })
  await writeFile(path.join(projectPath, '教程', '章节', '流程.md'), '# 流程\n\n```mermaid\ngraph TD\n  A[开始] --> B[完成]\n```\n')
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
  await expect(page.locator('.cm-content')).toContainText('FastAPI 学习')

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

  const editor = page.locator('.cm-content').last()
  await editor.click()
  await editor.fill('# 第一篇笔记\n\n这是可被其他软件打开的标准 Markdown。')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(async () => readFile(notePath, 'utf8')).toContain('标准 Markdown')
  await page.screenshot({ path: testInfo.outputPath('workspace.png') })
})

test('renders Mermaid fenced blocks in Markdown preview', async ({}, testInfo) => {
  await page.locator('.tree-row').filter({ hasText: '章节' }).click()
  await page.locator('.tree-row').filter({ hasText: '流程.md' }).click()
  await expect(page.getByLabel('流程.md Markdown 编辑器')).toBeVisible()
  await page.getByRole('button', { name: '预览', exact: true }).click()
  await expect(page.locator('.vk-mermaid-svg svg')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.vk-mermaid-error')).toHaveCount(0)
  const lightSvg = await page.locator('.vk-mermaid-svg svg').evaluate((element) => element.outerHTML)
  await page.screenshot({ path: testInfo.outputPath('mermaid-preview.png') })

  await page.locator('.app-titlebar__actions').getByRole('button', { name: '设置' }).click()
  await page.getByLabel('主题').selectOption('dark')
  await page.getByRole('button', { name: '保存设置' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect.poll(async () => page.locator('.vk-mermaid-svg svg').evaluate((element) => element.outerHTML)).not.toBe(lightSvg)
  await expect(page.locator('.vk-mermaid-error')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('mermaid-preview-dark.png') })
})

test('opens DOCX files as a local semantic document', async () => {
  await page.locator('.tree-row').filter({ hasText: '示例文档.docx' }).click()

  await expect(page.getByLabel('示例文档.docx DOCX 阅读器')).toBeVisible()
  await expect(page.locator('.vk-docx-page')).toContainText('Walking on imported air')
  await expect(page.getByRole('button', { name: '复制正文' })).toBeVisible()
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
    expect(serialized).toContain('必须直接把该相对路径作为 targetPath 并使用 append')
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
