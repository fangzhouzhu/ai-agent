import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
// Tests execute the actual TypeScript modules while substituting external I/O.
export function createTsLoader(mocks = {}, globals = {}) {
  const cache = new Map()
  function load(file) {
    const absolute = path.resolve(file)
    if (cache.has(absolute)) return cache.get(absolute).exports
    const module = { exports: {} }
    cache.set(absolute, module)
    const code = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText
    const localRequire = name => {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('.')) {
        let target = path.resolve(path.dirname(absolute), name)
        if (fs.existsSync(`${target}.ts`)) target += '.ts'
        else target = path.join(target, 'index.ts')
        return load(target)
      }
      return require(name)
    }
    vm.runInNewContext(code, { module, exports: module.exports, require: localRequire,
      console, process, Buffer, URL, AbortController, AbortSignal, DOMException,
      setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, fetch: globalThis.fetch, ...globals,
    }, { filename: absolute })
    return module.exports
  }
  return load
}
