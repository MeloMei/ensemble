import { useTranslation } from 'react-i18next';
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react';
import { Annotation, Compartment, EditorSelection, EditorState, Text, Transaction } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers, runScopeHandlers, type Panel } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { diff } from '@codemirror/merge';
import { SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel, search, searchKeymap, setSearchQuery } from '@codemirror/search';
import { useAppearance } from './appearance';
import type { FileReference } from './workspace-file-reference';

const remoteUpdate = Annotation.define<boolean>();
const lineSeparator = (value: string) => value.includes('\r\n') ? '\r\n' : value.includes('\r') ? '\r' : '\n';
const findKeymap = searchKeymap.filter(binding => binding.scope === 'editor search-panel');
const editorTheme = (dark: boolean) => EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--code-font-size)', backgroundColor: 'var(--editor-bg)', color: 'var(--text)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', lineHeight: '1.8' },
  '.cm-gutters': { backgroundColor: 'var(--editor-bg)', color: 'var(--dim)', borderRight: '1px solid var(--border)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 8px' },
  '.cm-activeLine': { backgroundColor: 'var(--selected)' },
  '.cm-activeLineGutter': { color: 'var(--text)', backgroundColor: 'var(--selected)' },
  '.cm-content': { padding: '10px 0', minHeight: '100%', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 12px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--editor-selection)' },
  '.cm-panels': { color: 'var(--text)', backgroundColor: 'var(--surface)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-file-find': { display: 'flex', alignItems: 'center', gap: '3px', padding: '4px 7px' },
  '.cm-file-find input': { flex: '1', minWidth: '0', height: '26px', padding: '0 6px', color: 'var(--text)',
    background: 'var(--editor-bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-control)', font: 'inherit' },
  '.cm-file-find button': { flexShrink: '0', width: '26px', height: '26px', color: 'var(--muted)',
    background: 'transparent', border: '0', borderRadius: 'var(--radius-control)', font: 'inherit' },
  '.cm-file-find button:hover': { color: 'var(--text)', background: 'var(--hover)' },
  '.cm-searchMatch': { backgroundColor: 'var(--warning-soft)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent)' },
  '&.cm-focused': { outline: 'none' },
}, { dark });

function fileFindPanel(view: EditorView): Panel {
  const doc = view.dom.ownerDocument;
  const dom = doc.createElement('div');
  dom.className = 'cm-file-find';
  dom.setAttribute('role', 'search');
  const field = doc.createElement('input');
  field.type = 'search';
  field.spellcheck = false;
  field.setAttribute('main-field', 'true');
  field.value = getSearchQuery(view.state).search;
  field.oninput = () => view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: field.value })) });
  const actions = [
    { label: 'Previous match', symbol: '↑', run: findPrevious },
    { label: 'Next match', symbol: '↓', run: findNext },
    { label: 'Close find', symbol: '×', run: closeSearchPanel },
  ].map(({ label, symbol, run }) => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = symbol;
    button.onclick = () => run(view);
    return { label, button };
  });
  const localize = () => {
    const label = view.state.phrase('Find in file');
    dom.setAttribute('aria-label', label);
    field.setAttribute('aria-label', label);
    field.placeholder = label;
    for (const action of actions) {
      action.button.title = view.state.phrase(action.label);
      action.button.setAttribute('aria-label', action.button.title);
    }
  };
  localize();
  dom.append(field, ...actions.map(action => action.button));
  dom.onkeydown = event => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (runScopeHandlers(view, event, 'search-panel')) event.preventDefault();
    else if (event.key === 'Enter' && event.target === field) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(view);
    }
  };
  return {
    dom, top: true,
    mount() { field.focus({ preventScroll: true }); field.select(); },
    update(update) {
      const query = getSearchQuery(update.state).search;
      if (field.value !== query) field.value = query;
      if (update.startState.facet(EditorState.phrases) !== update.state.facet(EditorState.phrases)) localize();
    },
  };
}

export interface CodeEditorHandle { find(): void; isComposing(): boolean }

export function CodeEditor({ value, onChange, readOnly = false, wrapLines = false, language = 'text', location, ref }: {
  value: string; onChange(value: string): void; readOnly?: boolean; wrapLines?: boolean; language?: string; location?: FileReference;
  ref?: Ref<CodeEditorHandle>;
}) {
  const { t } = useTranslation('workspace');
  const { theme, preferences: { codeFont, codeSize } } = useAppearance();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const permission = useRef(new Compartment());
  const appearance = useRef(new Compartment());
  const accessibility = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const lineEndings = useRef(new Compartment());
  const editorAccessibility = () => [
    EditorView.contentAttributes.of({ 'aria-label': t('editor.label', { language }), spellcheck: 'false' }),
    EditorState.phrases.of({
      'Find in file': t('editor.find'), 'Previous match': t('editor.findPrevious'),
      'Next match': t('editor.findNext'), 'Close find': t('editor.closeFind'),
      'current match': t('editor.currentMatch'), 'on line': t('editor.onLine'),
    }),
  ];
  const changed = useRef(onChange); changed.current = onChange;
  const initial = useRef(value);
  useImperativeHandle(ref, () => ({
    find() { if (editor.current) openSearchPanel(editor.current); },
    isComposing() { return editor.current?.composing ?? false; },
  }), []);
  useEffect(() => {
    if (!host.current) return;
    const separator = lineSeparator(initial.current);
    const view = new EditorView({ parent: host.current, state: EditorState.create({
      doc: initial.current,
      extensions: [lineNumbers(), highlightActiveLine(), drawSelection(), history(), search({ createPanel: fileFindPanel }),
        keymap.of([...findKeymap, ...defaultKeymap, ...historyKeymap]), appearance.current.of(editorTheme(theme === 'dark')),
        lineEndings.current.of(EditorState.lineSeparator.of(separator)), permission.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        accessibility.current.of(editorAccessibility()), wrapping.current.of(wrapLines ? EditorView.lineWrapping : []),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(remoteUpdate))) {
            changed.current(update.state.sliceDoc());
          }
        })],
    }) });
    editor.current = view;
    return () => { view.destroy(); editor.current = null; };
  }, []);
  useEffect(() => {
    editor.current?.dispatch({ effects: permission.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);
  useEffect(() => {
    editor.current?.dispatch({ effects: appearance.current.reconfigure(editorTheme(theme === 'dark')) });
  }, [theme]);
  useEffect(() => { editor.current?.requestMeasure(); }, [codeFont, codeSize]);
  useEffect(() => {
    editor.current?.dispatch({ effects: accessibility.current.reconfigure(editorAccessibility()) });
  }, [language, t]);
  useEffect(() => {
    editor.current?.dispatch({ effects: wrapping.current.reconfigure(wrapLines ? EditorView.lineWrapping : []) });
  }, [wrapLines]);
  useLayoutEffect(() => {
    const view = editor.current;
    if (!view) return;
    const { state } = view;
    const separator = lineSeparator(value);
    if (state.lineBreak === separator && state.sliceDoc() === value) return;
    const next = Text.of(value.split(separator));
    const changes = state.changes(diff(state.doc.toString(), next.toString(), { scanLimit: 500, timeout: 20 })
      .map(change => ({ from: change.fromA, to: change.toA, insert: next.slice(change.fromB, change.toB) })));
    const effects = state.lineBreak === separator ? [] : [lineEndings.current.reconfigure(EditorState.lineSeparator.of(separator))];
    if (!changes.empty) {
      const scroll = view.scrollSnapshot().map(changes);
      if (scroll) effects.push(scroll);
    }
    view.dispatch({ changes, effects,
      annotations: [remoteUpdate.of(true), Transaction.addToHistory.of(false)] });
  }, [value]);
  useEffect(() => {
    const view = editor.current;
    if (!view || location?.line === undefined) return;
    const { doc } = view.state;
    const first = doc.line(Math.min(location.line, doc.lines));
    const start = first.from + Math.min((location.column ?? 1) - 1, first.length);
    const last = location.endLine === undefined ? undefined : doc.line(Math.min(location.endLine, doc.lines));
    const selection = last ? EditorSelection.range(start, last.to) : EditorSelection.cursor(start);
    view.dispatch({ selection, effects: EditorView.scrollIntoView(start, { y: 'center' }) });
  }, [location]);
  return <div className="code-editor-host" ref={host} style={{ height: '100%', minHeight: 180 }} />;
}
