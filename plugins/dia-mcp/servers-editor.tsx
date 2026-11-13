import { Textarea } from '@dia/renderer-plugin'
import { draftOfText } from './draft'
import type { McpServersEditorProps } from './editor'

/**
 * The MCP servers editor the mcp plugin provides under `McpServersEditorKey`: a JSON textarea, its
 * caption and, when `error` is set, the error line. Other plugins read it through the key.
 */
export function McpServersEditor({ id, draft, onChange, error }: McpServersEditorProps) {
  return (
    <>
      <Textarea
        id={id}
        value={draft}
        spellCheck={false}
        aria-invalid={error !== undefined}
        onChange={(event) => onChange(draftOfText(event.target.value))}
        className="min-h-16 font-mono text-xs md:text-xs"
      />
      <p className="text-xs text-ink-muted">
        A JSON object of server name to server, as in .mcp.json without the "mcpServers" key.
      </p>
      {error === undefined ? null : <p className="text-xs text-error">{error}</p>}
    </>
  )
}
