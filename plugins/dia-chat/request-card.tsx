import { PermissionAnswer, PlanReviewAnswer, QuestionAnswer } from '@dia/plugin'
import type { RequestCardProps } from '@dia-plugin/dia-chat/slots'
import { ClarifyingQuestionCard } from './clarifying-question-card'
import { PermissionRequestCard } from './permission-request-card'
import { PlanReviewCard } from './plan-review-card'

/** Draws `request` with the card a pane uses for its kind and reports the answer as a `RunAnswer`. */
export function RequestCard({ request, onAnswer }: RequestCardProps) {
  switch (request._tag) {
    case 'PermissionRequest':
      return (
        <PermissionRequestCard
          request={request}
          onResolve={(response) => onAnswer(PermissionAnswer.make({ response }))}
        />
      )
    case 'ClarifyingQuestion':
      return (
        <ClarifyingQuestionCard
          request={request}
          onResolve={(response) => onAnswer(QuestionAnswer.make({ response }))}
        />
      )
    case 'PlanReview':
      return (
        <PlanReviewCard
          request={request}
          onResolve={(approved) => onAnswer(PlanReviewAnswer.make({ approved }))}
        />
      )
  }
}
