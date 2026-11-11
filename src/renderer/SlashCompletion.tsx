import { BookOpen, Settings2, TerminalSquare } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { PROMPT_SKILL_LIMIT, type PromptSkill, type RuntimeCommand, type SkillInfo } from '../shared/types';
import { ComposerCompletionList, restoreComposerCursor, useComposerCompletion, type ComposerToken } from './ComposerCompletion';

const manageSkills = 'manage-skills';

type SlashItem =
  | { kind: 'runtime'; command: RuntimeCommand }
  | { kind: 'skill'; skill: SkillInfo }
  | { kind: 'local' };

function slashAt(input: HTMLTextAreaElement): ComposerToken | undefined {
  const cursor = input.selectionStart;
  if (cursor !== input.selectionEnd) return undefined;
  const match = /^\/([^\s/\p{C}]{0,80})$/u.exec(input.value.slice(0, cursor));
  if (!match) return undefined;
  const tail = /^[^\s]*/u.exec(input.value.slice(cursor))![0];
  return { start: 0, end: cursor + tail.length, query: match[1] };
}

export function useSlashCompletion({ workspaceId, enabled, commands, skills, onPick, canOpenSettings }: {
  workspaceId?: string;
  enabled: boolean;
  commands?: RuntimeCommand[];
  skills?: PromptSkill[];
  onPick: (text: string, skill?: PromptSkill, openSettings?: true) => void | boolean;
  canOpenSettings: boolean;
}) {
  const completion = useComposerCompletion(slashAt);
  const { token } = completion;
  const open = enabled && Boolean(token);
  const [catalog, setCatalog] = useState<{ workspaceId: string; skills: SkillInfo[]; error?: true }>();
  useEffect(() => {
    if (!open || !workspaceId) return;
    let active = true;
    void window.workbench.listSkills(workspaceId).then(
      result => { if (active) setCatalog({ workspaceId, skills: result }); },
      () => { if (active) setCatalog({ workspaceId, skills: [], error: true }); },
    );
    return () => { active = false; setCatalog(undefined); };
  }, [open, workspaceId]);
  const current = open && catalog?.workspaceId === workspaceId ? catalog : undefined;
  const query = token?.query.toLowerCase() ?? '';
  const items: SlashItem[] = [];
  const matches = (name: string) => name.toLowerCase().includes(query);
  if (open) {
    for (const command of commands ?? []) if (matches(command.name)) items.push({ kind: 'runtime', command });
    if (canOpenSettings && matches(manageSkills)) items.push({ kind: 'local' });
    if ((skills?.length ?? 0) < PROMPT_SKILL_LIMIT) {
      for (const skill of current?.skills ?? []) {
        if (!skill.issue && matches(skill.name) && !skills?.some(item => item.id === skill.id)) items.push({ kind: 'skill', skill });
      }
    }
  }

  const insert = (input: HTMLTextAreaElement, item: SlashItem) => {
    const currentToken = slashAt(input);
    if (!currentToken) return;
    const rest = input.value.slice(currentToken.end);
    const reference = item.kind === 'runtime' ? `/${item.command.name}${rest[0] ?? ' '}` : '';
    const suffix = item.kind === 'runtime' || rest.startsWith(' ') ? rest.slice(1) : rest;
    const next = reference + suffix;
    if (input.maxLength >= 0 && next.length > input.maxLength) return;
    const skill = item.kind === 'skill' ? { id: item.skill.id, name: item.skill.name.slice(0, 200) } : undefined;
    if (onPick(next, skill, item.kind === 'local' ? true : undefined) === false) return;
    completion.close(input);
    restoreComposerCursor(input, next, reference.length);
  };
  return {
    ...completion, open, items, insert, loading: Boolean(open && workspaceId && !current), error: Boolean(current?.error),
    keyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => open && completion.keyDown(event, items, insert),
  };
}

export function SlashCompletion({ completion, onPick }: {
  completion: ReturnType<typeof useSlashCompletion>;
  onPick: (item: SlashItem) => void;
}) {
  const { t } = useTranslation('workspace');
  if (!completion.open) return null;
  const status = completion.error ? t('chat.slashSkillsUnavailable') : completion.loading ? t('chat.slashSearchingSkills')
    : !completion.items.length ? t('chat.slashNoMatch') : '';
  return <ComposerCompletionList className="slash-completion" id={completion.id} selected={completion.selected(completion.items.length)}
    items={completion.items} label={t('chat.slashSuggestions')} status={status} onPick={onPick}
    itemKey={item => item.kind === 'runtime' ? `runtime-${item.command.name}` : item.kind === 'skill' ? `skill-${item.skill.id}` : 'manage'}>
    {item => {
      const Icon = item.kind === 'runtime' ? TerminalSquare : item.kind === 'skill' ? BookOpen : Settings2;
      const name = item.kind === 'runtime' ? item.command.name : item.kind === 'skill' ? item.skill.name : manageSkills;
      const label = t(item.kind === 'runtime' ? 'chat.slashRuntimeCommand' : item.kind === 'skill' ? 'chat.slashDraftSkill' : 'chat.slashLocalCommand');
      const detail = item.kind === 'runtime' ? [item.command.description, item.command.inputHint].filter(Boolean).join(' · ')
        : item.kind === 'skill' ? item.skill.description : t('chat.slashManageSkills');
      return <><Icon size={14} aria-hidden="true" /><span><strong>{item.kind === 'skill' ? name : `/${name}`}</strong>
        <small title={detail || undefined}>{label}{detail ? ` · ${detail}` : ''}</small></span></>;
    }}
  </ComposerCompletionList>;
}
