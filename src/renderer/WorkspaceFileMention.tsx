import { FileText } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceFileMatch } from '../shared/types';
import { ComposerCompletionList, restoreComposerCursor, useComposerCompletion, type ComposerToken } from './ComposerCompletion';
import { useWorkspaceFileMatches } from './workspace-file-search';

function mentionAt(input: HTMLTextAreaElement): ComposerToken | undefined {
  if (input.selectionStart !== input.selectionEnd) return undefined;
  const end = input.selectionStart;
  const match = /(?:^|[\s(])@([^\s@]{0,240})$/u.exec(input.value.slice(0, end));
  if (!match) return undefined;
  const query = match[1];
  return { query, start: end - query.length - 1, end };
}

export function useWorkspaceFileMention(workspaceId: string | undefined, onChange: (value: string) => void) {
  const completion = useComposerCompletion(mentionAt);
  const { token } = completion;
  const open = Boolean(workspaceId && token);
  const { matches, loading, error } = useWorkspaceFileMatches(workspaceId, open ? token!.query : null);
  const insert = (input: HTMLTextAreaElement, file: WorkspaceFileMatch) => {
    if (!token) return;
    const reference = `@${/[\s"\\]/u.test(file.path) ? JSON.stringify(file.path) : file.path} `;
    const { value } = input;
    const rest = value.slice(token.end);
    const after = rest.replace(/^[^\s@]*/u, '');
    const suffix = after.startsWith(' ') ? after.slice(1) : after;
    const next = value.slice(0, token.start) + reference + suffix;
    if (input.maxLength >= 0 && next.length > input.maxLength) return;
    onChange(next);
    completion.close(input);
    restoreComposerCursor(input, next, token.start + reference.length);
  };
  return {
    ...completion, open, matches, loading, error, insert,
    keyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => open && completion.keyDown(event, matches, insert),
  };
}

export function WorkspaceFileMention({ mention, onPick }: {
  mention: ReturnType<typeof useWorkspaceFileMention>; onPick: (file: WorkspaceFileMatch) => void;
}) {
  const { t } = useTranslation('workspace');
  if (!mention.open) return null;
  const status = mention.error || (mention.loading ? t('evidence.fileSearching') : !mention.matches.length ? t('evidence.fileNoMatch') : '');
  return <ComposerCompletionList className="workspace-file-mention" id={mention.id} selected={mention.selected(mention.matches.length)}
    items={mention.matches} label={t('evidence.fileSuggestions')} status={status} itemKey={file => file.path} onPick={onPick}>
    {file => <><FileText size={14} aria-hidden="true" /><span><strong>{file.name}</strong><small title={file.path}>{file.path}</small></span></>}
  </ComposerCompletionList>;
}
