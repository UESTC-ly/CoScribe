import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'coscribe-research-test-mcp', version: '1.0.0' })
server.registerTool('search_repositories', {
  description: 'Read-only public repository search fixture',
  annotations: { readOnlyHint: true },
  inputSchema: { query: z.string(), perPage: z.number().min(1).max(10), minimal_output: z.boolean() }
}, async () => {
  const result = { total_count: 1, items: [{ full_name: 'fixture/graph-research', html_url: 'https://github.com/fixture/graph-research', description: 'Grounded repository metadata', language: 'Python' }] }
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
})
await server.connect(new StdioServerTransport())
