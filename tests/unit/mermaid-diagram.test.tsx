// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (id: string) => ({
    svg: `<svg id="${id}" data-render-id="${id}"></svg>`,
  })),
}))

vi.mock('mermaid', () => ({ default: mermaidMock }))

import { MermaidDiagram } from '../../src/components/viewers/MermaidDiagram'

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
})

describe('MermaidDiagram rendering', () => {
  it('deduplicates identical renders, reuses initialization, and caches separately by theme', async () => {
    const code = 'graph TD\n  A --> B'
    const { container } = render(
      <>
        <MermaidDiagram code={code} />
        <MermaidDiagram code={code} />
      </>,
    )

    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(1), { timeout: 2000 })
    await waitFor(() => expect(container.querySelectorAll('.vk-mermaid-svg svg')).toHaveLength(2), { timeout: 2000 })
    expect(mermaidMock.render).toHaveBeenCalledTimes(1)
    expect(mermaidMock.initialize).toHaveBeenCalledTimes(1)
    expect(mermaidMock.initialize).toHaveBeenLastCalledWith(expect.objectContaining({
      securityLevel: 'strict',
      theme: 'default',
    }))

    document.documentElement.dataset.theme = 'dark'
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(2), { timeout: 2000 })
    expect(mermaidMock.initialize).toHaveBeenCalledTimes(2)
    expect(mermaidMock.initialize).toHaveBeenLastCalledWith(expect.objectContaining({
      securityLevel: 'strict',
      theme: 'dark',
    }))
  })
})
