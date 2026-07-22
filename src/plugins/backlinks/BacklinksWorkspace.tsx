import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowRight, Link2, Network, RefreshCw, Unlink2 } from 'lucide-react'

import type { BacklinkGraph, BacklinkNode } from '../../shared/types'

interface BacklinksWorkspaceProps {
  activePath?: string
  onOpenMarkdown: (path: string) => void
}

function name(value: string): string {
  return value.split(/[\\/]/u).filter(Boolean).at(-1) ?? value
}

export default function BacklinksWorkspace(props: BacklinksWorkspaceProps): React.JSX.Element {
  const [graph, setGraph] = useState<BacklinkGraph | null>(null)
  const [selectedPath, setSelectedPath] = useState(props.activePath ?? '')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const next = await window.coscribe.knowledge.backlinks()
      setGraph(next)
      setSelectedPath((current) => next.nodes.some((node) => node.path === current)
        ? current
        : next.nodes.some((node) => node.path === props.activePath)
          ? props.activePath ?? ''
          : next.nodes[0]?.path ?? '')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '双向链接分析失败。')
    } finally {
      setLoading(false)
    }
  }, [props.activePath])

  useEffect(() => { void load() }, [load])

  const selected = graph?.nodes.find((node) => node.path === selectedPath)
  const inbound = useMemo(() => graph?.edges.filter((edge) => edge.targetPath === selectedPath && edge.kind === 'link') ?? [], [graph, selectedPath])
  const outbound = useMemo(() => graph?.edges.filter((edge) => edge.sourcePath === selectedPath && edge.kind === 'link') ?? [], [graph, selectedPath])
  const mentions = useMemo(() => graph?.edges.filter((edge) => edge.targetPath === selectedPath && edge.kind === 'unlinked-mention') ?? [], [graph, selectedPath])
  const isolated = graph?.nodes.filter((node) => node.inbound === 0 && node.outbound === 0 && node.unlinkedMentions === 0).length ?? 0

  const nodeRow = (node: BacklinkNode): React.JSX.Element => (
    <button key={node.path} className={selectedPath === node.path ? 'is-active' : ''} type="button" onClick={() => setSelectedPath(node.path)}>
      <strong>{node.title}</strong><small>{node.inbound} 入链 · {node.outbound} 出链{node.unlinkedMentions ? ` · ${node.unlinkedMentions} 提及` : ''}</small>
    </button>
  )

  return (
    <section className="plugin-workspace backlinks-workspace" aria-label="双向链接插件">
      <header className="plugin-hero">
        <div className="plugin-hero__identity"><span><Network size={23} /></span><div><small>PROJECT LINK INDEX</small><h1>双向链接</h1><p>基于本地增量索引分析 Markdown 链接，不运行常驻图谱引擎</p></div></div>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => void load()}><RefreshCw size={14} />重新分析</button>
      </header>

      <div className="backlink-metrics">
        <article><strong>{graph?.nodes.length ?? 0}</strong><small>Markdown 笔记</small></article>
        <article><strong>{graph?.edges.filter((edge) => edge.kind === 'link').length ?? 0}</strong><small>明确链接</small></article>
        <article><strong>{graph?.edges.filter((edge) => edge.kind === 'unlinked-mention').length ?? 0}</strong><small>未链接提及</small></article>
        <article><strong>{isolated}</strong><small>孤立笔记</small></article>
      </div>

      {error && <p className="plugin-inline-message is-error" role="alert">{error}</p>}
      {loading ? <div className="plugin-loading"><span className="viewer-spinner" />正在更新关系索引…</div> : !graph?.nodes.length ? (
        <div className="plugin-empty"><Unlink2 size={28} /><strong>项目里还没有 Markdown 笔记</strong><p>创建两份笔记并使用 [[双链]] 或 Markdown 链接后再来查看。</p></div>
      ) : (
        <div className="backlink-layout">
          <aside className="backlink-note-list">{graph.nodes.map(nodeRow)}</aside>
          <section className="backlink-detail">
            <header><div><small>SELECTED NOTE</small><h2>{selected?.title ?? '选择一份笔记'}</h2></div>{selected && <button className="text-button" type="button" onClick={() => props.onOpenMarkdown(selected.path)}>打开笔记 <ArrowRight size={13} /></button>}</header>
            <div className="backlink-columns">
              <section><h3><Link2 size={14} />反向链接 <span>{inbound.length}</span></h3>{inbound.length ? inbound.map((edge) => <button key={`${edge.sourcePath}-${edge.line}`} onClick={() => props.onOpenMarkdown(edge.sourcePath)}><strong>{name(edge.sourcePath)}</strong><p>{edge.excerpt}</p><small>{edge.line ? `第 ${edge.line} 行` : 'Markdown 链接'}</small></button>) : <p className="backlink-none">没有其他笔记链接到这里。</p>}</section>
              <section><h3><ArrowRight size={14} />出站链接 <span>{outbound.length}</span></h3>{outbound.length ? outbound.map((edge) => <button key={`${edge.targetPath}-${edge.line}`} onClick={() => props.onOpenMarkdown(edge.targetPath)}><strong>{name(edge.targetPath)}</strong><p>{edge.excerpt}</p></button>) : <p className="backlink-none">这份笔记还没有链接到其他笔记。</p>}</section>
              <section><h3><Unlink2 size={14} />未链接提及 <span>{mentions.length}</span></h3>{mentions.length ? mentions.map((edge) => <button key={`${edge.sourcePath}-${edge.line}`} onClick={() => props.onOpenMarkdown(edge.sourcePath)}><strong>{name(edge.sourcePath)}</strong><p>{edge.excerpt}</p><small>{edge.line ? `第 ${edge.line} 行` : '文本提及'}</small></button>) : <p className="backlink-none">没有发现可以补链的文字提及。</p>}</section>
            </div>
          </section>
        </div>
      )}
    </section>
  )
}
