import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const unpackedPath = path.resolve(process.argv[2] ?? 'release/win-unpacked')
const executablePath = path.join(unpackedPath, 'CoScribe.exe')
const asarPath = path.join(unpackedPath, 'resources', 'app.asar')
const installerPath = path.resolve(process.argv[3] ?? `release/CoScribe Setup ${packageJson.version}.exe`)

for (const required of [executablePath, asarPath, installerPath]) {
  if (!existsSync(required)) throw new Error(`找不到 Windows x64 成品：${required}`)
}

function peMachine(filePath) {
  const bytes = readFileSync(filePath)
  if (bytes.length < 0x40 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error(`${filePath} 不是有效的 PE 文件。`)
  const headerOffset = bytes.readUInt32LE(0x3c)
  if (headerOffset + 6 > bytes.length || bytes.toString('ascii', headerOffset, headerOffset + 4) !== 'PE\0\0') {
    throw new Error(`${filePath} 缺少 PE 标头。`)
  }
  return bytes.readUInt16LE(headerOffset + 4)
}

if (peMachine(executablePath) !== 0x8664) throw new Error('CoScribe.exe 不是 Windows x64 (AMD64) 可执行文件。')
if (peMachine(installerPath) !== 0x014c) {
  throw new Error('NSIS 安装器引导程序不是预期的 Windows x86 PE；它无法启动 x64 安装流程。')
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
  '/resources/ocr/LICENSE-APACHE-2.0.txt'
]
const missing = requiredEntries.filter((entry) => !entrySet.has(entry))
if (missing.length) throw new Error(`Windows 成品缺少运行文件：\n${missing.join('\n')}`)

const rendererOnlyPackages = [
  '@codemirror/commands',
  '@paddleocr/paddleocr-js',
  '@uiw/react-codemirror',
  'mermaid',
  'react',
  'react-dom',
  'react-markdown',
  'react-pdf'
]
const duplicated = rendererOnlyPackages.filter((name) =>
  entries.some((entry) => entry === `/node_modules/${name}` || entry.startsWith(`/node_modules/${name}/`))
)
if (duplicated.length) throw new Error(`Windows 成品重复打包了 renderer 依赖：${duplicated.join(', ')}`)

const sourceMaps = entries.filter((entry) => entry.endsWith('.map'))
if (sourceMaps.length) throw new Error(`Windows 成品仍包含 ${sourceMaps.length} 个 source map。`)

const asarMiB = statSync(asarPath).size / 1024 / 1024
const installerMiB = statSync(installerPath).size / 1024 / 1024
if (installerMiB < 20) throw new Error(`Windows 安装器体积异常：${installerMiB.toFixed(1)} MiB。`)

console.log(`Windows packaging verification passed: x64 app, ${asarMiB.toFixed(1)} MiB app.asar, ${installerMiB.toFixed(1)} MiB NSIS installer, 0 source maps.`)
