import { useContext, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, Minus, Plus, RotateCw, Search, X } from 'lucide-react';
import { browserFindShortcut, browserUrl, type BrowserBounds, type BrowserCommand, type BrowserState } from '../shared/embedded-browser';
import { OverlayContext } from './overlays';
import { IconButton } from './ui';
import './BrowserPane.css';

function stageBounds(stage: HTMLDivElement): BrowserBounds | null {
  const pane = stage.closest('[data-workspace-pane]')?.getBoundingClientRect();
  if (!pane || document.hidden || document.documentElement.inert || document.querySelector('dialog[open]')) return null;
  const stageRect = stage.getBoundingClientRect();
  const x = Math.ceil(Math.max(0, pane.left, stageRect.left));
  const y = Math.ceil(Math.max(0, pane.top, stageRect.top));
  const width = Math.floor(Math.min(window.innerWidth, pane.right, stageRect.right)) - x;
  const height = Math.floor(Math.min(window.innerHeight, pane.bottom, stageRect.bottom)) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function BrowserPane({ id, obscured }: { id: string; obscured: boolean }) {
  const { t } = useTranslation('shell');
  const { top } = useContext(OverlayContext);
  const stage = useRef<HTMLDivElement>(null);
  const refreshLayout = useRef<(() => void) | undefined>(undefined);
  const findInput = useRef<HTMLInputElement>(null);
  const findButton = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<BrowserState>();
  const [address, setAddress] = useState('');
  const editingAddress = useRef(false);
  const [invalid, setInvalid] = useState(false);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const hidden = obscured || Boolean(top);

  const command = (input: BrowserCommand) => window.workbench.browserCommand(id, input);
  const showFind = () => {
    setFinding(true);
    findInput.current?.focus();
    findInput.current?.select();
  };
  const stopFind = () => {
    setFinding(false);
    setQuery('');
    void command({ action: 'stop-find' });
    findButton.current?.querySelector('button')?.focus();
  };
  const submitFind = (text: string, forward = true) => {
    void command(text ? { action: 'find', text, forward } : { action: 'stop-find' });
  };

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element || hidden) return;
    let live = true;
    let revision = 0;
    let previous: string | undefined;
    const receive = (next: BrowserState) => {
      setState(next);
      if (!editingAddress.current) setAddress(next.url);
    };
    const unsubscribe = window.workbench.onBrowserState((tabId, next) => {
      if (tabId !== id) return;
      revision += 1;
      receive(next);
    });
    const unsubscribeShortcut = window.workbench.onBrowserFindShortcut(tabId => { if (tabId === id) showFind(); });
    const update = () => {
      const bounds = stageBounds(element);
      const key = JSON.stringify(bounds);
      if (key === previous) return;
      previous = key;
      const request = ++revision;
      void window.workbench.browserLayout(id, bounds).then(next => {
        if (live && revision === request && next) receive(next);
      });
    };
    refreshLayout.current = update;
    const sizes = new ResizeObserver(update);
    sizes.observe(element);
    const pane = element.closest('[data-workspace-pane]');
    if (pane) sizes.observe(pane);
    const inert = new MutationObserver(update);
    inert.observe(document.documentElement, { attributes: true, attributeFilter: ['inert'] });
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      live = false;
      unsubscribe();
      unsubscribeShortcut();
      refreshLayout.current = undefined;
      sizes.disconnect();
      inert.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      document.removeEventListener('visibilitychange', update);
      void window.workbench.browserLayout(id, null);
    };
  }, [hidden, id]);
  useLayoutEffect(() => { refreshLayout.current?.(); });

  const zoom = state?.zoom ?? 100;
  return <section className="browser-pane" aria-label={t('browser.title')} onKeyDown={event => {
    if (hidden || !state?.url || event.nativeEvent.isComposing) return;
    if (browserFindShortcut(event.key, event.ctrlKey, event.metaKey, event.altKey, event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
      showFind();
    } else if (event.key === 'Escape' && finding) {
      event.preventDefault();
      event.stopPropagation();
      stopFind();
    }
  }}>
    <div className="browser-toolbar">
      <div className="browser-buttons">
        <IconButton label={t('browser.back')} disabled={!state?.canGoBack} onClick={() => void command({ action: 'back' })}><ArrowLeft size={15} /></IconButton>
        <IconButton label={t('browser.forward')} disabled={!state?.canGoForward} onClick={() => void command({ action: 'forward' })}><ArrowRight size={15} /></IconButton>
        <IconButton label={t('common.reload')} disabled={!state?.url || state.loading} onClick={() => void command({ action: 'reload' })}><RotateCw size={14} className={state?.loading ? 'spin' : undefined} /></IconButton>
      </div>
      <form className="browser-address" onSubmit={event => {
        event.preventDefault();
        const url = address.trim();
        if (!browserUrl(url)) { setInvalid(true); return; }
        editingAddress.current = false;
        void command({ action: 'navigate', url }).then(accepted => {
          setInvalid(!accepted);
        });
      }}>
        <input type="text" inputMode="url" aria-label={t('browser.address')} aria-invalid={invalid}
          spellCheck={false} maxLength={4096} placeholder="https://example.com" value={address}
          onBlur={() => {
            if (editingAddress.current && !invalid) setAddress(state?.url ?? '');
            editingAddress.current = false;
          }}
          onChange={event => { editingAddress.current = true; setAddress(event.target.value); setInvalid(false); }} />
      </form>
      <div className="browser-buttons">
        <span ref={findButton}><IconButton label={t('browser.find')} aria-expanded={finding} disabled={!state?.url} onClick={showFind}><Search size={15} /></IconButton></span>
        <IconButton label={t('browser.zoomOut')} disabled={zoom <= 50} onClick={() => void command({ action: 'zoom', change: 'out' })}><Minus size={14} /></IconButton>
        <button className="browser-zoom" aria-label={t('browser.zoomReset', { zoom })} onClick={() => void command({ action: 'zoom', change: 'reset' })}>{zoom}%</button>
        <IconButton label={t('browser.zoomIn')} disabled={zoom >= 200} onClick={() => void command({ action: 'zoom', change: 'in' })}><Plus size={14} /></IconButton>
      </div>
    </div>
    {invalid && <div className="browser-message" role="alert">{t('browser.urlError')}</div>}
    {state?.failed && <div className="browser-message" role="status">{t('browser.loadError')}</div>}
    {finding && <form className="browser-find" onSubmit={event => {
      event.preventDefault();
      submitFind(query);
    }}>
      <input ref={findInput} type="search" autoFocus aria-label={t('browser.find')} maxLength={256} value={query}
        onChange={event => { setQuery(event.target.value); submitFind(event.target.value); }}
        onKeyDown={event => {
          if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); submitFind(query, false); }
        }} />
      <span className="browser-matches" aria-live="polite">{query && state?.match && t('browser.matches', state.match)}</span>
      <IconButton type="button" label={t('browser.previousMatch')} disabled={!query} onClick={() => submitFind(query, false)}><ChevronUp size={15} /></IconButton>
      <IconButton type="button" label={t('browser.nextMatch')} disabled={!query} onClick={() => submitFind(query)}><ChevronDown size={15} /></IconButton>
      <IconButton type="button" label={t('browser.closeFind')} onClick={stopFind}><X size={15} /></IconButton>
    </form>}
    <div ref={stage} className="browser-stage" />
  </section>;
}
