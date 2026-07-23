import { describe, expect, it } from 'vitest'

import { chatCommandSuggestions, parseChatCommand } from '../../src/lib/chat-commands'

describe('chat commands', () => {
  it('parses known commands and keeps optional arguments', () => {
    expect(parseChatCommand('/compact')).toEqual({
      kind: 'command',
      invocation: { name: 'compact', argument: '', raw: '/compact' }
    })
    expect(parseChatCommand('  /resume  LangGraph 学习  ')).toEqual({
      kind: 'command',
      invocation: { name: 'resume', argument: 'LangGraph 学习', raw: '/resume  LangGraph 学习' }
    })
  })

  it('does not treat ordinary prompts as commands and reports unknown slash commands', () => {
    expect(parseChatCommand('解释 /compact 的含义')).toBeNull()
    expect(parseChatCommand('/missing')).toEqual({ kind: 'unknown', command: '/missing' })
  })

  it('filters the command menu from the current slash prefix', () => {
    expect(chatCommandSuggestions('/co').map((item) => item.command)).toEqual(['/compact'])
    expect(chatCommandSuggestions('/').length).toBeGreaterThan(8)
    expect(chatCommandSuggestions('normal text')).toEqual([])
  })
})
