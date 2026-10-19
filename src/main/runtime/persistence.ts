import * as fs from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

// Both replacements happen in the target directory (and therefore on one volume).
export async function atomicWriteJson(file: string, serialized: string): Promise<void> {
  await fs.promises.mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  const previous = `${temporary}.bak`
  try {
    await fs.promises.writeFile(temporary, serialized, 'utf8')
    try {
      // Do not overwrite a usable backup with an already corrupt primary file.
      JSON.parse(await fs.promises.readFile(file, 'utf8'))
      await fs.promises.copyFile(file, previous)
      await fs.promises.rename(previous, `${file}.bak`)
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await fs.promises.rename(temporary, file)
  } finally {
    await Promise.allSettled([temporary, previous].map(path => fs.promises.rm(path, { force: true })))
  }
}

// Small synchronous repositories keep their public API while using the same
// replacement and recovery guarantees as asynchronous settings writes.
export function atomicWriteJsonSync(file: string, serialized: string): void {
  fs.mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  const previous = `${temporary}.bak`
  try {
    fs.writeFileSync(temporary, serialized, 'utf8')
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'))
      fs.copyFileSync(file, previous)
      fs.renameSync(previous, `${file}.bak`)
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    fs.renameSync(temporary, file)
  } finally {
    for (const target of [temporary, previous]) {
      try { fs.rmSync(target, { force: true }) } catch { /* keep the original write error */ }
    }
  }
}

export function readJsonWithBackup<T>(file: string, fallback: T): T {
  for (const candidate of [file, `${file}.bak`]) {
    try { return JSON.parse(fs.readFileSync(candidate, 'utf8')) as T } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`读取 ${candidate} 失败，尝试恢复上一版本`)
    }
  }
  return fallback
}
