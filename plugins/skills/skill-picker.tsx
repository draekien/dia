import type { PluginServices } from '@dia/plugin'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  cn,
  followHost,
  Skeleton
} from '@dia/renderer-plugin'
import { useAtomValue } from '@effect/atom-react'
import { Cause, Option } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'
import { CheckIcon } from 'lucide-react'
import { WatchSkills } from './calls'
import type { SkillPickerProps } from './picker'
import type { Skill } from './registry'

/**
 * Makes the atom family that follows the skill list for the `skills` renderer entry `ctx`, one
 * atom per project directory. The key `''` means no project.
 */
export const makeSkillsFamily = (ctx: Pick<PluginServices, 'name'>) =>
  Atom.family((cwd: string) => Atom.make(followHost(ctx, WatchSkills, cwd === '' ? {} : { cwd })))

/** The atom family {@link makeSkillsFamily} makes; {@link SkillPicker} reads it. */
export type SkillsFamily = ReturnType<typeof makeSkillsFamily>

const groupsOf = (skills: ReadonlyArray<Skill>): ReadonlyArray<[string, ReadonlyArray<Skill>]> => {
  const groups = new Map<string, Array<Skill>>()
  for (const skill of skills) {
    const group = groups.get(skill.group)
    if (group === undefined) groups.set(skill.group, [skill])
    else group.push(skill)
  }
  return [...groups]
}

function SkillList({
  label,
  value,
  onChange,
  skills
}: Omit<SkillPickerProps, 'cwd'> & { readonly skills: ReadonlyArray<Skill> }) {
  const chosen = new Set(value)
  const known = new Set(skills.map((skill) => skill.name))
  const missing = value.filter((name) => !known.has(name))
  const toggle = (name: string) =>
    onChange(chosen.has(name) ? value.filter((each) => each !== name) : [...value, name])
  const check = (name: string) => (
    <>
      <CheckIcon className={cn(!chosen.has(name) && 'invisible')} />
      <span className="sr-only">{chosen.has(name) ? 'Selected,' : 'Not selected,'}</span>
    </>
  )

  return (
    <div className="flex flex-col gap-1.5">
      <Command label={label} className="border">
        <CommandInput placeholder="Search skills" />
        <CommandList className="max-h-64">
          <CommandEmpty>No skill matches.</CommandEmpty>
          {missing.length === 0 ? null : (
            <CommandGroup heading="Missing">
              {missing.map((name) => (
                <CommandItem
                  key={`missing/${name}`}
                  value={`missing/${name}`}
                  keywords={[name]}
                  onSelect={() => toggle(name)}
                >
                  {check(name)}
                  <span className="truncate font-mono text-xs">{name}</span>
                  <span className="text-xs text-ink-muted">(missing)</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {groupsOf(skills).map(([group, members]) => (
            <CommandGroup key={group} heading={group}>
              {members.map((skill) => (
                <CommandItem
                  key={`${group}/${skill.name}`}
                  value={`${group}/${skill.name}`}
                  keywords={[skill.name, skill.description]}
                  onSelect={() => toggle(skill.name)}
                >
                  {check(skill.name)}
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-mono text-xs">{skill.name}</span>
                    {skill.description === '' ? null : (
                      <span className="truncate text-xs text-ink-muted" title={skill.description}>
                        {skill.description}
                      </span>
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
      <p className="text-xs text-ink-muted">
        {value.length === 0
          ? 'None selected: sessions get every skill.'
          : `${value.length} selected`}
      </p>
    </div>
  )
}

/**
 * The skill picker: every registered skill under its group, with a search box, and the chosen
 * names checked. Chosen names no skill has are listed first as `(missing)`. It follows
 * `skillsFamily` while shown.
 */
export function SkillPicker({
  skillsFamily,
  cwd,
  ...props
}: SkillPickerProps & { readonly skillsFamily: SkillsFamily }) {
  const result = useAtomValue(skillsFamily(cwd ?? ''))
  return AsyncResult.match(result, {
    onInitial: () => <Skeleton className="h-40 w-full" aria-busy="true" />,
    onFailure: ({ cause }) => (
      <p className="text-xs text-error">
        {Cause.prettyErrors(cause)[0]?.message ?? 'Could not list the skills.'}
      </p>
    ),
    onSuccess: ({ value }) =>
      Option.match(value, {
        onNone: () => (
          <p className="text-xs text-ink-muted">The skills plugin's host entry is not loaded.</p>
        ),
        onSome: (skills) => <SkillList {...props} skills={skills} />
      })
  })
}
