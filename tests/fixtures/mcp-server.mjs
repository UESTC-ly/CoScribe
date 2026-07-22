import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'coscribe-test-mcp', version: '1.0.0' })
server.registerTool('echo', {
  description: 'Echo a bounded message',
  inputSchema: { message: z.string().max(1000) }
}, async ({ message }) => ({ content: [{ type: 'text', text: `echo:${message}` }], structuredContent: { echoed: message } }))
server.registerResource('example', new ResourceTemplate('test://example/{name}', { list: undefined }), {
  description: 'Test resource'
}, async (uri) => ({ contents: [{ uri: uri.href, text: `resource:${uri.pathname}` }] }))
server.registerPrompt('summarize', {
  description: 'Test prompt',
  argsSchema: { topic: z.string() }
}, ({ topic }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `summarize:${topic}` } }] }))
await server.connect(new StdioServerTransport())
