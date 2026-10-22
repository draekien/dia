// @effect-diagnostics *:off
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'dia-hooks-'))
const write = (generation: number, depSpecifier: string): string => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
  writeFileSync(join(dir, 'dep.ts'), `export const dep: number = ${generation}\n`)
  writeFileSync(
    join(dir, 'plugin.ts'),
    `import { dep } from '${depSpecifier}'\nexport const version = { plugin: ${generation}, dep }\n`
  )
  return pathToFileURL(join(dir, 'plugin.ts')).href
}

const rootUrl = pathToFileURL(dir).href
let generation = 1
const seen: Array<string> = []
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    seen.push(`${specifier} -> ${resolved.url}`)
    if (!resolved.url.startsWith(rootUrl)) return resolved
    return { ...resolved, url: `${resolved.url.split('?')[0]}?gen=${generation}` }
  }
})

const depSpecifier = process.argv[2] ?? './dep'
const url = write(1, depSpecifier)
const first = await import(url)
write(2, depSpecifier)
generation = 2
const second = await import(url)
console.log(JSON.stringify({ depSpecifier, before: first.version, after: second.version }))
console.log(seen.filter((line) => line.includes('dia-hooks')).join('\n'))
