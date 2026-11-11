import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { REMOTE_REPLY_BYTES, REMOTE_REQUEST_BYTES, remoteDeviceInput, remoteReply, remoteRequest, type RemoteDevice, type RemoteDeviceSnapshot } from '../shared/remote-devices';

const deviceId = z.string().uuid();
const deviceList = z.array(remoteDeviceInput.extend({ id: deviceId })).max(20);
const saveInput = remoteDeviceInput.extend({ id: deviceId.optional() });
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function sshArguments(device: RemoteDevice): string[] {
  const command = [...(device.nodePath ? [`WORKBENCH_NODE=${quote(device.nodePath)}`] : []),
    quote(device.cliPath), 'remote-stdio', ...(device.dataPath ? ['--data-dir', quote(device.dataPath)] : [])];
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes',
    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no', '-o', 'ConnectTimeout=6',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '--', device.destination, command.join(' ')];
}

function exchange(device: RemoteDevice, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('ssh', sshArguments(device), { maxBuffer: REMOTE_REPLY_BYTES + 1024, timeout: 15000 }, (error, stdout, stderr) => {
      if (!error) { resolve(stdout); return; }
      if (error.killed) { reject(new Error('远程连接未在限时内返回，刷新会话以确认操作结果。')); return; }
      const detail = stderr.includes('Host key verification failed') ? '请在终端核对远程主机密钥。'
        : stderr.includes('Permission denied') ? '请在终端确认 SSH 密钥和账号。'
        : stderr.includes('WORKBENCH_NODE') ? '请在设备设置里填写 Node.js 的绝对路径。' : '请检查设备连接和远程 CLI 路径。';
      reject(new Error(`无法连接 ${device.name}。${detail}`));
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

export class RemoteDevices {
  private mutations = Promise.resolve<unknown>(undefined);
  private readonly file: string;

  constructor(private readonly dataPath: string, private readonly transport = exchange) {
    this.file = join(dataPath, 'remote-devices.json');
  }

  async list(): Promise<RemoteDevice[]> {
    try { return deviceList.parse(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('远程设备配置无法读取。');
    }
  }

  private change(update: (devices: RemoteDevice[]) => RemoteDevice[]): Promise<RemoteDevice[]> {
    const operation = this.mutations.then(async () => {
      const devices = update(await this.list());
      await mkdir(this.dataPath, { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(devices), { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.file);
      } finally { await unlink(temporary).catch(() => {}); }
      return devices;
    });
    this.mutations = operation.catch(() => {});
    return operation;
  }

  save(input: unknown): Promise<RemoteDevice[]> {
    const parsed = saveInput.parse(input);
    return this.change(devices => {
      if (parsed.id) {
        if (!devices.some(device => device.id === parsed.id)) throw new Error('远程设备已被移除。');
        return devices.map(device => device.id === parsed.id ? { ...parsed, id: device.id } : device);
      }
      if (devices.length >= 20) throw new Error('最多保存 20 台远程设备。');
      return [...devices, { ...parsed, id: randomUUID() }];
    });
  }

  remove(input: unknown): Promise<RemoteDevice[]> {
    const id = deviceId.parse(input);
    return this.change(devices => devices.filter(device => device.id !== id));
  }

  async request(inputId: unknown, input: unknown): Promise<RemoteDeviceSnapshot | undefined> {
    const id = deviceId.parse(inputId);
    const request = remoteRequest.parse(input);
    const device = (await this.list()).find(item => item.id === id);
    if (!device) throw new Error('远程设备已被移除。');
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > REMOTE_REQUEST_BYTES) throw new Error('远程请求超过大小限制。');
    const output = await this.transport(device, body);
    let response: unknown;
    try { response = JSON.parse(output); }
    catch { throw new Error('远程 CLI 没有返回有效响应。请检查版本和登录脚本的输出。'); }
    const parsed = remoteReply.safeParse(response);
    if (!parsed.success) throw new Error('远程 CLI 的响应与当前版本不兼容。');
    if (!parsed.data.ok) throw new Error(parsed.data.error);
    if (request.action === 'snapshot' && !parsed.data.snapshot) throw new Error('远程 CLI 没有返回会话。');
    if (request.action === 'create' && !parsed.data.snapshot?.selected) throw new Error('远程 CLI 没有返回创建的会话。');
    return parsed.data.snapshot;
  }
}
