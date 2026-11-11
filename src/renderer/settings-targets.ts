import type { TFunction } from 'i18next';
import { shortcutActionIds, shortcutActions, shortcutSearchText, type ShortcutAction } from './app-shortcuts';

export type SettingsSection = 'general' | 'providers' | 'project' | 'session' | 'shortcuts' | 'remote';

export const settingsTargets = [
  { id: 'language', section: 'general', label: 'preferences.language', keywords: '语言 中文 English locale' },
  { id: 'dictation-language', section: 'general', label: 'workspace:dictation.settings.language', keywords: '听写 麦克风 dictation microphone speech locale' },
  { id: 'theme', section: 'general', label: 'preferences.theme', keywords: '外观 深色 浅色 dark light appearance' },
  { id: 'text-size', section: 'general', label: 'preferences.textSize', keywords: '外观 字体 字号 font scale appearance' },
  { id: 'code-font', section: 'general', label: 'preferences.codeFont', keywords: '外观 字体 代码 等宽 monospace editor appearance' },
  { id: 'code-size', section: 'general', label: 'preferences.codeSize', keywords: '外观 字号 代码 等宽 monospace editor appearance' },
  { id: 'reduce-motion', section: 'general', label: 'preferences.reduceMotion', keywords: '外观 动效 动画 辅助功能 animation accessibility appearance' },
  { id: 'updates', section: 'general', label: 'settings.search.updates', keywords: '更新 版本 version upgrade' },
  { id: 'notification-enabled', section: 'general', label: 'settings.notifications.enabled', keywords: '通知 桌面 desktop banner alerts' },
  { id: 'notification-backgroundOnly', section: 'general', label: 'settings.notifications.backgroundOnly', keywords: '通知 后台 background foreground' },
  { id: 'notification-approvals', section: 'general', label: 'settings.notifications.approvals', keywords: '通知 审批 请求 permission approval' },
  { id: 'notification-results', section: 'general', label: 'settings.notifications.results', keywords: '通知 结果 完成 completed result' },
  { id: 'notification-failures', section: 'general', label: 'settings.notifications.failures', keywords: '通知 失败 failed error' },
  { id: 'notification-sound', section: 'general', label: 'settings.notifications.sound', keywords: '通知 声音 sound mute' },
  { id: 'notification-afterQuit', section: 'general', label: 'settings.notifications.afterQuit', keywords: '通知 退出 后台 notifications quit background macOS' },
  { id: 'window-capture', section: 'general', label: 'settings.capture.shortcut', keywords: '截图 窗口 shortcut capture window screenshot' },
  { id: 'providers', section: 'providers', label: 'app.providers', keywords: '运行时 Agent runtime provider' },
  { id: 'remote-devices', section: 'remote', label: 'remote.title', keywords: '远程 设备 remote device ssh' },
  { id: 'project-path', section: 'project', label: 'settings.projectScope', keywords: '项目 目录 workspace path' },
  { id: 'project-skills', section: 'project', label: 'settings.search.skills', keywords: '技能 Skills tool 项目 workspace' },
  { id: 'project-mcp', section: 'project', label: 'settings.search.mcp', keywords: '项目 服务 MCP server' },
  { id: 'session-skills', section: 'session', label: 'settings.search.sessionSkills', keywords: '会话 技能 session skill' },
  ...shortcutActionIds.map(action => ({
    id: `shortcut-${action}`, section: 'shortcuts', label: shortcutActions[action].label,
    keywords: `快捷键 keyboard shortcut ${shortcutActions[action].keywords}`, shortcut: action,
  } as const)),
] as const satisfies readonly { id: string; section: SettingsSection; label: string; keywords: string }[];

export type SettingsTarget = Pick<typeof settingsTargets[number], 'id' | 'section'>;

const sectionLabels: Record<SettingsSection, string> = {
  general: 'settings.general', providers: 'app.providers', project: 'settings.project', session: 'settings.session', shortcuts: 'shortcuts.title', remote: 'remote.title',
};

export function searchableSettings(t: TFunction<'shell'>, workspace?: string, session?: string, binding?: (action: ShortcutAction) => string | undefined) {
  return settingsTargets.flatMap(target => {
    if (target.id === 'window-capture' && !navigator.platform.startsWith('Mac')) return [];
    if ((target.section === 'project' && !workspace) || (target.section === 'session' && !session)) return [];
    const scope = target.section === 'project' ? workspace : target.section === 'session' ? session : undefined;
    const keys = 'shortcut' in target ? shortcutSearchText(binding?.(target.shortcut)) : '';
    return [{ ...target, keywords: [target.keywords, keys].filter(Boolean).join(' '), title: t(target.label), detail: [t(sectionLabels[target.section]), scope].filter(Boolean).join(' · ') }];
  });
}
