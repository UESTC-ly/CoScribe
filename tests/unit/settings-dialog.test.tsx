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
})
