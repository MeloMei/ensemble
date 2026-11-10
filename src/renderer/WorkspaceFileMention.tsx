import { FileText } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceFileMatch } from '../shared/types';
import { useWorkspaceFileMatches } from './workspace-file-search';

interface Mention { start: number; end: number; query: string }

function mentionAt(input: HTMLTextAreaElement): Mention | undefined {
  if (input.selectionStart !== input.selectionEnd) return undefined;
  const end = input.selectionStart;
  const match = /(?:^|[\s(])@([^\s@]{0,240})$/u.exec(input.value.slice(0, end));
  if (!match) return undefined;
  const query = match[1];
  return { query, start: end - query.length - 1, end };
}

export function useWorkspaceFileMention(workspaceId: string | undefined, onChange: (value: string) => void) {
  const [mention, setMention] = useState<Mention>();
  const dismissed = useRef<{ value: string; start: number }>(undefined);
  const [index, setIndex] = useState(0);
  const id = useId();
  const open = Boolean(workspaceId && mention);
  const { matches, loading, error } = useWorkspaceFileMatches(workspaceId, open ? mention!.query : null);
  const selected = Math.min(index, Math.max(0, matches.length - 1));
  const close = (input: HTMLTextAreaElement) => {
    const current = mentionAt(input);
    if (current) dismissed.current = { value: input.value, start: current.start };
    setMention(undefined);
  };
  const update = (input: HTMLTextAreaElement) => {
    const next = mentionAt(input);
    if (dismissed.current?.value !== input.value) dismissed.current = undefined;
    if (next && dismissed.current?.start === next.start) return;
    if (next?.start !== mention?.start || next?.query !== mention?.query) setIndex(0);
    setMention(next);
  };
  const insert = (input: HTMLTextAreaElement, file: WorkspaceFileMatch) => {
    if (!mention) return;
    const reference = `@${/[\s"\\]/u.test(file.path) ? JSON.stringify(file.path) : file.path} `;
    const { value } = input;
    const rest = value.slice(mention.end);
    const after = rest.replace(/^[^\s@]*/u, '');
    const suffix = after.startsWith(' ') ? after.slice(1) : after;
    const next = value.slice(0, mention.start) + reference + suffix;
    if (input.maxLength >= 0 && next.length > input.maxLength) return;
    onChange(next);
    close(input);
    const cursor = mention.start + reference.length;
    requestAnimationFrame(() => { if (input.isConnected && input.value === next) input.setSelectionRange(cursor, cursor); });
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || event.nativeEvent.isComposing || event.keyCode === 229) return false;
    if (!['Escape', 'ArrowUp', 'ArrowDown', 'Enter'].includes(event.key) || (event.key === 'Enter' && event.shiftKey)) return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') close(event.currentTarget);
    else if (event.key === 'Enter') {
      const file = matches[selected];
      if (file) insert(event.currentTarget, file);
    } else if (matches.length) {
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setIndex((selected + delta + matches.length) % matches.length);
      document.getElementById(`${id}-${(selected + delta + matches.length) % matches.length}`)?.scrollIntoView({ block: 'nearest' });
    }
    return true;
  };
  return { id, open, matches, loading, error, selected, close, update, insert, keyDown };
}

export function WorkspaceFileMention({ mention, onPick }: {
  mention: ReturnType<typeof useWorkspaceFileMention>; onPick: (file: WorkspaceFileMatch) => void;
}) {
  const { t } = useTranslation('workspace');
  if (!mention.open) return null;
  const status = mention.error || (mention.loading ? t('evidence.fileSearching') : !mention.matches.length ? t('evidence.fileNoMatch') : '');
  return <div className="workspace-file-mention">
    {status && <p role="status">{status}</p>}
    <ul id={mention.id} role="listbox" aria-label={t('evidence.fileSuggestions')}>
      {mention.matches.map((file, index) => <li id={`${mention.id}-${index}`} key={file.path} role="option" aria-selected={mention.selected === index}
        onMouseDown={event => event.preventDefault()} onClick={() => onPick(file)}>
        <FileText size={14} aria-hidden="true" /><span><strong>{file.name}</strong><small title={file.path}>{file.path}</small></span>
      </li>)}
    </ul>
  </div>;
}
