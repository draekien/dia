import type { PermissionMode } from '@shared/domain/pane'
import { useEffect, useState } from 'react'

/**
 * The permission modes the settings of agent adapter `adapter` (an adapter id) turn off for an
 * agent working in `cwd`, read through `window.dia.adapter` when the component mounts and whenever
 * `adapter` or `cwd` changes. Returns an
 * empty list until the answer arrives, and when it cannot be read.
 */
export function useDisabledPermissionModes(
  adapter: string,
  cwd: string
): ReadonlyArray<PermissionMode> {
  const [disabled, setDisabled] = useState<ReadonlyArray<PermissionMode>>([])

  useEffect(() => {
    let current = true
    window.dia.adapter.getDisabledPermissionModes(adapter, cwd).then(
      (modes) => {
        if (current) setDisabled(modes)
      },
      () => undefined
    )
    return () => {
      current = false
    }
  }, [adapter, cwd])

  return disabled
}
