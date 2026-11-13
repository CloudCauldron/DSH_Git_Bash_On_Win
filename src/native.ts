import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { tempWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl';
import { extendWin32ProcessBindings } from '@deepseek-ai/dsh-win32-process';

const aclRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl'));
export const nativeRuntime = {
  aclRequire,
  baseRequire: createRequire(import.meta.url),
  load: (require: NodeJS.Require, name: string) => import(pathToFileURL(require.resolve(name)).href),
};

/** Query only. The launcher inherits DSH's token; it never constructs a token. */
export function ipcSids(mode: string): { pipeSid: string; defaultDaclSid: string } {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native Windows x64 is required.');
  const ffi = aclRequire('koffi');
  const api = extendWin32ProcessBindings(({ kernel32, advapi32, bind }) => ({
    currentProcess: bind(kernel32, 'GetCurrentProcess', 'void *', []),
    openToken: bind(advapi32, 'OpenProcessToken', 'int', ['void *', 'uint32', 'void *']),
    tokenInfo: bind(advapi32, 'GetTokenInformation', 'int', ['void *', 'int', 'void *', 'uint32', 'void *']),
    restricted: bind(advapi32, 'IsTokenRestricted', 'int', ['void *']),
    inJob: bind(kernel32, 'IsProcessInJob', 'int', ['void *', 'void *', 'void *']),
  })) as unknown as {
    currentProcess(): bigint;
    openToken(...args: unknown[]): number;
    tokenInfo(...args: unknown[]): number;
    restricted(...args: unknown[]): number;
    inJob(...args: unknown[]): number;
    getLastError(): number;
    closeHandle(...args: unknown[]): number;
  };
  const output = Buffer.alloc(8);
  if (!api.openToken(api.currentProcess(), 8, output)) throw new Error(`OpenProcessToken(query): ${api.getLastError()}`);
  const token = ffi.decode(output, 'void *');
  try {
    const query = (kind: number): Buffer => {
      const needed = Buffer.alloc(4);
      api.tokenInfo(token, kind, null, 0, needed);
      const bytes = needed.readUInt32LE();
      if (bytes < 4 || bytes > 65_536) throw new Error('Invalid token information size.');
      const result = Buffer.alloc(bytes);
      if (!api.tokenInfo(token, kind, result, bytes, needed)) throw new Error(`GetTokenInformation(${kind}): ${api.getLastError()}`);
      return result;
    };
    const sid = (pointer: bigint): string => {
      const count = Number(ffi.decode(pointer, 1, 'uint8'));
      if (Number(ffi.decode(pointer, 0, 'uint8')) !== 1 || count > 15) throw new Error('Invalid SID.');
      let authority = 0;
      for (let index = 2; index < 8; index++) authority = authority * 256 + Number(ffi.decode(pointer, index, 'uint8'));
      return `S-1-${authority}` + Array.from({ length: count }, (_, index) => `-${Number(ffi.decode(pointer, 8 + index * 4, 'uint32'))}`).join('');
    };
    const groups = (kind: number) => {
      const data = query(kind), count = data.readUInt32LE();
      if (count > 0 && 8 + count * 16 > data.length) throw new Error('Invalid TOKEN_GROUPS layout.');
      return Array.from({ length: count }, (_, index) => ({
        sid: sid(ffi.decode(data, 8 + index * 16, 'void *')),
        attributes: data.readUInt32LE(16 + index * 16),
      }));
    };
    const logon = groups(2).find(group => ((group.attributes & 0xc0000000) >>> 0) === 0xc0000000)?.sid;
    if (!logon) throw new Error('The inherited token has no logon SID.');
    const job = Buffer.alloc(4);
    if (!api.inJob(api.currentProcess(), null, job) || !job.readUInt32LE()) throw new Error('DSH Job containment is required.');
    if (mode === 'danger-full-access') return { pipeSid: logon, defaultDaclSid: logon };
    const restrictions = groups(11).map(group => group.sid);
    const user = sid(ffi.decode(query(1), 0, 'void *'));
    const integrity = sid(ffi.decode(query(25), 0, 'void *'));
    const capabilities = restrictions.filter(value => value.startsWith('S-1-4-'));
    if (!api.restricted(token) || integrity !== 'S-1-16-4096' || restrictions.includes(user) || restrictions.includes('S-1-5-11') || !restrictions.includes(logon)) {
      throw new Error('DSH Windows sandbox restrictions are missing; the command did not run.');
    }
    if (mode === 'read-only' && capabilities.length === 0) return { pipeSid: logon, defaultDaclSid: logon };
    const temp = tempWriteSid(tmpdir());
    if (mode === 'workspace-write' && capabilities.includes(temp)) return { pipeSid: temp, defaultDaclSid: temp };
    throw new Error('The inherited DSH mode or private-temp capability is incompatible; the command did not run.');
  } finally {
    if (!api.closeHandle(token)) throw new Error(`CloseHandle(token): ${api.getLastError()}`);
  }
}
