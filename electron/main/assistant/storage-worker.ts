import { parentPort, workerData } from 'node:worker_threads'

import { AssistantDatabase } from './database'
import type { AssistantWorkerRequest, AssistantWorkerResponse } from './contract'

if (!parentPort) throw new Error('助理存储缺少父进程端口。')
const port = parentPort
let database: AssistantDatabase | undefined
let initializationError: string | undefined
try {
  database = new AssistantDatabase(workerData.filePath as string)
} catch (error) {
  // Do not expose SQL, private paths, or memory text in diagnostic output.
  initializationError = error instanceof Error && /^(记忆文件|记忆 Markdown|记忆正文|记忆目录|记忆索引|记忆检索|个人记忆来源|助理数据库|助理存储目录|助理授权)/u.test(error.message)
    ? error.message + ' 原数据已保留；普通聊天仍可使用。'
    : '个人记忆存储不可用，原数据库已保留。请检查文件或使用兼容版本；普通聊天仍可使用。'
}
port.on('message', (request: AssistantWorkerRequest) => {
  const response: AssistantWorkerResponse = { id: request.id }
  try {
    if (initializationError) throw new Error(initializationError)
    response.value = database!.execute(request.command, request.payload)
  } catch (error) {
    response.error = error instanceof Error && error.name !== 'ZodError' && !error.message.includes('SQLITE')
      ? error.message : '个人记忆操作未能确认，请刷新核对后重试。'
  }
  port.postMessage(response)
  if (request.command === 'close') port.close()
})
