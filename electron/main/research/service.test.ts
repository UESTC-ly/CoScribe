import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectService } from '../project'
import { ProjectPathGuard } from '../security'
import type { SettingsStore } from '../settings'
import { normalizeReference } from '../../../src/plugins/references/reference-utils'
import type { ResearchCandidate, ResearchRun } from '../../../src/shared/research'
import { AutoResearchService, evidenceClaims, mergeResearchReference } from './service'
import { hash, ResearchProviders } from './providers'

let root: string
let project: ProjectService
let service: AutoResearchService
let providers: ResearchProviders
let revision: number
const complete = vi.fn()
const authorize = vi.fn()
const request = { topic: 'graph drug discovery', sources: ['arxiv' as const], limit: 3, useAi: false }
const candidate: ResearchCandidate = { id: 'arxiv-test', source: 'arxiv', sourceId: '2601.00001', reference: normalizeReference({ id: 'ref-test', citeKey: 'Ada2026Graph', title: 'Graph methods', authors: ['Ada Smith'], doi: '10.1000/test', url: 'https://arxiv.org/abs/2601.00001', abstract: 'Graph models predict molecular properties with limited experimental evidence.' }) }
function createService(): AutoResearchService {
  return new AutoResearchService({ project, providers, model: { complete }, pdf: { evidencePages: async () => ({ totalPages: 12, pages: [{ page: 1, readable: true, text: 'Actual PDF page evidence about molecular graph models.' }] }) }, settingsRevision: () => revision, authorize })
}
async function ready(): Promise<ResearchRun> {
  const run = await service.start(request)
  await expect.poll(async () => (await service.get(run.id)).status).toBe('ready')
  return service.get(run.id)
}
async function imported(download = false): Promise<ResearchRun> {
  const run = await ready()
  await service.import(run.id, [candidate.id], download)
  await expect.poll(async () => (await service.get(run.id)).status).toBe('completed')
  return service.get(run.id)
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'coscribe-research-'))
  project = new ProjectService({} as SettingsStore, () => undefined, () => undefined)
  ;(project as unknown as { guardValue: ProjectPathGuard }).guardValue = new ProjectPathGuard(root)
  revision = 0
  complete.mockReset(); authorize.mockReset(); authorize.mockResolvedValue(undefined)
  providers = new ResearchProviders()
  vi.spyOn(providers, 'search').mockResolvedValue([structuredClone(candidate)])
  vi.spyOn(providers, 'fetch').mockResolvedValue(Buffer.from('%PDF-1.7\nmock'))
  service = createService()
})
afterEach(async () => { service.stopAll(); await service.settled(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
describe('Auto Research project workflow', () => {
  it('persists bounded searches, imports metadata and PDF, and writes a source log', async () => {
    const run = await imported(true)
    expect(run.candidates[0]).toMatchObject({ imported: true, referenceId: 'ref-test', downloadStatus: 'PDF 已下载；尚未代表已读全文' })
    const stored = await project.pluginData('references') as { references: unknown[]; revision: number }
    expect(stored.references).toHaveLength(1)
    expect(stored.revision).toBe(1)
    expect(await readFile(run.logPath!, 'utf8')).toContain('探索性检索')
    const restarted = createService()
    expect((await restarted.list())[0].candidates[0].imported).toBe(true)
    expect(providers.fetch).toHaveBeenCalledWith('https://arxiv.org/pdf/2601.00001', expect.any(AbortSignal), 20 * 1024 * 1024)
  })
  it('recovers from a failed initial state write instead of leaving a stuck busy task', async () => {
    vi.spyOn(project, 'writeMetadata').mockRejectedValueOnce(new Error('磁盘不可写'))
    await expect(service.start(request)).rejects.toThrow('磁盘不可写')
    const run = await ready()
    vi.mocked(project.writeMetadata).mockRejectedValueOnce(new Error('磁盘不可写'))
    await expect(service.import(run.id, [candidate.id], false)).rejects.toThrow('磁盘不可写')
    await service.import(run.id, [candidate.id], false)
    await expect.poll(async () => (await service.get(run.id)).status).toBe('completed')
  })
  it('preserves a modified file whose name matches the downloaded PDF digest', async () => {
    const run = await ready()
    const target = `研究/资料/${hash(Buffer.from('%PDF-1.7\nmock'))}.pdf`
    await project.createWebPdf(target, Buffer.from('%PDF-1.7\ndiff'))
    await service.import(run.id, [candidate.id], true)
    await expect.poll(async () => (await service.get(run.id)).status).toBe('completed')
    const result = await service.get(run.id)
    expect(result.candidates[0].downloadStatus).toContain('不一致')
    expect(result.candidates[0].reference.pdfPath).toBeUndefined()
    expect(await readFile(path.join(root, target), 'utf8')).toBe('%PDF-1.7\ndiff')
  })
  it('keeps metadata after failed download and permits an explicit retry', async () => {
    vi.mocked(providers.fetch).mockRejectedValueOnce(new Error('网络断开'))
    let run = await imported(true)
    expect(run.candidates[0]).toMatchObject({ imported: true, downloadStatus: expect.stringContaining('下载失败') })
    expect(run.candidates[0].reference.pdfPath).toBeUndefined()
    await service.import(run.id, [candidate.id], true)
    await expect.poll(async () => (await service.get(run.id)).status).toBe('completed')
    run = await service.get(run.id)
    expect(run.candidates[0].reference.pdfPath).toMatch(/\.pdf$/u)
    expect((await project.pluginData('references') as { references: unknown[] }).references).toHaveLength(1)
  })
  it('previews evidence-based drafts and creates files only on confirmation, preserving existing notes', async () => {
    const run = await imported(true)
    await writeFile(path.join(root, 'manual.md'), '# 我的原笔记\n')
    complete.mockResolvedValue({ claims: [{ heading: '发现', text: '作者讨论了分子图预测。', evidenceId: `${candidate.id}:page1`, quote: 'Actual PDF page evidence' }], questions: ['是否存在外部验证？'] })
    const draft = await service.draft(run.id, [candidate.id], 'note', true)
    expect(draft.content).toContain('PDF 第 1 页')
    expect(draft.content).toContain('共 12 页')
    expect(draft.content).toContain('[@Ada2026Graph]')
    await expect(readFile(path.join(root, draft.path))).rejects.toMatchObject({ code: 'ENOENT' })
    await service.confirm(draft.id)
    expect(await readFile(path.join(root, draft.path), 'utf8')).toBe(draft.content)
    expect(await readFile(path.join(root, 'manual.md'), 'utf8')).toBe('# 我的原笔记\n')
    await expect(service.confirm(draft.id)).rejects.toThrow('过期')
  })
  it('rejects fabricated model quotes and creates no draft', async () => {
    const run = await imported()
    complete.mockResolvedValue({ claims: [{ text: '伪造发现', evidenceId: `${candidate.id}:abstract`, quote: 'Invented citation text' }] })
    await expect(service.draft(run.id, [candidate.id], 'review', true)).rejects.toThrow('不存在')
    expect(() => evidenceClaims({ claims: [{ text: 'x', evidenceId: 'unknown', quote: '12345678' }] }, [])).toThrow('不存在')
  })
  it('falls back to original queries after unavailable AI and records source failures', async () => {
    complete.mockRejectedValue(new Error('未配置模型'))
    vi.mocked(providers.search).mockRejectedValueOnce(new Error('HTTP 429'))
    const run = await service.start({ ...request, sources: ['crossref', 'arxiv'], useAi: true })
    await expect.poll(async () => (await service.get(run.id)).status).toBe('ready')
    const result = await service.get(run.id)
    expect(result.queries).toEqual([request.topic])
    expect(result.warnings.join('\n')).toContain('HTTP 429')
    expect(result.warnings.join('\n')).toContain('原始主题')
  })
  it('rejects invalid limits, unknown candidates and missing grants before external calls', async () => {
    await expect(service.start({ ...request, limit: 100 })).rejects.toThrow('1–10')
    expect(providers.search).not.toHaveBeenCalled()
    authorize.mockRejectedValueOnce(new Error('权限未授权'))
    await expect(service.start(request)).rejects.toThrow('未授权')
    const run = await ready()
    await expect(service.import(run.id, ['forged'], true)).rejects.toThrow('不存在')
    expect(providers.fetch).not.toHaveBeenCalled()
  })
  it('cancels searches and blocks writes following project switch or settings revocation', async () => {
    const run = await imported()
    const draft = await service.draft(run.id, [candidate.id], 'review', false)
    revision += 1
    await expect(service.confirm(draft.id)).rejects.toThrow('授权已改变')
    await expect(readFile(path.join(root, draft.path))).rejects.toMatchObject({ code: 'ENOENT' })
    const another = await service.draft(run.id, [candidate.id], 'note', false)
    ;(project as unknown as { projectRevision: number }).projectRevision += 1
    await expect(service.confirm(another.id)).rejects.toThrow('项目已切换')
  })
  it('checks revocation inside atomic creation and rejects symlink targets', async () => {
    const run = await imported()
    const draft = await service.draft(run.id, [candidate.id], 'review', false)
    const create = project.createMarkdown.bind(project)
    vi.spyOn(project, 'createMarkdown').mockImplementation(async (target, content, scope) => { revision += 1; return create(target, content, scope) })
    await expect(service.confirm(draft.id)).rejects.toThrow('授权已改变')
    vi.mocked(project.createMarkdown).mockRestore()
    const next = await service.draft(run.id, [candidate.id], 'review', false)
    await symlink(path.join(root, 'outside'), path.join(root, next.path.split('/').slice(0, 2).join('/'), 'bad')).catch(() => undefined)
    await writeFile(path.join(root, 'target.md'), 'existing')
    await symlink(path.join(root, 'target.md'), path.join(root, next.path))
    await expect(service.confirm(next.id)).rejects.toThrow()
    expect(await readFile(path.join(root, 'target.md'), 'utf8')).toBe('existing')
  })
  it('marks unfinished restored runs as interrupted and cancels a pending network request', async () => {
    vi.mocked(providers.search).mockImplementation(async (_source, _query, _limit, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
    const run = await service.start(request)
    expect((await createService().get(run.id)).status).toBe('interrupted')
    await service.cancel(run.id)
    await expect.poll(async () => (await service.get(run.id)).status).toBe('cancelled')
  })
  it('serializes plugin updates and rejects stale library saves without losing imported references', async () => {
    const run = await imported()
    await expect(project.savePluginData('references', { version: 1, revision: 0, references: [] })).rejects.toThrow('刷新')
    await Promise.all([project.savePluginData('flashcards', { cards: ['manual'] }), project.updatePluginData('references', (value) => ({ ...(value as object), marker: 'kept' }))])
    expect(await project.pluginData('flashcards')).toEqual({ cards: ['manual'] })
    expect((await project.pluginData('references') as { references: unknown[] }).references).toHaveLength(1)
    expect(run.candidates[0].imported).toBe(true)
  })
  it('fails closed on corrupt stored project metadata', async () => {
    await ready()
    await writeFile(path.join(root, '.coscribe', 'plugin-data.json'), 'broken json')
    await expect(project.savePluginData('references', { version: 1, references: [] })).rejects.toThrow()
    expect(await readFile(path.join(root, '.coscribe', 'plugin-data.json'), 'utf8')).toBe('broken json')
  })
  it('preserves curated metadata and separates different papers with identical citation keys', () => {
    const existing = normalizeReference({ ...candidate.reference, notes: '人工批注', title: '人工校正题名', tags: ['mine'] })
    const merged = mergeResearchReference([existing], normalizeReference({ ...candidate.reference, notes: 'external', tags: ['auto'] }))
    expect(merged.reference).toMatchObject({ title: '人工校正题名', notes: '人工批注', tags: ['mine', 'auto'] })
    const separate = mergeResearchReference([existing], normalizeReference({ ...candidate.reference, id: 'different', doi: '10.1000/different', url: 'https://doi.org/10.1000/different' }))
    expect(separate.references).toHaveLength(2)
    expect(separate.reference.citeKey).toBe('Ada2026Graph-2')
  })
})
