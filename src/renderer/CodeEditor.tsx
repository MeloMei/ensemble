import { useEffect, useRef } from 'react';
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { useAppearance } from './appearance';

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

export function CodeEditor({ value, onChange, readOnly = false, language = 'text' }: {
  value: string; onChange(value: string): void; readOnly?: boolean; language?: string;
}) {
  const { theme } = useAppearance();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const permission = useRef(new Compartment());
  const appearance = useRef(new Compartment());
  const changed = useRef(onChange); changed.current = onChange;
  const initial = useRef(value);
  useEffect(() => {
    if (!host.current) return;
    const separator = initial.current.includes('\r\n') ? '\r\n' : initial.current.includes('\r') ? '\r' : '\n';
    const view = new EditorView({ parent: host.current, state: EditorState.create({
      doc: initial.current,
      extensions: [lineNumbers(), highlightActiveLine(), history(), keymap.of([...defaultKeymap, ...historyKeymap]), appearance.current.of(editorTheme(theme === 'dark')),
        EditorState.lineSeparator.of(separator), permission.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        EditorView.contentAttributes.of({ 'aria-label': `文件编辑器 (${language})`, spellcheck: 'false' }),
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
    const view = editor.current;
    if (!view || view.state.doc.eq(view.state.toText(value))) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: [remoteUpdate.of(true), Transaction.addToHistory.of(false)] });
  }, [value]);
  return <div className="code-editor-host" ref={host} style={{ height: '100%', minHeight: 180 }} />;
}
