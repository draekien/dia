import { Schema } from 'effect'

/** A JSON object with unknown values, such as a tool call's input. */
export const JsonRecord = Schema.Record(Schema.String, Schema.Unknown)
