import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProjectNavigator } from '../../src/components/shell/ProjectNavigator'

afterEach(cleanup)

function buildProps(
  overrides: Partial<ComponentProps<typeof ProjectNavigator>> = {}
): ComponentProps<typeof ProjectNavigator> {
  return {
    section: 'files',
    projectName: '测试项目',
    projectPath: '/projects/test',
    tree: [],
    sessions: [],
    currentSessionId: null,
    annotations: [],
    searchQuery: '',
    searchResults: [],
    onCloseProject: vi.fn(),
    onRefresh: vi.fn(),
    onCreateMarkdown: vi.fn(),
    onCreateCodeFile: vi.fn(),
    onCreateFolder: vi.fn(),
    onOpenNode: vi.fn(),
    onSelectNode: vi.fn(),
    onRenameNode: vi.fn(),
    onMoveNode: vi.fn(),
    onTrashNode: vi.fn(),
    onRevealNode: vi.fn(),
    onImportFiles: vi.fn(),
    onMovePath: vi.fn(),
    onNewSession: vi.fn(),
    onSelectSession: vi.fn(),
    onRenameSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onSearch: vi.fn(),
    onOpenSearchResult: vi.fn(),
    onOpenAnnotation: vi.fn(),
    onDeleteAnnotation: vi.fn(),
    onOpenMemory: vi.fn(),
    onMemorySaved: vi.fn(),
    onSendMemoryToAi: vi.fn(),
    operationHistory: [],
    undoingOperationId: null,
    onUndoOperation: vi.fn(),
    enabledPluginIds: [],
    pluginGrants: {},
    activePluginId: null,
    onOpenPlugin: vi.fn(),
    onTogglePlugin: vi.fn(),
    onClose: vi.fn(),
    refreshingTree: false,
    ...overrides
  }
}

describe('ProjectNavigator file tree refresh', () => {
  it.each(['files', 'ide'] as const)('shows the same busy feedback in the %s view', (section) => {
    render(<ProjectNavigator {...buildProps({ section, refreshingTree: true })} />)

    const refresh = screen.getByRole('button', { name: '刷新文件树' })
    expect(refresh).toBeDisabled()
    expect(refresh).toHaveAttribute('aria-busy', 'true')
    expect(refresh.querySelector('svg')).toHaveClass('is-spinning')
  })

  it('runs one refresh action when the ready button is clicked', () => {
    const onRefresh = vi.fn()
    render(<ProjectNavigator {...buildProps({ onRefresh })} />)

    fireEvent.click(screen.getByRole('button', { name: '刷新文件树' }))

    expect(onRefresh).toHaveBeenCalledOnce()
  })
})
