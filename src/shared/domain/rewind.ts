import { Schema } from 'effect'

/**
 * Why a rewind did not complete. `NoLiveSession`, `TurnNotInTranscript` and `FilesNotRewound`
 * leave files and conversation unchanged; `ConversationNotBranched` means the files were already
 * rewound but the conversation was not branched; `Interrupted` means the rewind stopped before
 * the Agent SDK reported the files rewound, so the files may or may not have been restored.
 */
export const RewindFailureCause = Schema.Literals([
  'NoLiveSession',
  'TurnNotInTranscript',
  'FilesNotRewound',
  'ConversationNotBranched',
  'Interrupted'
])
/** A {@link RewindFailureCause} value. */
export type RewindFailureCause = typeof RewindFailureCause.Type
