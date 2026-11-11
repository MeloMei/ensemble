import { useLayoutEffect, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

interface FileTab { path: string; dirty: boolean; saving: boolean }

export function FileEditorTabs({ tabs, activePath, focusPath, id, activeButton, onActivate, onClose }: {
  tabs: FileTab[];
  activePath?: string;
  focusPath: string | null;
  id: string;
  activeButton: RefObject<HTMLButtonElement | null>;
  onActivate(path: string): void;
  onClose(path: string): void;
}) {
  const { t } = useTranslation('workspace');
  useLayoutEffect(() => {
    activeButton.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeButton, activePath]);

  return <div className="file-editor-tabs" role="tablist" aria-label={t('files.openTabs')} onKeyDown={event => {
    if (!(event.target instanceof HTMLButtonElement) || event.target.getAttribute('role') !== 'tab'
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')];
    const index = buttons.indexOf(event.target);
    if (event.key === 'Delete') {
      event.preventDefault();
      if (!event.repeat) onClose(tabs[index].path);
      return;
    }
    const next = event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    onActivate(tabs[next].path);
    buttons[next].focus({ preventScroll: true });
  }}>
    {tabs.map(({ path, dirty, saving }, index) => <div className="file-editor-tab" role="presentation" key={path}
      data-active={path === activePath || undefined} data-dirty={dirty || undefined}>
      <button id={`${id}-${index}`} role="tab" type="button" title={path} aria-label={dirty ? t('files.unsavedTab', { path }) : path}
        aria-controls={activePath ? `${id}-panel` : undefined} aria-selected={path === activePath} tabIndex={path === focusPath ? 0 : -1}
        ref={path === focusPath ? activeButton : undefined} onClick={() => onActivate(path)}>
        <span>{path.split('/').at(-1)}</span>
        {dirty && <i aria-hidden="true" />}
      </button>
      <button className="file-editor-tab-close" type="button" aria-label={t('files.closeTab', { path })}
        title={t('files.closeTab', { path })} disabled={saving} tabIndex={path === focusPath ? 0 : -1} onClick={() => onClose(path)}>
        <X size={12} aria-hidden="true" />
      </button>
    </div>)}
  </div>;
}
