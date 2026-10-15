import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IPC } from '../ipc-channels'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/types'
import type { LearningSnapshot } from '../../src/shared/learning'

const handlers = vi.hoisted(() => new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  app: {}, clipboard: {},
  ipcMain: {
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => handlers.set(channel, listener)
  }
}))
// Unrelated service constructors stay inert; LearningService and the real IPC
// authorization/sender wrappers run without launching Electron or a worker.
vi.mock('./assistant/review-service', () => ({ ReviewService: class {} }))
vi.mock('./research/model', () => ({ ConfiguredResearchModel: class {} }))
vi.mock('./research/providers', () => ({ ResearchProviders: class {} }))
vi.mock('./research/service', () => ({ AutoResearchService: class {} }))

import { registerIpc } from './ipc'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const snapshot: LearningSnapshot = { revision: 0, knowledge: [], sources: [], records: [], relations: [], materials: [], events: [] }
let preferences: AppSettings
let revision: number
let saveGate: ReturnType<typeof deferred<void>> | undefined
let workflow: ReturnType<typeof vi.fn>
let get: ReturnType<typeof vi.fn>
let event: IpcMainInvokeEvent
let searchPolicy: ReturnType<typeof vi.fn>
let rebuildIndex: ReturnType<typeof vi.fn>
let stopAll: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubEnv('ELECTRON_RENDERER_URL', '')
  handlers.clear()
  revision = 0
  saveGate = undefined
  preferences = { ...DEFAULT_SETTINGS, enabledPlugins: ['flashcards'], pluginGrants: { flashcards: ['learning:read', 'learning:write'] } }
  workflow = vi.fn(async (command: string) => command === 'learning-sources' ? [] : snapshot)
  get = vi.fn(async () => preferences)
  searchPolicy = vi.fn(async () => null)
  rebuildIndex = vi.fn(async () => null)
  stopAll = vi.fn()
  const frame = { url: 'coscribe-app://app/index.html' }
  event = { senderFrame: frame, sender: { mainFrame: frame, getURL: () => frame.url } } as unknown as IpcMainInvokeEvent
  registerIpc({
    assistant: { workflow, setSearch: searchPolicy, rebuildIndex },
    settings: {
      get revision() { return revision },
      get,
      async save(value: AppSettings) {
        revision += 1
        await saveGate?.promise
        preferences = value
        return value
      }
    },
    project: { captureWriteScope() { throw new Error('项目未打开') } },
    ai: { stopAll }, terminal: { revoke: vi.fn() }
  } as unknown as Parameters<typeof registerIpc>[0])
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args)
const mutation = { op: 'knowledge.save', name: 'RAG', domain: 'AI', expectedRevision: 0 }

describe('learning IPC authorization without desktop launch', () => {
  it('rejects foreign pages and subframes before exposing personal data', () => {
    const foreignFrame = { url: 'https://example.com/index.html' }
    event = { senderFrame: foreignFrame, sender: { mainFrame: foreignFrame, getURL: () => foreignFrame.url } } as unknown as IpcMainInvokeEvent
    expect(() => invoke(IPC.learningInspect)).toThrow('不受信任')
    expect(() => invoke(IPC.assistantMemorySearchPolicy, {})).toThrow('不受信任')
    expect(() => invoke(IPC.assistantMemoryRebuildIndex, {})).toThrow('不受信任')
    event = { ...event, senderFrame: { url: foreignFrame.url } } as unknown as IpcMainInvokeEvent
    expect(() => invoke(IPC.learningInspect)).toThrow('非主窗口')
    expect(workflow).not.toHaveBeenCalled()
    expect(searchPolicy).not.toHaveBeenCalled()
    expect(rebuildIndex).not.toHaveBeenCalled()
  })

  it('requires optional learning grants while keeping core privacy controls available', async () => {
    preferences.pluginGrants = { flashcards: [] }
    await expect(invoke(IPC.learningMutate, mutation)).rejects.toThrow('尚未获得用户授权')
    expect(workflow).not.toHaveBeenCalled()
    preferences.enabledPlugins = []
    await expect(invoke(IPC.learningInspect)).resolves.toEqual(snapshot)
    await expect(invoke(IPC.learningCorrect, mutation)).rejects.toThrow('只能纠正或删除')
    expect(workflow).toHaveBeenCalledTimes(1)
  })

  it('blocks new plugin operations throughout a pending revocation save', async () => {
    saveGate = deferred<void>()
    const saving = invoke(IPC.settingsSave, { ...preferences, enabledPlugins: [] })
    await expect(invoke(IPC.learningMutate, mutation)).rejects.toThrow('设置正在保存')
    expect(workflow).not.toHaveBeenCalled()
    await expect(invoke(IPC.learningInspect)).resolves.toEqual(snapshot)
    saveGate.resolve()
    await saving
    await expect(invoke(IPC.learningList)).rejects.toThrow('未启用')
    expect(workflow).toHaveBeenCalledTimes(1)
  })

  it('rejects stale authorization reads when settings change during the await', async () => {
    const reading = deferred<AppSettings>()
    get.mockImplementationOnce(() => reading.promise)
    const listing = invoke(IPC.learningList)
    saveGate = deferred<void>()
    const saving = invoke(IPC.settingsSave, { ...preferences, enabledPlugins: [] })
    reading.resolve(preferences)
    await expect(listing).rejects.toThrow('授权或设置已变化')
    expect(workflow).not.toHaveBeenCalled()
    saveGate.resolve()
    await saving
  })

  it('releases the pending-save guard after a failed save', async () => {
    saveGate = deferred<void>()
    const saving = invoke(IPC.settingsSave, preferences)
    saveGate.reject(new Error('磁盘写入失败'))
    await expect(saving).rejects.toThrow('磁盘写入失败')
    await expect(invoke(IPC.learningList)).resolves.toEqual(snapshot)
    expect(workflow).toHaveBeenCalledWith('learning-list', undefined)
  })

  it('routes narrow memory search controls through the trusted sender and request cancellation boundary', async () => {
    const input = { profileId: 'local', model: 'embedding', expectedRevision: 1 }
    await invoke(IPC.assistantMemorySearchPolicy, input)
    await invoke(IPC.assistantMemoryRebuildIndex, { expectedRevision: 2 })
    expect(searchPolicy).toHaveBeenCalledWith(input)
    expect(rebuildIndex).toHaveBeenCalledWith({ expectedRevision: 2 })
    expect(stopAll).toHaveBeenCalledTimes(4)
  })
})
