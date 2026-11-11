import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { connectBackend } from './backend-client';
import { daemonMarkerName, managedBackend } from './backend-discovery';

const owner = 'Ensemble managed backend';
const basePath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
const exec = promisify(execFile);

const xmlEscapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xml = (value: string) => `<string>${value.replace(/[&<>"']/g, character => xmlEscapes[character])}</string>`;
const unit = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;

export function daemonDefinition(options: {
  platform: 'darwin' | 'linux'; dataPath: string; command: string; entryPath: string;
  home: string; configHome?: string; path?: string; uid: number;
}) {
  const { platform, dataPath, command, entryPath, home, configHome, uid } = options;
  const path = options.path?.split(':').filter(isAbsolute).join(':') || basePath;
  const args = [command, entryPath, '--data-dir', dataPath];
  if ([...args, path].some(value => /[\u0000-\u001f\u007f]/.test(value))) throw new Error('服务路径不能包含控制字符。');
  const id = `local.agent-workbench.backend.${createHash('sha256').update(dataPath).digest('hex').slice(0, 20)}`;
  if (platform === 'darwin') {
    const configPath = join(home, 'Library', 'LaunchAgents', `${id}.plist`);
    const domain = `gui/${uid}`;
    const target = `${domain}/${id}`;
    return { id, configPath, platform, manager: '/bin/launchctl',
      status: ['print', target], start: ['bootstrap', domain, configPath], stop: ['bootout', target],
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${owner} -->
<plist version="1.0"><dict>
  <key>Label</key>${xml(id)}
  <key>ProgramArguments</key><array>${args.map(xml).join('')}</array>
  <key>EnvironmentVariables</key><dict>
    <key>ELECTRON_RUN_AS_NODE</key>${xml('1')}
    <key>WORKBENCH_MANAGED_BACKEND</key>${xml(id)}
    <key>PATH</key>${xml(path)}
  </dict>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key>${xml(join(dataPath, 'backend.log'))}
  <key>StandardErrorPath</key>${xml(join(dataPath, 'backend.log'))}
  <key>Umask</key><integer>63</integer>
</dict></plist>
` };
  }
  const service = `${id}.service`;
  const configPath = join(configHome && isAbsolute(configHome) ? configHome : join(home, '.config'), 'systemd', 'user', service);
  return { id, configPath, platform, manager: 'systemctl',
    status: ['--user', 'show', '--property=ActiveState', '--value', service],
    start: ['--user', 'start', service], stop: ['--user', 'stop', service], restart: ['--user', 'restart', service],
    enable: ['--user', 'enable', '--now', service], disable: ['--user', 'disable', '--now', service],
    reload: ['--user', 'daemon-reload'],
    content: `# ${owner}
[Unit]
Description=Ensemble headless backend

[Service]
Type=simple
UMask=0077
Environment=${unit('ELECTRON_RUN_AS_NODE=1')} ${unit(`WORKBENCH_MANAGED_BACKEND=${id}`)} ${unit(`PATH=${path}`)}
ExecStart=:${args.map(unit).join(' ')}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
` };
}

type Definition = ReturnType<typeof daemonDefinition>;

async function invoke(service: Definition, args: string[], allowMissing = false): Promise<string> {
  try { return (await exec(service.manager, args, { timeout: 30000, maxBuffer: 512 * 1024 })).stdout; }
  catch (error) {
    const result = error as { code?: number | string; stderr?: string };
    if (allowMissing && service.platform === 'darwin' && (result.code === 113 || result.stderr?.includes('Could not find service'))) return '';
    if (allowMissing && service.platform === 'linux' && result.stderr?.includes('could not be found')) return '';
    throw new Error(`无法执行 ${service.manager} ${args[0]}。请确认当前用户的服务管理器已运行。`, { cause: error });
  }
}

async function ownedDefinition(service: Definition): Promise<boolean> {
  try {
    const stat = await lstat(service.configPath);
    if (!stat.isFile() || stat.size > 16 * 1024 || !(await readFile(service.configPath, 'utf8')).includes(owner)) {
      throw new Error('服务配置路径已被其他文件占用。');
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function supervisorState(service: Definition): Promise<string> {
  const output = await invoke(service, service.status, true);
  if (service.platform === 'darwin') return output.match(/^\s*state = (.+)$/m)?.[1] ?? (output ? 'loaded' : 'unloaded');
  return output.trim() || 'inactive';
}

async function stopService(service: Definition): Promise<void> {
  if (service.platform === 'darwin' && await supervisorState(service) === 'unloaded') return;
  await invoke(service, service.stop, true);
  if (service.platform === 'linux') return;
  const deadline = Date.now() + 5000;
  while (await supervisorState(service) !== 'unloaded') {
    if (Date.now() >= deadline) throw new Error('后台服务仍在停止，请稍后重试。');
    await delay(100);
  }
}

export async function daemonCommand(action: string, dataDirectory: string, launch: { command: string; entryPath: string }): Promise<unknown> {
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'linux') throw new Error('后台服务支持 macOS launchd 和 Linux systemd 用户服务。');
  if (!['install', 'status', 'start', 'stop', 'restart', 'uninstall'].includes(action)) {
    throw new Error('daemon 支持 install、status、start、stop、restart、uninstall。');
  }
  const inputPath = resolve(dataDirectory);
  if (action === 'install') await mkdir(inputPath, { recursive: true, mode: 0o700 });
  const dataPath = await realpath(inputPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return inputPath;
  });
  const service = daemonDefinition({ platform, dataPath, ...launch, home: homedir(),
    configHome: process.env.XDG_CONFIG_HOME, uid: userInfo().uid, path: process.env.PATH });
  const marker = await managedBackend(dataPath);
  if (marker !== undefined && marker !== service.id) throw new Error('数据目录中的后台服务标记与当前路径不匹配。');
  const installed = await ownedDefinition(service);
  const state = async () => {
    const managed = await ownedDefinition(service);
    const backend = await connectBackend(dataPath).catch(() => undefined);
    return {
      installed: managed, dataPath, service: service.id, configuration: service.configPath,
      state: managed ? await supervisorState(service) : 'not-installed',
      ready: backend?.endpoint.managedService === service.id,
      ...(backend ? { backend: { pid: backend.endpoint.pid, source: backend.endpoint.managedService ? 'service' : 'standalone' } } : {}),
    };
  };
  if (action === 'status') return state();
  if (action === 'install') {
    const running = await connectBackend(dataPath).catch(() => undefined);
    if (running && running.endpoint.managedService !== service.id) {
      throw new Error('此数据目录已有普通后台。请退出桌面应用，运行 workbench stop，再安装服务。');
    }
    if (!marker) await writeFile(join(dataPath, daemonMarkerName), service.id + '\n', { mode: 0o600, flag: 'wx' });
    if (!installed) {
      await mkdir(dirname(service.configPath), { recursive: true, mode: 0o700 });
      if (platform === 'darwin') {
        const log = join(dataPath, 'backend.log');
        await writeFile(log, '', { mode: 0o600, flag: 'a' });
      }
      await writeFile(service.configPath, service.content, { mode: 0o600, flag: 'wx' });
    }
    if (service.reload) await invoke(service, service.reload);
    if (service.enable) await invoke(service, service.enable);
    else if (await supervisorState(service) === 'unloaded') await invoke(service, service.start);
    return state();
  }
  if (action === 'uninstall') {
    if (installed) {
      if (service.disable) await invoke(service, service.disable, true);
      else await stopService(service);
      await unlink(service.configPath);
      if (service.reload) await invoke(service, service.reload);
    }
    if (marker) await unlink(join(dataPath, daemonMarkerName));
    return state();
  }
  if (!installed || !marker) throw new Error('此数据目录尚未安装后台服务。');
  if (action === 'restart' && service.restart) await invoke(service, service.restart);
  else {
    if (action === 'stop' || action === 'restart') await stopService(service);
    if ((action === 'start' || action === 'restart') && (platform === 'linux' || await supervisorState(service) === 'unloaded')) {
      await invoke(service, service.start);
    }
  }
  return state();
}
