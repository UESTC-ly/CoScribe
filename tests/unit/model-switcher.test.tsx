import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
        profiles={[
          { id: 'openai', name: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-terra', enabledModels: ['gpt-5.6-terra'], apiProtocol: 'auto', hasApiKey: true },
          { id: 'anthropic', name: 'Anthropic', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-6', enabledModels: ['claude-sonnet-4-6'], apiProtocol: 'auto', hasApiKey: true }
        ]}
        activeProfileId="openai"
        reasoningEffort="ultra"
        isConfigured
        onChange={onChange}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /切换 AI 模型和思考强度/u }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Anthropic claude-sonnet-4-6/u }))

    await waitFor(() => expect(onChange).toHaveBeenCalledWith({
      activeAiProfileId: 'anthropic',
      aiProvider: 'anthropic',
      reasoningEffort: 'max'
    }))
  })

  it('shows only Anthropic-supported effort choices for an active Anthropic profile', () => {
    render(
      <ModelSwitcher
        provider="anthropic"
        openAiModel="gpt-5.6-terra"
        anthropicModel="claude-sonnet-4-6"
        profiles={[
          { id: 'anthropic', name: 'Anthropic', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-6', enabledModels: ['claude-sonnet-4-6'], apiProtocol: 'auto', hasApiKey: true }
        ]}
        activeProfileId="anthropic"
        reasoningEffort="max"
        isConfigured
        onChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /切换 AI 模型和思考强度/u }))
    expect(screen.queryByRole('menuitemradio', { name: /Ultra/u })).not.toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /More reasoning/u })).toBeInTheDocument()
  })

  it('shows only the third-party provider enabled models, never hardcoded GPT presets', () => {
    render(
      <ModelSwitcher
        provider="openai"
        openAiModel="deepseek-v3.2"
        anthropicModel="claude-sonnet-4-6"
        profiles={[
          {
            id: 'deepseek',
            name: 'DeepSeek',
            provider: 'openai',
            baseUrl: 'https://api.deepseek.com/v1',
            model: 'deepseek-v3.2',
            enabledModels: ['deepseek-v3.2', 'deepseek-reasoner'],
            apiProtocol: 'auto',
            hasApiKey: true
          }
        ]}
        activeProfileId="deepseek"
        reasoningEffort="medium"
        isConfigured
        onChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /切换 AI 模型和思考强度/u }))
    const group = screen.getByRole('group', { name: '当前配置模型' })
    expect(within(group).getByRole('menuitemradio', { name: /deepseek-v3.2/u })).toBeInTheDocument()
    expect(within(group).getByRole('menuitemradio', { name: /deepseek-reasoner/u })).toBeInTheDocument()
    expect(within(group).queryByRole('menuitemradio', { name: /gpt-5.6/u })).not.toBeInTheDocument()
  })
})
