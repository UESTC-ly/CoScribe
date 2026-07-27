import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  spawn: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showMessageBox: mocks.showMessageBox }
}))

vi.mock('node-pty', () => ({
  spawn: mocks.spawn
}))

import type { AppSettings } from '../../src/shared/types'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import type { ProjectService } from './project'
import type { SettingsStore } from './settings'
import { TerminalService } from './terminal'

interface FakePty {
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  onData: (listener: (data: string) => void) => { dispose: () => void }
  onExit: (listener: (event: { exitCode: number; signal: number }) => void) => { dispose: () => void }
  emitData: (data: string) => void
  emitExit: (exitCode: number) => void
}

function fakePty(): FakePty {
  const dataListeners: Array<(data: string) => void> = []
  const exitListeners: Array<(event: { exitCode: number; signal: number }) => void> = []
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (listener) => {
      dataListeners.push(listener)
      return { dispose: () => undefined }
    },
    onExit: (listener) => {
      exitListeners.push(listener)
      return { dispose: () => undefined }
    },
    emitData: (data) => dataListeners.forEach((listener) => listener(data)),
    emitExit: (exitCode) => exitListeners.forEach((listener) => listener({ exitCode, signal: 0 }))
  }
}

function harness(overrides: Partial<AppSettings> = {}): {
  service: TerminalService
  settings: AppSettings
  sender: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
  setProjectPath: (value: string) => void
} {
  const settings = { ...DEFAULT_SETTINGS, ...overrides }
  let projectPath = '/project'
  const project = {
    get info() {
      return { path: projectPath, name: 'project' }
    },
    guard: {
      existing: vi.fn(async (value: string) => value)
    }
  } as unknown as ProjectService
  const store = { get: vi.fn(async () => settings) } as unknown as SettingsStore
  const sender = { isDestroyed: () => false, send: vi.fn() }
  return {
    service: new TerminalService(store, project),
    settings,
    sender,
    setProjectPath: (value) => { projectPath = value }
  }
}

beforeEach(() => {
  mocks.showMessageBox.mockReset()
  mocks.spawn.mockReset()
})

describe('AI Shell authorization', () => {
  it('is disabled by default and never opens a warning dialog', async () => {
    const { service, sender } = harness()
    await expect(service.authorize(sender as never)).rejects.toThrow('默认关闭')
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
    await expect(service.status()).resolves.toMatchObject({ enabled: false, authorized: false })
  })

  it('requires both confirmations every time and keeps the grant in memory for one project', async () => {
    const { service, sender, setProjectPath } = harness({ aiShellEnabled: true })
    mocks.showMessageBox
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 1 })

    await expect(service.authorize(sender as never)).resolves.toMatchObject({ authorized: true, projectPath: '/project' })
    await expect(service.authorize(sender as never)).resolves.toMatchObject({ authorized: true })
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(4)

    setProjectPath('/other-project')
    await expect(service.status()).resolves.toMatchObject({ authorized: false, projectPath: '/other-project' })
  })

  it('does not grant when either confirmation is declined', async () => {
    const { service, sender } = harness({ aiShellEnabled: true })
    mocks.showMessageBox.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 })
    await expect(service.authorize(sender as never)).resolves.toMatchObject({ authorized: false })
  })

  it('keeps an existing grant when a re-authorization dialog is cancelled', async () => {
    const { service, sender } = harness({ aiShellEnabled: true })
    mocks.showMessageBox
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 0 })

    await expect(service.authorize(sender as never)).resolves.toMatchObject({ authorized: true })
    await expect(service.authorize(sender as never)).resolves.toMatchObject({ authorized: true })
  })

  it('rechecks per-command permission and returns bounded sanitized output', async () => {
    const { service, sender } = harness({
      aiShellEnabled: true,
      aiShellApprovalMode: 'per-command'
    })
    mocks.showMessageBox
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 1 })
    await service.authorize(sender as never)

    const child = fakePty()
    mocks.spawn.mockReturnValue(child)
    const running = service.runAiCommand(sender as never, {
      requestId: 'command-1',
      command: 'printf hello'
    })
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1))
    child.emitData('\u001b[31mhello\u001b[0m\r\n')
    child.emitExit(0)

    await expect(running).resolves.toMatchObject({
      requestId: 'command-1',
      command: 'printf hello',
      cwd: '/project',
      output: 'hello\n',
      exitCode: 0,
      timedOut: false,
      truncated: false
    })
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(3)
  })

  it('kills an AI command when raw output reaches the hard limit', async () => {
    const { service, sender } = harness({
      aiShellEnabled: true,
      aiShellApprovalMode: 'session'
    })
    mocks.showMessageBox
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 1 })
    await service.authorize(sender as never)

    const child = fakePty()
    mocks.spawn.mockReturnValue(child)
    const running = service.runAiCommand(sender as never, {
      requestId: 'command-output-limit',
      command: 'yes'
    })
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1))
    child.emitData(`\u001b[31m${'x'.repeat(300_000)}`)

    const result = await running
    expect(result).toMatchObject({ exitCode: 125, truncated: true })
    expect(result.output.length).toBeLessThan(66_000)
    expect(result.output).toContain('[输出已截断]')
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('runs at most one AI command at a time', async () => {
    const { service, sender } = harness({
      aiShellEnabled: true,
      aiShellApprovalMode: 'session'
    })
    mocks.showMessageBox
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 1 })
    await service.authorize(sender as never)

    const child = fakePty()
    mocks.spawn.mockReturnValue(child)
    const first = service.runAiCommand(sender as never, {
      requestId: 'command-running',
      command: 'sleep 1'
    })
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1))
    await expect(service.runAiCommand(sender as never, {
      requestId: 'command-concurrent',
      command: 'pwd'
    })).rejects.toThrow('正在运行')
    child.emitExit(0)
    await expect(first).resolves.toMatchObject({ exitCode: 0 })
  })

  it('refuses command execution without a current project grant', async () => {
    const { service, sender } = harness({ aiShellEnabled: true })
    await expect(service.runAiCommand(sender as never, {
      requestId: 'command-2',
      command: 'pwd'
    })).rejects.toThrow('双重确认授权')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('allows only the creating renderer to control a user terminal session', async () => {
    const { service, sender } = harness()
    const child = fakePty()
    mocks.spawn.mockReturnValue(child)
    const session = await service.create(sender as never)
    const other = { isDestroyed: () => false, send: vi.fn() }

    expect(() => service.write(other as never, session.id, 'pwd\r')).toThrow('不属于当前窗口')
    expect(() => service.resize(other as never, session.id, 120, 40)).toThrow('不属于当前窗口')
    expect(() => service.kill(other as never, session.id)).toThrow('不属于当前窗口')
    service.write(sender as never, session.id, 'pwd\r')
    expect(child.write).toHaveBeenCalledWith('pwd\r')
  })
})
