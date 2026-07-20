import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ProjectPathGuard } from './security'
import { atomicCreate, atomicWrite } from './storage'

describe('ProjectPathGuard', () => {
  let fixture = ''
  let root = ''
  let outside = ''
  let guard: ProjectPathGuard

  beforeEach(async () => {
    fixture = await mkdtemp(path.join(tmpdir(), 'coscribe-security-'))
    root = path.join(fixture, 'project')
    outside = path.join(fixture, 'project-evil')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(path.join(root, 'note.md'), '# safe\n')
    await writeFile(path.join(outside, 'outside.md'), '# outside\n')
    guard = new ProjectPathGuard(root)
    root = guard.root
    outside = await realpath(outside)
  })

  afterEach(async () => {
    if (fixture) await rm(fixture, { recursive: true, force: true })
  })

  it('accepts a regular project file', async () => {
    await expect(guard.existing(path.join(root, 'note.md'), 'file')).resolves.toBe(path.join(guard.root, 'note.md'))
  })

  it.each(['../project-evil/outside.md', '..\\project-evil\\outside.md'])(
    'rejects traversal form %s',
    async (maliciousPath) => {
      await expect(guard.existing(maliciousPath)).rejects.toThrow(/路径|越级/u)
    }
  )

  it('rejects an absolute path with a colliding root prefix', async () => {
    await expect(guard.existing(path.join(outside, 'outside.md'))).rejects.toThrow(/路径/u)
  })

  it('rejects a symlinked directory that points outside the project', async () => {
    await symlink(outside, path.join(root, 'escape'), 'dir')
    await expect(guard.existing(path.join(root, 'escape', 'outside.md'))).rejects.toThrow(/符号链接/u)
    await expect(guard.target(path.join(root, 'escape', 'new.md'))).rejects.toThrow(/符号链接/u)
  })

  it('rejects a target file that is itself an outside symlink', async () => {
    await symlink(path.join(outside, 'outside.md'), path.join(root, 'linked.md'), 'file')
    await expect(guard.assertMarkdown(path.join(root, 'linked.md'), true)).rejects.toThrow(/符号链接/u)
    await expect(guard.assertMarkdown(path.join(root, 'linked.md'), false)).rejects.toThrow(/符号链接/u)
  })

  it('allows only Markdown targets through the Markdown write boundary', async () => {
    await expect(guard.assertMarkdown(path.join(root, 'new.md'), false)).resolves.toBe(path.join(guard.root, 'new.md'))
    await expect(guard.assertMarkdown(path.join(root, 'image.png'), false)).rejects.toThrow(/Markdown/u)
  })

  it('rejects create when a validated parent is swapped for an outside symlink', async () => {
    const parent = path.join(root, 'notes')
    await mkdir(parent)
    const identity = await guard.identity(parent, 'directory')
    await rename(parent, path.join(root, 'notes-original'))
    await symlink(outside, parent, 'dir')

    await expect(
      atomicCreate(path.join(parent, 'escaped.md'), 'must stay inside', () => guard.verifyIdentity(identity))
    ).rejects.toThrow(/符号链接|替换/u)
    await expect(readFile(path.join(outside, 'escaped.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects replace when a validated parent is swapped for an outside symlink', async () => {
    const parent = path.join(root, 'notes')
    await mkdir(parent)
    await writeFile(path.join(parent, 'note.md'), 'inside')
    await writeFile(path.join(outside, 'note.md'), 'outside')
    const identity = await guard.identity(parent, 'directory')
    await rename(parent, path.join(root, 'notes-original'))
    await symlink(outside, parent, 'dir')

    await expect(
      atomicWrite(path.join(parent, 'note.md'), 'must stay inside', 0o600, () => guard.verifyIdentity(identity))
    ).rejects.toThrow(/符号链接|替换/u)
    await expect(readFile(path.join(outside, 'note.md'), 'utf8')).resolves.toBe('outside')
  })
})

describe('atomicCreate', () => {
  let fixture = ''

  beforeEach(async () => {
    fixture = await mkdtemp(path.join(tmpdir(), 'coscribe-atomic-'))
  })

  afterEach(async () => {
    if (fixture) await rm(fixture, { recursive: true, force: true })
  })

  it('never overwrites an existing file', async () => {
    const target = path.join(fixture, 'note.md')
    await atomicCreate(target, 'first')
    await expect(atomicCreate(target, 'second')).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(readFile(target, 'utf8')).resolves.toBe('first')
  })
})
