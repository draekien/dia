import type { DiaToolResult } from '@dia/plugin'
import { Data, Effect, Schema } from 'effect'

/** A dia tool call refused because of its input; `message` is returned to the agent. */
export class InvalidInput extends Data.TaggedError('InvalidInput')<{ readonly message: string }> {}

/** The input of a dia tool call: each field's text, absent when the agent left it out. */
export type Input = Readonly<Partial<Record<string, string>>>

/** A dia tool result with `text`, marked as an error when `isError` is true. */
export const result = (text: string, isError = false): DiaToolResult => ({ text, isError })

/** A required dia tool field described by `description`; it must not be empty. */
export const required = (description: string) => Schema.NonEmptyString.annotate({ description })

/** An optional dia tool field described by `description`. */
export const optional = (description: string) =>
  Schema.optionalKey(Schema.String.annotate({ description }))

/** The text of `field` in `input`, or undefined when it is absent or empty. */
export const present = (input: Input, field: string): string | undefined => {
  const value = input[field]
  return value === undefined || value === '' ? undefined : value
}

/** Decodes `value` of `field` with `schema`, failing with {@link InvalidInput} that names `field`. */
export const decodeField = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  field: string,
  value: string
) =>
  Schema.decodeEffect(schema)(value).pipe(
    Effect.mapError((error) => new InvalidInput({ message: `Invalid ${field}: ${error.message}` }))
  )

/** As {@link decodeField}, succeeding with undefined when `value` is undefined. */
export const decodeOptional = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  field: string,
  value: string | undefined
) => (value === undefined ? Effect.undefined : decodeField(schema, field, value))
