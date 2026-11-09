import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useContext, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderInfo, Session, SessionUpdate } from '../shared/types';
import { AgentIcon } from './AgentIcon';
import { OverlayContext } from './overlays';
import { defaultModelId, modelName } from './ui';
import { DiscreteSlider } from './ui-kit/DiscreteSlider';
import { RollingText } from './ui-kit/RollingText';
import './ComposerModelPicker.css';

interface ComposerModelPickerProps {
  session: Session;
  provider?: ProviderInfo;
  disabled: boolean;
  saving: boolean;
  hint: string;
  onChange: (patch: SessionUpdate) => Promise<boolean>;
}

interface Selection {
  modelId?: string;
  effort?: string;
}

interface SelectionChange {
  previous: Selection;
  next: Selection;
  phase: 'writing' | 'accepted' | 'settled';
}

function sameSelection(left: Selection, right: Selection) {
  return left.modelId === right.modelId && left.effort === right.effort;
}

function supportedEfforts(provider: ProviderInfo | undefined, modelId: string | undefined): readonly string[] {
  if (!provider?.capabilities.effort) return [];
  const model = provider.models?.find(item => item.id === modelId);
  if (modelId && provider.models && !model) return [];
  return model?.efforts ?? provider.efforts ?? [];
}

export function ComposerModelPicker({ session, provider, disabled, saving, hint, onChange }: ComposerModelPickerProps) {
  const { t } = useTranslation('workspace');
  const { top } = useContext(OverlayContext);
  const titleId = useId();
  const listId = useId();
  const disclosure = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const changing = useRef(false);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [change, setChange] = useState<SelectionChange | null>(null);

  const authority = { modelId: session.modelId, effort: session.settings?.effort };
  const snapshotChanged = change !== null && !sameSelection(authority, change.previous);
  const matchesChange = change !== null && sameSelection(authority, change.next);
  // The write response and the session snapshot arrive on separate channels.
  const projecting = change !== null && (change.phase === 'writing' || (change.phase === 'accepted' && !snapshotChanged));
  const selection = projecting ? change.next : authority;
  const providerName = provider?.name ?? session.providerId;
  const runtimeDefaultId = defaultModelId(provider);
  const models = provider?.models ?? [];
  const hasModels = models.length > 0;
  const unavailable = models.some(model => model.id === selection.modelId) ? undefined : selection.modelId;
  const modelLabel = selection.modelId ? modelName(provider, selection.modelId) : t('chat.modelDefault', { provider: providerName });
  const defaultLabel = runtimeDefaultId ? t('chat.defaultModelName', { model: modelName(provider, runtimeDefaultId) }) : t('chat.cliDefault');
  const efforts = supportedEfforts(provider, selection.modelId);
  const effortIndex = selection.effort ? efforts.indexOf(selection.effort) + 1 : 0;
  const effortStops = [t('chat.runtimeDefault'), ...efforts.map(effort => t(`chat.effort.${effort}`, { defaultValue: effort }))];
  const effortLabel = effortIndex ? effortStops[effortIndex] : t('chat.effortDefaultShort');
  const locked = saving || projecting;
  const blocked = disabled || (!hasModels && !efforts.length);
  const animate = open && (projecting || matchesChange);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (...fields: string[]) => fields.some(field => field.toLocaleLowerCase().includes(normalizedQuery));
  const showDefault = matches(defaultLabel);
  const showUnavailable = unavailable && matches(unavailable);
  const filteredModels = models.filter(model => matches(model.name, model.id));

  function setPickerOpen(next: boolean) {
    setOpen(next);
    if (!next) {
      setExpanded(false);
      setQuery('');
    }
  }

  useEffect(() => {
    if (blocked) setPickerOpen(false);
  }, [blocked]);

  useEffect(() => {
    if (expanded) search.current?.focus({ preventScroll: true });
  }, [expanded]);

  useEffect(() => {
    if (change?.phase === 'accepted' && snapshotChanged) {
      setChange(matchesChange ? { ...change, phase: 'settled' } : null);
    } else if (change?.phase === 'settled' && !matchesChange) {
      setChange(null);
    }
  }, [change, matchesChange, snapshotChanged]);

  function collapse() {
    setExpanded(false);
    setQuery('');
    disclosure.current?.focus({ preventScroll: true });
  }

  function update(next: Selection, patch: SessionUpdate) {
    if (blocked || locked || changing.current) return;
    changing.current = true;
    const request: SelectionChange = { previous: authority, next, phase: 'writing' };
    setChange(request);
    void onChange(patch).catch(() => false).then(accepted => {
      changing.current = false;
      setChange(accepted ? { ...request, phase: 'accepted' } : null);
    });
  }

  function chooseModel(value: string | undefined) {
    if (locked) return;
    collapse();
    const nextModelId = value ?? runtimeDefaultId;
    if (nextModelId === selection.modelId) return;
    const effort = selection.effort && supportedEfforts(provider, nextModelId).includes(selection.effort)
      ? selection.effort : undefined;
    update({ modelId: nextModelId, effort }, {
      modelId: value ?? null,
      ...(effort === selection.effort ? {} : { settings: { effort: null } }),
    });
  }

  return <Popover.Root open={open && !blocked} onOpenChange={setPickerOpen}>
    <Popover.Trigger className="composer-select composer-select-model" disabled={blocked || (!open && locked)}
      aria-label={[t('chat.model'), modelLabel, efforts.length ? effortLabel : ''].filter(Boolean).join(' · ')}
      title={blocked ? (disabled ? hint : modelLabel) : undefined}>
      <AgentIcon providerId={session.providerId} size={14} />
      <RollingText className="composer-select-value" value={modelLabel} animate={animate} />
      {efforts.length > 0 && <span className="composer-model-effort"><RollingText value={effortLabel} animate={animate} /></span>}
      <ChevronDown size={11} aria-hidden="true" />
    </Popover.Trigger>
    <Popover.Portal container={top ?? document.body}>
      <Popover.Content className="composer-model-picker" side="top" align="start" sideOffset={8} collisionPadding={10}
        aria-labelledby={titleId} aria-busy={locked || undefined}
        onEscapeKeyDown={event => { if (expanded) { event.preventDefault(); collapse(); } }}>
        <div className="composer-model-heading">
          <span className="composer-model-agent"><AgentIcon providerId={session.providerId} size={16} /></span>
          <div className="composer-model-copy">
            <span className="composer-model-runtime">{providerName}</span>
            <h2 id={titleId}><RollingText value={modelLabel} animate={animate} /></h2>
          </div>
        </div>
        {efforts.length > 0 && <DiscreteSlider label={t('chat.effort')} stops={effortStops} value={effortIndex}
          disabled={locked || blocked} animate={animate}
          onCommit={index => {
            const effort = efforts[index - 1];
            if (effort !== selection.effort) update({ ...selection, effort }, { settings: { effort: effort ?? null } });
          }} />}
        {hasModels && <div className="composer-model-catalog">
          <button ref={disclosure} className="composer-model-disclosure" type="button" aria-expanded={expanded}
            aria-controls={listId} aria-disabled={locked || undefined}
            onClick={() => { if (!locked) expanded ? collapse() : setExpanded(true); }}>
            <span>{t('chat.chooseModel')}</span><ChevronRight size={14} aria-hidden="true" />
          </button>
          <div id={listId} className="composer-model-catalog-content" aria-hidden={!expanded} inert={!expanded}><div>
            <label className="composer-model-search">
              <Search size={14} aria-hidden="true" />
              <input ref={search} type="search" aria-label={t('chat.searchModels')} placeholder={t('chat.searchModels')}
                value={query} onChange={event => setQuery(event.target.value)} />
            </label>
            <div className="composer-model-options" style={{ '--model-catalog-rows': models.length + 1 + Number(Boolean(unavailable)) } as CSSProperties}>
              {showDefault && <ModelOption label={defaultLabel} selected={!selection.modelId} disabled={locked} onClick={() => chooseModel(undefined)} />}
              {showUnavailable && <ModelOption label={unavailable} description={t('chat.modelUnavailable')} selected disabled />}
              {filteredModels.map(model => <ModelOption key={model.id} label={model.name} selected={model.id === selection.modelId}
                description={t(model.free ? 'chat.modelFree' : session.providerId === 'codex' ? 'chat.modelAccount' : 'chat.modelMetered')}
                disabled={locked} onClick={() => chooseModel(model.id)} />)}
              {!showDefault && !showUnavailable && !filteredModels.length && <p className="composer-model-empty" role="status">{t('chat.noMatchingModels')}</p>}
            </div>
          </div></div>
        </div>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

function ModelOption({ label, description, selected, disabled, onClick }: {
  label: string;
  description?: string;
  selected: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return <button className="composer-model-option" type="button" aria-pressed={selected} disabled={disabled} onClick={onClick} title={label}>
    <span><span>{label}</span>{description && <small>{description}</small>}</span>
    {selected && <Check size={14} aria-hidden="true" />}
  </button>;
}
