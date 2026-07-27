import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import path from 'node:path'

import { BrowserWindow, dialog, type WebContents } from 'electron'
import * as pty from 'node-pty'

import type {
  AiShellCommandRequest,
  AiShellCommandResult,
  AiShellStatus,
  TerminalCreateRequest,
  TerminalEvent,
  TerminalSessionInfo
} from '../../src/shared/types'
import { IPC } from '../ipc-channels'
import { ProjectService } from './project'
import { SettingsStore } from './settings'

const MAX_USER_SESSIONS = 8
const MAX_TERMINAL_WRITE_CHARS = 64 * 1024
const MAX_AI_COMMAND_CHARS = 8_000
const MAX_AI_OUTPUT_CHARS = 64 * 1024
const MAX_AI_RAW_OUTPUT_CHARS = 256 * 1024
const DEFAULT_AI_TIMEOUT_MS = 30_000
const MAX_AI_TIMEOUT_MS = 120_000

interface TerminalSession {
  info: TerminalSessionInfo
  process: pty.IPty
  sender: WebContents
}

function shellConfiguration(): { executable: string; interactiveArgs: string[]; commandArgs: (command: string) => string[] } {
  if (process.platform === 'win32') {
    const executable = process.env.ComSpec || 'cmd.exe'
    return {
      executable,
      interactiveArgs: [],
      commandArgs: (command) => ['/d', '/s', '/c', command]
    }
  }
  const fallback = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  const configured = process.env.SHELL
  const executable = configured && path.isAbsolute(configured) ? configured : fallback
  return {
    executable,
    interactiveArgs: ['-l'],
    commandArgs: (command) => ['-lc', command]
  }
}

function terminalEnvironment(): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    ),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor'
  }
}

function normalizedOutput(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/gu, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '')
}

function promiseExecFile(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { windowsHide: false }, (error) => error ? reject(error) : resolve())
  })
}

export class TerminalService {
  private readonly sessions = new Map<string, TerminalSession>()
  private authorizedProjectPath: string | null = null
  private activeAiProcess: pty.IPty | null = null

  constructor(
    private readonly settings: SettingsStore,
    private readonly project: ProjectService
  ) {}

  private projectRoot(): string {
    return this.project.info.path
  }

  private emit(sender: WebContents, event: TerminalEvent): void {
    if (!sender.isDestroyed()) sender.send(IPC.terminalEvent, event)
  }

  private async cwd(input?: string): Promise<string> {
    const root = this.projectRoot()
    return this.project.guard.existing(input ? path.resolve(root, input) : root, 'directory')
  }

  async create(sender: WebContents, request: TerminalCreateRequest = {}): Promise<TerminalSessionInfo> {
    if (this.sessions.size >= MAX_USER_SESSIONS) throw new Error(`最多同时打开 ${MAX_USER_SESSIONS} 个终端会话。`)
    const cwd = await this.cwd(request.cwd)
    const cols = Math.max(20, Math.min(500, Math.round(request.cols ?? 100)))
    const rows = Math.max(5, Math.min(200, Math.round(request.rows ?? 28)))
    const shell = shellConfiguration()
    const child = pty.spawn(shell.executable, shell.interactiveArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: terminalEnvironment()
    })
    const info: TerminalSessionInfo = {
      id: randomUUID(),
      kind: 'user',
      cwd,
      shell: shell.executable,
      createdAt: Date.now()
    }
    const session: TerminalSession = { info, process: child, sender }
    this.sessions.set(info.id, session)
    child.onData((data) => this.emit(sender, { sessionId: info.id, type: 'data', data }))
    child.onExit(({ exitCode, signal }) => {
      this.sessions.delete(info.id)
      this.emit(sender, { sessionId: info.id, type: 'exit', exitCode, ...(signal ? { signal } : {}) })
    })
    this.emit(sender, { sessionId: info.id, type: 'started', session: info })
    return info
  }

  private ownedSession(sender: WebContents, sessionId: string): TerminalSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('终端会话不存在或已经结束。')
    if (session.sender !== sender) throw new Error('终端会话不属于当前窗口。')
    return session
  }

  write(sender: WebContents, sessionId: string, data: string): void {
    if (typeof data !== 'string' || data.length > MAX_TERMINAL_WRITE_CHARS) {
      throw new Error('终端输入为空或超过长度限制。')
    }
    this.ownedSession(sender, sessionId).process.write(data)
  }

  resize(sender: WebContents, sessionId: string, cols: number, rows: number): void {
    const session = this.ownedSession(sender, sessionId)
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) throw new Error('终端尺寸无效。')
    session.process.resize(
      Math.max(20, Math.min(500, Math.round(cols))),
      Math.max(5, Math.min(200, Math.round(rows)))
    )
  }

  kill(sender: WebContents, sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.sender !== sender) throw new Error('终端会话不属于当前窗口。')
    this.sessions.delete(sessionId)
    session.process.kill()
  }

  killAll(): void {
    for (const session of this.sessions.values()) session.process.kill()
    this.sessions.clear()
    this.activeAiProcess?.kill()
    this.activeAiProcess = null
    this.authorizedProjectPath = null
  }

  async openExternal(input?: string): Promise<void> {
    const cwd = await this.cwd(input)
    if (process.platform === 'darwin') {
      await promiseExecFile('/usr/bin/open', ['-a', 'Terminal', cwd])
      return
    }
    if (process.platform === 'win32') {
      await promiseExecFile('wt.exe', ['-d', cwd])
      return
    }
    const candidates: Array<[string, string[]]> = [
      ['x-terminal-emulator', ['--working-directory', cwd]],
      ['gnome-terminal', ['--working-directory', cwd]],
      ['konsole', ['--workdir', cwd]]
    ]
    for (const [executable, args] of candidates) {
      try {
        await promiseExecFile(executable, args)
        return
      } catch {
        // Try the next common terminal executable.
      }
    }
    throw new Error('没有找到可用的系统终端，请在 IDE 底部使用内置终端。')
  }

  private async confirm(sender: WebContents, options: Electron.MessageBoxOptions): Promise<number> {
    const parent = BrowserWindow.fromWebContents(sender)
    const result = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
    return result.response
  }

  async status(): Promise<AiShellStatus> {
    const preferences = await this.settings.get()
    let projectPath: string | undefined
    try {
      projectPath = this.projectRoot()
    } catch {
      projectPath = undefined
    }
    return {
      enabled: preferences.aiShellEnabled,
      authorized: Boolean(
        preferences.aiShellEnabled &&
        projectPath &&
        this.authorizedProjectPath === projectPath
      ),
      approvalMode: preferences.aiShellApprovalMode,
      ...(projectPath ? { projectPath } : {})
    }
  }

  async authorize(sender: WebContents): Promise<AiShellStatus> {
    const preferences = await this.settings.get()
    if (!preferences.aiShellEnabled) {
      this.authorizedProjectPath = null
      throw new Error('AI Shell 默认关闭。请先在“设置 → AI 行为”中启用。')
    }
    const root = this.projectRoot()
    const warning = await this.confirm(sender, {
      type: 'warning',
      title: '开启 AI Shell：风险警告',
      message: 'AI Shell 可以执行本机命令',
      detail: [
        '命令以当前登录用户权限运行，并不受项目文件夹沙箱限制。',
        '命令可能修改或删除项目外文件、访问网络、读取本机环境信息。',
        '只有在你理解并接受这些风险时才继续。'
      ].join('\n\n'),
      buttons: ['取消', '继续查看确认'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (warning !== 1) return this.status()
    const confirmation = await this.confirm(sender, {
      type: 'warning',
      title: '再次确认开启 AI Shell',
      message: '确认仅为当前项目、当前应用会话授权？',
      detail: preferences.aiShellApprovalMode === 'per-command'
        ? '开启后，每一条 AI 命令仍会单独展示并等待确认。关闭项目或应用会立即撤销授权。'
        : '开启后，当前项目在本次应用会话内的 AI 命令无需逐条确认。关闭项目或应用会立即撤销授权。',
      buttons: ['取消', '我确认开启 AI Shell'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (confirmation === 1) this.authorizedProjectPath = root
    return this.status()
  }

  async revoke(): Promise<AiShellStatus> {
    this.authorizedProjectPath = null
    return this.status()
  }

  async runAiCommand(
    sender: WebContents,
    request: AiShellCommandRequest,
    signal?: AbortSignal
  ): Promise<AiShellCommandResult> {
    if (!request || typeof request.requestId !== 'string' || !request.requestId.trim()) {
      throw new Error('AI Shell 请求 ID 无效。')
    }
    if (
      typeof request.command !== 'string' ||
      !request.command.trim() ||
      request.command.length > MAX_AI_COMMAND_CHARS ||
      /[\u0000\u202a-\u202e\u2066-\u2069]/u.test(request.command)
    ) {
      throw new Error('AI Shell 命令为空、过长或包含非法控制字符。')
    }
    const preferences = await this.settings.get()
    const root = this.projectRoot()
    if (!preferences.aiShellEnabled || this.authorizedProjectPath !== root) {
      throw new Error('AI Shell 未获得当前项目的双重确认授权。')
    }
    if (this.activeAiProcess) throw new Error('当前项目已有一条 AI Shell 命令正在运行。')
    const cwd = await this.cwd(request.cwd)
    if (preferences.aiShellApprovalMode === 'per-command') {
      const response = await this.confirm(sender, {
        type: 'warning',
        title: '允许 AI 执行这条命令？',
        message: request.command.length > 500 ? `${request.command.slice(0, 500)}…` : request.command,
        detail: `工作目录：${cwd}\n\n命令以当前用户权限运行，不受项目沙箱限制。`,
        buttons: ['拒绝', '允许执行'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      if (response !== 1) throw new Error('用户拒绝了这条 AI Shell 命令。')
    }
    if (this.activeAiProcess) throw new Error('当前项目已有一条 AI Shell 命令正在运行。')

    const timeoutMs = Math.max(
      1_000,
      Math.min(MAX_AI_TIMEOUT_MS, Math.round(request.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS))
    )
    const shell = shellConfiguration()
    const sessionId = randomUUID()
    const info: TerminalSessionInfo = {
      id: sessionId,
      kind: 'ai',
      cwd,
      shell: shell.executable,
      createdAt: Date.now()
    }
    this.emit(sender, { sessionId, type: 'started', session: info })

    return new Promise<AiShellCommandResult>((resolve) => {
      let rawOutput = ''
      let timedOut = false
      let settled = false
      const child = pty.spawn(shell.executable, shell.commandArgs(request.command), {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd,
        env: terminalEnvironment()
      })
      this.activeAiProcess = child
      const finish = (exitCode: number): void => {
        if (settled) return
        settled = true
        if (this.activeAiProcess === child) this.activeAiProcess = null
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        const clean = normalizedOutput(rawOutput)
        const truncated = clean.length > MAX_AI_OUTPUT_CHARS || rawOutput.length >= MAX_AI_RAW_OUTPUT_CHARS
        const output = clean.length > MAX_AI_OUTPUT_CHARS
          ? `${clean.slice(0, MAX_AI_OUTPUT_CHARS)}\n[输出已截断]`
          : clean
        this.emit(sender, { sessionId, type: 'exit', exitCode })
        resolve({
          requestId: request.requestId,
          sessionId,
          command: request.command,
          cwd,
          output,
          exitCode,
          timedOut,
          truncated
        })
      }
      const abort = (): void => {
        timedOut = signal?.aborted ? false : timedOut
        child.kill()
        finish(130)
      }
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
        finish(124)
      }, timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) {
        abort()
        return
      }
      child.onData((data) => {
        const remaining = Math.max(0, MAX_AI_RAW_OUTPUT_CHARS - rawOutput.length)
        const accepted = data.slice(0, remaining)
        rawOutput += accepted
        if (accepted) this.emit(sender, { sessionId, type: 'data', data: accepted })
        if (rawOutput.length >= MAX_AI_RAW_OUTPUT_CHARS && !settled) {
          child.kill()
          finish(125)
        }
      })
      child.onExit(({ exitCode }) => finish(exitCode))
    })
  }
}
