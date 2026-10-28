import { SelectItem } from '@renderer/components/ui/select'
import type { PermissionModeOption } from '@renderer/lib/permission-modes'
import type { PermissionMode } from '@shared/domain/pane'

/**
 * The items of a permission-mode `Select`, one per option, each showing its label over its
 * description. The item text includes the description, so give the `SelectValue` the label
 * (`permissionModeLabel`) as its children.
 */
export function PermissionModeItems({
  options
}: {
  readonly options: ReadonlyArray<PermissionModeOption<PermissionMode>>
}) {
  return options.map((option) => (
    <SelectItem key={option.value} value={option.value} className="max-w-72">
      <span className="flex flex-col items-start gap-0.5">
        <span>{option.label}</span>
        <span className="text-xs text-muted-foreground">{option.description}</span>
      </span>
    </SelectItem>
  ))
}
