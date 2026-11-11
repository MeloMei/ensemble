import { createContext, useContext, useEffect, useEffectEvent, useMemo, useState, type ReactNode } from 'react';

const isMac = navigator.platform.startsWith('Mac');
export const primaryModifier = isMac ? 'Meta' : 'Control';
export const primaryShortcut = (key: string) => `${primaryModifier}+${key}`;

export const shortcutActions = {
  commandPalette: { label: 'commandPalette.title', default: primaryShortcut('K'), keywords: 'search command palette 搜索 命令面板' },
  settings: { label: 'preferences.open', default: primaryShortcut(','), keywords: 'preferences settings 偏好 设置' },
  visitBack: { label: 'app.visitBack', default: primaryShortcut('['), keywords: 'visit history previous 访问 历史 返回' },
  visitForward: { label: 'app.visitForward', default: primaryShortcut(']'), keywords: 'visit history next 访问 历史 前进' },
  newSession: { label: 'app.newAgentSession', default: primaryShortcut('N'), keywords: 'new agent session 新建 会话' },
  toggleSidebar: { label: 'shortcuts.toggleSidebar', default: undefined, keywords: 'sidebar hide show 侧栏 展开 收起' },
  toggleFiles: { label: 'shortcuts.toggleFiles', default: undefined, keywords: 'files panel hide show 文件 面板 展开 收起' },
} as const;

export type ShortcutAction = keyof typeof shortcutActions;
type Overrides = Partial<Record<ShortcutAction, string>>;
export const shortcutActionIds = Object.keys(shortcutActions) as ShortcutAction[];

const storageKey = 'ensemble.shortcuts';
const modifierNames = ['Control', 'Alt', 'Shift', 'Meta'] as const;
const modifierLabels = {
  Control: isMac ? '⌃' : 'Ctrl', Alt: isMac ? '⌥' : 'Alt', Shift: isMac ? '⇧' : 'Shift', Meta: isMac ? '⌘' : 'Meta',
};
const keyLabels: Readonly<Record<string, string>> = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Plus: '+',
};
const fixedShortcuts: Readonly<Partial<Record<string, string>>> = {
  'Meta+J': 'app.openSessionTerminal', 'Control+J': 'app.openSessionTerminal',
  'Shift+Meta+I': 'shortcuts.previewAnnotation', 'Control+Shift+I': 'shortcuts.previewAnnotation',
  ...(isMac ? { 'Control+Alt+Space': 'settings.capture.shortcut' } : {}),
};

function shortcutKey(key: string) {
  if (key === ' ') return 'Space';
  if (key === '+') return 'Plus';
  if (/^[A-Za-z]$/.test(key)) return key.toUpperCase();
  if (/^[\p{L}\p{N}\p{P}\p{S}]$/u.test(key)) return key;
  if (/^(?:F(?:[1-9]|1\d|2[0-4])|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|Insert|Delete|Backspace|Space|Plus)$/.test(key)) return key;
}

function normalizeShortcut(value: string) {
  const parts = value.split('+');
  const key = shortcutKey(parts.pop() ?? '');
  const modifiers = modifierNames.filter(modifier => parts.includes(modifier));
  if (!key || parts.length !== modifiers.length || !modifiers.some(modifier => modifier !== 'Shift')) return undefined;
  return [...modifiers, key].join('+');
}

export function composingShortcut(event: KeyboardEvent) {
  return event.isComposing || event.keyCode === 229 || event.getModifierState('AltGraph');
}

export function shortcutFromEvent(event: KeyboardEvent) {
  if (composingShortcut(event)) return undefined;
  const key = shortcutKey(event.key);
  if (!key) return undefined;
  return normalizeShortcut([
    event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', key,
  ].filter(Boolean).join('+'));
}

export function displayShortcut(binding: string) {
  return binding.split('+').map(part => modifierLabels[part as keyof typeof modifierLabels] ?? keyLabels[part] ?? part).join(isMac ? '' : '+');
}

export function shortcutSearchText(binding?: string) {
  if (!binding) return '';
  const parts = binding.split('+');
  const primaryFirst = parts.includes(primaryModifier)
    ? [primaryModifier, ...parts.filter(part => part !== primaryModifier)].join('+') : binding;
  return [displayShortcut(binding), binding, primaryFirst,
    ...[binding, primaryFirst].map(value => value.replace('Control', 'Ctrl').replace('Meta', 'Cmd')),
    primaryFirst.replace('Meta', 'Command')].join(' ');
}

function effectiveBinding(overrides: Overrides, action: ShortcutAction) {
  return overrides[action] ?? shortcutActions[action].default;
}

function shortcutConflict(overrides: Overrides, action: ShortcutAction, binding?: string) {
  if (!binding) return undefined;
  if (Object.hasOwn(fixedShortcuts, binding)) return fixedShortcuts[binding];
  const other = shortcutActionIds.find(id => id !== action && effectiveBinding(overrides, id) === binding);
  return other ? shortcutActions[other].label : undefined;
}

function readOverrides(): Overrides {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (saved?.version !== 1 || !saved.overrides || typeof saved.overrides !== 'object') return {};
    const overrides: Overrides = {};
    for (const action of shortcutActionIds) {
      const candidate = saved.overrides[action];
      if (typeof candidate !== 'string') continue;
      const binding = normalizeShortcut(candidate);
      if (binding && binding !== shortcutActions[action].default) overrides[action] = binding;
    }
    return shortcutActionIds.some(action => shortcutConflict(overrides, action, effectiveBinding(overrides, action))) ? {} : overrides;
  } catch { return {}; }
}

function useShortcutPreferences() {
  const [overrides, setOverrides] = useState(readOverrides);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, overrides })); }
    catch { /* The current window still keeps its shortcuts. */ }
  }, [overrides]);
  return useMemo(() => ({
    binding: (action: ShortcutAction) => effectiveBinding(overrides, action),
    conflict: (action: ShortcutAction, binding?: string) => shortcutConflict(overrides, action, binding),
    assign: (action: ShortcutAction, value?: string) => setOverrides(current => {
      const binding = value === undefined ? shortcutActions[action].default : normalizeShortcut(value);
      if ((value !== undefined && !binding) || shortcutConflict(current, action, binding)
        || effectiveBinding(current, action) === binding) return current;
      const next = { ...current };
      if (binding === undefined || binding === shortcutActions[action].default) delete next[action];
      else next[action] = binding;
      return next;
    }),
    customized: (action: ShortcutAction) => overrides[action] !== undefined,
    canRestore: Object.keys(overrides).length > 0,
    restoreAll: () => setOverrides({}),
  }), [overrides]);
}

const ShortcutContext = createContext<ReturnType<typeof useShortcutPreferences> | null>(null);

export function ShortcutProvider({ children }: { children: ReactNode }) {
  const preferences = useShortcutPreferences();
  return <ShortcutContext.Provider value={preferences}>{children}</ShortcutContext.Provider>;
}

export function useShortcuts() {
  const context = useContext(ShortcutContext);
  if (!context) throw new Error('ShortcutProvider is required.');
  return context;
}

function shortcutTarget(event: KeyboardEvent) {
  const target = event.composedPath().find((item): item is Element => item instanceof Element) ?? document.activeElement;
  return target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cm-editor, .terminal-pane, [role="menu"], [role="listbox"]');
}

export function useShortcutDispatch(actions: Partial<Record<ShortcutAction, () => void>>) {
  const { binding } = useShortcuts();
  const dispatch = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat) return;
    const combination = shortcutFromEvent(event);
    if (!combination) return;
    const action = shortcutActionIds.find(id => binding(id) === combination);
    const run = action && actions[action];
    if (!run || shortcutTarget(event) ||
      document.querySelector('dialog[open], [role="menu"]:popover-open, .tab-menu[role="menu"], [role="listbox"][data-state="open"]')) return;
    event.preventDefault();
    event.stopPropagation();
    run();
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => dispatch(event);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
