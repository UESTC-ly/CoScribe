import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { extractTrackedPage, WebTrackerService } from './web-tracker'
import type { ProjectService, ProjectWriteScope } from './project'
import { ProjectPathGuard } from './security'

const roots: string[] = []

async function mockProject(): Promise<ProjectService> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coscribe-web-tracker-'))
  roots.push(root)
  await mkdir(path.join(root, '.vibeknowledge'), { recursive: true })
  let data: unknown = null
  const guard = new ProjectPathGuard(root)
  const project = {
    guard,
    captureWriteScope: () => ({ root, revision: 1 }),
    pluginData: async () => data,
    savePluginData: async (_id: string, value: unknown) => { data = structuredClone(value) },
    createMarkdown: async (relative: string, content: string, _scope: ProjectWriteScope) => {
      const target = path.join(root, relative)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
      const info = await stat(target)
      return { path: target, name: path.basename(target), kind: 'markdown', content, size: info.size, modifiedAt: info.mtimeMs }
    }
  }
  return project as unknown as ProjectService
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('WebTrackerService', () => {
  it('extracts readable content without scripts', () => {
    const page = extractTrackedPage('<html><title>研究 &amp; 发现</title><script>secret()</script><body><h1>标题</h1><p>正文</p></body></html>')
    expect(page.title).toBe('研究 & 发现')
    expect(page.text).toContain('标题')
    expect(page.text).toContain('正文')
    expect(page.text).not.toContain('secret')
  })

  it('stores the first version and reports an unchanged second check', async () => {
    const project = await mockProject()
    const html = '<html><title>示例论文</title><body><main><h1>结果</h1><p>稳定正文</p></main></body></html>'
    const fetcher = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', etag: 'v1' } })
    const tracker = new WebTrackerService(project, fetcher as typeof fetch)
    const source = await tracker.add({ url: 'https://example.com/paper', intervalMinutes: 60 })

    const first = await tracker.check(source.id)
    const second = await tracker.check(source.id)

    expect(first[0]?.changed).toBe(true)
    expect(first[0]?.source.changeCount).toBe(1)
    expect(second[0]?.changed).toBe(false)
    expect(second[0]?.source.changeCount).toBe(1)
    const snapshotPath = first[0]?.snapshot?.path
    expect(snapshotPath).toBeTruthy()
    expect(await readFile(snapshotPath!, 'utf8')).toContain('https://example.com/paper')
  })

  it('does not run scheduled checks after its plugin permission is revoked', async () => {
    const project = await mockProject()
    let fetchCount = 0
    const fetcher = async () => {
      fetchCount += 1
      return new Response('<html><body>should not be fetched</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })
    }
    const tracker = new WebTrackerService(project, fetcher as typeof fetch, async () => false)
    await tracker.add({ url: 'https://example.com/revoked', intervalMinutes: 60 })

    await (tracker as unknown as { checkDue: () => Promise<void> }).checkDue()

    expect(fetchCount).toBe(0)
  })
})
