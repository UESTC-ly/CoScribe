import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modelId = 'sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16'
const destination = path.join(root, '.cache', 'asr', modelId)
const base = 'https://huggingface.co/csukuangfj/k2fsa-zipformer-bilingual-zh-en-t/resolve/main'
const files = [
  {
    source: 'exp/32/encoder-epoch-99-avg-1.int8.onnx',
    name: 'encoder-epoch-99-avg-1.int8.onnx',
    size: 42_980_793,
    sha256: 'db6f51551762e40e549166fe041ea3e45464370b595e9ad23f06478ec3794fbb'
  },
  {
    source: 'exp/32/decoder-epoch-99-avg-1.onnx',
    name: 'decoder-epoch-99-avg-1.onnx',
    size: 13_877_276,
    sha256: '89be509a83175261695bdef5fd1c7b9ab1129a663d1284e7ba9f8507b21e0906'
  },
  {
    source: 'exp/32/joiner-epoch-99-avg-1.int8.onnx',
    name: 'joiner-epoch-99-avg-1.int8.onnx',
    size: 3_228_485,
    sha256: 'bdda356d6f9b8c2d7cee9ee0e26075fa537490f7fd06520be408d287073667b9'
  },
  {
    source: 'data/lang_char_bpe/tokens.txt',
    name: 'tokens.txt',
    size: 56_317,
    sha256: 'a8e0e4ec53810e433789b54a5c0134a7eaa2ffca595a6334d54c00da858841d3'
  }
]

async function digest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function valid(file, descriptor) {
  try {
    const info = await lstat(file)
    return info.isFile() && !info.isSymbolicLink() && info.size === descriptor.size && await digest(file) === descriptor.sha256
  } catch {
    return false
  }
}

await mkdir(destination, { recursive: true, mode: 0o700 })
for (const descriptor of files) {
  const target = path.join(destination, descriptor.name)
  if (await valid(target, descriptor)) {
    console.log(`ASR model verified: ${descriptor.name}`)
    continue
  }
  const temporary = `${target}.part`
  await rm(temporary, { force: true })
  console.log(`Downloading ASR model: ${descriptor.name}`)
  const response = await fetch(`${base}/${descriptor.source}`, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`ASR model download failed (${response.status}): ${descriptor.name}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o600 }))
  if (!await valid(temporary, descriptor)) {
    await rm(temporary, { force: true })
    throw new Error(`ASR model checksum failed: ${descriptor.name}`)
  }
  await rename(temporary, target)
}
console.log(`ASR model ready: ${destination}`)
