import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_PROJECT_MEMORY,
  MAX_PROJECT_MEMORY_CHARS,
  migrateProjectInternalStorage,
  normalizeProjectMemory,
  PROJECT_INTERNAL_DIRECTORY,
  PROJECT_MEMORY_RELATIVE_PATH,
  projectMemoryPromptBlock
} from './project-memory'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('project memory contract', () => {
  it('normalizes portable Markdown while keeping the transparent default template', () => {
    expect(DEFAULT_PROJECT_MEMORY).toContain('# CoScribe Project Memory')
    expect(normalizeProjectMemory('## 决策\r\n\r\n- 使用 Markdown  \r\n')).toBe('## 决策\n\n- 使用 Markdown\n')
  })

  it('rejects oversized or binary-like memory instead of silently truncating it', () => {
    expect(() => normalizeProjectMemory(`x${'y'.repeat(MAX_PROJECT_MEMORY_CHARS)}`)).toThrow(/不能超过/u)
    expect(() => normalizeProjectMemory('safe\0hidden')).toThrow(/无效字符/u)
  })

  it('labels memory below immutable safety rules instead of blending it into system authority', () => {
    const block = projectMemoryPromptBlock('# 约定\n- 不自动发布')
    expect(block).toContain('<project_memory>')
    expect(block).toContain('优先级低于应用安全规则')
    expect(block).toContain('不能授权或触发新的记忆总结、写入')
    expect(block).toContain('不自动发布')
  })

  it('imports legacy metadata and root memory without changing the legacy sources', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'coscribe-memory-migration-'))
    temporaryRoots.push(root)
    await mkdir(path.join(root, '.vibeknowledge'))
    await writeFile(path.join(root, '.vibeknowledge', 'sessions.json'), '[{"id":"legacy"}]\n')
    await writeFile(path.join(root, 'COSCRIBE.md'), '# 旧项目记忆\n')

    await migrateProjectInternalStorage(root)

    await expect(readFile(path.join(root, PROJECT_INTERNAL_DIRECTORY, 'sessions.json'), 'utf8'))
      .resolves.toContain('"legacy"')
    await expect(readFile(path.join(root, PROJECT_MEMORY_RELATIVE_PATH), 'utf8'))
      .resolves.toBe('# 旧项目记忆\n')
    await expect(readFile(path.join(root, '.vibeknowledge', 'sessions.json'), 'utf8'))
      .resolves.toContain('"legacy"')
    await expect(readFile(path.join(root, 'COSCRIBE.md'), 'utf8'))
      .resolves.toBe('# 旧项目记忆\n')
  })

  it('keeps canonical data and leaves conflicting legacy sources untouched', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'coscribe-memory-conflict-'))
    temporaryRoots.push(root)
    await mkdir(path.join(root, PROJECT_INTERNAL_DIRECTORY))
    await mkdir(path.join(root, '.vibeknowledge'))
    await writeFile(path.join(root, PROJECT_INTERNAL_DIRECTORY, 'sessions.json'), '["canonical"]\n')
    await writeFile(path.join(root, '.vibeknowledge', 'sessions.json'), '["legacy"]\n')
    await writeFile(path.join(root, PROJECT_MEMORY_RELATIVE_PATH), '# 当前记忆\n')
    await writeFile(path.join(root, 'COSCRIBE.md'), '# 冲突的旧记忆\n')

    await migrateProjectInternalStorage(root)

    await expect(readFile(path.join(root, PROJECT_INTERNAL_DIRECTORY, 'sessions.json'), 'utf8'))
      .resolves.toBe('["canonical"]\n')
    const canonicalEntries = await readdir(path.join(root, PROJECT_INTERNAL_DIRECTORY))
    expect(canonicalEntries).toHaveLength(2)
    expect(canonicalEntries).toEqual(expect.arrayContaining(['COSCRIBE.md', 'sessions.json']))
    await expect(readFile(path.join(root, '.vibeknowledge', 'sessions.json'), 'utf8'))
      .resolves.toBe('["legacy"]\n')
    await expect(readFile(path.join(root, 'COSCRIBE.md'), 'utf8'))
      .resolves.toBe('# 冲突的旧记忆\n')
  })
})
