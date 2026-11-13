/**
 * The path of the Host's `host.db` for a plugin whose `ctx.dataDir` is `dataDir`
 * (`<userData>/plugins/<name>`, built in `host-plugins.ts`). A plugin that hands over data the
 * kernel stored in `host.db` attaches this file; it must only read it.
 */
export const hostDatabaseOf = (dataDir: string): string => `${dataDir}/../../host.db`

/**
 * The path of the Host's `settings.json` for a plugin whose `ctx.dataDir` is `dataDir`. A plugin
 * that takes over a setting the kernel stored there reads this file once; it must not write it.
 */
export const hostSettingsOf = (dataDir: string): string => `${dataDir}/../../settings.json`
