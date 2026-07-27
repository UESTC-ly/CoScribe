// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileTree } from '../../src/components/shell/FileTree'
import type { FileNode } from '../../src/shared/types'

afterEach(cleanup)

const nodes: FileNode[] = [
  {
    name: '资料',
    path: '/projects/demo/资料',
    kind: 'folder',
    size: 0,
    modifiedAt: 1,
    children: []
  },
  {
    name: '笔记.md',
    path: '/projects/demo/笔记.md',
    kind: 'markdown',
    size: 12,
    modifiedAt: 1
  }
]

describe('FileTree drag data', () => {
  it.each(nodes)('allows %s to be moved in the tree or copied into the AI composer', (node) => {
    const dataTransfer = {
      effectAllowed: 'none',
      setData: vi.fn()
    } as unknown as DataTransfer
    render(
      <FileTree
        nodes={[node]}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onMove={vi.fn()}
        onTrash={vi.fn()}
        onReveal={vi.fn()}
        onImport={vi.fn()}
        onMovePath={vi.fn()}
      />
    )

    const row = screen.getByLabelText(node.path).closest('.tree-row')
    expect(row).not.toBeNull()
    fireEvent.dragStart(row!, { dataTransfer })

    expect(dataTransfer.setData).toHaveBeenCalledWith('application/x-vibe-path', node.path)
    expect(dataTransfer.effectAllowed).toBe('copyMove')
  })

  it('selects on one click and opens on double click in IDE mode', () => {
    const code: FileNode = {
      name: 'main.py',
      path: '/projects/demo/main.py',
      kind: 'code',
      size: 24,
      modifiedAt: 1
    }
    const onSelect = vi.fn()
    const onOpen = vi.fn()
    render(
      <FileTree
        nodes={[code]}
        openOnSingleClick={false}
        selectedPath={code.path}
        onSelect={onSelect}
        onOpen={onOpen}
        onRename={vi.fn()}
        onMove={vi.fn()}
        onTrash={vi.fn()}
        onReveal={vi.fn()}
        onImport={vi.fn()}
        onMovePath={vi.fn()}
      />
    )
    const row = screen.getByLabelText(code.path).closest('.tree-row')
    expect(row).toHaveClass('is-active')

    fireEvent.click(row!)
    expect(onSelect).toHaveBeenCalledWith(code)
    expect(onOpen).not.toHaveBeenCalled()

    fireEvent.doubleClick(row!)
    expect(onOpen).toHaveBeenCalledWith(code)
  })
})
