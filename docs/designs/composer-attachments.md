# Composer attachments

Issue #74, part of the composer redesign #81. The visual rules are in `DESIGN.md` > Components > Composer > Attachments.

## Data

`src/shared/domain/attachment.ts`:

| Schema | Fields | Meaning |
|---|---|---|
| `ContentAttachment` | `name`, `mediaType`, `data` (base64) | A file the adapter accepts as a content block. Its bytes travel with the message. |
| `PathAttachment` | `path` (absolute), `kind` (`file` \| `directory`), `missing` (optional) | A file or directory the agent reads with its own tools. `missing` is set by the session when the path did not exist at send time. |
| `Attachment` | union of the two | |
| `AttachmentType` | `mediaType`, `block` (`image`), `maxBytes` | One type the adapter accepts as a content block. |
| `ProjectEntry` | `path` (relative to cwd, `/`-separated), `kind` | One row of the `@` search index. |

`OutgoingMessage` and `ConversationMessage` gain `attachments` (optional; absent means none). `SendMessage` and `EditQueuedMessage` gain `attachments`. `PROTOCOL_VERSION` 0.0.13 → 0.0.14.

## Flow

```text
composer chips ──SendMessage{text, attachments}──▶ host ──sendText(text, mode, attachments)──▶ claude-code session
                                                                   │ stat each PathAttachment → missing
                                                                   │ paths outside cwd → applyFlagSettings({ permissions: { additionalDirectories } })
                                                                   ▼
                                                     SDKUserMessage.content = [text + path lines, ...image blocks]
```

- `AgentBackend.attachmentTypes` declares the content-block types; `GetAttachmentTypes` returns them to the renderer. The composer reads a dropped or pasted file's bytes only when its MIME type is on that list.
- `ListProjectEntries({ cwd })` returns the `@` index: `git ls-files --cached --others --exclude-standard` plus the directories those paths imply, capped at 20 000 entries; outside a git repository, a walk one directory at a time that does not enter `.git` or `node_modules`, skips entries it cannot read, and stops at the same cap.
- The prompt text is the message text, a blank line, then one absolute path per line for each `PathAttachment`. A message with no text and only images sends image blocks alone.
- A user message whose content is a block array without `tool_result` blocks is a user prompt: the live reducer offers its checkpoint, and `sessionMessagesToConversation` restores its text and image blocks as `attachments`.

## Composer

```text
┌ InputGroup ────────────────────────────────────────────┐
│ header row (model, effort, mode, donut)                │  block-start
│ [▢ shot.png ×] [▤ docs/adr ×] [▤ F:\other\a.ts ×]      │  block-start, wraps, only when chips exist
│ textarea                                               │
│ [+]                                            [Send]  │  block-end
└────────────────────────────────────────────────────────┘
```

- Paste: when `clipboardData.files` is non-empty, the files are attached and the text paste is suppressed; otherwise the paste is plain text.
- Drop on the form: each item's `webkitGetAsEntry().isDirectory` gives `kind`; `window.dia.pathForFile` (preload `webUtils.getPathForFile`) gives the path.
- Attach (`Plus`, bottom-left) opens `<input type="file" multiple>`.
- A file whose type is accepted becomes a `ContentAttachment`; over `maxBytes` its chip shows `Too large, 3.75 MB max` and it is not sent. Any other file, or a directory, becomes a `PathAttachment`.
- `@` opens the path menu (`CompletionMenu`, the listbox the `/` menu uses) over `ListProjectEntries`, fetched once per opened token. Choosing a row deletes the `@query` token and adds a `PathAttachment` chip.
- Backspace with the caret at 0 and no selection removes the last chip. Each chip's × has `aria-label="Remove <name>"`. An image chip opens a preview dialog.
- Send is enabled with text or at least one sendable attachment.

## Queued messages and transcript

- A queued bubble with attachments is 54px: the text line, then one row of 28×20 thumbnails and 20px chips, then `+N` for the ones that do not fit. In the collapsed stack only the front bubble shows the row.
- The queued message editor shows the chips with × and saves the ones kept.
- A sent user message shows its chips under the text, read-only. A `missing` path chip is red.

## Decisions

| Decision | Reason |
|---|---|
| Only images (PNG, JPEG, GIF, WebP) are content blocks | Claude Code's Read tool reads PDFs and text from a path, and a path keeps the bytes out of every later request in the conversation. |
| `maxBytes` is 3.75 MiB of file size | The API limit is 5 MB of base64 per image; 3.75 MiB of bytes is 5 MiB of base64. |
| Paths outside cwd go through `Query.applyFlagSettings` | A probe showed a Read outside cwd prompts without it and runs without a prompt after it, on a running query. No restart is needed. See `docs/reasoning/2026-11-01-sdk-attachments-probe.md`. |
| Attach uses `<input type="file" multiple>`, not a `showOpenDialog` IPC | On Windows and Linux a dialog cannot select files and folders together. The input returns `File` objects, so accepted types are read the same way as a drop. Folders come from drop, paste and `@`. |
| Clipboard files win over clipboard text | Explorer and browsers put a file and text on the clipboard together; the file is what the user copied. |
| The renderer caches the `@` index per cwd and re-reads it when a menu opens more than 10 seconds after the last read | No watcher to keep fresh; typing and deleting `@` does not spawn `git` each time, and a new file shows up within 10 seconds. |
| A send waits while a dropped or pasted file is still being read | Otherwise the message goes without the file and its chip appears in the next draft. |
| Image bytes ride in the queue snapshot and the sent-message event | The renderer shows thumbnails in the queue and the transcript; a renderer-side cache keyed by attachment would be a second store of the same bytes. |
| `attachments` is optional on `OutgoingMessage` and `ConversationMessage` | Existing messages and history entries have none, and every existing producer stays valid. |
| Restored history shows path attachments as the path lines in the message text, not as chips | The transcript stores only the prompt text; telling attached path lines from paths the user typed would be a guess, and the restored text is what the agent saw. |
| A rejected (too large) chip stays visible and is not sent | The user sees why it is not attached and removes it. |
