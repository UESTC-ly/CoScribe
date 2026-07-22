import { useCallback, useEffect, useState } from 'react'
import { Activity, Database, Gauge, HardDrive, RefreshCw, RotateCcw } from 'lucide-react'

import type { DiagnosticsSnapshot } from '../../shared/types'

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function DiagnosticsWorkspace(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [rebuilding, setRebuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try { setSnapshot(await window.coscribe.diagnostics.snapshot()) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '性能快照读取失败。') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const rebuild = async (): Promise<void> => {
    setRebuilding(true)
    setError(null)
    try {
      await window.coscribe.knowledge.rebuild()
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '知识索引重建失败。')
    } finally {
      setRebuilding(false)
    }
  }

  return (
    <section className="plugin-workspace diagnostics-workspace" aria-label="性能诊断插件">
      <header className="plugin-hero">
        <div className="plugin-hero__identity"><span><Gauge size={23} /></span><div><small>ON-DEMAND SNAPSHOT</small><h1>性能诊断</h1><p>仅在打开或点击刷新时采样，不启动常驻监控定时器</p></div></div>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => void refresh()}><RefreshCw size={14} />刷新快照</button>
      </header>

      {error && <p className="plugin-inline-message is-error" role="alert">{error}</p>}
      {loading && !snapshot ? <div className="plugin-loading"><span className="viewer-spinner" />正在读取进程指标…</div> : snapshot && <>
        <div className="diagnostic-metrics">
          <article><span><HardDrive size={17} /></span><div><strong>{snapshot.appMemoryMb.toFixed(1)} MB</strong><small>主进程常驻内存</small></div></article>
          <article><span><Activity size={17} /></span><div><strong>{snapshot.processes.length}</strong><small>Electron 进程</small></div></article>
          <article><span><Database size={17} /></span><div><strong>{snapshot.index.fileCount}</strong><small>已索引文件</small></div></article>
          <article><span><Gauge size={17} /></span><div><strong>{snapshot.enabledPlugins}/{snapshot.totalPlugins}</strong><small>已启用插件</small></div></article>
        </div>

        <div className="diagnostic-layout">
          <section className="diagnostic-panel">
            <div className="plugin-section-title"><div><small>PROCESS FOOTPRINT</small><h2>进程资源</h2></div><span>运行 {Math.round(snapshot.uptimeSeconds / 60)} 分钟</span></div>
            <div className="diagnostic-table"><header><span>进程</span><span>CPU</span><span>内存</span></header>{snapshot.processes.map((process, index) => <div key={`${process.type}-${index}`}><strong>{process.type}</strong><span>{process.cpuPercent.toFixed(1)}%</span><span>{process.memoryMb.toFixed(1)} MB</span></div>)}</div>
          </section>

          <aside className="diagnostic-panel">
            <div className="plugin-section-title"><div><small>LOCAL KNOWLEDGE INDEX</small><h2>增量索引</h2></div><span className={`diagnostic-state is-${snapshot.index.state}`}>{snapshot.index.state}</span></div>
            <dl>
              <div><dt>文本片段</dt><dd>{snapshot.index.segmentCount}</dd></div>
              <div><dt>索引体积</dt><dd>{fileSize(snapshot.index.storedBytes)}</dd></div>
              <div><dt>上次变化</dt><dd>{snapshot.index.changedFiles} 个文件</dd></div>
              <div><dt>处理耗时</dt><dd>{snapshot.index.durationMs} ms</dd></div>
              <div><dt>本地语音模型</dt><dd>{snapshot.speechModelInstalled ? '已安装' : '未安装'}</dd></div>
            </dl>
            <button className="secondary-button" type="button" disabled={rebuilding} onClick={() => void rebuild()}><RotateCcw size={14} />{rebuilding ? '正在重建…' : '完整重建索引'}</button>
            <p>日常搜索只读取发生变化的文件；完整重建仅用于排查索引异常。</p>
          </aside>
        </div>
      </>}
    </section>
  )
}
