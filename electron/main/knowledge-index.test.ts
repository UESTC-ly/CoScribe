import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { KnowledgeIndexService, retrievalTokens } from './knowledge-index'
import type { PdfTextService } from './pdf'
import { ProjectService } from './project'
import { ProjectPathGuard } from './security'
import type { SettingsStore } from './settings'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; project: ProjectService; index: KnowledgeIndexService }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coscribe-index-'))
  roots.push(root)
  const project = new ProjectService({} as SettingsStore, () => undefined, () => undefined)
  const mutable = project as unknown as {
    guardValue: ProjectPathGuard
    currentInfo: { name: string; path: string; openedAt: number; exists: boolean }
  }
  mutable.guardValue = new ProjectPathGuard(root)
  mutable.currentInfo = { name: path.basename(root), path: root, openedAt: Date.now(), exists: true }
  return { root: project.guard.root, project, index: new KnowledgeIndexService(project, {} as PdfTextService) }
}

describe('incremental project knowledge index', () => {
  it('indexes changed Markdown only and returns line-grounded results', async () => {
    const { root, index } = await fixture()
    const first = path.join(root, 'first.md')
    await writeFile(first, '# Retrieval\n\nCoScribe keeps source citations.\n')
    await writeFile(path.join(root, 'second.md'), '# Other\n\nUnrelated text.\n')

    const initial = await index.ensureFresh()
    expect(initial).toMatchObject({ state: 'ready', fileCount: 2, changedFiles: 2 })
    const [result] = await index.search('source citations', 5, true)
    expect(result).toMatchObject({ path: path.join(root, 'first.md'), heading: 'Retrieval', line: 3 })

    await writeFile(first, '# Retrieval\n\nCoScribe keeps verifiable source citations.\n')
    index.invalidate(first)
    const refreshed = await index.ensureFresh()
    expect(refreshed.changedFiles).toBe(1)
    expect((await index.search('verifiable', 5))[0]?.path).toBe(path.join(root, 'first.md'))
  })

  it('does not rescan or rewrite an unchanged index again in the same session', async () => {
    const { root, project, index } = await fixture()
    await writeFile(path.join(root, 'stable.md'), '# Stable\n\nNo changes.\n')
    const tree = vi.spyOn(project, 'tree')
    const writeMetadata = vi.spyOn(project, 'writeMetadata')

    await index.ensureFresh()
    const treeCalls = tree.mock.calls.length
    const writeCalls = writeMetadata.mock.calls.length
    await index.ensureFresh()

    expect(tree).toHaveBeenCalledTimes(treeCalls)
    expect(writeMetadata).toHaveBeenCalledTimes(writeCalls)
  })

  it('retains a file invalidation that arrives while indexing is in progress', async () => {
    const { root, project, index } = await fixture()
    const filePath = path.join(root, 'changing.md')
    await writeFile(filePath, '# Changing\n\nFirst version.\n')
    const originalTree = project.tree.bind(project)
    vi.spyOn(project, 'tree').mockImplementationOnce(async () => {
      const tree = await originalTree()
      index.invalidate(filePath)
      return tree
    })

    await index.ensureFresh()
    const next = await index.ensureFresh()

    expect(next.changedFiles).toBe(1)
  })

  it('builds explicit backlinks and separate unlinked mentions', async () => {
    const { root, index } = await fixture()
    const alpha = path.join(root, 'alpha.md')
    const beta = path.join(root, 'beta.md')
    const gamma = path.join(root, 'gamma.md')
    await writeFile(alpha, '# Alpha\n\nSee [[Beta]]. Gamma is also relevant.\n')
    await writeFile(beta, '# Beta\n\nTarget note.\n')
    await writeFile(gamma, '# Gamma\n\nAnother target.\n')

    const graph = await index.backlinks()
    expect(graph.edges).toContainEqual(expect.objectContaining({ sourcePath: alpha, targetPath: beta, kind: 'link' }))
    expect(graph.edges).toContainEqual(expect.objectContaining({ sourcePath: alpha, targetPath: gamma, kind: 'unlinked-mention' }))
    expect(graph.nodes.find((node) => node.path === beta)).toMatchObject({ inbound: 1 })
  })

  it('tokenizes long Chinese questions into bounded retrieval terms', () => {
    expect(retrievalTokens('请回答当前项目中增量知识索引如何保持引用可靠')).toEqual(expect.arrayContaining(['增量知识', '索引如何']))
    expect(retrievalTokens('current project document')).toEqual([])
  })
})
