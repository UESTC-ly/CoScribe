import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

export function memoryHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function memoryMarkdown(id: string, text: string): string {
  return `<!-- CoScribe personal memory: ${id} -->\n\n${text}\n`
}

// The outbox is committed with metadata/index changes. No read returns a new
// fact until its canonical Markdown is durable. Recovery accepts only the
// recorded before/after hashes, never overwrites an unrelated external edit.
export function migrateMarkdown(db: DatabaseSync, filePath: string, backup: boolean): void {
  if (backup) {
    const destination = filePath + '.v3-' + randomUUID() + '.bak'
    db.prepare('VACUUM INTO ?').run(destination)
    chmodSync(destination, 0o600)
  }
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE')
  try {
    db.exec(`
      CREATE TABLE sources_v4 (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('user-explicit','user-stated')), origin TEXT NOT NULL CHECK(origin IN ('about-me','chat','memory-file')), recordedAt INTEGER NOT NULL, quote TEXT, sessionId TEXT);
      INSERT INTO sources_v4 SELECT * FROM sources;
      DROP TABLE sources;
      ALTER TABLE sources_v4 RENAME TO sources;
      CREATE TABLE memory_files (id TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE memory_file_outbox (id TEXT PRIMARY KEY, beforeHash TEXT, text TEXT);
      CREATE TABLE memory_vectors (id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE, textHash TEXT NOT NULL, identity TEXT NOT NULL, vector TEXT NOT NULL);
      CREATE TABLE memory_search_policy (id INTEGER PRIMARY KEY CHECK(id=1), profileId TEXT NOT NULL, model TEXT NOT NULL);
      INSERT INTO memory_search_policy VALUES(1,'','');
      CREATE TABLE memory_answer_origins (sessionId TEXT NOT NULL, hash TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(sessionId,hash));
      CREATE TABLE memory_answer_pending (sessionId TEXT NOT NULL, requestId TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(sessionId,requestId));
      INSERT INTO memory_file_outbox SELECT id,NULL,text FROM memories;
      CREATE TRIGGER memory_markdown_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memory_file_outbox VALUES(new.id,NULL,new.text);
      END;
      CREATE TRIGGER memory_markdown_update AFTER UPDATE OF text ON memories BEGIN
        INSERT INTO memory_file_outbox VALUES(new.id,(SELECT hash FROM memory_files WHERE id=new.id),new.text)
          ON CONFLICT(id) DO UPDATE SET text=excluded.text;
        DELETE FROM memory_vectors WHERE id=new.id;
      END;
      CREATE TRIGGER memory_markdown_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memory_file_outbox VALUES(old.id,(SELECT hash FROM memory_files WHERE id=old.id),NULL)
          ON CONFLICT(id) DO UPDATE SET text=NULL;
        DELETE FROM memory_vectors WHERE id=old.id;
      END;
      PRAGMA user_version=4;
    `)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  finally { db.exec('PRAGMA foreign_keys=ON') }
}

export class MarkdownMemoryStore {
  readonly directory: string

  constructor(private readonly db: DatabaseSync, filePath: string) {
    this.directory = path.join(path.dirname(filePath), 'memory')
    this.guardDirectory()
  }

  private guardDirectory(): void {
    const parent = lstatSync(path.dirname(this.directory))
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('记忆目录不能是符号链接。')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const stat = lstatSync(this.directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('记忆目录不能是符号链接。')
    chmodSync(this.directory, 0o700)
  }

  private file(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(id)) throw new Error('记忆文件标识无效。')
    this.guardDirectory()
    return path.join(this.directory, id + '.md')
  }

  read(id: string): string | null {
    const file = this.file(id)
    try {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8_192) throw new Error('记忆文件无效或过大，原文件已保留。')
      // O_NOFOLLOW is available on supported desktop platforms through Node.
      const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        if (fstatSync(descriptor).ino !== stat.ino) throw new Error('记忆文件在读取时变化，请重试。')
        const content = readFileSync(descriptor, 'utf8')
        if (lstatSync(file).ino !== stat.ino) throw new Error('记忆文件在读取时变化，请重试。')
        return content
      } finally { closeSync(descriptor) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  text(id: string, content: string): string {
    const prefix = `<!-- CoScribe personal memory: ${id} -->\n\n`
    if (!content.startsWith(prefix)) throw new Error('记忆 Markdown 标识损坏，原文件已保留。')
    const text = content.slice(prefix.length).trim()
    if (!text || text.length > 1_000) throw new Error('记忆正文必须为 1–1,000 字符，原文件已保留。')
    return text
  }

  private replace(id: string, content: string | null, beforeHash: string | null): void {
    const file = this.file(id)
    const current = this.read(id)
    const hash = current === null ? null : memoryHash(current)
    if (content === current) return // Committed file, interrupted index finish.
    if (hash !== beforeHash) throw new Error('记忆文件与待完成操作冲突，未覆盖原文件。请保留文件并核对迁移备份。')
    if (content === null) {
      if (current !== null) unlinkSync(file)
    } else {
      const temporary = path.join(this.directory, '.' + id + '-' + randomUUID() + '.tmp')
      const descriptor = openSync(temporary, 'wx', 0o600)
      try {
        try { writeFileSync(descriptor, content, 'utf8'); fsyncSync(descriptor) }
        finally { closeSync(descriptor) }
        const latest = this.read(id)
        if ((latest === null ? null : memoryHash(latest)) !== beforeHash) throw new Error('记忆文件在写入时变化，未覆盖原文件。')
        renameSync(temporary, file)
      } finally {
        try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
    }
    // Directory fsync is not supported on Windows; the file itself was synced.
    if (process.platform !== 'win32') {
      const descriptor = openSync(this.directory, 'r')
      try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
    }
  }

  flush(): void {
    const rows = this.db.prepare('SELECT * FROM memory_file_outbox ORDER BY id').all()
    for (const row of rows) {
      const id = String(row.id)
      const content = row.text === null ? null : memoryMarkdown(id, String(row.text))
      this.replace(id, content, row.beforeHash === null ? null : String(row.beforeHash))
      this.db.exec('BEGIN IMMEDIATE')
      try {
        if (content === null) this.db.prepare('DELETE FROM memory_files WHERE id=?').run(id)
        else this.db.prepare('INSERT OR REPLACE INTO memory_files VALUES(?,?)').run(id, memoryHash(content))
        this.db.prepare('DELETE FROM memory_file_outbox WHERE id=?').run(id)
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    }
  }

  // Unknown files are never promoted as user facts. Existing file identities
  // and provenance come from the database, not from prose or file headers.
  changes(): Array<{ id: string; text: string | null; hash: string | null }> {
    this.flush()
    if (this.db.prepare(`
      SELECT m.id FROM memories m LEFT JOIN memory_files f ON f.id=m.id WHERE f.id IS NULL
      UNION ALL SELECT f.id FROM memory_files f LEFT JOIN memories m ON m.id=f.id WHERE m.id IS NULL LIMIT 1
    `).get()) throw new Error('记忆正文与索引身份不一致，已保留原数据。')
    return this.db.prepare('SELECT id,hash FROM memory_files ORDER BY id').all().flatMap((row) => {
      const id = String(row.id)
      const content = this.read(id)
      const hash = content === null ? null : memoryHash(content)
      if (hash === row.hash) return []
      return [{ id, text: content === null ? null : this.text(id, content), hash }]
    })
  }
}
