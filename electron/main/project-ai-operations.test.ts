import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatImageAttachment } from '../../src/shared/types'
import { fileKind, ProjectService } from './project'
import { ProjectPathGuard } from './security'
import type { SettingsStore } from './settings'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function projectService(): Promise<{ root: string; service: ProjectService }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coscribe-ai-files-'))
  temporaryRoots.push(root)
  const service = new ProjectService({} as SettingsStore, () => undefined, () => undefined)
  ;(service as unknown as { guardValue: ProjectPathGuard }).guardValue = new ProjectPathGuard(root)
  return { root: service.guard.root, service }
}

describe('AI Markdown operations', () => {
  it('creates nested parent folders only after a batch proposal is accepted', async () => {
    const { root, service } = await projectService()
    const proposal = await service.prepareAiOperation({
      operations: [
        { kind: 'create', targetPath: 'course/index.md', proposedContent: '# Course\n\n- [Topic](topics/topic.md)' },
        { kind: 'create', targetPath: 'course/topics/topic.md', proposedContent: '# Topic' }
      ],
      summary: '创建课程笔记项目'
    })

    await expect(lstat(path.join(root, 'course'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(proposal.operations).toHaveLength(2)
    expect(proposal.targetPath).toBe(path.join(root, 'course/index.md'))

    const result = await service.applyAiOperation({ ...proposal, status: 'accepted' })
    expect(result.files.map((file) => path.relative(root, file.path))).toEqual([
      'course/index.md',
      path.join('course', 'topics', 'topic.md')
    ])
    expect(result.path).toBe(result.files[0].path)
    await expect(readFile(path.join(root, 'course/topics/topic.md'), 'utf8')).resolves.toBe('# Topic')
  })

  it('keeps single-file append compatible and rejects a modified confirmation payload', async () => {
    const { root, service } = await projectService()
    const note = path.join(root, 'note.md')
    await writeFile(note, '# Existing\n')
    const proposal = await service.prepareAiOperation({
      kind: 'append',
      targetPath: note,
      proposedContent: 'New paragraph',
      summary: '追加笔记'
    })

    await expect(service.applyAiOperation({
      ...proposal,
      proposedContent: 'tampered',
      status: 'accepted'
    })).rejects.toThrow('确认前发生变化')

    const result = await service.applyAiOperation({ ...proposal, status: 'accepted' })
    expect(result.files).toHaveLength(1)
    await expect(readFile(note, 'utf8')).resolves.toBe('# Existing\nNew paragraph')
  })

  it('rejects traversal, duplicate targets, and file-as-parent conflicts before preview', async () => {
    const { service } = await projectService()
    await expect(service.prepareAiOperation({
      kind: 'create',
      targetPath: '../outside.md',
      proposedContent: '# outside'
    })).rejects.toThrow('越级目录')

    await expect(service.prepareAiOperation({
      operations: [
        { kind: 'create', targetPath: 'same.md', proposedContent: 'one' },
        { kind: 'create', targetPath: 'same.md', proposedContent: 'two' }
      ]
    })).rejects.toThrow('重复')

    await expect(service.prepareAiOperation({
      operations: [
        { kind: 'create', targetPath: 'parent.md', proposedContent: 'file' },
        { kind: 'create', targetPath: 'parent.md/child.md', proposedContent: 'child' }
      ]
    })).rejects.toThrow('父目录')
  })

  it('rolls back earlier files when a later batch write fails', async () => {
    const { root, service } = await projectService()
    const proposal = await service.prepareAiOperation({
      operations: [
        { kind: 'create', targetPath: 'course/first.md', proposedContent: '# First' },
        { kind: 'create', targetPath: 'course/second.md', proposedContent: '# Second' }
      ],
      summary: '创建两篇笔记'
    })
    const createMarkdown = service.createMarkdown.bind(service)
    let writes = 0
    vi.spyOn(service, 'createMarkdown').mockImplementation(async (...args) => {
      writes += 1
      if (writes === 2) throw new Error('simulated disk failure')
      return createMarkdown(...args)
    })

    await expect(service.applyAiOperation({ ...proposal, status: 'accepted' })).rejects.toThrow(/均已回滚/u)
    await expect(lstat(path.join(root, 'course', 'first.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(path.join(root, 'course', 'second.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('transparent project memory', () => {
  it('starts from a portable template and saves only to project-root COSCRIBE.md', async () => {
    const { root, service } = await projectService()
    const initial = await service.memory()

    expect(initial).toMatchObject({ path: path.join(root, 'COSCRIBE.md'), exists: false })
    expect(initial.content).toContain('# CoScribe Project Memory')

    const saved = await service.saveMemory('# 项目记忆\n\n- 使用双链笔记')
    expect(saved).toMatchObject({ path: path.join(root, 'COSCRIBE.md'), exists: true })
    await expect(readFile(saved.path, 'utf8')).resolves.toBe('# 项目记忆\n\n- 使用双链笔记\n')
  })

  it('rejects a symlinked COSCRIBE.md instead of following it outside the project', async () => {
    const { root, service } = await projectService()
    const outside = path.join(path.dirname(root), 'outside-memory.md')
    await writeFile(outside, '# secret')
    await symlink(outside, path.join(root, 'COSCRIBE.md'))

    await expect(service.memory()).rejects.toThrow(/符号链接/u)
    await expect(service.saveMemory('# replaced')).rejects.toThrow(/符号链接/u)
    await expect(readFile(outside, 'utf8')).resolves.toBe('# secret')
  })
})

describe('generated image persistence', () => {
  const attachment: ChatImageAttachment = {
    id: 'generated-1',
    name: 'gpt-image-2-1234.png',
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    size: 8
  }

  it('writes generated bytes under assets/ai-images and returns verified path metadata', async () => {
    const { root, service } = await projectService()
    const stored = await service.persistGeneratedImage(attachment)

    expect(stored.projectRelativePath).toMatch(/^assets\/ai-images\/gpt-image-2-1234-[a-f0-9]{8}\.png$/u)
    expect(stored.absolutePath).toBe(path.join(root, stored.projectRelativePath!))
    await expect(readFile(stored.absolutePath!)).resolves.toEqual(Buffer.from(attachment.dataUrl.split(',')[1], 'base64'))
    await expect(service.verifiedChatImageAttachments([stored])).resolves.toEqual([stored])
  })

  it('drops forged path metadata while retaining the chat image', async () => {
    const { service } = await projectService()
    const [verified] = await service.verifiedChatImageAttachments([{
      ...attachment,
      projectRelativePath: '../secret.png',
      absolutePath: '/tmp/secret.png'
    }])
    expect(verified.projectRelativePath).toBeUndefined()
    expect(verified.absolutePath).toBeUndefined()
    expect(verified.dataUrl).toBe(attachment.dataUrl)
  })
})

describe('PowerPoint file kinds', () => {
  it('distinguishes modern and legacy PowerPoint files', () => {
    expect(fileKind('slides.pptx')).toBe('pptx')
    expect(fileKind('slides.PPT')).toBe('ppt')
  })
})

describe('complete webpage archive persistence', () => {
  it('atomically writes a Chromium MHTML archive without text conversion', async () => {
    const { root, service } = await projectService()
    const archive = Buffer.from([
      'From: <Saved by Blink>',
      'Snapshot-Content-Location: https://example.com/',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="archive"',
      '',
      '--archive--'
    ].join('\r\n'))

    const result = await service.createWebArchive('资料剪藏/Example.mhtml', archive)
    expect(result.path).toBe(path.join(root, '资料剪藏', 'Example.mhtml'))
    expect(result.kind).toBe('webarchive')
    await expect(readFile(result.path)).resolves.toEqual(archive)
  })

  it('rejects arbitrary bytes at the webpage archive boundary', async () => {
    const { service } = await projectService()
    await expect(service.createWebArchive('资料剪藏/fake.mhtml', Buffer.alloc(128, 1))).rejects.toThrow(/有效的 MHTML/u)
  })

  it('rejects an archive write that was captured before the active project changed', async () => {
    const { root, service } = await projectService()
    const writeScope = service.captureWriteScope()
    const nextRoot = await mkdtemp(path.join(os.tmpdir(), 'coscribe-next-project-'))
    temporaryRoots.push(nextRoot)
    const mutable = service as unknown as { guardValue: ProjectPathGuard; projectRevision: number }
    mutable.projectRevision += 1
    mutable.guardValue = new ProjectPathGuard(nextRoot)
    const archive = Buffer.from([
      'From: <Saved by Blink>',
      'Snapshot-Content-Location: https://example.com/old-project',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="archive"',
      '',
      '--archive--'
    ].join('\r\n'))

    await expect(service.createWebArchive('资料剪藏/Old Page.mhtml', archive, writeScope)).rejects.toThrow(/项目已切换/u)
    await expect(lstat(path.join(root, '资料剪藏', 'Old Page.mhtml'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(path.join(nextRoot, '资料剪藏', 'Old Page.mhtml'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
