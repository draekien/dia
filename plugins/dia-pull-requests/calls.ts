import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'
import { PullRequestUrl } from './pull-request-url'

/** A check on the pull request's head commit. `url` links to its details when GitHub has one. */
export const PullRequestCheck = Schema.Struct({
  name: Schema.String,
  state: Schema.Literals(['pending', 'passed', 'failed', 'skipped']),
  url: Schema.optionalKey(Schema.String)
})
/** A check on a pull request; see {@link PullRequestCheck}. */
export type PullRequestCheck = typeof PullRequestCheck.Type

/** A submitted review. `author` is the reviewer's login; `at` is epoch milliseconds. */
export const PullRequestReview = Schema.TaggedStruct('Review', {
  author: Schema.String,
  state: Schema.Literals(['approved', 'changes_requested', 'commented', 'dismissed']),
  body: Schema.String,
  at: Schema.Finite
})
/** A submitted review; see {@link PullRequestReview}. */
export type PullRequestReview = typeof PullRequestReview.Type

/** A comment on the pull request's conversation. `author` is a login; `at` is epoch milliseconds. */
export const PullRequestComment = Schema.TaggedStruct('Comment', {
  author: Schema.String,
  body: Schema.String,
  at: Schema.Finite
})
/** A conversation comment; see {@link PullRequestComment}. */
export type PullRequestComment = typeof PullRequestComment.Type

/** A review or a comment on a pull request. */
export const PullRequestActivity = Schema.Union([PullRequestReview, PullRequestComment])
/** A review or a comment; see {@link PullRequestActivity}. */
export type PullRequestActivity = typeof PullRequestActivity.Type

/** What dia shows about one pull request. `activity` is in ascending order of `at`. */
export const PullRequestDetails = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.Literals(['open', 'draft', 'merged', 'closed']),
  author: Schema.String,
  baseRef: Schema.String,
  headRef: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int,
  body: Schema.String,
  reviewDecision: Schema.optionalKey(
    Schema.Literals(['approved', 'changes_requested', 'review_required'])
  ),
  checks: Schema.Array(PullRequestCheck),
  activity: Schema.Array(PullRequestActivity)
})
/** One pull request's details; see {@link PullRequestDetails}. */
export type PullRequestDetails = typeof PullRequestDetails.Type

/** The first read of a linked pull request has not finished. */
export const PullRequestReading = Schema.TaggedStruct('Reading', {})
/** A first read in progress; see {@link PullRequestReading}. */
export type PullRequestReading = typeof PullRequestReading.Type

/** The last read succeeded at `at` (epoch milliseconds). */
export const PullRequestRead = Schema.TaggedStruct('Read', {
  details: PullRequestDetails,
  at: Schema.Finite
})
/** A successful read; see {@link PullRequestRead}. */
export type PullRequestRead = typeof PullRequestRead.Type

/** The last read failed; `message` is one line for the user. */
export const PullRequestReadFailed = Schema.TaggedStruct('ReadFailed', { message: Schema.String })
/** A failed read; see {@link PullRequestReadFailed}. */
export type PullRequestReadFailed = typeof PullRequestReadFailed.Type

/** What dia last learned about a linked pull request. */
export const PullRequestReadState = Schema.Union([
  PullRequestReading,
  PullRequestRead,
  PullRequestReadFailed
])
/** The outcome of the latest read; see {@link PullRequestReadState}. */
export type PullRequestReadState = typeof PullRequestReadState.Type

/** One linked pull request and what dia last learned about it. */
export const LinkedPullRequest = Schema.Struct({ url: PullRequestUrl, read: PullRequestReadState })
/** A linked pull request; see {@link LinkedPullRequest}. */
export type LinkedPullRequest = typeof LinkedPullRequest.Type

/** Run `runId`'s linked pull requests, oldest link first, now and after every change. */
export const FollowRunPullRequests = Rpc.make('FollowRunPullRequests', {
  payload: { runId: Schema.String },
  success: Schema.Array(LinkedPullRequest),
  stream: true
})

/** Removes the link; the pull request on GitHub is not changed. Unlinking an unlinked URL succeeds. */
export const UnlinkPullRequest = Rpc.make('UnlinkPullRequest', {
  payload: { runId: Schema.String, url: PullRequestUrl }
})

/** Reads the linked pull request again, whatever its state, and returns when the read ends. */
export const RefreshPullRequest = Rpc.make('RefreshPullRequest', {
  payload: { runId: Schema.String, url: PullRequestUrl }
})
