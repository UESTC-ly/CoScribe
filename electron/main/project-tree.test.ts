import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ProjectService } from './project'
import { ProjectPathGuard } from './security'
import type { SettingsStore } from './settings'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('project file tree', () => {
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
})
