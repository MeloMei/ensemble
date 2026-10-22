# Your first collaboration

English | [简体中文](first-collaboration.zh-CN.md)

Use two participants to fix a small search function and review the change. You can assign Codex to both roles; each gets its own session and permissions.

The application guides you through **填写目标 → 检查分工 → 开始协作**: describe the goal, review the setup, then start. [Watch the workflow](media/ensemble-demo.mp4).

## 1. Prepare a small project

You need Ensemble running, Node.js 22.22 or newer, Git, and a configured runtime that supports read-only execution. See [Getting started](getting-started.md) and the [official runtime guides](runtimes.md#install-and-configure).

Create a new folder named `ensemble-search-demo`, with these files:

```text
ensemble-search-demo/
├── package.json
├── src/search.js
└── test/search.test.js
```

Save this as `package.json`:

```json
{
  "name": "ensemble-search-demo",
  "private": true,
  "type": "module"
}
```

Save this as `src/search.js`. The initial function does not trim the query:

```js
export function searchItems(items, query) {
  const value = query.toLowerCase();
  return items.filter(item => item.title.toLowerCase().includes(value));
}
```

Save this as `test/search.test.js`. This file describes the required behavior with three focused checks:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchItems } from '../src/search.js';

const items = [
  { id: 'canvas', title: 'Agent Canvas' },
  { id: 'notes', title: 'Release Notes' },
];

test('trims the keyword and matches without case sensitivity', () => {
  assert.deepEqual(searchItems(items, '  AGENT  '), [items[0]]);
});

test('blank input shows every item', () => {
  assert.deepEqual(searchItems(items, '   '), items);
});

test('keeps the original items unchanged', () => {
  const before = structuredClone(items);
  searchItems(items, 'release');
  assert.deepEqual(items, before);
});
```

In the example directory, create the Git baseline so the final change can be inspected as a diff:

```sh
git init
git add package.json src/search.js test/search.test.js
git commit -m "Add search example"
```

Git may ask you to configure your own author name and email if you have not done that before. No npm dependencies are needed for this example.

## 2. Describe the goal

In Ensemble, choose **新建工作区** and select the example directory. Open **协作**, then choose **实现与审阅**.

Paste this into **任务目标**:

```text
Fix searchItems in src/search.js.

Requirements:
- Ignore leading and trailing whitespace in the query.
- Match titles without case sensitivity.
- Return all items for an empty or whitespace-only query.
- Leave the input array and item objects unchanged.

The implementer should modify only src/search.js, leave the test unchanged,
and run only: node --test test/search.test.js
Report the actual check result. Do not commit the change.

The reviewer should inspect the changed file and the recorded check result
read-only. Report defects or missing coverage with concrete file locations.
Do not modify files. Reuse passed checks unless a specific concern requires
further verification.
```

Select the runtime and model for **实现者** and **审阅者**. The same Codex installation can serve both roles. The reviewer list only offers runtimes that support read-only execution; DeepSeek Harness cannot fill that role.

If no suitable runtime is available, choose **接入与登录帮助**, follow the official setup guide, and select **刷新检测**. Close the help dialog to continue. A discovered entry does not confirm sign-in or model access.

## 3. Review the setup

Choose **检查分工**. You can adjust the full configuration before saving.

| Check | Expected setup |
| --- | --- |
| Project and execution directory | Your `ensemble-search-demo` folder |
| Implementer | May modify the authorized project; approvals follow the runtime |
| Reviewer | Read-only |
| First task | **实现目标**, assigned to the implementer |
| Second task | **审阅改动**, assigned to the reviewer and waiting for **实现目标** |
| Completion | Finish after all submitted tasks complete |

The template does not grant permission to dispatch more tasks, send collaboration messages, publish artifacts, or change the run configuration. Both tasks receive the shared goal. The reviewer also receives the preceding task output.

Choose **保存并查看协作**. This saves a draft run. It does not execute the tasks yet.

## 4. Start and follow the work

Choose **开始协作** when you are ready to use the selected model accounts. Model requests and charges follow those accounts; the template is not a cost cap.

Open **任务与数据流** to follow the two tasks. Implementation runs first. Review waits for its dependency and then starts in the same project.

Select a task to inspect its requirements, state, result, and execution attempts. **打开真实会话** takes you to its conversation. If it is waiting for approval, inspect the requested operation there before responding. If a task fails, read the recorded error before choosing whether to retry.

A read-only reviewer checks the code and available results. It is not expected to rerun shell commands that its permission mode blocks.

## 5. Inspect the result

From the task details, choose **打开真实会话** to return to the workspace. In **文件与改动**, open **改动** and select `src/search.js`. Ensemble opens the actual Git diff.

Read the check result recorded by the implementer. Reuse a passed result while the code and environment are unchanged. If the result is missing or a concrete concern requires verification, run the same focused command in the example directory:

```sh
node --test test/search.test.js
```

The example is complete when:

- The diff contains only the intended change to `src/search.js`.
- The focused check passes without changing its expectations.
- The reviewer has explained its inspection and any findings.
- You have read the review and inspected the file change yourself.

Task completion records execution status. Read the output and review findings before keeping the change.

For another arrangement, choose **自定义协作**. Individual sessions, terminals, and previews remain available from the workspace. See [Getting started](getting-started.md) for drafts and backend controls.
