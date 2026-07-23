import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ModelSwitcher } from '../../src/components/shell/ModelSwitcher'

describe('ModelSwitcher provider-aware selection', () => {
  it('switches from OpenAI to an Anthropic model and normalizes unsupported ultra effort', async () => {
    const onChange = vi.fn()
    render(
      <ModelSwitcher
        provider="openai"
        openAiModel="gpt-5.6-terra"
        anthropicModel="claude-sonnet-4-6"
        reasoningEffort="ultra"
        isConfigured
        onChange={onChange}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /切换 AI 模型和思考强度/u }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'claude-opus-4-8' }))

    await waitFor(() => expect(onChange).toHaveBeenCalledWith({
      aiProvider: 'anthropic',
      anthropicModel: 'claude-opus-4-8',
      reasoningEffort: 'max'
    }))
  })

  it('shows only Anthropic-supported effort choices for an active Anthropic profile', () => {
    render(
      <ModelSwitcher
        provider="anthropic"
        openAiModel="gpt-5.6-terra"
        anthropicModel="claude-sonnet-4-6"
        reasoningEffort="max"
        isConfigured
        onChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /切换 AI 模型和思考强度/u }))
    expect(screen.queryByRole('menuitemradio', { name: /Ultra/u })).not.toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /More reasoning/u })).toBeInTheDocument()
  })
})
