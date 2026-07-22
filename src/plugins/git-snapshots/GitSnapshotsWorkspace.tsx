import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, GitBranch, History, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react'

import type { GitSnapshotEntry, GitSnapshotStatus } from '../../shared/types'

export default function GitSnapshotsWorkspace(): React.JSX.Element {
  const [status, setStatus] = useState<GitSnapshotStatus | null>(null)
  const [history, setHistory] = useState<GitSnapshotEntry[]>([])
  const [message, setMessage] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setNotice(null)
    try {
      const nextStatus = await window.coscribe.gitSnapshots.status()
      setStatus(nextStatus)
      setHistory(nextStatus.initialized ? await window.coscribe.gitSnapshots.history(40) : [])
      if (nextStatus.error) setNotice(nextStatus.error)
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Git 状态读取失败。') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const create = async (): Promise<void> => {
    if (!message.trim()) return
    setCreating(true)
    setNotice(null)
    try {
      const result = await window.coscribe.gitSnapshots.create(message.trim())
      setStatus(result.status)
      setHistory(await window.coscribe.gitSnapshots.history(40))
      setMessage('')
      setNotice(`已创建本地快照 ${result.entry.shortHash}。没有向任何远程仓库推送。`)
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Git 快照创建失败。') }
    finally { setCreating(false) }
  }

  return (
    <section className="plugin-workspace git-workspace" aria-label="Git 快照插件">
      <header className="plugin-hero">
        <div className="plugin-hero__identity"><span><GitBranch size={23} /></span><div><small>LOCAL PROJECT CHECKPOINTS</small><h1>Git 快照</h1><p>仅创建本地提交，不配置远程、不推送、不修改全局 Git 身份</p></div></div>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => void load()}><RefreshCw size={14} />刷新状态</button>
      </header>

      <div className="git-safety-strip"><ShieldCheck size={18} /><span><strong>默认排除敏感和生成内容。</strong>.env、私钥、凭据命名文件、.vibeknowledge、node_modules、release、dist、out 与单文件超过 100 MB 的内容不会进入快照。</span></div>
      {notice && <p className="plugin-inline-message research-message" role="status">{notice}</p>}

      {loading || !status ? <div className="plugin-loading"><span className="viewer-spinner" />正在读取 Git 状态…</div> : <div className="git-layout">
        <div className="git-main-column">
          <section className="git-status-card">
            <div className="plugin-section-title"><div><small>WORKTREE</small><h2>{status.initialized ? status.branch || 'Git 仓库' : '尚未初始化 Git'}</h2></div>{status.head && <code>{status.head}</code>}</div>
            {!status.available ? <div className="plugin-empty"><GitBranch size={28} /><strong>系统没有可用的 Git</strong><p>安装 Git 后再使用项目快照。</p></div> : <>
              <div className="git-status-summary"><article><strong>{status.changedFiles.length}</strong><small>工作区变更</small></article><article><strong>{status.stagedFiles.length}</strong><small>用户已暂存</small></article><article><strong>{status.excludedFiles.length}</strong><small>安全排除</small></article></div>
              {status.stagedFiles.length > 0 && <p className="git-warning">暂存区已有用户内容。CoScribe 会拒绝创建快照，直到你在 Git 工具中处理这些暂存项。</p>}
              <div className="git-file-columns"><div><strong>将考虑的变更</strong>{status.changedFiles.length ? <ul>{status.changedFiles.map((file) => <li key={file}><span>{status.excludedFiles.includes(file) ? '排除' : '包含'}</span><code>{file}</code></li>)}</ul> : <p>工作区没有变更。</p>}</div><div><strong>安全排除</strong>{status.excludedFiles.length ? <ul>{status.excludedFiles.map((file) => <li key={file}><span>排除</span><code>{file}</code></li>)}</ul> : <p>当前没有被排除的文件。</p>}</div></div>
            </>}
          </section>

          {status.available && <section className="git-create-card">
            <div className="plugin-section-title"><div><small>CREATE CHECKPOINT</small><h2>{status.initialized ? '创建本地快照' : '初始化并创建首个快照'}</h2></div><Sparkles size={17} /></div>
            {!status.initialized && <p>首次创建会在项目根目录执行 <code>git init</code>。这不会创建远程仓库，也不会上传文件。</p>}
            <label><span>快照说明</span><input value={message} onChange={(event) => setMessage(event.target.value)} maxLength={240} placeholder="例如：完成第二轮文献筛选与矩阵整理" /></label>
            <button className="primary-button" type="button" disabled={!message.trim() || creating || status.stagedFiles.length > 0 || status.changedFiles.length === status.excludedFiles.length && status.initialized} onClick={() => void create()}><CheckCircle2 size={14} />{creating ? '正在创建…' : '创建本地快照'}</button>
          </section>}
        </div>

        <aside className="git-history-card">
          <div className="plugin-section-title"><div><small>HISTORY</small><h2>最近提交</h2></div><History size={16} /></div>
          {history.length ? <ol>{history.map((entry) => <li key={entry.hash}><div><code>{entry.shortHash}</code><time>{new Date(entry.createdAt).toLocaleString('zh-CN')}</time></div><strong>{entry.message}</strong><small>{entry.author}</small></li>)}</ol> : <div className="plugin-empty"><History size={26} /><strong>还没有提交记录</strong><p>创建首个项目快照后会显示在这里。</p></div>}
        </aside>
      </div>}
    </section>
  )
}
