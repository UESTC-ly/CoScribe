import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HomeScreen } from '../../src/components/shell/HomeScreen'

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('HomeScreen project creation', () => {
  it('keeps the project-name input focused while typing multiple characters', () => {
    render(
      <HomeScreen
        recentProjects={[]}
        defaultParentPath="/projects"
        onCreate={vi.fn()}
        onChooseLocation={vi.fn(async () => null)}
        onOpenFolder={vi.fn()}
        onOpenRecent={vi.fn()}
        onOpenGuide={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    )

    expect(screen.getByRole('heading', { name: 'CoScribe' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: '新建项目' }))
    const input = screen.getByRole('textbox', { name: '项目名称' })
    expect(input).toHaveFocus()

    let value = ''
    for (const character of 'FastAPI学习') {
      value += character
      fireEvent.change(input, { target: { value } })
      expect(input).toHaveFocus()
    }
    expect(input).toHaveValue('FastAPI学习')
  })

  it('redirects existing material folders to the open-folder flow', () => {
    const onOpenFolder = vi.fn()
    render(
      <HomeScreen
        recentProjects={[]}
        defaultParentPath="/projects"
        onCreate={vi.fn()}
        onChooseLocation={vi.fn(async () => null)}
        onOpenFolder={onOpenFolder}
        onOpenRecent={vi.fn()}
        onOpenGuide={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '新建项目' }))
    expect(screen.getByText(/已有 Markdown 或子文件夹/)).toBeVisible()
    const openButtons = screen.getAllByRole('button', { name: '打开已有文件夹' })
    fireEvent.click(openButtons[openButtons.length - 1])
    expect(onOpenFolder).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog', { name: '新建项目' })).not.toBeInTheDocument()
  })

  it('offers the built-in guide before a project is opened', () => {
    const onOpenGuide = vi.fn()
    render(
      <HomeScreen
        recentProjects={[]}
        onCreate={vi.fn()}
        onChooseLocation={vi.fn(async () => null)}
        onOpenFolder={vi.fn()}
        onOpenRecent={vi.fn()}
        onOpenGuide={onOpenGuide}
        onOpenSettings={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '使用指南' }))
    expect(onOpenGuide).toHaveBeenCalledOnce()
  })
})
