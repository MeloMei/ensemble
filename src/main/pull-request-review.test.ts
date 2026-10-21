import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePullRequestReview } from './pull-request-review';

test('read-only PR projection retains HEAD and distinct pending, cancelled and action-required checks', () => {
  const review = parsePullRequestReview({ url: 'https://github.com/example/repo/pull/1', number: 1, title: 'Change', state: 'OPEN', headRefOid: 'abc123',
    reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [
      { name: 'Running', status: 'IN_PROGRESS', conclusion: null },
      { name: 'Cancelled', status: 'COMPLETED', conclusion: 'CANCELLED' },
      { context: 'Manual', state: 'PENDING', targetUrl: 'https://ci.example.invalid/' },
    ] });
  assert.equal(review.headSha, 'abc123'); assert(review.checkedAt);
  assert.deepEqual(review.checks?.map(check => [check.status, check.conclusion]), [['IN_PROGRESS', undefined], ['COMPLETED', 'CANCELLED'], ['PENDING', undefined]]);
});
