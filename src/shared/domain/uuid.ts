import { Schema } from 'effect'

/**
 * A string in the 8-4-4-4-12 hexadecimal UUID layout, with any version digit.
 * Use for pane ids and other UUID fields that cross the IPC boundary or are
 * persisted. It accepts the nil-based `00000000-0000-0000-0000-000000000001`
 * initial pane id and every id stored by earlier builds, which Effect's
 * `Schema.isUUID()` rejects because it also checks the version digit.
 */
export const Uuid = Schema.String.check(
  Schema.isPattern(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    {
      expected: 'a UUID'
    }
  )
)
