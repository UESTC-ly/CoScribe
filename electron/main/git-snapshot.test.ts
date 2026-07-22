import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ProjectPathGuard } from './security'
import { excludedSnapshotPath, GitSnapshotService } from './git-snapshot'
import type { ProjectService } from './project'

const directories: string[] = []

async function service(): Promise<{ root: string; snapshots: GitSnapshotService }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coscribe-git-snapshot-'))
  directories.push(root)
  const project = { guard: new ProjectPathGuard(root) } as ProjectService
  return { root, snapshots: new GitSnapshotService(project) }
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('GitSnapshotService', () => {
  it('excludes secrets and generated directories', () => {
    expect(excludedSnapshotPath('.env.local')).toBe(true)
    expect(excludedSnapshotPath('notes/private.key')).toBe(true)
    expect(excludedSnapshotPath('dist/app.js')).toBe(true)
    expect(excludedSnapshotPath('研究/论文.md')).toBe(false)
  })

  it('initializes a repository, commits safe files and leaves secrets untracked', async () => {
    const { root, snapshots } = await service()
    await writeFile(path.join(root, '研究.md'), '# 研究\n', 'utf8')
    await writeFile(path.join(root, '.env'), 'TOKEN=never-commit\n', 'utf8')

    const result = await snapshots.create('保存研究进度')

    expect(result.entry.message).toBe('保存研究进度')
    expect(result.status.initialized).toBe(true)
    expect(result.status.excludedFiles).toContain('.env')
    expect(await readFile(path.join(root, '.env'), 'utf8')).toContain('never-commit')
    const history = await snapshots.history()
    expect(history[0]?.author).toBe('CoScribe')
  })
})
