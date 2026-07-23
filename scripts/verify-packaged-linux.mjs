import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const unpackedPath = path.resolve(process.argv[2] ?? 'release/linux-unpacked')
const releasePath = path.resolve('release')
const executablePath = ['coscribe', 'CoScribe']
  .map((name) => path.join(unpackedPath, name))
  .find((candidate) => existsSync(candidate))
const resourcesPath = path.join(unpackedPath, 'resources')
const asarPath = path.join(resourcesPath, 'app.asar')
const appImagePath = path.join(releasePath, `CoScribe-${packageJson.version}-x64.AppImage`)
const debPath = path.join(releasePath, `CoScribe-${packageJson.version}-x64.deb`)

if (!executablePath) throw new Error(`找不到 Linux x64 可执行文件：${unpackedPath}`)
for (const required of [asarPath, appImagePath, debPath]) {
  if (!existsSync(required)) throw new Error(`找不到 Linux x64 成品：${required}`)
}

function assertX64Elf(filePath) {
  const bytes = readFileSync(filePath)
  if (bytes.length < 20 || bytes.toString('binary', 0, 4) !== '\u007fELF') {
    throw new Error(`${filePath} 不是有效的 ELF 文件。`)
  }
  if (bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 0x3e) {
    throw new Error(`${filePath} 不是 Linux x64 (x86-64) 可执行文件。`)
  }
}

assertX64Elf(executablePath)
assertX64Elf(appImagePath)
if ((statSync(executablePath).mode & 0o111) === 0 || (statSync(appImagePath).mode & 0o111) === 0) {
  throw new Error('Linux 可执行文件缺少执行权限。')
}

function readArEntries(filePath) {
  const archive = readFileSync(filePath)
  if (archive.toString('ascii', 0, 8) !== '!<arch>\n') throw new Error(`${filePath} 不是有效的 Debian ar 归档。`)
  const entries = new Map()
  let offset = 8
  while (offset + 60 <= archive.length) {
    const header = archive.subarray(offset, offset + 60)
    if (header.toString('ascii', 58, 60) !== '`\n') throw new Error(`${filePath} 的 ar 条目头损坏。`)
    const name = header.toString('ascii', 0, 16).trim().replace(/\/$/u, '')
    const size = Number.parseInt(header.toString('ascii', 48, 58).trim(), 10)
    if (!Number.isSafeInteger(size) || size < 0 || offset + 60 + size > archive.length) {
      throw new Error(`${filePath} 的 ar 条目大小无效。`)
    }
    entries.set(name, archive.subarray(offset + 60, offset + 60 + size))
    offset += 60 + size + (size % 2)
  }
  return entries
}

const debEntries = readArEntries(debPath)
if (debEntries.get('debian-binary')?.toString('ascii') !== '2.0\n') throw new Error('Debian 安装包版本标记无效。')
const controlEntry = [...debEntries.entries()].find(([name]) => name.startsWith('control.tar.'))
if (!controlEntry || ![...debEntries.keys()].some((name) => name.startsWith('data.tar.'))) {
  throw new Error('Debian 安装包缺少 control 或 data 归档。')
}
const controlArchive = path.join(tmpdir(), `coscribe-deb-control-${process.pid}-${Date.now()}.${controlEntry[0].split('.').pop()}`)
try {
  writeFileSync(controlArchive, controlEntry[1])
  let control = ''
  for (const member of ['./control', 'control']) {
    try {
      control = execFileSync('/usr/bin/tar', ['-xOf', controlArchive, member], { encoding: 'utf8' })
      break
    } catch {
      // Try the alternative archive member spelling.
    }
  }
  if (!/^Architecture: amd64$/mu.test(control)) throw new Error('Debian 安装包不是 amd64 架构。')
  if (!new RegExp(`^Version: ${packageJson.version.replaceAll('.', '\\.')}($|-)`, 'mu').test(control)) {
    throw new Error(`Debian 安装包版本不是 ${packageJson.version}。`)
  }
} finally {
  if (existsSync(controlArchive)) unlinkSync(controlArchive)
}

const asarCli = require.resolve('@electron/asar/bin/asar.js')
const entries = execFileSync(process.execPath, [asarCli, 'list', asarPath], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024
}).split(/\r?\n/u).filter(Boolean)
const entrySet = new Set(entries)
const requiredEntries = [
  '/node_modules/chokidar/package.json',
  '/node_modules/mammoth/package.json',
  '/node_modules/pdfjs-dist/legacy/build/pdf.mjs',
  '/out/renderer/assets/ocr/models/PP-OCRv6_small_det_onnx_infer.tar',
  '/out/renderer/assets/ocr/models/PP-OCRv6_small_rec_onnx_infer.tar',
  '/out/renderer/assets/ocr/ort/ort-wasm-simd-threaded.jsep.mjs',
  '/out/renderer/assets/ocr/ort/ort-wasm-simd-threaded.jsep.wasm',
  '/resources/guide/CoScribe 使用指南.md',
  '/resources/ocr/LICENSE-APACHE-2.0.txt'
]
const missing = requiredEntries.filter((entry) => !entrySet.has(entry))
if (missing.length) throw new Error(`Linux 成品缺少运行文件：\n${missing.join('\n')}`)

const sourceMaps = entries.filter((entry) => entry.endsWith('.map'))
if (sourceMaps.length) throw new Error(`Linux 成品仍包含 ${sourceMaps.length} 个 source map。`)
const speechEntries = entries.filter((entry) => entry.startsWith('/node_modules/sherpa-onnx-'))
if (speechEntries.length || existsSync(path.join(resourcesPath, 'asr')) || existsSync(path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-darwin-arm64'))) {
  throw new Error('Linux 成品误带了仅供 Apple Silicon macOS 使用的本地语音模型或运行库。')
}

const asarMiB = statSync(asarPath).size / 1024 / 1024
const appImageMiB = statSync(appImagePath).size / 1024 / 1024
const debMiB = statSync(debPath).size / 1024 / 1024
if (appImageMiB < 20 || debMiB < 20) throw new Error('Linux 安装包体积异常。')

console.log(`Linux packaging verification passed: x64 ELF, amd64 DEB ${packageJson.version}, ${asarMiB.toFixed(1)} MiB app.asar, ${appImageMiB.toFixed(1)} MiB AppImage, ${debMiB.toFixed(1)} MiB DEB, 0 source maps.`)
