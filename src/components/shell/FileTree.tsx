import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, File, FileImage, FileText, Folder, FolderOpen, MoreHorizontal } from 'lucide-react'
import type { FileNode } from '../../shared/types'

interface FileTreeProps {
  nodes: FileNode[]
  activePath?: string
  onOpen: (node: FileNode) => void
  onRename: (node: FileNode) => void
  onMove: (node: FileNode) => void
  onTrash: (node: FileNode) => void
  onReveal: (node: FileNode) => void
  onImport: (files: File[], targetFolder: string) => void
  onMovePath: (sourcePath: string, targetFolder: string) => void
}

function FileIcon({ node, expanded }: { node: FileNode; expanded: boolean }): React.JSX.Element {
  if (node.kind === 'folder') return expanded ? <FolderOpen size={15} /> : <Folder size={15} />
  if (node.kind === 'image') return <FileImage size={15} />
  if (node.kind === 'markdown' || node.kind === 'text') return <FileText size={15} />
  return <File size={15} />
}

interface TreeItemProps extends Omit<FileTreeProps, 'nodes'> {
  node: FileNode
  depth: number
  expanded: Set<string>
  toggle: (path: string) => void
  onContext: (event: React.MouseEvent, node: FileNode) => void
}

function TreeItem({ node, depth, expanded, toggle, onContext, ...props }: TreeItemProps): React.JSX.Element {
  const isFolder = node.kind === 'folder'
  const isExpanded = expanded.has(node.path)
  const open = (): void => isFolder ? toggle(node.path) : props.onOpen(node)
  return (
    <li role="treeitem" aria-expanded={isFolder ? isExpanded : undefined}>
      <div
        className={`tree-row ${props.activePath === node.path ? 'is-active' : ''}`}
        style={{ paddingLeft: 7 + depth * 14 }}
        onClick={open}
        onDoubleClick={() => !isFolder && props.onOpen(node)}
        onContextMenu={(event) => onContext(event, node)}
        draggable
        onDragStart={(event) => { event.dataTransfer.setData('application/x-vibe-path', node.path); event.dataTransfer.effectAllowed = 'move' }}
        onDragOver={(event) => { if (isFolder) event.preventDefault() }}
        onDrop={(event) => {
          if (!isFolder) return
          event.preventDefault()
          const path = event.dataTransfer.getData('application/x-vibe-path')
          if (path) props.onMovePath(path, node.path)
          else if (event.dataTransfer.files.length) props.onImport([...event.dataTransfer.files], node.path)
        }}
      >
        <span className="tree-row__chevron">{isFolder && <ChevronRight size={13} className={isExpanded ? 'is-open' : ''} />}</span>
        <span className={`tree-row__icon kind-${node.kind}`}><FileIcon node={node} expanded={isExpanded} /></span>
        <span className="tree-row__name" title={node.path}>{node.name}</span>
        <button className="tree-row__more" onClick={(event) => { event.stopPropagation(); onContext(event, node) }} aria-label={`${node.name} 的更多操作`}><MoreHorizontal size={14} /></button>
      </div>
      {isFolder && isExpanded && node.children && (
        <ul role="group">
          {node.children.map((child) => <TreeItem key={child.path} {...props} node={child} depth={depth + 1} expanded={expanded} toggle={toggle} onContext={onContext} />)}
        </ul>
      )}
    </li>
  )
}

export function FileTree({ nodes, ...props }: FileTreeProps): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ x: number; y: number; node: FileNode } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const initialFolders = useMemo(() => nodes.filter((node) => node.kind === 'folder').slice(0, 4).map((node) => node.path), [nodes])

  useEffect(() => setExpanded((current) => current.size ? current : new Set(initialFolders)), [initialFolders])
  useEffect(() => {
    if (!menu) return
    const dismiss = (): void => setMenu(null)
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('blur', dismiss)
    return () => { window.removeEventListener('mousedown', dismiss); window.removeEventListener('blur', dismiss) }
  }, [menu])

  const toggle = (path: string): void => setExpanded((current) => {
    const next = new Set(current)
    if (next.has(path)) next.delete(path); else next.add(path)
    return next
  })

  return (
    <div className="file-tree-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      if (event.target !== event.currentTarget || !event.dataTransfer.files.length) return
      event.preventDefault(); props.onImport([...event.dataTransfer.files], '.')
    }}>
      <ul className="file-tree" role="tree" aria-label="项目文件">
        {nodes.map((node) => <TreeItem key={node.path} {...props} node={node} depth={0} expanded={expanded} toggle={toggle} onContext={(event, item) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, node: item }) }} />)}
      </ul>
      {menu && (
        <div ref={menuRef} className="context-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(event) => event.stopPropagation()} role="menu">
          {menu.node.kind !== 'folder' && <button role="menuitem" onClick={() => { props.onOpen(menu.node); setMenu(null) }}>打开</button>}
          <button role="menuitem" onClick={() => { props.onRename(menu.node); setMenu(null) }}>重命名</button>
          <button role="menuitem" onClick={() => { props.onMove(menu.node); setMenu(null) }}>移动到…</button>
          <button role="menuitem" onClick={() => { props.onReveal(menu.node); setMenu(null) }}>在文件管理器中显示</button>
          <span className="context-menu__separator" />
          <button className="is-danger" role="menuitem" onClick={() => { props.onTrash(menu.node); setMenu(null) }}>移到废纸篓</button>
        </div>
      )}
    </div>
  )
}
