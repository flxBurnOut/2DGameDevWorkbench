import assert from 'node:assert/strict';

export function verifyPlanningProgress(progress, requestKey) {
  let identities = 0;
  const create = () => `new-request-${++identities}`;
  assert.equal(requestKey(null, '', create), 'new-request-1');
  assert.equal(requestKey({request_key:'failed-request'}, 'failed-request', create), 'new-request-2', 'explicit unchanged replan must not return the old failure');
  assert.equal(requestKey({request_key:'failed-request'}, 'pending-request', create), 'pending-request', 'lost POST response must reuse its pending identity');
  assert.equal(requestKey(null, 'pending-request', create), 'pending-request', 'unconfirmed initial creation is also idempotent');
  assert.equal(identities, 2);
  const work = { status: 'planning', plan: null, messages: [], planning_calls: [] };
  const reply = (role, action, call) => ({ role, call, response: { action, summary: 'saved evidence' } });
  work.messages.push({ ...reply('motion', 'propose'), reused_from: { revision: 1, call: 2, request_id: 'original-call' } });
  assert.deepEqual(progress(work, 'motion'), { state: 'complete', label: '沿用第 1 版意见' });
  work.planning_calls.push({ role: 'appearance', state: 'completed' });
  work.messages.push(reply('appearance', 'inspect_reference', 1));
  assert.equal(progress(work, 'appearance').state, 'pending', 'a crop request is not a finished opinion');
  work.planning_calls.push({ role: 'appearance', state: 'submitting' });
  assert.equal(progress(work, 'appearance').state, 'running', 'current call overrides an earlier message');
  work.planning_calls[1].state = 'invalid_response'; work.status = 'planning_failed';
  assert.equal(progress(work, 'appearance').state, 'failed');
  assert.notEqual(progress(work, 'strategy').state, 'running');
  work.planning_calls.push({ role: 'coordinator', state: 'completed' });
  work.messages.push(reply('coordinator', 'finalize', 3), reply('validator', 'validation_feedback', 3));
  assert.equal(progress(work, 'coordinator').label, '已提交方案');
  assert.equal(progress(work, 'validator').label, '校验未通过', 'rejection must never show a pass');
  work.planning_calls.push({ role: 'coordinator', state: 'invalid_response' });
  assert.equal(progress(work, 'coordinator').state, 'failed', 'failed revision overrides the first valid reply');
  work.planning_calls[3].state = 'submitting';
  assert.equal(progress(work, 'coordinator').state, 'unknown', 'interrupted work never spins forever');
  work.planning_calls[3].state = 'outcome_unknown';
  assert.equal(progress(work, 'coordinator').label, '结果待核对');
  work.planning_calls[3].state = 'failed_request';
  assert.equal(progress(work, 'coordinator').state, 'failed');
  work.status = 'planning';
  assert.equal(progress(work, 'validator').label, '等待修订后校验');
  work.plan = { questions: ['关键目标冲突'] }; work.status = 'needs_input';
  assert.equal(progress(work, 'validator').state, 'blocked', 'questions do not pass execution validation');
  work.plan = { questions: [] }; work.status = 'ready';
  assert.equal(progress(work, 'validator').label, '校验通过', 'accepted plan supersedes old feedback');
  work.status = 'executing';
  assert.equal(progress(work, 'validator').state, 'complete');
  for (const status of ['planning_failed', 'budget_exhausted', 'needs_input']) {
    work.status = status; work.plan = null; work.planning_calls[3].state = 'submitting';
    for (const role of ['appearance', 'strategy', 'coordinator', 'validator'])
      assert.notEqual(progress(work, role).state, 'running');
  }
}
