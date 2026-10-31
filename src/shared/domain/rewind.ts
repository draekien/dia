import { Schema } from 'effect'

/**
 * Why a rewind did not complete. `NoLiveSession`, `TurnNotInTranscript` and `FilesNotRewound`
 * leave files and conversation unchanged; `ConversationNotBranched` means the files were already
 * rewound but the conversation was not branched; `Interrupted` means the rewind stopped before
 * any file was rewound.
 */
export const RewindFailureCause = Schema.Literals([
  'NoLiveSession',
  'TurnNotInTranscript',
  'FilesNotRewound',
  'ConversationNotBranched',
  'Interrupted'
])
export type RewindFailureCause = typeof RewindFailureCause.Type
