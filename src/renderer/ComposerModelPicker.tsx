import { Tooltip } from './Tooltip';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useContext, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderInfo, ProviderModel, Session, SessionModelSelection, SessionUpdate } from '../shared/types';
import { modelEffortChoices } from '../shared/model-efforts';
import { providerForDirectory } from '../shared/provider-models';
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
  onChange: (patch: SessionUpdate) => Promise<SessionModelSelection | undefined>;
}

type Selection = Pick<SessionModelSelection, 'modelId' | 'effort'>;

interface SelectionChange {
  next: Selection;
  phase: 'writing' | 'accepted' | 'settled';
  acknowledgedAt?: string;
}

function sameSelection(left: Selection, right: Selection) {
  return left.modelId === right.modelId && left.effort === right.effort;
}

export function ComposerModelPicker({ session, provider: detected, disabled, saving, hint, onChange }: ComposerModelPickerProps) {
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
  const matchesChange = change !== null && sameSelection(authority, change.next);
  const snapshotAccepted = matchesChange || (change?.acknowledgedAt !== undefined && session.updatedAt >= change.acknowledgedAt);
  // The write response and the session snapshot arrive on separate channels.
  const projecting = change !== null && (change.phase === 'writing' || (change.phase === 'accepted' && !snapshotAccepted));
  const selection = projecting ? change.next : authority;
  const provider = providerForDirectory(detected, session.cwd);
  const providerName = provider?.name ?? session.providerId;
  const runtimeDefaultId = defaultModelId(provider);
  const models = provider?.models ?? [];
  const selectedModel = models.find(model => model.id === selection.modelId);
  const unavailable = selectedModel ? undefined : selection.modelId;
  const hasModels = models.length > 0;
  const baseId = selectedModel?.contextWindow?.baseModelId ?? selection.modelId;
  const variantsByBase = new Map<string, ProviderModel[]>();
  for (const model of models) {
    const base = model.contextWindow?.baseModelId;
    if (base) {
      const variants = variantsByBase.get(base) ?? [];
      variants.push(model);
      variantsByBase.set(base, variants);
    }
  }
  const variants = baseId ? variantsByBase.get(baseId) ?? [] : [];
  const extendedContext = t('chat.contextWindow1m');
  const contextStops = [t('chat.contextWindowDefault'), ...variants.map(model => variants.length > 1
    ? t('chat.contextWindowVariant', { context: extendedContext, model: model.id }) : extendedContext)];
  const contextIndex = variants.findIndex(model => model.id === selection.modelId) + 1;
  const modelLabel = baseId
    ? (selectedModel?.contextWindow ? t('chat.modelWithContext', { model: modelName(provider, baseId), context: extendedContext }) : modelName(provider, baseId))
    : t('chat.modelDefault', { provider: providerName });
  const defaultLabel = runtimeDefaultId ? t('chat.defaultModelName', { model: modelName(provider, runtimeDefaultId) }) : t('chat.cliDefault');
  const observed = selection.modelId === authority.modelId ? session.runtimeModel : undefined;
  const efforts = modelEffortChoices(provider, selection.modelId, observed);
  const effortIndex = selection.effort ? efforts.indexOf(selection.effort) + 1 : 0;
  const labelEffort = (effort: string) => t(`chat.effort.${effort}`, { defaultValue: effort });
  const reportedDefault = !selection.effort && observed?.effort ? labelEffort(observed.effort) : undefined;
  const effortStops = [reportedDefault ? t('chat.effortReportedDefault', { effort: reportedDefault }) : t('chat.runtimeDefault'), ...efforts.map(labelEffort)];
  const effortLabel = effortIndex ? effortStops[effortIndex] : t('chat.effortDefaultShort');
  const locked = saving || projecting;
  const blocked = disabled || (!hasModels && !efforts.length);
  const animate = open && (projecting || matchesChange);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (...fields: string[]) => fields.some(field => field.toLocaleLowerCase().includes(normalizedQuery));
  const showDefault = matches(defaultLabel);
  const showUnavailable = unavailable && matches(unavailable);
  const filteredModels = models.filter(model => !model.contextWindow?.baseModelId
    && matches(model.name, model.id, ...(variantsByBase.get(model.id) ?? []).flatMap(variant => [variant.name, variant.id])));

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
    if (change?.phase === 'accepted' && snapshotAccepted) {
      setChange(matchesChange ? { ...change, phase: 'settled' } : null);
    } else if (change?.phase === 'settled' && !matchesChange) {
      setChange(null);
    }
  }, [change, matchesChange, snapshotAccepted]);

  function collapse() {
    setExpanded(false);
    setQuery('');
    disclosure.current?.focus({ preventScroll: true });
  }

  function update(next: Selection, patch: SessionUpdate) {
    if (blocked || locked || changing.current) return;
    changing.current = true;
    setChange({ next, phase: 'writing' });
    void onChange({ ...patch, expectedProviderId: session.providerId }).catch(() => undefined).then(accepted => {
      changing.current = false;
      setChange(accepted ? { next: accepted, acknowledgedAt: accepted.updatedAt, phase: 'accepted' } : null);
    });
  }

  function chooseModel(value: string | undefined) {
    if (locked) return;
    collapse();
    const nextModelId = value ?? runtimeDefaultId;
    if (nextModelId === selection.modelId) return;
    update({ modelId: nextModelId }, { modelId: value ?? null });
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
        {baseId && variants.length > 0 && <DiscreteSlider label={t('chat.contextWindow')} stops={contextStops} value={contextIndex}
          disabled={locked || blocked} animate={animate}
          onCommit={index => {
            const modelId = index === 0 ? baseId : variants[index - 1]?.id;
            if (modelId && modelId !== selection.modelId) update({ modelId }, { modelId });
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
              {filteredModels.map(model => <ModelOption key={model.id} label={model.name} selected={model.id === baseId}
                description={model.contextWindow ? extendedContext : model.free ? t('chat.modelFree') : session.providerId === 'codex' ? undefined : t('chat.modelMetered')}
                tooltip={!model.free && session.providerId === 'codex' ? t('chat.modelAccount') : undefined}
                disabled={locked} onClick={() => model.id === baseId ? collapse() : chooseModel(model.id)} />)}
              {!showDefault && !showUnavailable && !filteredModels.length && <p className="composer-model-empty" role="status">{t('chat.noMatchingModels')}</p>}
            </div>
          </div></div>
        </div>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

function ModelOption({ label, description, tooltip, selected, disabled, onClick }: {
  label: string;
  description?: string;
  tooltip?: string;
  selected: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const option = <button className="composer-model-option" type="button" aria-pressed={selected} disabled={disabled} onClick={onClick} title={label}>
    <span><span>{label}</span>{description && <small>{description}</small>}</span>
    {selected && <Check size={14} aria-hidden="true" />}
  </button>;
  return tooltip ? <Tooltip label={tooltip}>{option}</Tooltip> : option;
}
