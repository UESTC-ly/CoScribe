import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

type WriteVerifier = () => Promise<void>

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || error instanceof SyntaxError) return fallback
    throw error
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const descriptor = await open(directory, constants.O_RDONLY)
    try {
      await descriptor.sync()
    } finally {
      await descriptor.close()
    }
  } catch {
    // Some filesystems do not allow fsync on directories. The file itself is still synced.
  }
}

export async function atomicWrite(
  filePath: string,
  content: string,
  mode = 0o600,
  verify?: WriteVerifier
): Promise<void> {
  const directory = path.dirname(filePath)
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  let created = false
  try {
    await verify?.()
    const descriptor = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      mode
    )
    created = true
    try {
      await descriptor.writeFile(content, 'utf8')
      await descriptor.sync()
    } finally {
      await descriptor.close()
    }
    await verify?.()
    await rename(temporary, filePath)
    created = false
    await syncDirectory(directory)
  } finally {
    if (created) await unlink(temporary).catch(() => undefined)
  }
}

export async function atomicWriteJson(filePath: string, value: unknown, verify?: WriteVerifier): Promise<void> {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`, 0o600, verify)
}

export async function atomicCreate(filePath: string, content: string | Uint8Array, verify?: WriteVerifier): Promise<void> {
  const directory = path.dirname(filePath)
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  let temporaryExists = false
  try {
    await verify?.()
    const descriptor = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600
    )
    temporaryExists = true
    try {
      if (typeof content === 'string') await descriptor.writeFile(content, 'utf8')
      else await descriptor.writeFile(content)
      await descriptor.sync()
    } finally {
      await descriptor.close()
    }
    await verify?.()
    try {
      await link(temporary, filePath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EXDEV' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw error
      await copyFile(temporary, filePath, constants.COPYFILE_EXCL)
      const target = await open(filePath, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        await target.sync()
      } finally {
        await target.close()
      }
    }
    await unlink(temporary)
    temporaryExists = false
    await syncDirectory(directory)
  } finally {
    if (temporaryExists) await unlink(temporary).catch(() => undefined)
  }
}
