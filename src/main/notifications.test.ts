import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Session, SessionAttentionOpen } from '../shared/types';
import { WorkbenchNotifications } from './notifications';
import { setLanguage } from '../shared/i18n';

class Notice extends EventEmitter {
  closed = false;
  show() {}
  close() { this.closed = true; }
}
function session(status: Session['status']): Session {
  return { id: 'one', title: 'Review', providerId: 'codex', cwd: '/fixture', status, messages: [], approvals: [],
    createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z' };
}

test('notifications follow actual transitions once, track delivery failure, and focus the owning session', () => {
  const notices: Notice[] = []; const opened: SessionAttentionOpen[] = [];
  const manager = new WorkbenchNotifications(id => opened.push(id), { supported: true, create() { const notice = new Notice(); notices.push(notice); return notice; } });
  manager.observe({ sessions: [session('completed')] }); assert.equal(notices.length, 0);
  assert.equal(manager.status().state, 'idle');
  manager.observe({ sessions: [session('running')] });
  manager.observe({ sessions: [{ ...session('completed'), attention: { reason: 'result', seenRevision: 0, revision: 1, updatedAt: session('completed').updatedAt, messageId: 'first-result' } }] });
  manager.observe({ sessions: [session('completed')] }); assert.equal(notices.length, 1);
  assert.equal(manager.status().state, 'requested');
  notices[0].emit('failed', {}, 'codesign required'); assert.equal(manager.status().state, 'failed');
  assert.equal(manager.status().error, 'codesign required');
  const approval = { ...session('waiting_approval'), approvals: [{ id: 'approval', sessionId: 'one', title: 'Approval', detail: '', choices: [] }] };
  manager.observe({ sessions: [approval] }); manager.observe({ sessions: [approval] }); assert.equal(notices.length, 2);
  assert.equal(manager.status().state, 'requested');
  notices[1].emit('show'); assert.equal(manager.status().state, 'shown');
  const secondApproval = { ...approval.approvals[0], id: 'another-approval' };
  manager.observe({ sessions: [{ ...approval, approvals: [secondApproval] }] });
  notices[1].emit('click');
  notices[0].emit('click');
  assert.deepEqual(opened, [
    { sessionId: 'one', reason: 'approval', approvalId: 'approval', revision: undefined },
    { sessionId: 'one', reason: 'result', messageId: 'first-result', revision: 1 },
  ]);
  manager.dispose();
});

test('notification language changes apply to new notices without replaying prior transitions', async () => {
  const notices: { title: string; body: string; handle: Notice }[] = [];
  const manager = new WorkbenchNotifications(() => {}, { supported: true, create(input) {
    const handle = new Notice(); notices.push({ ...input, handle }); return handle;
  } });
  try {
    await setLanguage('zh-CN');
    const running = { ...session('running'), title: '用户自定义标题' };
    const completed = { ...running, status: 'completed' as const };
    manager.observe({ sessions: [running] }); manager.observe({ sessions: [completed] });
    assert.equal(notices[0].title, 'Agent 已完成');
    await setLanguage('en');
    manager.observe({ sessions: [completed] });
    assert.equal(notices.length, 1);
    manager.observe({ sessions: [{ ...running, approvals: [{ id: 'language-approval', sessionId: 'one', title: 'Approval', detail: '', choices: [] }] }] });
    assert.equal(notices[1].title, 'Agent needs approval');
    assert.equal(notices[1].body, '用户自定义标题 · codex');
    notices[1].handle.emit('failed');
    assert.match(manager.status().error ?? '', /could not show/);
    await setLanguage('zh-CN');
    assert.match(manager.status().error ?? '', /系统未能显示通知/);
  } finally { manager.dispose(); await setLanguage('zh-CN'); }
});
