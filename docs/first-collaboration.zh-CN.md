# 第一次协作

[English](first-collaboration.md) | 简体中文

用两位参与者修复一个小搜索函数，再审阅实际改动。同一套 Codex 安装可以承担两个角色，各自使用独立会话和权限。

直接在关系图上编辑团队分工，保存草稿后再开始协作。[30 秒中文概览](media/ensemble-overview-zh-CN.mp4)介绍了这个示例；当前界面的具体操作以下面的图编辑器步骤为准。

本教程使用简体中文。新建协作前，可以在 **偏好设置**（Preferences）中选择 **简体中文**，也可以选择 **English** 或 **跟随系统**。首次启动跟随系统语言，选择会保存在本机。已有对话、任务内容、代码和运行时诊断保留原文。下文中的角色和任务名称对应新建的中文模板。

## 1. 准备示例项目

需要已启动的 Ensemble、Node.js 22.22 或更新版本、Git，以及一个已配置且支持只读执行的运行时。这里的 Node.js 用于运行示例测试；安装包中的桌面应用不要求另装 Node.js。安装步骤见[下载与开始使用](../README.zh-CN.md#开始使用)和[官方运行时指南](runtimes.zh-CN.md#安装与配置)。

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

在 Ensemble 中点击 **新建工作区**，选择示例目录。进入 **协作**，第一次会直接显示可编辑的 **实现与审阅** 关系图。如果已有保存的协作，点击 **新建协作** 打开新图。检查画布上方的 **项目目录**。

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

点击 **实现者** 节点，在右侧面板选择 **运行时** 和模型，并核对 **职责与交付要求**。再点击 **审阅者** 节点，完成同样的设置。同一套 Codex 安装也可以承担两个角色。审阅者需要支持只读执行的运行时，DeepSeek Harness 不能担任这个角色。不支持的权限会显示为权限问题，并阻止保存。

没有合适运行时时，点击工具栏中标为 **协作设置** 的齿轮，再点击面板中的 **接入与登录帮助**。按照官方指南完成配置，在运行时设置中点击 **刷新检测**，关闭设置后回到关系图。发现入口不代表登录状态或模型访问已经通过验证。

## 3. 编辑分工并核对顺序

直接在画布上调整配置。点击 Agent 节点，可以编辑名称、运行时、模型、职责和预设任务。展开面板中的 **连接、权限与高级设置**，检查文件权限和协作权限。点击 **新增 Agent**，即可继续向同一张图添加参与者。

点击两位 Agent 之间的连线，可以修改方向、关系类型和显示名称。关系用于说明分工；选为 **监督** 不会自动审阅或控制其他 Agent。

切到 **执行顺序** 查看任务依赖。点击任务编辑内容，或从前置任务连到需要等待它的任务。这个示例中，**审阅改动** 必须依赖 **实现目标**。打开 **协作设置**，可以检查结束条件和运行限制。

| 核对项 | 预期配置 |
| --- | --- |
| 项目与执行目录 | 你的 `ensemble-search-demo` 目录 |
| 实现者 | 可以修改授权项目，审批遵循运行时规则 |
| 审阅者 | 只读 |
| 第一项任务 | **实现目标**，交给实现者 |
| 第二项任务 | **审阅改动**，交给审阅者，等待 **实现目标** 完成 |
| 结束条件 | 全部已提交任务完成后结束 |

模板没有授予继续派工、发送协作消息、发布产物或调整配置的权限。两项任务都会收到共同目标，审阅者还会收到前序任务的输出。

点击 **保存草稿**。保存后的协作会保留图的布局，等待你手动启动。

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

需要其他分工方式时，新建协作并点击画布上的 **从空白开始**，也可以直接修改模板、添加 Agent。工作区中的单 Agent 会话、终端和预览仍可照常使用。草稿和后台控制见[入门指南](getting-started.zh-CN.md)。
