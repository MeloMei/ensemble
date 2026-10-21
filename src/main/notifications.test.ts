import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Session } from '../shared/types';
import { WorkbenchNotifications } from './notifications';

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
  const notices: Notice[] = []; const opened: string[] = [];
  const manager = new WorkbenchNotifications(id => opened.push(id), { supported: true, create() { const notice = new Notice(); notices.push(notice); return notice; } });
  manager.observe({ sessions: [session('completed')] }); assert.equal(notices.length, 0);
  assert.equal(manager.status().state, 'idle');
  manager.observe({ sessions: [session('running')] }); manager.observe({ sessions: [session('completed')] });
  manager.observe({ sessions: [session('completed')] }); assert.equal(notices.length, 1);
  assert.equal(manager.status().state, 'requested');
  notices[0].emit('failed', {}, 'codesign required'); assert.equal(manager.status().state, 'failed');
  assert.equal(manager.status().error, 'codesign required');
  const approval = { ...session('waiting_approval'), approvals: [{ id: 'approval', sessionId: 'one', title: 'Approval', detail: '', choices: [] }] };
  manager.observe({ sessions: [approval] }); manager.observe({ sessions: [approval] }); assert.equal(notices.length, 2);
  assert.equal(manager.status().state, 'requested');
  notices[1].emit('show'); assert.equal(manager.status().state, 'shown');
  notices[1].emit('click'); assert.deepEqual(opened, ['one']);
  manager.dispose();
});
