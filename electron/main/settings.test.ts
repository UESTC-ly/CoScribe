import { describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS } from '../../src/shared/types'
import { MAX_AI_PROFILES, MAX_CUSTOM_SYSTEM_PROMPT_CHARS, sanitizeSettings } from './settings'

describe('v2 settings boundaries', () => {
  it('keeps a bounded custom system prompt and only trusted plugin IDs', () => {
    const settings = sanitizeSettings({
      ...DEFAULT_SETTINGS,
      customSystemPrompt: `  ${'x'.repeat(MAX_CUSTOM_SYSTEM_PROMPT_CHARS + 20)}  `,
      enabledPlugins: ['planner', 'backlinks', 'remote-unsigned', 'planner'],
      pluginGrants: {
        planner: ['project:read', 'calendar:write', 'diagnostics:read'],
        backlinks: ['project:read', 'project:write'],
        'remote-unsigned': ['project:read']
      }
    })

    expect(settings.customSystemPrompt).toHaveLength(MAX_CUSTOM_SYSTEM_PROMPT_CHARS)
    expect(settings.enabledPlugins).toEqual(['planner', 'backlinks'])
    expect(settings.pluginGrants).toEqual({
      planner: ['project:read', 'calendar:write'],
      backlinks: ['project:read']
    })
  })

  it('restores memory and plugin defaults for older settings files', () => {
    const settings = sanitizeSettings({ baseUrl: DEFAULT_SETTINGS.baseUrl, imageBaseUrl: DEFAULT_SETTINGS.imageBaseUrl })
    expect(settings.projectMemoryEnabled).toBe(true)
    expect(settings.enabledPlugins).toEqual(['planner'])
    expect(settings.pluginGrants).toEqual(DEFAULT_SETTINGS.pluginGrants)
    expect(settings.aiProvider).toBe('openai')
    expect(settings.anthropicBaseUrl).toBe('https://api.anthropic.com')
    expect(settings.activeAiProfileId).toBe('openai-default')
    expect(settings.aiProfiles.map((profile) => profile.id)).toEqual(['openai-default', 'anthropic-default'])
    expect(settings.contextAutoCompact).toBe(true)
  })

  it('sanitizes Anthropic and context-window preferences', () => {
    const settings = sanitizeSettings({
      ...DEFAULT_SETTINGS,
      aiProfiles: undefined,
      activeAiProfileId: undefined,
      aiProvider: 'anthropic',
      anthropicBaseUrl: 'https://proxy.example.com/anthropic/v1/',
      anthropicModel: `  claude-custom-${'x'.repeat(240)} `,
      contextWindowTokens: 4_000,
      contextOutputReserveTokens: 999_999,
      contextAutoCompact: false
    })

    expect(settings.aiProvider).toBe('anthropic')
    expect(settings.anthropicBaseUrl).toBe('https://proxy.example.com/anthropic/v1')
    expect(settings.anthropicModel.length).toBe(200)
    expect(settings.contextWindowTokens).toBe(8_192)
    expect(settings.contextOutputReserveTokens).toBe(128_000)
    expect(settings.contextAutoCompact).toBe(false)
  })

  it('sanitizes multiple named provider profiles and derives the active legacy fields', () => {
    const settings = sanitizeSettings({
      ...DEFAULT_SETTINGS,
      activeAiProfileId: 'team-proxy',
      aiProfiles: [
        {
          id: 'team-proxy',
          name: '  Team Proxy  ',
          provider: 'openai',
          baseUrl: 'https://proxy.example.com/v1/',
          model: '  gpt-team  ',
          apiProtocol: 'chat-completions',
          hasApiKey: true,
          apiKey: ['must', 'not', 'be', 'persisted'].join('-')
        },
        {
          id: 'claude-work',
          name: 'Claude Work',
          provider: 'anthropic',
          baseUrl: 'https://anthropic.example.com/v1/',
          model: ' claude-custom ',
          apiProtocol: 'responses',
          hasApiKey: false
        },
        {
          id: 'team-proxy',
          name: 'Duplicate',
          provider: 'openai',
          baseUrl: 'https://duplicate.example.com',
          model: 'duplicate',
          apiProtocol: 'auto',
          hasApiKey: false
        }
      ]
    })

    expect(settings.aiProfiles).toHaveLength(2)
    expect(settings.aiProfiles[0]).toMatchObject({
      id: 'team-proxy',
      name: 'Team Proxy',
      baseUrl: 'https://proxy.example.com/v1',
      model: 'gpt-team',
      apiProtocol: 'chat-completions'
    })
    expect(settings.aiProfiles[0]).not.toHaveProperty('apiKey')
    expect(settings.baseUrl).toBe('https://proxy.example.com/v1')
    expect(settings.model).toBe('gpt-team')
    expect(settings.apiProtocol).toBe('chat-completions')
    expect(settings.anthropicBaseUrl).toBe('https://anthropic.example.com/v1')
    expect(settings.anthropicModel).toBe('claude-custom')
  })

  it('bounds the number of saved AI profiles', () => {
    const settings = sanitizeSettings({
      ...DEFAULT_SETTINGS,
      aiProfiles: Array.from({ length: MAX_AI_PROFILES + 4 }, (_, index) => ({
        id: `profile-${index}`,
        name: `Profile ${index}`,
        provider: 'openai' as const,
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-example',
        apiProtocol: 'auto' as const,
        hasApiKey: false
      }))
    })

    expect(settings.aiProfiles).toHaveLength(MAX_AI_PROFILES)
  })
})
