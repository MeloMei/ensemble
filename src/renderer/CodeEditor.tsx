import { useTranslation } from 'react-i18next';
import { useEffect, useRef } from 'react';
import { Annotation, Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { useAppearance } from './appearance';
import type { FileReference } from './workspace-file-reference';

const remoteUpdate = Annotation.define<boolean>();
const editorTheme = (dark: boolean) => EditorView.theme({
  '&': { height: '100%', fontSize: '12px', backgroundColor: 'var(--editor-bg)', color: 'var(--text)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: '"SFMono-Regular", Menlo, monospace', lineHeight: '1.8' },
  '.cm-gutters': { backgroundColor: 'var(--editor-bg)', color: 'var(--dim)', borderRight: '1px solid var(--border)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 8px' },
  '.cm-activeLine': { backgroundColor: 'var(--selected)' },
  '.cm-activeLineGutter': { color: 'var(--text)', backgroundColor: 'var(--selected)' },
  '.cm-content': { padding: '10px 0', minHeight: '100%', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 12px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--editor-selection)' },
  '&.cm-focused': { outline: 'none' },
}, { dark });

export function CodeEditor({ value, onChange, readOnly = false, language = 'text', location }: {
  value: string; onChange(value: string): void; readOnly?: boolean; language?: string; location?: FileReference;
}) {
  const { t } = useTranslation('workspace');
  const { theme } = useAppearance();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const permission = useRef(new Compartment());
  const appearance = useRef(new Compartment());
  const accessibility = useRef(new Compartment());
  const changed = useRef(onChange); changed.current = onChange;
  const initial = useRef(value);
  useEffect(() => {
    if (!host.current) return;
    const separator = initial.current.includes('\r\n') ? '\r\n' : initial.current.includes('\r') ? '\r' : '\n';
    const view = new EditorView({ parent: host.current, state: EditorState.create({
      doc: initial.current,
      extensions: [lineNumbers(), highlightActiveLine(), drawSelection(), history(), keymap.of([...defaultKeymap, ...historyKeymap]), appearance.current.of(editorTheme(theme === 'dark')),
        EditorState.lineSeparator.of(separator), permission.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        accessibility.current.of(EditorView.contentAttributes.of({ 'aria-label': t('editor.label', { language }), spellcheck: 'false' })),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(remoteUpdate))) {
            changed.current(update.state.doc.sliceString(0, undefined, separator));
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
  useEffect(() => {
    editor.current?.dispatch({ effects: accessibility.current.reconfigure(
      EditorView.contentAttributes.of({ 'aria-label': t('editor.label', { language }), spellcheck: 'false' }),
    ) });
  }, [language, t]);
  useEffect(() => {
    const view = editor.current;
    if (!view || view.state.doc.eq(view.state.toText(value))) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value },
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
