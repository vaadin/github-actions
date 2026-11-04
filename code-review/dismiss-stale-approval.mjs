#!/usr/bin/env node
/**
 * Dismiss the automatic approvals of the code-review action that a push made
 * stale.
 *
 * Runs in the code-review action in the dismiss-stale-approval mode, on the
 * synchronize event of the PR: dismisses each approval of the token's
 * identity made on a commit other than the PR head. The other approvals,
 * human ones included, stay.
 *
 * Reads from the environment (set by GitHub Actions):
 *   PR_NUMBER / argv[2]  pull request number
 *   GITHUB_REPOSITORY    owner/repo
 *   GH_TOKEN             token for the gh CLI; the identity the review
 *                        approves as
 *
 * Usage:
 *   node code-review/dismiss-stale-approval.mjs <pr-number>
 */

import { dismissApprovals, prArguments } from './post-review.mjs';

const { prNumber, repo } = prArguments();
if (!dismissApprovals(repo, prNumber)) {
  console.log('Auto-approve: no stale automatic approvals');
}
