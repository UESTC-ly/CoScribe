import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import { app, safeStorage } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import type {
  McpInvocationRequest,
  McpInvocationResult,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpServerCatalog,
  McpServerConfig,
  McpToolDescriptor
} from '../../src/shared/types'
import { atomicWriteJson, readJson } from './storage'

const MAX_CONFIGS = 30
const MAX_ARGUMENT_BYTES = 128 * 1024
const MAX_RESULT_CHARS = 200_000
const REQUEST_TIMEOUT_MS = 60_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clean(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : ''
}

function safeStringRecord(value: unknown, kind: 'env' | 'headers'): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).flatMap(([key, raw]): Array<[string, string]> => {
    const name = key.trim()
    const item = typeof raw === 'string' ? raw : ''
    const validName = kind === 'env' ? /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) : /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u.test(name)
    if (!validName || item.length > 20_000 || /[\u0000\r\n]/u.test(item)) return []
    return [[name, item]]
  }).slice(0, 100)
  return entries.length ? Object.fromEntries(entries) : undefined
}

function safeRemoteUrl(value: unknown): string {
  const candidate = clean(value, 8_000)
  let parsed: URL
  try { parsed = new URL(candidate) }
  catch { throw new Error('MCP 服务地址不是有效 URL。') }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '::1' || parsed.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('远程 MCP 只允许 HTTPS；HTTP 仅允许本机回环地址。')
  }
  if (parsed.username || parsed.password) throw new Error('MCP URL 不能内嵌账号或密码。')
  parsed.hash = ''
  return parsed.toString()
}

export function sanitizeMcpServerConfig(value: Partial<McpServerConfig>, previous?: McpServerConfig, now = Date.now()): McpServerConfig {
  const transport = value.transport === 'streamable-http' ? 'streamable-http' : value.transport === 'stdio' ? 'stdio' : previous?.transport
  if (!transport) throw new Error('请选择 MCP 传输方式。')
  const name = clean(value.name ?? previous?.name, 120)
  if (!name) throw new Error('MCP 服务名称不能为空。')
  const id = clean(value.id ?? previous?.id, 200) || `mcp-${randomUUID()}`
  if (!/^[A-Za-z0-9_.:-]{1,200}$/u.test(id)) throw new Error('MCP 服务 ID 无效。')
  const base = {
    id,
    name,
    transport,
    createdAt: previous?.createdAt ?? (typeof value.createdAt === 'number' ? value.createdAt : now),
    updatedAt: now
  } satisfies Pick<McpServerConfig, 'id' | 'name' | 'transport' | 'createdAt' | 'updatedAt'>
  if (transport === 'stdio') {
    const command = clean(value.command ?? previous?.command, 2_000)
    if (!command || /[\u0000\r\n]/u.test(command)) throw new Error('stdio MCP 需要有效启动命令。')
    const args = Array.isArray(value.args ?? previous?.args)
      ? (value.args ?? previous?.args ?? []).flatMap((arg): string[] => typeof arg === 'string' && arg.length <= 4_000 && !/[\u0000\r\n]/u.test(arg) ? [arg] : []).slice(0, 100)
      : []
    const cwd = clean(value.cwd ?? previous?.cwd, 8_000)
    return {
      ...base,
      command,
      args,
      ...(cwd ? { cwd } : {}),
      ...(safeStringRecord(value.env ?? previous?.env, 'env') ? { env: safeStringRecord(value.env ?? previous?.env, 'env') } : {})
    }
  }
  return {
    ...base,
    url: safeRemoteUrl(value.url ?? previous?.url),
    ...(safeStringRecord(value.headers ?? previous?.headers, 'headers') ? { headers: safeStringRecord(value.headers ?? previous?.headers, 'headers') } : {})
  }
}

export interface McpConfigRepository {
  list(): Promise<McpServerConfig[]>
  write(configs: McpServerConfig[]): Promise<void>
}

interface StoredMcpConfigs {
  version: 1
  encrypted: string
}

class EncryptedMcpConfigRepository implements McpConfigRepository {
  private get filePath(): string { return path.join(app.getPath('userData'), 'mcp-servers.json') }

  async list(): Promise<McpServerConfig[]> {
    const stored = await readJson<StoredMcpConfigs | null>(this.filePath, null)
    if (!stored) return []
    if (stored.version !== 1 || typeof stored.encrypted !== 'string') return []
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法读取 MCP 配置。')
    let value: unknown
    try { value = JSON.parse(safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64'))) }
    catch { throw new Error('MCP 配置无法解密，请重新配置。') }
    if (!Array.isArray(value)) return []
    const configs: McpServerConfig[] = []
    for (const raw of value.slice(0, MAX_CONFIGS)) {
      try { configs.push(sanitizeMcpServerConfig(raw as Partial<McpServerConfig>, undefined, (raw as McpServerConfig).updatedAt)) }
      catch { /* Ignore invalid encrypted entries without exposing their raw values. */ }
    }
    return configs
  }

  async write(configs: McpServerConfig[]): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，MCP 配置未保存。')
    const payload = JSON.stringify(configs.slice(0, MAX_CONFIGS))
    if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error('MCP 配置总量超过 1 MB 上限。')
    await atomicWriteJson(this.filePath, { version: 1, encrypted: safeStorage.encryptString(payload).toString('base64') })
  }
}

function boundedJson(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value)
    return Buffer.byteLength(serialized) <= MAX_RESULT_CHARS ? JSON.parse(serialized) : undefined
  } catch {
    return undefined
  }
}

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.flatMap((item): string[] => {
    if (!isRecord(item)) return []
    if (item.type === 'text' && typeof item.text === 'string') return [item.text]
    if (item.type === 'resource' && isRecord(item.resource) && typeof item.resource.text === 'string') return [item.resource.text]
    if (item.type === 'resource_link' && typeof item.uri === 'string') return [`[MCP 资源] ${item.name ?? item.uri}: ${item.uri}`]
    if (item.type === 'image') return [`[MCP 图片结果：${clean(item.mimeType, 200) || '未知格式'}，二进制内容未注入聊天]`]
    if (item.type === 'audio') return [`[MCP 音频结果：${clean(item.mimeType, 200) || '未知格式'}，二进制内容未注入聊天]`]
    return []
  }).join('\n\n').slice(0, MAX_RESULT_CHARS)
}

type ConnectedClient = {
  client: Client
  close: () => Promise<void>
}

export class McpService {
  constructor(private readonly repository: McpConfigRepository = new EncryptedMcpConfigRepository()) {}

  async listServers(): Promise<McpServerConfig[]> {
    return this.repository.list()
  }

  async saveServer(value: Partial<McpServerConfig>): Promise<McpServerConfig> {
    const current = await this.repository.list()
    const previous = value.id ? current.find((server) => server.id === value.id) : undefined
    const config = sanitizeMcpServerConfig(value, previous)
    const next = [config, ...current.filter((server) => server.id !== config.id)].slice(0, MAX_CONFIGS)
    await this.repository.write(next)
    return config
  }

  async removeServer(serverId: string): Promise<void> {
    const id = clean(serverId, 200)
    const current = await this.repository.list()
    await this.repository.write(current.filter((server) => server.id !== id))
  }

  private async config(serverId: string): Promise<McpServerConfig> {
    const config = (await this.repository.list()).find((server) => server.id === serverId)
    if (!config) throw new Error('找不到这项 MCP 配置。')
    return config
  }

  private async connect(config: McpServerConfig): Promise<ConnectedClient> {
    const client = new Client({ name: 'CoScribe', version: '2.2.1' }, { capabilities: {} })
    if (config.transport === 'stdio') {
      let cwd = config.cwd
      if (cwd) {
        cwd = await realpath(path.resolve(cwd))
        if (!(await stat(cwd)).isDirectory()) throw new Error('MCP 工作目录不是普通文件夹。')
      }
      const transport = new StdioClientTransport({
        command: config.command!,
        args: config.args ?? [],
        ...(cwd ? { cwd } : {}),
        env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
        stderr: 'pipe'
      })
      let stderr = ''
      transport.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000) })
      try { await client.connect(transport, { timeout: 20_000 }) }
      catch (error) {
        await client.close().catch(() => undefined)
        const detail = stderr.trim()
        throw new Error(`无法连接 stdio MCP：${error instanceof Error ? error.message : String(error)}${detail ? `；服务输出：${detail}` : ''}`)
      }
      return { client, close: () => client.close() }
    }
    const transport = new StreamableHTTPClientTransport(new URL(config.url!), {
      requestInit: { headers: config.headers ?? {} }
    })
    try { await client.connect(transport, { timeout: 20_000 }) }
    catch (error) {
      await client.close().catch(() => undefined)
      throw new Error(`无法连接 Streamable HTTP MCP：${error instanceof Error ? error.message : String(error)}`)
    }
    return {
      client,
      close: async () => {
        await transport.terminateSession().catch(() => undefined)
        await client.close().catch(() => undefined)
      }
    }
  }

  private async withClient<T>(serverId: string, task: (client: Client, config: McpServerConfig) => Promise<T>): Promise<T> {
    const config = await this.config(serverId)
    const connection = await this.connect(config)
    try { return await task(connection.client, config) }
    finally { await connection.close() }
  }

  async inspect(serverId: string): Promise<McpServerCatalog> {
    return this.withClient(serverId, async (client, config) => {
      const capabilities = client.getServerCapabilities()
      const tools: McpToolDescriptor[] = []
      const resources: McpResourceDescriptor[] = []
      const prompts: McpPromptDescriptor[] = []
      if (capabilities?.tools) {
        let cursor: string | undefined
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 20_000 })
          tools.push(...page.tools.slice(0, Math.max(0, 500 - tools.length)).map((tool) => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description.slice(0, 4_000) } : {}),
            ...(isRecord(tool.inputSchema) ? { inputSchema: boundedJson(tool.inputSchema) as Record<string, unknown> } : {})
          })))
          cursor = tools.length < 500 ? page.nextCursor : undefined
        } while (cursor)
      }
      if (capabilities?.resources) {
        let cursor: string | undefined
        do {
          const page = await client.listResources(cursor ? { cursor } : undefined, { timeout: 20_000 })
          resources.push(...page.resources.slice(0, Math.max(0, 500 - resources.length)).map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            ...(resource.description ? { description: resource.description.slice(0, 4_000) } : {}),
            ...(resource.mimeType ? { mimeType: resource.mimeType } : {})
          })))
          cursor = resources.length < 500 ? page.nextCursor : undefined
        } while (cursor)
      }
      if (capabilities?.prompts) {
        let cursor: string | undefined
        do {
          const page = await client.listPrompts(cursor ? { cursor } : undefined, { timeout: 20_000 })
          prompts.push(...page.prompts.slice(0, Math.max(0, 500 - prompts.length)).map((prompt) => ({
            name: prompt.name,
            ...(prompt.description ? { description: prompt.description.slice(0, 4_000) } : {}),
            ...(prompt.arguments ? { arguments: prompt.arguments.map((argument) => ({
              name: argument.name,
              ...(argument.description ? { description: argument.description.slice(0, 2_000) } : {}),
              ...(argument.required !== undefined ? { required: argument.required } : {})
            })) } : {})
          })))
          cursor = prompts.length < 500 ? page.nextCursor : undefined
        } while (cursor)
      }
      const version = client.getServerVersion()
      return {
        serverId: config.id,
        serverName: version?.name || config.name,
        ...(version?.version ? { serverVersion: version.version } : {}),
        ...(client.getInstructions() ? { instructions: client.getInstructions()!.slice(0, 20_000) } : {}),
        tools,
        resources,
        prompts,
        connectedAt: Date.now()
      }
    })
  }

  async invoke(request: McpInvocationRequest): Promise<McpInvocationResult> {
    if (!request || !['tool', 'resource', 'prompt'].includes(request.kind) || !clean(request.name, 8_000)) throw new Error('MCP 调用参数无效。')
    const args = isRecord(request.arguments) ? request.arguments : {}
    if (Buffer.byteLength(JSON.stringify(args)) > MAX_ARGUMENT_BYTES) throw new Error('MCP 参数超过 128 KB 上限。')
    const started = performance.now()
    return this.withClient(request.serverId, async (client) => {
      if (request.kind === 'tool') {
        const available = await client.listTools(undefined, { timeout: 20_000 })
        if (!available.tools.some((tool) => tool.name === request.name)) throw new Error('MCP 服务没有声明这个工具。')
        const result = await client.callTool({ name: request.name, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT_MS })
        return {
          kind: request.kind,
          name: request.name,
          content: resultText(result.content) || (result.isError ? 'MCP 工具报告失败。' : 'MCP 工具执行完成，没有文本结果。'),
          ...(boundedJson(result.structuredContent) !== undefined ? { structuredContent: boundedJson(result.structuredContent) } : {}),
          isError: result.isError === true,
          durationMs: Math.round(performance.now() - started)
        }
      }
      if (request.kind === 'resource') {
        const result = await client.readResource({ uri: request.name }, { timeout: REQUEST_TIMEOUT_MS })
        const content = result.contents.map((item) => 'text' in item ? item.text : `[二进制资源 ${item.mimeType ?? ''}，未注入聊天]`).join('\n\n').slice(0, MAX_RESULT_CHARS)
        return { kind: request.kind, name: request.name, content, isError: false, durationMs: Math.round(performance.now() - started) }
      }
      const result = await client.getPrompt({ name: request.name, arguments: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value)])) }, { timeout: REQUEST_TIMEOUT_MS })
      const content = result.messages.map((message) => `${message.role === 'user' ? '用户' : '助手'}：${resultText([message.content])}`).join('\n\n').slice(0, MAX_RESULT_CHARS)
      return { kind: request.kind, name: request.name, content, isError: false, durationMs: Math.round(performance.now() - started) }
    })
  }
}
