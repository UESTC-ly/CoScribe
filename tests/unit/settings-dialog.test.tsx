import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SettingsDialog } from '../../src/components/shell/SettingsDialog'
import { DEFAULT_SETTINGS } from '../../src/shared/types'

describe('SettingsDialog', () => {
  it('separates general preferences from AI configuration', () => {
    render(<SettingsDialog open settings={DEFAULT_SETTINGS} onSave={vi.fn()} onClose={vi.fn()} />)

    expect(screen.getByRole('button', { name: /通用设置/u })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByLabelText('主题')).toBeVisible()
    expect(screen.queryByLabelText('服务地址')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /AI 服务商/u }))
    expect(screen.getByLabelText('服务地址')).toBeVisible()
    expect(screen.queryByLabelText('主题')).not.toBeInTheDocument()
  })

  it('adds and saves an independent provider profile', async () => {
    const onSave = vi.fn()
    render(<SettingsDialog open settings={DEFAULT_SETTINGS} onSave={onSave} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /AI 服务商/u }))
    fireEvent.click(screen.getByRole('button', { name: '添加' }))

    const tabs = screen.getByRole('tablist', { name: 'AI 服务商列表' })
    expect(within(tabs).getAllByRole('tab')).toHaveLength(3)
    fireEvent.change(screen.getByLabelText('服务商名称'), { target: { value: '校内代理' } })
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'https://ai.example.edu/v1' } })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-campus' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    expect(onSave).toHaveBeenCalledOnce()
    const saved = onSave.mock.calls[0]?.[0]
    expect(saved.aiProfiles).toHaveLength(3)
    expect(saved.aiProfiles.find((profile: { name: string }) => profile.name === '校内代理')).toMatchObject({
      baseUrl: 'https://ai.example.edu/v1',
      apiKey: 'sk-campus'
    })
  })

  it('fetches compatible models and enables a curated set without leaking GPT presets', async () => {
    const formValue = 'fixture-compatible-key'
    const listModels = vi.fn().mockResolvedValue({ models: ['qwen3-coder-plus', 'deepseek-v3.2'] })
    Object.defineProperty(window, 'coscribe', {
      configurable: true,
      value: { ai: { listModels } }
    })
    const onSave = vi.fn()
    render(<SettingsDialog open settings={DEFAULT_SETTINGS} onSave={onSave} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /AI 服务商/u }))
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'https://proxy.example.com/v1' } })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: formValue } })
    fireEvent.click(screen.getByRole('button', { name: '获取可用模型' }))

    // Moving the default OpenAI profile onto a third-party host strips the GPT
    // presets from the enabled set; only the fetched catalogue is offered.
    const qwenToggle = await screen.findByRole('checkbox', { name: '在模型菜单中显示 qwen3-coder-plus' })
    expect(screen.queryByRole('checkbox', { name: '在模型菜单中显示 gpt-5.6-luna' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: '在模型菜单中显示 gpt-5.6-terra' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: '在模型菜单中显示 gpt-5.6-sol' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('模型')).toHaveValue('qwen3-coder-plus')
    expect(listModels).toHaveBeenCalledWith({
      profileId: 'openai-default',
      provider: 'openai',
      baseUrl: 'https://proxy.example.com/v1',
      apiKey: formValue,
      useStoredApiKey: false
    })

    fireEvent.click(qwenToggle)
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'deepseek-v3.2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    const saved = onSave.mock.calls[0]?.[0]
    const profile = saved.aiProfiles.find((entry: { id: string }) => entry.id === 'openai-default')
    expect(profile.model).toBe('deepseek-v3.2')
    expect(profile.enabledModels).toEqual(expect.arrayContaining(['qwen3-coder-plus', 'deepseek-v3.2']))
    expect(profile.enabledModels).not.toContain('gpt-5.6-luna')
    expect(profile.enabledModels).not.toContain('gpt-5.6-terra')
    expect(profile.enabledModels).not.toContain('gpt-5.6-sol')
  })
})
