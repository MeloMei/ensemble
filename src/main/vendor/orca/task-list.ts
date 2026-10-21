// Extracted from Orca src/shared/native-chat-task-list.ts:1-70 at 36913fd4f556c44495ed6da5cd6a81910c3cde21.
// Copyright (c) 2026 Lovecast Inc. MIT; see licenses/Orca-MIT.txt.
export type NativeChatTaskStatus = 'pending' | 'in_progress' | 'completed'
export type NativeChatTask = {
  content: string
  status: NativeChatTaskStatus
  activeForm?: string
}
export type NativeChatTaskList = { tasks: NativeChatTask[]; explanation?: string }
export type NativeChatTaskChange = {
  kind: 'added' | 'removed' | 'started' | 'completed' | 'pending' | 'updated'
  task: NativeChatTask
}
export type NativeChatTaskListTool = 'todowrite' | 'update_plan'

export function nativeChatTaskListTool(name: string): NativeChatTaskListTool | null {
  const normalized = name.trim().toLowerCase()
  return normalized === 'todowrite' || normalized === 'update_plan' ? normalized : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function normalizeNativeChatTaskList(
  name: string,
  input: unknown
): NativeChatTaskList | null {
  const tool = nativeChatTaskListTool(name)
  if (!tool) {
    return null
  }
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input)
    } catch {
      return null
    }
  }
  const value = record(input)
  const entries = tool === 'todowrite' ? value?.todos : value?.plan
  if (!Array.isArray(entries)) {
    return null
  }
  const tasks: NativeChatTask[] = []
  for (const entry of entries) {
    const item = record(entry)
    const content = nonemptyString(tool === 'todowrite' ? item?.content : item?.step)
    if (!item || !content) {
      continue
    }
    const status =
      item.status === 'in_progress' || (tool === 'update_plan' && item.status === 'inProgress')
        ? 'in_progress'
        : item.status === 'completed'
          ? 'completed'
          : 'pending'
    const activeForm = tool === 'todowrite' ? nonemptyString(item.activeForm) : undefined
    tasks.push({ content, status, ...(activeForm ? { activeForm } : {}) })
  }
  if (entries.length > 0 && tasks.length === 0) {
    return null
  }
  const explanation = tool === 'update_plan' ? nonemptyString(value?.explanation) : undefined
  return { tasks, ...(explanation ? { explanation } : {}) }
}
