# Your first collaboration

English | [简体中文](first-collaboration.zh-CN.md)

Use two participants to fix a small search function and review the change. You can assign Codex to both roles; each gets its own session and permissions.

Create the team directly on an editable graph, save a draft, then start the collaboration. The [30-second English overview](media/ensemble-overview-en.mp4) introduces the example; follow the graph-editor steps below for the current interface.

These instructions use English. Open **Preferences** (偏好设置) and select **English** before creating the collaboration. You can also choose **简体中文** or **Follow system**; the first launch follows your system language, and your choice is saved locally. Existing conversations, task text, code, and runtime diagnostics keep their original language. The task and role names below belong to a newly created English template.

## 1. Prepare a small project

You need Ensemble running, Node.js 22.22 or newer, Git, and a configured runtime that supports read-only execution. Node.js runs this example's tests; the packaged desktop app does not require a separate Node.js installation. See [Download and setup](../README.md#get-started) and the [official runtime guides](runtimes.md#install-and-configure).

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

In Ensemble, choose **New workspace** and select the example directory. Open **Collaboration**. The first collaboration opens directly as an editable **Implement and review** graph. If you already have saved collaborations, choose **New collaboration** to open a new graph. Check the **Project directory** above the canvas.

Paste this into **Task goal**:

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

Click the **Implementer** node. In the panel on the right, select its **Runtime** and model, then check **Responsibilities and deliverables**. Do the same for **Reviewer**. The same Codex installation can serve both roles. The reviewer needs a runtime that supports read-only execution; DeepSeek Harness cannot fill that role. Unsupported permissions prevent saving and are shown as permission issues.

If no suitable runtime is available, open the toolbar gear labeled **Collaboration settings**, then choose **Setup and sign-in help** in its panel. Follow the official setup guide and select **Refresh detection** in runtime settings. Close settings to return to the graph. A discovered entry does not confirm sign-in or model access.

## 3. Edit the graph and check the order

Stay on the canvas to adjust the setup. Click an agent node to edit its name, runtime, model, responsibilities and preset tasks. Expand **Connection, permissions and advanced settings** in that panel to check file access and collaboration permissions. **Add agent** places another participant on the same canvas.

Click the connection between the two agents to edit its direction, type or display label. Relationships describe responsibilities. A **Supervises** relationship does not automatically review or control another agent.

Switch to **Execution order** to check task dependencies. Click a task to edit it, or drag from an earlier task to the task that should wait for it. In this example, **Review the changes** must depend on **Implement the goal**. Open **Collaboration settings** to check the completion condition and run limits.

| Check | Expected setup |
| --- | --- |
| Project and execution directory | Your `ensemble-search-demo` folder |
| Implementer | May modify the authorized project; approvals follow the runtime |
| Reviewer | Read-only |
| First task | **Implement the goal**, assigned to the implementer |
| Second task | **Review the changes**, assigned to the reviewer and waiting for **Implement the goal** |
| Completion | Finish after all submitted tasks complete |

The template does not grant permission to dispatch more tasks, send collaboration messages, publish artifacts, or change the run configuration. Both tasks receive the shared goal. The reviewer also receives the preceding task output.

Choose **Save draft**. The saved collaboration keeps the graph layout and waits for you to start it explicitly.

## 4. Start and follow the work

Choose **Start collaboration** when you are ready to use the selected model accounts. Model requests and charges follow those accounts; the template is not a cost cap.

Open **Tasks and data flow** to follow the two tasks. Implementation runs first. Review waits for its dependency and then starts in the same project.

Select a task to inspect its requirements, state, result, and execution attempts. **Open actual session** takes you to its conversation. If it is waiting for approval, inspect the requested operation there before responding. If a task fails, read the recorded error before choosing whether to retry.

A read-only reviewer checks the code and available results. It is not expected to rerun shell commands that its permission mode blocks.

## 5. Inspect the result

From the task details, choose **Open actual session** to return to the workspace. In **Files and changes**, open **Changes** and select `src/search.js`. Ensemble opens the actual Git diff.

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

For another arrangement, create a new collaboration and choose **Start blank** on the canvas, or edit the template and add agents. Individual sessions, terminals, and previews remain available from the workspace. See [Getting started](getting-started.md) for drafts and backend controls.
