import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import type { GitSnapshotEntry, GitSnapshotResult, GitSnapshotStatus } from '../../src/shared/types'
import type { ProjectService } from './project'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_CHANGED_FILES = 2_000
const MAX_SNAPSHOT_FILE_BYTES = 100 * 1024 * 1024
const EXCLUDED_SEGMENTS = new Set([
  '.git',
  '.vibeknowledge',
  '.cache',
  'node_modules',
  'release',
  'dist',
  'out'
])

type PorcelainEntry = {
  index: string
  worktree: string
  filePath: string
}

function messageText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('快照说明格式无效。')
  const message = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 240)
  if (!message) throw new Error('请填写快照说明。')
  return message
}

function normalizedGitPath(value: string): string {
  return value.split(path.sep).join('/').replace(/^\.\//u, '')
}

export function excludedSnapshotPath(value: string): boolean {
  const normalized = normalizedGitPath(value)
  const segments = normalized.split('/').filter(Boolean)
  if (!segments.length || normalized.startsWith('../') || path.isAbsolute(value)) return true
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return true
  const name = segments.at(-1)?.toLocaleLowerCase() ?? ''
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    /\.(?:pem|key|p12|pfx)$/u.test(name) ||
    /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.pub)?$/u.test(name) ||
    /(?:^|[-_.])(?:credential|credentials|secret|secrets)(?:[-_.]|$)/u.test(name)
  )
}

function parsePorcelain(output: string): PorcelainEntry[] {
  const records = output.split('\0')
  const entries: PorcelainEntry[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record || record.length < 4 || record[2] !== ' ') continue
    const entry: PorcelainEntry = {
      index: record[0],
      worktree: record[1],
      filePath: normalizedGitPath(record.slice(3))
    }
    entries.push(entry)
    if (entry.index === 'R' || entry.index === 'C' || entry.worktree === 'R' || entry.worktree === 'C') index += 1
  }
  return entries
}

function parseLog(output: string): GitSnapshotEntry[] {
  return output.split('\x1e').flatMap((record): GitSnapshotEntry[] => {
    const [hash, shortHash, message, author, createdAt] = record.trim().split('\x1f')
    const timestamp = Date.parse(createdAt ?? '')
    if (!hash || !shortHash || !message || !author || !Number.isFinite(timestamp)) return []
    return [{ hash, shortHash, message, author, createdAt: timestamp }]
  })
}

export class GitSnapshotService {
  constructor(private readonly project: ProjectService) {}

  private get root(): string {
    return this.project.guard.root
  }

  private async git(args: string[], allowFailure = false): Promise<{ stdout: string; stderr: string; failed: boolean }> {
    try {
      const result = await execFileAsync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: this.root,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' }
      })
      return { stdout: result.stdout, stderr: result.stderr, failed: false }
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string; code?: string | number }
      if (allowFailure) return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message, failed: true }
      if (failure.code === 'ENOENT') throw new Error('系统没有安装 Git。')
      throw new Error((failure.stderr || failure.message || 'Git 命令执行失败。').trim().slice(0, 4_000))
    }
  }

  private async initialized(): Promise<boolean> {
    const result = await this.git(['rev-parse', '--is-inside-work-tree'], true)
    return !result.failed && result.stdout.trim() === 'true'
  }

  private async entries(): Promise<PorcelainEntry[]> {
    const result = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    const entries = parsePorcelain(result.stdout)
    if (entries.length > MAX_CHANGED_FILES) throw new Error(`变更文件超过 ${MAX_CHANGED_FILES} 个，请先缩小快照范围。`)
    return entries
  }

  private async safePaths(entries: PorcelainEntry[]): Promise<{ included: string[]; excluded: string[] }> {
    const included: string[] = []
    const excluded: string[] = []
    for (const entry of entries) {
      if (excludedSnapshotPath(entry.filePath)) {
        excluded.push(entry.filePath)
        continue
      }
      try {
        const info = await lstat(path.join(this.root, entry.filePath))
        if (info.isFile() && info.size > MAX_SNAPSHOT_FILE_BYTES) {
          excluded.push(entry.filePath)
          continue
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // Deleted files have no local size and are safe to stage by their exact path.
      }
      included.push(entry.filePath)
    }
    return { included, excluded }
  }

  async status(): Promise<GitSnapshotStatus> {
    const available = !(await this.git(['--version'], true)).failed
    if (!available) return { available: false, initialized: false, changedFiles: [], stagedFiles: [], excludedFiles: [], error: '系统没有安装 Git。' }
    if (!(await this.initialized())) return { available: true, initialized: false, changedFiles: [], stagedFiles: [], excludedFiles: [] }
    try {
      const entries = await this.entries()
      const { excluded } = await this.safePaths(entries)
      const stagedFiles = entries.filter((entry) => entry.index !== ' ' && entry.index !== '?').map((entry) => entry.filePath)
      const branchResult = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], true)
      const headResult = await this.git(['rev-parse', '--short', 'HEAD'], true)
      return {
        available: true,
        initialized: true,
        ...(!branchResult.failed && branchResult.stdout.trim() ? { branch: branchResult.stdout.trim() } : {}),
        ...(!headResult.failed && headResult.stdout.trim() ? { head: headResult.stdout.trim() } : {}),
        changedFiles: entries.map((entry) => entry.filePath),
        stagedFiles,
        excludedFiles: excluded
      }
    } catch (error) {
      return {
        available: true,
        initialized: true,
        changedFiles: [],
        stagedFiles: [],
        excludedFiles: [],
        error: error instanceof Error ? error.message : '读取 Git 状态失败。'
      }
    }
  }

  private async assertRepositoryReady(): Promise<void> {
    const branch = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], true)
    if (branch.failed || !branch.stdout.trim()) throw new Error('当前仓库处于 detached HEAD，不能创建 CoScribe 快照。')
    for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD']) {
      const markerPath = await this.git(['rev-parse', '--git-path', marker], true)
      if (markerPath.failed || !markerPath.stdout.trim()) continue
      try {
        await lstat(path.resolve(this.root, markerPath.stdout.trim()))
        throw new Error('仓库正在合并、变基或挑选提交，请先完成该操作。')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  async create(rawMessage: string): Promise<GitSnapshotResult> {
    const message = messageText(rawMessage)
    if ((await this.git(['--version'], true)).failed) throw new Error('系统没有安装 Git。')
    if (!(await this.initialized())) await this.git(['init'])
    await this.assertRepositoryReady()
    const entries = await this.entries()
    const staged = entries.filter((entry) => entry.index !== ' ' && entry.index !== '?')
    if (staged.length) throw new Error('Git 暂存区已有内容。为避免混入用户操作，CoScribe 没有创建快照。')
    const { included } = await this.safePaths(entries)
    if (!included.length) throw new Error('没有可写入快照的变更；敏感文件、构建产物和超大文件会被自动排除。')
    let stagedByService = false
    try {
      for (let offset = 0; offset < included.length; offset += 100) {
        await this.git(['add', '-A', '--', ...included.slice(offset, offset + 100)])
      }
      stagedByService = true
      const stagedNow = await this.git(['diff', '--cached', '--name-only', '-z'])
      if (!stagedNow.stdout) throw new Error('没有可提交的内容。')
      await this.git([
        '-c', 'user.name=CoScribe',
        '-c', 'user.email=snapshots@coscribe.local',
        'commit', '--no-gpg-sign', '--no-verify', '-m', message
      ])
    } catch (error) {
      if (stagedByService) {
        const reset = await this.git(['reset', '--mixed'], true)
        if (reset.failed) await this.git(['rm', '--cached', '-r', '--ignore-unmatch', '.'], true)
      }
      throw error
    }
    const [entry] = await this.history(1)
    if (!entry) throw new Error('快照提交已创建，但无法读取提交记录。')
    return { entry, status: await this.status() }
  }

  async history(limit = 30): Promise<GitSnapshotEntry[]> {
    if (!(await this.initialized())) return []
    const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 30))
    const result = await this.git([
      'log', `--max-count=${safeLimit}`, '--date=iso-strict',
      '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e'
    ], true)
    return result.failed ? [] : parseLog(result.stdout)
  }
}
