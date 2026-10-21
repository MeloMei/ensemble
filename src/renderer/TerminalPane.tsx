import { useEffect, useRef } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CircleStop, TerminalSquare } from 'lucide-react';
import type { TerminalInfo } from '../shared/types';
import { type Perform } from './ui';
import { useAppearance } from './appearance';
import '@xterm/xterm/css/xterm.css';

const terminalColors = {
  background: 'background', foreground: 'foreground', cursor: 'cursor', cursorAccent: 'background',
  selectionBackground: 'selection', selectionInactiveBackground: 'selection',
  black: 'black', red: 'red', green: 'green', yellow: 'yellow', blue: 'blue', magenta: 'magenta', cyan: 'cyan', white: 'white',
  brightBlack: 'bright-black', brightRed: 'bright-red', brightGreen: 'bright-green', brightYellow: 'bright-yellow',
  brightBlue: 'bright-blue', brightMagenta: 'bright-magenta', brightCyan: 'bright-cyan', brightWhite: 'bright-white',
} as const satisfies Partial<Record<keyof ITheme, string>>;

function terminalTheme(element: HTMLElement): ITheme {
  const styles = getComputedStyle(element);
  return Object.fromEntries(Object.entries(terminalColors).map(([key, token]) => [key, styles.getPropertyValue(`--terminal-${token}`).trim()]));
}

export function TerminalPane({ info, cwd, perform }: { info: TerminalInfo; cwd: string; perform: Perform }) {
  const { theme } = useAppearance();
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<Terminal | null>(null);
  const consumedEnd = useRef<number | null>(null);
  const performRef = useRef(perform);
  const statusRef = useRef(info.status);
  performRef.current = perform;
  statusRef.current = info.status;

  useEffect(() => {
    if (!container.current) return;
    const terminal = new Terminal({
      allowProposedApi: false, convertEol: false, cursorBlink: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 12, lineHeight: 1.5, scrollback: 5000,
      theme: terminalTheme(container.current),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current);
    instance.current = terminal;
    consumedEnd.current = null;
    let frame = 0;
    let previousSize = '';
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!container.current || container.current.clientWidth < 20 || container.current.clientHeight < 20) return;
        fit.fit();
        const size = `${terminal.cols}:${terminal.rows}`;
        if (size === previousSize || statusRef.current !== 'running') return;
        previousSize = size;
        void performRef.current(`resize-${info.id}`, () => window.workbench.resizeTerminal(info.id, terminal.cols, terminal.rows));
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    resize();
    const input = terminal.onData(data => {
      void performRef.current(`terminal-input-${info.id}`, () => window.workbench.writeTerminal(info.id, data));
    });
    terminal.focus();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); input.dispose(); terminal.dispose(); instance.current = null; consumedEnd.current = null; };
  }, [info.id]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (instance.current && container.current) instance.current.options.theme = terminalTheme(container.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [theme]);

  useEffect(() => {
    const terminal = instance.current;
    if (!terminal) return;
    const end = info.outputOffset + info.output.length;
    const previousEnd = consumedEnd.current;
    if (previousEnd === null || info.outputOffset > previousEnd) {
      if (previousEnd !== null) terminal.reset();
      terminal.write(info.output);
      consumedEnd.current = end;
    } else if (end > previousEnd) {
      terminal.write(info.output.slice(previousEnd - info.outputOffset));
      consumedEnd.current = end;
    }
    terminal.options.disableStdin = info.status === 'exited';
  }, [info.output, info.outputOffset, info.status]);

  return <section className="terminal-pane"><div className="terminal-toolbar"><span title={cwd}><TerminalSquare size={14} /><span>{cwd}</span></span>
    <span className={`terminal-status ${info.status === 'running' ? 'running' : ''}`}><i />{info.status === 'running' ? '运行中' : `已退出${info.exitCode !== null ? ` · ${info.exitCode}` : ''}`}</span>
    {info.status === 'running' && <button className="text-button" onClick={() => void perform(`stop-terminal-${info.id}`, () => window.workbench.stopTerminal(info.id))}><CircleStop size={13} />停止</button>}
  </div><div className="terminal-surface" ref={container} /></section>;
}
