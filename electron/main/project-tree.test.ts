import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { fileKind, ProjectService } from './project'
import { ProjectPathGuard } from './security'
import type { SettingsStore } from './settings'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('project file tree', () => {
  it('recognizes Chromium web archives as first-class project files', () => {
    expect(fileKind('/project/资料剪藏/Research.mhtml')).toBe('webarchive')
    expect(fileKind('/project/资料剪藏/Research.mht')).toBe('webarchive')
  })

  it('recursively includes user content and skips dependency or metadata directories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'coscribe-tree-'))
    temporaryRoots.push(root)
    await mkdir(path.join(root, '教程', '章节'), { recursive: true })
    await writeFile(path.join(root, '教程', '章节', '流程.md'), '# 流程\n')
    await mkdir(path.join(root, '.venv', 'lib'), { recursive: true })
    await writeFile(path.join(root, '.venv', 'lib', 'dependency.py'), 'ignored = True\n')
    await mkdir(path.join(root, 'node_modules', 'package'), { recursive: true })
    await writeFile(path.join(root, 'node_modules', 'package', 'README.md'), '# dependency\n')
    await mkdir(path.join(root, '.vibeknowledge'), { recursive: true })
    await writeFile(path.join(root, '.vibeknowledge', 'workspace.json'), '{}\n')

    const service = new ProjectService({} as SettingsStore, () => undefined, () => undefined)
    ;(service as unknown as { guardValue: ProjectPathGuard }).guardValue = new ProjectPathGuard(root)

    const tree = await service.tree()
    expect(tree.map((node) => node.name)).toEqual(['教程'])
    expect(tree[0].children?.[0].children?.[0]).toMatchObject({ name: '流程.md', kind: 'markdown' })
  })

  it('persists a complete Chromium MHTML archive without converting it to text', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'coscribe-web-archive-'))
    temporaryRoots.push(root)
    const service = new ProjectService({} as SettingsStore, () => undefined, () => undefined)
    ;(service as unknown as { guardValue: ProjectPathGuard }).guardValue = new ProjectPathGuard(root)
    const archive = Buffer.from([
      'From: <Saved by Blink>',
      'Snapshot-Content-Location: https://example.com/research',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="coscribe-boundary"',
      '',
      '--coscribe-boundary',
      'Content-Type: text/html; charset=utf-8',
      'Content-Location: https://example.com/research',
      '',
      '<!doctype html><style>h1{color:green}</style><h1>ORIGINAL_ARCHIVE_SENTINEL</h1>',
      '--coscribe-boundary--',
      ''
    ].join('\r\n'))

    const result = await service.createWebArchive('资料剪藏/Research.mhtml', archive)

    expect(result).toMatchObject({ kind: 'webarchive', content: '', size: archive.byteLength })
    await expect(readFile(path.join(root, '资料剪藏', 'Research.mhtml'))).resolves.toEqual(archive)
  })
})
