import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BrowserWorkspace } from '../../src/components/browser/BrowserWorkspace'
import type { ResearchBrowserState } from '../../src/shared/types'

const state: ResearchBrowserState = {
  url: 'https://example.com/article',
  title: 'Example Article',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  secure: true,
  activeTabId: 'tab-1',
  tabs: [{
    id: 'tab-1',
    url: 'https://example.com/article',
    title: 'Example Article',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    secure: true
  }],
  maxTabs: 10
}

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('BrowserWorkspace history', () => {
  it('lists persisted visits, reopens one, and clears the list through typed browser APIs', async () => {
    const history = vi.fn().mockResolvedValue([{
      url: 'https://example.com/article',
      title: 'Example Article',
      visitedAt: 1_000
    }])
    const clearHistory = vi.fn().mockResolvedValue([])
    const navigate = vi.fn().mockResolvedValue(state)
    Object.defineProperty(window, 'coscribe', {
      configurable: true,
      value: {
        browser: {
          open: vi.fn().mockResolvedValue(state),
          newTab: vi.fn(),
          activateTab: vi.fn(),
          closeTab: vi.fn(),
          navigate,
          back: vi.fn(),
          forward: vi.fn(),
          reload: vi.fn(),
          stop: vi.fn(),
          setBounds: vi.fn().mockResolvedValue(undefined),
          setVisible: vi.fn().mockResolvedValue(undefined),
          extract: vi.fn(),
          saveArchive: vi.fn(),
          saveMarkdown: vi.fn(),
          savePdf: vi.fn(),
          openExternal: vi.fn(),
          close: vi.fn().mockResolvedValue(undefined),
          history,
          clearHistory,
          onState: vi.fn().mockReturnValue(() => undefined),
          onSelection: vi.fn().mockReturnValue(() => undefined)
        }
      }
    })

    render(<BrowserWorkspace
      onClose={vi.fn()}
      onSendToAi={vi.fn()}
      onCiteSource={vi.fn()}
      onSaved={vi.fn()}
      onError={vi.fn()}
    />)

    fireEvent.click(screen.getByRole('button', { name: '浏览历史记录' }))
    expect(await screen.findByRole('dialog', { name: '浏览历史记录' })).toHaveTextContent('Example Article')
    expect(history).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: /重新打开：Example Article/u }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://example.com/article'))

    fireEvent.click(screen.getByRole('button', { name: '浏览历史记录' }))
    fireEvent.click(await screen.findByRole('button', { name: '清空历史记录' }))
    await waitFor(() => expect(clearHistory).toHaveBeenCalledOnce())
    expect(screen.getByText('暂无浏览历史')).toBeVisible()
  })
})
