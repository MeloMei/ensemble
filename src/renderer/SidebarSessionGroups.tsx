import { useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Folder, FolderInput, Pencil, Pin, PinOff, Plus, Trash2 } from 'lucide-react';
import type { Session } from '../shared/types';
import { sectionNameAvailable, sectionNameLimit, type SidebarSessionSection, type useSidebarSessions } from './sidebar-sessions';
import { Modal } from './ui';
import { RowActionMenu } from './ui-kit/RowActionMenu';

type SidebarSessions = ReturnType<typeof useSidebarSessions>;

export function SidebarSessionActions({ session, sections, pinned, sectionId, onPin, onMove }: {
  session: Session;
  sections: SidebarSessionSection[];
  pinned?: boolean;
  sectionId?: string;
  onPin(): void;
  onMove(sectionId?: string): void;
}) {
  const { t } = useTranslation('shell');
  const PinIcon = pinned ? PinOff : Pin;
  return <RowActionMenu label={t('sidebarSessions.actions', { name: session.title })} items={[
    { id: 'pin', label: t(pinned ? 'sidebarSessions.unpin' : 'sidebarSessions.pin'), icon: <PinIcon size={14} aria-hidden="true" />, select: onPin },
    ...(pinned || sectionId ? [{
      id: 'move-to-project', label: t('sidebarSessions.moveToProject'), icon: <Folder size={14} aria-hidden="true" />, select: () => onMove(),
    }] : []),
    ...sections.filter(section => pinned || section.id !== sectionId).map(section => ({
      id: `move:${section.id}`, label: t('sidebarSessions.moveToSection', { name: section.name }),
      icon: <FolderInput size={14} aria-hidden="true" />, select: () => onMove(section.id),
    })),
  ]} />;
}

export function SidebarSessionGroups({ organization: { prefs, groups, dispatch }, visibleProjects, renderSession }: {
  organization: SidebarSessions;
  visibleProjects?: ReadonlySet<string>;
  renderSession(session: Session): ReactNode;
}) {
  const { t } = useTranslation('shell');
  const heading = useId();
  const controls = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState<SidebarSessionSection>();
  const visible = (rows: Session[]) => visibleProjects ? rows.filter(session => {
    const project = groups.projectBySession.get(session.id);
    return project !== undefined && visibleProjects.has(project);
  }) : rows;
  const pinned = visible(groups.pinned);
  const sortOptions = [
    { value: 'activity', label: t('sidebarSessions.recentActivity') },
    { value: 'created', label: t('sidebarSessions.creationTime') },
  ] as const;

  return <section className="sidebar-session-groups" aria-labelledby={heading}>
    <div className="sidebar-section-title sidebar-session-group-heading">
      <h2 id={heading}>{t('sidebarSessions.title')}</h2>
      <RowActionMenu label={t('sidebarSessions.options')} triggerRef={controls} items={[
        { id: 'new-section', label: t('sidebarSessions.newSection'), icon: <Plus size={14} aria-hidden="true" />,
          select: () => setEditing({ id: crypto.randomUUID(), name: '' }) },
        ...sortOptions.map(({ value, label }) => ({
          id: value, label, role: 'menuitemradio' as const, checked: prefs.sort === value,
          icon: <Check size={14} visibility={prefs.sort === value ? 'visible' : 'hidden'} aria-hidden="true" />,
          select: () => dispatch({ type: 'sort', sort: value }),
        })),
        { id: 'compact', label: t('sidebarSessions.compact'), role: 'menuitemcheckbox', checked: prefs.density === 'compact',
          icon: <Check size={14} visibility={prefs.density === 'compact' ? 'visible' : 'hidden'} aria-hidden="true" />,
          select: () => dispatch({ type: 'density', density: prefs.density === 'compact' ? 'comfortable' : 'compact' }) },
      ]} />
    </div>
    {pinned.length > 0 && <section data-sidebar-section="pinned" aria-labelledby={`${heading}-pinned`}>
      <div className="sidebar-section-title sidebar-session-group-heading">
        <Pin size={12} aria-hidden="true" /><h3 id={`${heading}-pinned`}>{t('sidebarSessions.pinned')}</h3>
      </div>
      <ul className="workspace-session-list">{pinned.map(renderSession)}</ul>
    </section>}
    {prefs.sections.map(section => {
      const rows = visible(groups.sections.get(section.id) ?? []);
      if (visibleProjects && !rows.length) return null;
      const headingId = `${heading}-${section.id}`;
      return <section key={section.id} data-sidebar-section={section.id} aria-labelledby={headingId}>
        <div className="sidebar-section-title sidebar-session-group-heading">
          <Folder size={12} aria-hidden="true" /><h3 id={headingId} title={section.name}>{section.name}</h3>
          <RowActionMenu label={t('sidebarSessions.sectionActions', { name: section.name })} items={[
            { id: 'rename', label: t('sidebarSessions.renameSection'), icon: <Pencil size={14} aria-hidden="true" />, select: () => setEditing(section) },
            { id: 'remove', label: t('sidebarSessions.removeSection'), icon: <Trash2 size={14} aria-hidden="true" />, select: () => {
              controls.current?.focus({ preventScroll: true });
              dispatch({ type: 'removeSection', id: section.id });
            } },
          ]} />
        </div>
        {rows.length > 0 && <ul className="workspace-session-list">{rows.map(renderSession)}</ul>}
      </section>;
    })}
    {editing && <SectionNameDialog section={editing} sections={prefs.sections} fallbackFocus={controls}
      onSave={section => { dispatch({ type: 'saveSection', section }); setEditing(undefined); }} onClose={() => setEditing(undefined)} />}
  </section>;
}

function SectionNameDialog({ section, sections, fallbackFocus, onSave, onClose }: {
  section: SidebarSessionSection;
  sections: SidebarSessionSection[];
  fallbackFocus: RefObject<HTMLButtonElement | null>;
  onSave(section: SidebarSessionSection): void;
  onClose(): void;
}) {
  const { t } = useTranslation('shell');
  const field = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(section.name);
  const [duplicate, setDuplicate] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = { ...section, name: name.trim() };
    if (!next.name) return;
    if (!sectionNameAvailable(sections, next)) { setDuplicate(true); field.current?.focus(); return; }
    onSave(next);
  };
  return <Modal title={t(section.name ? 'sidebarSessions.renameSection' : 'sidebarSessions.newSection')}
    initialFocus={field} fallbackFocus={fallbackFocus} onClose={onClose}>
    <form onSubmit={submit}>
      <label>{t('sidebarSessions.sectionName')}<input ref={field} required maxLength={sectionNameLimit}
        aria-invalid={duplicate || undefined} value={name} onChange={event => { setName(event.target.value); setDuplicate(false); }} /></label>
      {duplicate && <p className="error-text" role="alert">{t('sidebarSessions.duplicateSection')}</p>}
      <div className="modal-actions">
        <button type="button" className="button subtle" onClick={onClose}>{t('common.cancel')}</button>
        <button type="submit" className="button primary" disabled={!name.trim()}>{t('sidebarSessions.saveSection')}</button>
      </div>
    </form>
  </Modal>;
}
