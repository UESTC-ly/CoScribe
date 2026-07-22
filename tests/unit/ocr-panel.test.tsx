import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { OcrPanel } from '../../src/components/viewers/OcrPanel'

describe('OCR panel cancellation affordance', () => {
  it('only offers cancellation for the AI request that can be stopped', () => {
    const props = {
      result: null,
      error: null,
      onLocal: vi.fn(),
      onAi: vi.fn(),
      onCancel: vi.fn(),
      onClose: vi.fn()
    }
    const view = render(<OcrPanel {...props} status="local" />)
    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument()

    view.rerender(<OcrPanel {...props} status="ai" />)
    expect(screen.getByRole('button', { name: '取消' })).toBeVisible()
  })
})
