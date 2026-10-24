/**
 * Version table for the modules of the plugins the Host loads. A module's URL carries a
 * generation (`<url>?gen=<n>`); Node evaluates a module once per URL, so a module whose
 * generation did not change is not evaluated again on the next import. Construct one table per
 * process and feed it every import the Host's module resolution sees.
 */
export class ModuleGenerations {
  private counter = 0
  private generations = new Map<string, number>()
  private imports = new Map<string, Set<string>>()
  private importedBy = new Map<string, Set<string>>()

  /**
   * The URL to import for `url` (a module URL without a query): `url` plus the module's current
   * generation. A module never invalidated has generation 0.
   */
  versioned(url: string): string {
    return `${url}?gen=${this.generations.get(url) ?? 0}`
  }

  /** Records that the module `importer` imports the module `imported`, both given without a query. */
  recordImport(importer: string, imported: string): void {
    addTo(this.imports, importer, imported)
    addTo(this.importedBy, imported, importer)
  }

  /**
   * Gives each module in `changed`, and every module that imports one of them directly or
   * indirectly, a generation no module had before, and returns those modules. The importer links
   * of the returned modules are dropped; they are recorded again when the modules are imported.
   * Returns an empty set, and changes nothing, when `changed` is empty.
   */
  invalidate(changed: Iterable<string>): ReadonlySet<string> {
    const affected = new Set<string>()
    const pending = [...changed]
    for (let url = pending.pop(); url !== undefined; url = pending.pop()) {
      if (affected.has(url)) continue
      affected.add(url)
      pending.push(...(this.importedBy.get(url) ?? []))
    }
    if (affected.size === 0) return affected
    this.counter += 1
    for (const url of affected) {
      this.generations.set(url, this.counter)
      this.dropImportsOf(url)
    }
    return affected
  }

  /**
   * Captures the current generations and importer links and returns a function that restores them.
   * Restoring does not rewind the generation counter, so a generation handed out after the
   * snapshot is never handed out again.
   */
  snapshot(): () => void {
    const generations = new Map(this.generations)
    const imports = copyLinks(this.imports)
    const importedBy = copyLinks(this.importedBy)
    return () => {
      this.generations = generations
      this.imports = imports
      this.importedBy = importedBy
    }
  }

  private dropImportsOf(url: string): void {
    for (const imported of this.imports.get(url) ?? []) this.importedBy.get(imported)?.delete(url)
    this.imports.delete(url)
  }
}

const addTo = (links: Map<string, Set<string>>, key: string, value: string): void => {
  const existing = links.get(key)
  if (existing === undefined) links.set(key, new Set([value]))
  else existing.add(value)
}

const copyLinks = (links: Map<string, Set<string>>): Map<string, Set<string>> =>
  new Map([...links].map(([key, values]) => [key, new Set(values)]))
