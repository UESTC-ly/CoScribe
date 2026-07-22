import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { McpServerConfig } from '../../src/shared/types'
import { McpService, sanitizeMcpServerConfig, type McpConfigRepository } from './mcp'

class MemoryRepository implements McpConfigRepository {
  constructor(private configs: McpServerConfig[]) {}
  async list(): Promise<McpServerConfig[]> { return this.configs }
  async write(configs: McpServerConfig[]): Promise<void> { this.configs = configs }
}

describe('MCP client bridge', () => {
  it('validates stdio and HTTPS transport configuration without a shell', () => {
    expect(sanitizeMcpServerConfig({ name: 'Local', transport: 'stdio', command: 'node', args: ['server.mjs'] }, undefined, 10)).toMatchObject({ name: 'Local', command: 'node', args: ['server.mjs'] })
    expect(() => sanitizeMcpServerConfig({ name: 'Remote', transport: 'streamable-http', url: 'http://example.com/mcp' })).toThrow(/HTTPS/u)
    expect(sanitizeMcpServerConfig({ name: 'Loopback', transport: 'streamable-http', url: 'http://127.0.0.1:3000/mcp' })).toMatchObject({ url: 'http://127.0.0.1:3000/mcp' })
  })

  it('discovers and explicitly invokes a real stdio MCP server', async () => {
    const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/mcp-server.mjs')
    const config = sanitizeMcpServerConfig({ id: 'test', name: 'Fixture', transport: 'stdio', command: process.execPath, args: [fixture] }, undefined, 10)
    const service = new McpService(new MemoryRepository([config]))
    const catalog = await service.inspect('test')
    expect(catalog.serverName).toBe('coscribe-test-mcp')
    expect(catalog.tools.map((tool) => tool.name)).toContain('echo')
    expect(catalog.prompts.map((prompt) => prompt.name)).toContain('summarize')
    await expect(service.invoke({ serverId: 'test', kind: 'tool', name: 'echo', arguments: { message: 'hello' } })).resolves.toMatchObject({ content: 'echo:hello', structuredContent: { echoed: 'hello' }, isError: false })
  }, 20_000)
})
