# 第一次协作

[English](first-collaboration.md) | 简体中文

用两位参与者修复一个小搜索函数，再审阅实际改动。同一套 Codex 安装可以承担两个角色，各自使用独立会话和权限。

应用会依次引导你完成 **填写目标 → 检查分工 → 开始协作**。[查看流程演示](media/ensemble-demo.mp4)。视频录制于 Ensemble 0.7.0，使用当时的简体中文界面。

本教程使用简体中文。新建协作前，可以在 **偏好设置**（Preferences）中选择 **简体中文**，也可以选择 **English** 或 **跟随系统**。首次启动跟随系统语言，选择会保存在本机。已有对话、任务内容、代码和运行时诊断保留原文。下文中的角色和任务名称对应新建的中文模板。

## 1. 准备示例项目

需要已启动的 Ensemble、Node.js 22.22 或更新版本、Git，以及一个已配置且支持只读执行的运行时。安装步骤见[入门指南](getting-started.zh-CN.md)和[官方运行时指南](runtimes.zh-CN.md#安装与配置)。

新建 `ensemble-search-demo` 目录，准备以下文件：

```text
ensemble-search-demo/
├── package.json
├── src/search.js
└── test/search.test.js
```

将以下内容保存为 `package.json`：

```json
{
  "name": "ensemble-search-demo",
  "private": true,
  "type": "module"
}
```

将以下内容保存为 `src/search.js`。初始函数没有去掉关键词首尾的空白：

```js
export function searchItems(items, query) {
  const value = query.toLowerCase();
  return items.filter(item => item.title.toLowerCase().includes(value));
}
```

将以下内容保存为 `test/search.test.js`。这个文件用三项局部检查描述需要满足的行为：

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

在示例目录中建立 Git 基线，便于最后查看实际差异：

```sh
git init
git add package.json src/search.js test/search.test.js
git commit -m "Add search example"
```

如果还没有配置 Git 作者信息，Git 会提示你填写自己的姓名和邮箱。这个示例不需要安装 npm 依赖。

## 2. 填写目标

在 Ensemble 中点击 **新建工作区**，选择示例目录。进入 **协作**，选择 **实现与审阅**。

将以下内容填入 **任务目标**：

```text
修复 src/search.js 中的 searchItems。

要求：
- 忽略关键词首尾空白。
- 匹配标题时忽略大小写。
- 关键词为空或只有空白时，返回全部项目。
- 不修改原数组和其中的对象。

实现者只修改 src/search.js，不改测试，只运行：
node --test test/search.test.js
说明实际检查结果，不要提交改动。

审阅者只读检查实际文件变化和已有检查结果。
如有缺陷或遗漏，指出具体文件位置。
不要修改文件。复用已通过的检查，仅在发现具体疑点时补充必要验证。
```

为 **实现者** 和 **审阅者** 选择运行时及模型。同一套 Codex 安装也可以承担两个角色。审阅者列表只提供支持只读执行的运行时，DeepSeek Harness 不能担任这个角色。

没有合适运行时时，打开 **接入与登录帮助**，按照官方指南完成配置后点击 **刷新检测**。关闭帮助窗口即可继续填写。发现入口不代表登录状态或模型访问已经通过验证。

## 3. 检查分工

点击 **检查分工**。保存前仍可调整完整配置。

| 核对项 | 预期配置 |
| --- | --- |
| 项目与执行目录 | 你的 `ensemble-search-demo` 目录 |
| 实现者 | 可以修改授权项目，审批遵循运行时规则 |
| 审阅者 | 只读 |
| 第一项任务 | **实现目标**，交给实现者 |
| 第二项任务 | **审阅改动**，交给审阅者，等待 **实现目标** 完成 |
| 结束条件 | 全部已提交任务完成后结束 |

模板没有授予继续派工、发送协作消息、发布产物或调整配置的权限。两项任务都会收到共同目标，审阅者还会收到前序任务的输出。

点击 **保存并查看协作**。此时只保存草稿协作，还没有执行任务。

## 4. 开始并跟踪执行

准备好使用所选模型账户后，点击 **开始协作**。模型请求和费用沿用这些账户，模板不提供费用硬上限。

打开 **任务与数据流** 查看两项任务。实现先执行，审阅等待依赖完成后，在同一项目中继续。

点击任务可以查看要求、状态、结果和执行尝试。**打开真实会话** 会进入对应对话。遇到等待审批时，在会话中检查请求的操作后再回应。任务失败时，先看记录中的错误，再决定是否重试。

只读审阅者负责检查代码和已有结果，不要求它重新运行权限模式禁止的 shell 命令。

## 5. 检查结果

从任务详情点击 **打开真实会话**，返回工作区。在 **文件与改动** 中切到 **改动**，选择 `src/search.js`，查看实际 Git Diff。

查看实现者记录的局部检查结果。代码和环境未变化时，直接复用已通过的结果；结果缺失或有与本次改动相关的疑点时，再运行同一条命令：

```sh
node --test test/search.test.js
```

满足以下条件后，这个示例才算完成：

- Diff 只包含对 `src/search.js` 的预期修改。
- 局部检查通过，测试要求没有被改动。
- 审阅者说明了检查范围和发现的问题。
- 你已经读过审阅意见，并检查了实际文件差异。

任务完成状态记录的是执行结果，保留改动前仍需阅读输出和审阅意见。

需要其他分工方式时，选择 **自定义协作**。工作区中的单 Agent 会话、终端和预览仍可照常使用。草稿和后台控制见[入门指南](getting-started.zh-CN.md)。
