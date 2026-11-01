import type { AttachmentType } from '@shared/domain/attachment'
import { useEffect, useState } from 'react'

/**
 * The file types the agent adapter accepts as content blocks, read through `window.dia.adapter`
 * when the component mounts. Returns an empty list until the answer arrives, and when it cannot be
 * read; with an empty list every attached file is sent as its path.
 */
export function useAttachmentTypes(): ReadonlyArray<AttachmentType> {
  const [types, setTypes] = useState<ReadonlyArray<AttachmentType>>([])

  useEffect(() => {
    let current = true
    window.dia.adapter.getAttachmentTypes().then(
      (accepted) => {
        if (current) setTypes(accepted)
      },
      () => undefined
    )
    return () => {
      current = false
    }
  }, [])

  return types
}
