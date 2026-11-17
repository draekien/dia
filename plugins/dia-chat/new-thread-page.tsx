import { WorktreesKey } from '@dia/plugin'
import {
  actions,
  Button,
  CREATE_PERMISSION_MODE_OPTIONS,
  type Draft,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  disabledPermissionModesFor,
  emptyDraft,
  findModelOption,
  fitThinkingLevel,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  InstallNotice,
  installProblem,
  type ModelCatalogStateJson,
  PluginThreadTarget,
  ProjectTarget,
  paneChatAtom,
  REGISTER_PROJECT_REFUSAL_TEXT,
  TabSetupSteps,
  type ThreadTarget,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  thinkingLevelsFor,
  useAdapterStatus,
  useAdapters,
  useAttachmentTypes,
  useDisabledPermissionModes,
  useDrafts,
  useList,
  useModelCatalogs,
  useModelPreferences,
  usePluginList,
  useRunSummaries,
  userProjects,
  useWorkspace
} from '@dia/renderer-plugin'
import {
  type ThreadTargetEntry,
  ThreadTargetsSlot,
  targetEntryOf
} from '@dia-plugin/dia-chat/slots'
import { useAtomValue } from '@effect/atom-react'
import {
  adapterPreferencesOf,
  EMPTY_MODEL_PREFERENCES,
  type ModelPreferences,
  type ModelSelection,
  pickerModels
} from '@shared/domain/model-preferences'
import {
  DEFAULT_THINKING_LEVEL,
  type StartupPermissionMode,
  type ThinkingLevel
} from '@shared/domain/pane'
import type { Project, Workspace, WorktreeStart } from '@shared/domain/project'
import { Uuid } from '@shared/domain/uuid'
import { CreateTab } from '@shared/ipc/contract'
import type { ListEntry } from '@shared/plugin/list-slot'
import { Effect } from 'effect'
import { AsyncResult } from 'effect/reactivity'
import { ChevronDownIcon, FolderIcon, FolderPlusIcon, Loader2Icon, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AttachmentChip } from './attachment-chips'
import { composerAction } from './composer-action'
import { useComposerCompletion } from './composer-completion'
import { PermissionModeSelect, ThinkingLevelSelect } from './composer-setting-selects'
import { useSlashCommands } from './hooks/use-slash-commands'
import { ModelPicker } from './model-picker'
import { ComposerActionButton } from './pane'
import { filesOf, useComposerAttachments } from './use-composer-attachments'
import { WorkspaceMenu } from './workspace-menu'

type SendState =
  | { readonly step: 'editing' }
  | { readonly step: 'sending' }
  | { readonly step: 'failed'; readonly reason: string }

type ResolvedTarget =
  | { readonly _tag: 'Project'; readonly target: ProjectTarget; readonly project: Project }
  | {
      readonly _tag: 'Plugin'
      readonly target: PluginThreadTarget
      readonly entry: ListEntry<ThreadTargetEntry>
    }

const resolveTarget = (
  target: ThreadTarget | null,
  projects: ReadonlyArray<Project>,
  entries: ReadonlyArray<ListEntry<ThreadTargetEntry>>
): ResolvedTarget | null => {
  if (target === null) return null
  if (target._tag === 'ProjectTarget') {
    const project = projects.find((candidate) => candidate.projectId === target.projectId)
    return project === undefined ? null : { _tag: 'Project', target, project }
  }
  const entry = targetEntryOf(entries, target)
  return entry === undefined ? null : { _tag: 'Plugin', target, entry }
}

/**
 * The model a new thread starts on: `chosen` while a picker group offers it, else the stored
 * default selection while offered, else the first offered model of the first adapter in `adapters`
 * order; undefined while no model is offered. A picker group offers an adapter's favourite and
 * other visible models, read from `catalogs` once its list is ready.
 */
export const startingSelection = (
  adapters: ReadonlyArray<{ readonly id: string }>,
  catalogs: ReadonlyMap<string, ModelCatalogStateJson>,
  preferences: ModelPreferences,
  chosen: ModelSelection | null
): ModelSelection | undefined => {
  const offered = adapters.flatMap(({ id }) => {
    const state = catalogs.get(id)
    const models = state?._tag === 'Ready' ? state.models : []
    const { favourites, others } = pickerModels(models, adapterPreferencesOf(preferences, id))
    return [...favourites, ...others].map(
      (model): ModelSelection => ({ backend: id, model: model.value })
    )
  })
  const isOffered = (selection: ModelSelection | null | undefined) =>
    selection != null &&
    offered.some((o) => o.backend === selection.backend && o.model === selection.model)
  if (chosen !== null && isOffered(chosen)) return chosen
  const preferred = preferences.defaults.selection
  if (preferred !== undefined && isOffered(preferred)) return preferred
  return offered[0]
}

const UNREGISTERED_ADAPTER = 'dia-no-adapter'

/** The name of a thread working in `directory`'s checkout itself (not a worktree), or null. */
const busyThreadIn = (
  workspace: Workspace | undefined,
  directory: string,
  working: (paneId: string) => boolean
): string | null => {
  const tab = workspace?.projects
    .flatMap((entry) => entry.tabs)
    .find(
      (candidate) =>
        !candidate.archived &&
        candidate.config.worktree === undefined &&
        candidate.config.cwd === directory &&
        working(candidate.config.paneId)
    )
  return tab?.name ?? null
}

function SetupSteps({ paneId }: { readonly paneId: string }) {
  const steps = AsyncResult.getOrElse(useAtomValue(paneChatAtom(paneId)), () => undefined)?.setup
  if (steps === undefined) return null
  return <TabSetupSteps steps={steps} />
}

function TargetPicker({
  resolved,
  projects,
  entries,
  onPick
}: {
  readonly resolved: ResolvedTarget | null
  readonly projects: ReadonlyArray<Project>
  readonly entries: ReadonlyArray<ListEntry<ThreadTargetEntry>>
  readonly onPick: (target: ThreadTarget) => void
}) {
  const [refusal, setRefusal] = useState<string | null>(null)
  const addProject = () =>
    void actions
      .registerProject()
      .then((result) =>
        setRefusal(result == null ? null : REGISTER_PROJECT_REFUSAL_TEXT[result._tag])
      )
  if (projects.length === 0 && entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3">
        <h1 className="font-semibold text-2xl text-ink">What are we building today?</h1>
        <Button variant="outline" onClick={addProject}>
          <FolderPlusIcon data-icon="inline-start" />
          Add a project…
        </Button>
        {refusal === null ? null : <p className="text-error text-sm">{refusal}</p>}
      </div>
    )
  }
  const name =
    resolved === null
      ? 'a project'
      : resolved._tag === 'Project'
        ? resolved.project.displayName
        : `the ${resolved.entry.label}`
  const preposition = resolved?._tag === 'Plugin' ? 'with' : 'in'
  return (
    <div className="flex flex-col items-center gap-2">
      <h1 className="text-balance text-center font-semibold text-2xl text-ink">
        What are we building today {preposition}{' '}
        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex items-baseline gap-1 rounded-sm underline decoration-border decoration-1 underline-offset-4 outline-none hover:decoration-ink-muted focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Start the thread in: ${name}`}
          >
            {name}
            <ChevronDownIcon className="size-4 self-center text-ink-muted" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" className="min-w-56">
            {projects.length === 0 ? null : (
              <DropdownMenuGroup>
                {projects.map((project) => (
                  <DropdownMenuItem
                    key={project.projectId}
                    onClick={() => onPick(ProjectTarget.make({ projectId: project.projectId }))}
                  >
                    <FolderIcon />
                    {project.displayName}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            )}
            {entries.length === 0 ? null : (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  {entries.map((entry) => (
                    <DropdownMenuItem
                      key={`${entry.key.plugin}/${entry.key.id}`}
                      onClick={() =>
                        onPick(
                          PluginThreadTarget.make({ plugin: entry.key.plugin, id: entry.key.id })
                        )
                      }
                    >
                      <entry.icon />
                      {entry.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={addProject}>
                <FolderPlusIcon />
                Add a project…
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        ?
      </h1>
      {refusal === null ? null : <p className="text-error text-sm">{refusal}</p>}
    </div>
  )
}

/**
 * The new-thread page for draft `draftId`, filling the content area: a headline whose target name
 * picks the project or plugin target the thread starts in, a composer centred under it, the model,
 * thinking level and permission mode under the composer on the left and, for a git project, the
 * workspace control on the right. Every edit is saved to the draft. Send starts the thread; a
 * failure keeps the draft and shows its reason above the composer. A draft `draftId` that is not
 * saved yet starts empty, aimed at `actions.defaultThreadTarget()`, and is saved on the first edit.
 */
export function NewThreadPage({ draftId }: { readonly draftId: Uuid }) {
  const drafts = useDrafts()
  const workspace = useWorkspace()
  const entries = useList(ThreadTargetsSlot)
  const summaries = useRunSummaries()
  const adapters = useAdapters()
  const catalogs = useModelCatalogs(adapters)
  const preferences = useModelPreferences()
  const worktreesAvailable =
    usePluginList().plugins?.some((plugin) => plugin.provides.includes(WorktreesKey.name)) ?? false
  const [state, setState] = useState<SendState>({ step: 'editing' })
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const draft: Draft =
    drafts.find((saved) => saved.draftId === draftId) ??
    emptyDraft(draftId, actions.defaultThreadTarget())
  const update = (patch: Partial<Draft>) => actions.saveDraft({ ...draft, ...patch })

  const projects = workspace === undefined ? [] : userProjects(workspace).map((e) => e.project)
  const resolved = resolveTarget(draft.target, projects, entries)
  const project = resolved?._tag === 'Project' ? resolved.project : undefined
  const prefs = preferences ?? EMPTY_MODEL_PREFERENCES
  const selection = startingSelection(adapters, catalogs, prefs, draft.selection)
  const adapter = selection?.backend ?? adapters[0]?.id ?? UNREGISTERED_ADAPTER
  const adapterStatus = useAdapterStatus(adapter)
  const attachments = useComposerAttachments(useAttachmentTypes(adapter))
  const modelOption = findModelOption(catalogs.get(adapter), selection?.model)
  const thinkingLevels = thinkingLevelsFor(modelOption)
  const thinkingLevel = fitThinkingLevel(
    draft.thinkingLevel ?? prefs.defaults.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
    thinkingLevels
  )
  const disabledPermissionModes = disabledPermissionModesFor(
    useDisabledPermissionModes(adapter, project?.directory ?? ''),
    modelOption
  )
  const chosenMode: StartupPermissionMode =
    draft.permissionMode ?? prefs.defaults.permissionMode ?? 'auto'
  const permissionMode = disabledPermissionModes.includes(chosenMode) ? 'default' : chosenMode
  const showsWorkspace = project?.isGitRepo === true && worktreesAvailable
  const worktree = showsWorkspace ? draft.worktree : null
  const sending = state.step === 'sending'
  const text = draft.text
  const hasContent = text.trim() !== '' || attachments.ready.length > 0
  const blocked =
    resolved === null ||
    (resolved._tag === 'Project' &&
      (selection === undefined || installProblem(adapterStatus) !== undefined))

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    const sentAs = draft.sentAs
    if (sentAs === null) return
    return window.dia.onPaneCreateFailed((event) => {
      if (event.paneId !== sentAs) return
      setState({ step: 'failed', reason: event.reason })
    })
  }, [draft.sentAs])

  const sendToProject = (target: ProjectTarget, start: ModelSelection) => {
    // @effect-diagnostics-next-line cryptoRandomUUID:off -- a React handler outside any Effect; the id only has to be unique.
    const paneId = Uuid.make(crypto.randomUUID())
    actions.saveDraft({ ...draft, sentAs: paneId })
    Effect.runSync(Effect.logInfo('Starting a thread from a draft', { draftId, paneId, worktree }))
    window.dia.createTab(
      CreateTab.make({
        projectId: target.projectId,
        paneId,
        name: null,
        model: start.model,
        backend: start.backend,
        thinkingLevel,
        permissionMode,
        worktree,
        firstMessage: { text: text.trim(), attachments: attachments.ready }
      })
    )
  }

  const sendToPlugin = (target: PluginThreadTarget, entry: ThreadTargetEntry) =>
    Effect.runPromise(
      entry.send(text.trim()).pipe(
        Effect.match({
          onFailure: (reason) => setState({ step: 'failed', reason }),
          onSuccess: () => actions.completeDraft(draftId, target)
        })
      )
    )

  const send = () => {
    if (resolved === null || blocked || sending || attachments.reading || !hasContent) return
    setState({ step: 'sending' })
    if (resolved._tag === 'Plugin') void sendToPlugin(resolved.target, resolved.entry)
    else if (selection !== undefined) sendToProject(resolved.target, selection)
  }

  const pickTarget = (target: ThreadTarget) => {
    setState({ step: 'editing' })
    attachments.clear()
    update({ target, worktree: null })
  }

  const slashCommands = useSlashCommands(adapter, project?.directory ?? null)
  const completion = useComposerCompletion({
    text,
    setText: (value) => update({ text: value }),
    textareaRef,
    commands: slashCommands.commands,
    cwd: project?.directory ?? null,
    listId: draftId,
    onPath: attachments.attach
  })

  const action = composerAction({
    running: false,
    hasText: hasContent && !blocked && !sending,
    modifierHeld: false,
    defaultMode: 'queue'
  })

  return (
    <div className="flex h-full flex-col items-center justify-center overflow-y-auto bg-background p-6 text-ink">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <TargetPicker
          resolved={resolved}
          projects={projects}
          entries={entries}
          onPick={pickTarget}
        />
        {resolved?._tag === 'Project' ? <InstallNotice status={adapterStatus} /> : null}
        <div className="flex flex-col gap-1">
          {state.step === 'failed' ? (
            <p role="alert" className="mb-1 text-error text-sm">
              {state.reason}
            </p>
          ) : null}
          <form
            onDragOver={(event) => {
              if (resolved?._tag !== 'Project' || !event.dataTransfer.types.includes('Files'))
                return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
              setDragging(true)
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDragging(false)
              }
            }}
            onDrop={(event) => {
              event.preventDefault()
              setDragging(false)
              if (resolved?._tag === 'Project') void attachments.add(filesOf(event.dataTransfer))
            }}
            onSubmit={(event) => {
              event.preventDefault()
              send()
            }}
          >
            <div className="relative">
              {slashCommands.loading && (
                <div className="mb-1.5 flex items-center gap-2 px-1 text-muted-foreground text-xs">
                  <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />
                  Loading commands…
                </div>
              )}
              {completion.menu}
              <InputGroup
                className={dragging ? 'outline-1 outline-primary outline-solid' : undefined}
              >
                {dragging && (
                  <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md bg-background/85 text-foreground text-sm">
                    Drop to attach
                  </div>
                )}
                <InputGroupTextarea
                  ref={textareaRef}
                  className="min-h-20 max-h-60"
                  value={text}
                  disabled={resolved === null || sending}
                  placeholder={
                    resolved === null ? 'Add a project to start a thread' : 'Describe the work'
                  }
                  {...completion.textareaProps}
                  onPaste={(event) => {
                    const files = filesOf(event.clipboardData)
                    if (files.length === 0 || resolved?._tag !== 'Project') return
                    event.preventDefault()
                    void attachments.add(files)
                  }}
                  onKeyDown={(event) => {
                    if (completion.onKeyDown(event)) return
                    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing)
                      return
                    event.preventDefault()
                    send()
                  }}
                  aria-label="Message dia"
                />
                {attachments.drafts.length > 0 && project !== undefined && (
                  <InputGroupAddon align="block-start" className="flex-wrap gap-1.5 pt-1 pb-0">
                    {attachments.drafts.map((attachment) => (
                      <AttachmentChip
                        key={attachment.key}
                        draft={attachment}
                        cwd={project.directory}
                        onRemove={() => attachments.remove(attachment.key)}
                      />
                    ))}
                  </InputGroupAddon>
                )}
                <InputGroupAddon align="block-end">
                  {resolved?._tag === 'Project' ? (
                    <>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <InputGroupButton
                              type="button"
                              size="icon-xs"
                              variant="ghost"
                              className="-ml-1.5 translate-y-2.5"
                              aria-label="Attach files"
                              disabled={sending}
                              onClick={() => fileInputRef.current?.click()}
                            >
                              <Plus />
                            </InputGroupButton>
                          }
                        />
                        <TooltipContent>Attach files, or drop or paste them</TooltipContent>
                      </Tooltip>
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        hidden
                        tabIndex={-1}
                        onChange={(event) => {
                          const files = [...(event.currentTarget.files ?? [])]
                          event.currentTarget.value = ''
                          void attachments.add(files.map((file) => ({ file, isDirectory: false })))
                        }}
                      />
                    </>
                  ) : null}
                  <ComposerActionButton
                    action={action}
                    hint={['Send', 'Enter']}
                    onStop={() => {}}
                    onSubmit={send}
                  />
                </InputGroupAddon>
              </InputGroup>
            </div>
          </form>
          <div className="mt-1 flex min-w-0 items-center gap-0.5 pl-[5px]">
            {resolved?._tag === 'Project' && selection !== undefined ? (
              <>
                <ModelPicker value={selection} onChange={(next) => update({ selection: next })} />
                <ThinkingLevelSelect
                  value={thinkingLevel}
                  levels={thinkingLevels}
                  onChange={(level: ThinkingLevel) => update({ thinkingLevel: level })}
                />
                <PermissionModeSelect
                  value={permissionMode}
                  options={CREATE_PERMISSION_MODE_OPTIONS}
                  disabledModes={disabledPermissionModes}
                  onChange={(mode) => update({ permissionMode: mode === 'plan' ? null : mode })}
                />
              </>
            ) : null}
            {showsWorkspace && project !== undefined ? (
              <div className="ml-auto">
                <WorkspaceMenu
                  directory={project.directory}
                  worktree={worktree}
                  onWorktreeChange={(next: WorktreeStart | null) => update({ worktree: next })}
                  busyThread={busyThreadIn(
                    workspace,
                    project.directory,
                    (paneId) => summaries.get(paneId)?.status._tag === 'StatusWorking'
                  )}
                />
              </div>
            ) : null}
          </div>
          {state.step !== 'editing' && draft.sentAs !== null && worktree !== null ? (
            <div className="mt-3">
              <SetupSteps paneId={draft.sentAs} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
