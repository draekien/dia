import { Effect, FileSystem, Option, Schema } from 'effect'

/** The file in `dia-tools`' data folder that records the MCP endpoint's port. */
export const ENDPOINT_FILE = 'endpoint.json'
/** The file in `dia-tools`' data folder that records the hashes of outside agents' tokens. */
export const OUTSIDE_TOKENS_FILE = 'outside-tokens.json'

const Endpoint = Schema.fromJsonString(Schema.Struct({ port: Schema.Int }))
const OutsideTokens = Schema.fromJsonString(Schema.Struct({ hashes: Schema.Array(Schema.String) }))

const readJson = <S extends Schema.Codec<unknown, string>>(schema: S, path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(path).pipe(Effect.option)
    if (Option.isNone(text)) return Option.none<S['Type']>()
    const decoded = yield* Schema.decodeUnknownEffect(schema)(text.value).pipe(Effect.option)
    if (Option.isNone(decoded)) yield* Effect.logWarning('Ignored an unreadable file', { path })
    return decoded
  })

const writeJson = <S extends Schema.Codec<unknown, string>>(
  schema: S,
  path: string,
  value: S['Type']
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* Schema.encodeEffect(schema)(value).pipe(Effect.orDie)
    yield* fs
      .writeFileString(path, text)
      .pipe(Effect.catch((error) => Effect.logError('Could not write a file', { path, error })))
  })

/** The port recorded in the endpoint file at `path`, none when it is missing or unreadable. */
export const readPort = (path: string) =>
  Effect.map(
    readJson(Endpoint, path),
    Option.map((endpoint) => endpoint.port)
  )

/** Records `port` in the endpoint file at `path`; a write failure is logged. */
export const writePort = (path: string, port: number) => writeJson(Endpoint, path, { port })

/** The outside token hashes recorded at `path`, empty when the file is missing or unreadable. */
export const readOutsideTokens = (path: string) =>
  Effect.map(
    readJson(OutsideTokens, path),
    Option.match({ onNone: (): ReadonlyArray<string> => [], onSome: (file) => file.hashes })
  )

/** Records `hashes` as the outside token hashes at `path`; a write failure is logged. */
export const writeOutsideTokens = (path: string, hashes: ReadonlyArray<string>) =>
  writeJson(OutsideTokens, path, { hashes })
