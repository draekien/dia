/**
 * The path of the Host's `host.db` for a plugin whose `ctx.dataDir` is `dataDir`
 * (`<userData>/plugins/<name>`, built in `host-plugins.ts`). A plugin that hands over data the
 * kernel stored in `host.db` attaches this file; it must only read it.
 */
export const hostDatabaseOf = (dataDir: string): string => `${dataDir}/../../host.db`
