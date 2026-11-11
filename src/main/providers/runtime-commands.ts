import type { RuntimeCommand } from '../../shared/types';

export function normalizeRuntimeCommands(commands: Iterable<RuntimeCommand>, redact?: (value: string) => string): RuntimeCommand[] {
  const catalog = new Map<string, RuntimeCommand>();
  const text = (value?: string) => value === undefined ? undefined : (redact?.(value) ?? value)
    .replace(/[\p{C}\s]+/gu, ' ').trim().slice(0, 300) || undefined;
  for (const command of commands) {
    const name = command.name.replace(/^\//u, '');
    if (!/^[^\s/\p{C}]{1,80}$/u.test(name) || catalog.has(name) || (redact && redact(command.name) !== command.name)) continue;
    catalog.set(name, { name, description: text(command.description), inputHint: text(command.inputHint) });
    if (catalog.size === 128) break;
  }
  return [...catalog.values()];
}
