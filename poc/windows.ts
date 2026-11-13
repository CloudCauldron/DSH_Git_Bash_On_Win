import { createHash, randomUUID } from 'node:crypto';
import type { Runtime } from './runtime.ts';

type Pointer = bigint | null;
interface CType { size: number }
type Type = CType | string;
interface Library { func(convention: string, name: string, result: Type, args: Type[]): unknown }
interface Ffi {
  load(name: string): Library;
  pointer(type: Type): CType;
  struct(name: string, fields: Record<string, Type>): CType;
  decode(pointer: Pointer | Buffer, offset: number, type: Type): unknown;
}
type Binder = (library: Library, name: string, result: Type, args: Type[]) => unknown;
interface Api {
  closeHandle(handle: Pointer): number;
  getLastError(): number;
  currentProcess(): Pointer;
  openToken(process: Pointer, access: number, output: Buffer): number;
  tokenInfo(token: Pointer, kind: number, output: Buffer | null, bytes: number, needed: Buffer): number;
  restricted(token: Pointer): number;
  inJob(process: Pointer, job: null, output: Buffer): number;
  sessionId(pid: number, output: Buffer): number;
  descriptor(sddl: string, revision: number, output: Buffer, bytes: null): number;
  localFree(pointer: Pointer): Pointer;
  namedPipe(name: string, access: number, mode: number, instances: number, output: number, input: number, timeout: number, attributes: object | null): Pointer;
  openFile(name: string, access: number, share: number, attributes: null, disposition: number, flags: number, template: null): Pointer;
  createDirectory(output: Buffer, access: number, attributes: object): number;
  openDirectory(output: Buffer, access: number, attributes: object): number;
  fileSecurity(path: string, type: number, information: number, owner: Buffer, group: Buffer, dacl: Buffer, sacl: Buffer, descriptor: Buffer): number;
  descriptorLength(descriptor: Pointer): number;
}

interface Token {
  user: string;
  logon: string;
  capabilities: string[];
  public: {
    fingerprint: string;
    defaultDaclHash: string;
    restricted: boolean;
    integrity: string;
    restrictingSidCount: number;
    userSidInRestrictingList: boolean;
    authenticatedUsersInRestrictingList: boolean;
    inJob: boolean;
  };
}

/** Query-only token diagnostics and operations on NEW random private IPC objects. */
export async function createNativeDiagnostics(runtime: Runtime) {
  const ffi = runtime.aclRequire('koffi') as Ffi;
  const processModule = await runtime.load(runtime.aclRequire, '@deepseek-ai/dsh-win32-process');
  const pointerType = ffi.pointer('void');
  const unicode = ffi.struct('DSH_GITBASH_POC_UNICODE_STRING', { Length: 'uint16', MaximumLength: 'uint16', Buffer: 'str16' });
  const attributes = ffi.struct('DSH_GITBASH_POC_OBJECT_ATTRIBUTES', {
    Length: 'uint32', RootDirectory: pointerType, ObjectName: ffi.pointer(unicode), Attributes: 'uint32',
    SecurityDescriptor: pointerType, SecurityQualityOfService: pointerType,
  });
  const securityAttributes = ffi.struct('DSH_GITBASH_POC_SECURITY_ATTRIBUTES', { nLength: 'uint32', lpSecurityDescriptor: pointerType, bInheritHandle: 'int' });
  if (unicode.size !== 16 || attributes.size !== 48 || securityAttributes.size !== 24) throw new Error('Unsupported Windows ABI layout.');
  const api = processModule.extendWin32ProcessBindings(({ kernel32, advapi32, bind }: { kernel32: Library; advapi32: Library; bind: Binder }) => {
    const ntdll = ffi.load('ntdll.dll');
    return {
      currentProcess: bind(kernel32, 'GetCurrentProcess', pointerType, []),
      openToken: bind(advapi32, 'OpenProcessToken', 'int', [pointerType, 'uint32', pointerType]),
      tokenInfo: bind(advapi32, 'GetTokenInformation', 'int', [pointerType, 'int', pointerType, 'uint32', pointerType]),
      restricted: bind(advapi32, 'IsTokenRestricted', 'int', [pointerType]),
      inJob: bind(kernel32, 'IsProcessInJob', 'int', [pointerType, pointerType, pointerType]),
      sessionId: bind(kernel32, 'ProcessIdToSessionId', 'int', ['uint32', pointerType]),
      descriptor: bind(advapi32, 'ConvertStringSecurityDescriptorToSecurityDescriptorW', 'int', ['str16', 'uint32', pointerType, pointerType]),
      localFree: bind(kernel32, 'LocalFree', pointerType, [pointerType]),
      namedPipe: bind(kernel32, 'CreateNamedPipeW', pointerType, ['str16', 'uint32', 'uint32', 'uint32', 'uint32', 'uint32', 'uint32', ffi.pointer(securityAttributes)]),
      openFile: bind(kernel32, 'CreateFileW', pointerType, ['str16', 'uint32', 'uint32', pointerType, 'uint32', 'uint32', pointerType]),
      createDirectory: bind(ntdll, 'NtCreateDirectoryObject', 'int32', [pointerType, 'uint32', ffi.pointer(attributes)]),
      openDirectory: bind(ntdll, 'NtOpenDirectoryObject', 'int32', [pointerType, 'uint32', ffi.pointer(attributes)]),
      fileSecurity: bind(advapi32, 'GetNamedSecurityInfoW', 'uint32', ['str16', 'int', 'uint32', pointerType, pointerType, pointerType, pointerType, pointerType]),
      descriptorLength: bind(advapi32, 'GetSecurityDescriptorLength', 'uint32', [pointerType]),
    };
  }) as Api;

  const ptr = (buffer: Buffer, offset = 0) => ffi.decode(buffer, offset, pointerType) as Pointer;
  const valid = (p: Pointer) => p !== null && p !== 0n && BigInt.asUintN(64, p) !== 0xffffffffffffffffn;
  const close = (p: Pointer) => { if (valid(p) && !api.closeHandle(p)) throw new Error(`CloseHandle: ${api.getLastError()}`); };
  const ntstatus = (n: number) => '0x' + (n >>> 0).toString(16).padStart(8, '0');

  function sid(p: Pointer): string {
    if (!valid(p)) throw new Error('Missing SID pointer.');
    const byte = (offset: number) => Number(ffi.decode(p, offset, 'uint8'));
    const count = byte(1);
    if (byte(0) !== 1 || count > 15) throw new Error('Invalid SID header.');
    let authority = 0;
    for (let i = 2; i < 8; i++) authority = authority * 256 + byte(i);
    return `S-1-${authority}` + Array.from({ length: count }, (_, i) => `-${Number(ffi.decode(p, 8 + i * 4, 'uint32'))}`).join('');
  }

  function token(processHandle: Pointer = api.currentProcess()): Token {
    const output = Buffer.alloc(8);
    if (!api.openToken(processHandle, 0x0008, output)) throw new Error(`OpenProcessToken(query): ${api.getLastError()}`);
    const handle = ptr(output);
    try {
      const query = (kind: number) => {
        const needed = Buffer.alloc(4);
        api.tokenInfo(handle, kind, null, 0, needed);
        const bytes = needed.readUInt32LE();
        if (bytes < 4 || bytes > 1_048_576) throw new Error(`Invalid token query size: ${bytes}`);
        const buffer = Buffer.alloc(bytes);
        if (!api.tokenInfo(handle, kind, buffer, bytes, needed)) throw new Error(`GetTokenInformation(${kind}): ${api.getLastError()}`);
        return buffer;
      };
      const groups = (kind: number) => {
        const buffer = query(kind);
        const count = buffer.readUInt32LE();
        if (count !== 0 && 8 + count * 16 > buffer.length) throw new Error('Invalid TOKEN_GROUPS layout.');
        return Array.from({ length: count }, (_, i) => ({ sid: sid(ptr(buffer, 8 + i * 16)), attributes: buffer.readUInt32LE(16 + i * 16) }));
      };
      const userInfo = query(1);
      const user = sid(ptr(userInfo));
      const enabledGroups = groups(2);
      const logon = enabledGroups.find(x => (x.attributes & 0xc0000000) >>> 0 === 0xc0000000)?.sid;
      if (!logon) throw new Error('No logon SID in the query token.');
      const restricted = groups(11).map(x => x.sid).sort();
      const integrityInfo = query(25);
      const integrity = sid(ptr(integrityInfo));
      const defaultDaclInfo = query(6);
      const defaultDacl = ptr(defaultDaclInfo);
      let defaultDaclHash = 'null';
      if (valid(defaultDacl)) {
        const length = Number(ffi.decode(defaultDacl, 2, 'uint16'));
        if (length < 8 || length > 16_384) throw new Error('Invalid default DACL length.');
        const bytes = Buffer.from(Array.from({ length }, (_, i) => Number(ffi.decode(defaultDacl, i, 'uint8'))));
        defaultDaclHash = createHash('sha256').update(bytes).digest('hex');
      }
      const privileges = query(3);
      const count = privileges.readUInt32LE();
      if (4 + count * 12 > privileges.length) throw new Error('Invalid TOKEN_PRIVILEGES layout.');
      const privilegeValues = Array.from({ length: count }, (_, i) => ({
        luid: privileges.readBigUInt64LE(4 + i * 12).toString(), attributes: privileges.readUInt32LE(12 + i * 12),
      }));
      const inJob = Buffer.alloc(4);
      if (!api.inJob(processHandle, null, inJob)) throw new Error(`IsProcessInJob: ${api.getLastError()}`);
      const fingerprint = createHash('sha256').update(JSON.stringify({ user, enabledGroups, restricted, integrity, privilegeValues })).digest('hex');
      return {
        user, logon, capabilities: restricted.filter(x => x.startsWith('S-1-4-')),
        public: {
          fingerprint, defaultDaclHash, restricted: !!api.restricted(handle), integrity, restrictingSidCount: restricted.length,
          userSidInRestrictingList: restricted.includes(user), authenticatedUsersInRestrictingList: restricted.includes('S-1-5-11'),
          inJob: inJob.readUInt32LE() !== 0,
        },
      };
    } finally { close(handle); }
  }

  function fileSecurityHash(path: string) {
    const owner = Buffer.alloc(8), group = Buffer.alloc(8), dacl = Buffer.alloc(8), sacl = Buffer.alloc(8), descriptor = Buffer.alloc(8);
    const status = api.fileSecurity(path, 1, 0x17, owner, group, dacl, sacl, descriptor);
    if (status !== 0) throw new Error(`GetNamedSecurityInfoW(query): ${status}, ${path}`);
    const memory = ptr(descriptor);
    try {
      const length = api.descriptorLength(memory);
      if (length < 20 || length > 65_536) throw new Error('Invalid file security descriptor length.');
      const bytes = Buffer.from(Array.from({ length }, (_, i) => Number(ffi.decode(memory, i, 'uint8'))));
      return createHash('sha256').update(bytes).digest('hex');
    } finally { if (valid(memory)) api.localFree(memory); }
  }

  function withDescriptor<T>(sddl: string | undefined, fn: (descriptor: Pointer) => T): T {
    if (!sddl) return fn(null);
    const output = Buffer.alloc(8);
    if (!api.descriptor(sddl, 1, output, null)) throw new Error(`ConvertStringSecurityDescriptor: ${api.getLastError()}`);
    const sd = ptr(output);
    try { return fn(sd); }
    finally { if (api.localFree(sd) !== null) throw new Error('LocalFree security descriptor failed.'); }
  }

  function privateSddl(t: Token, extraSid?: string, low = false) {
    return `D:P(A;;GA;;;${t.user})(A;;GA;;;BA)(A;;GA;;;SY)`
      + (extraSid ? `(A;;GA;;;${extraSid})` : '') + (low ? 'S:(ML;;NW;;;LW)' : '');
  }

  function pipeMatrix(t: Token) {
    const variants: Array<[string, string | undefined]> = [
      ['inherited-default', undefined],
      ['explicit-user-admin-system', privateSddl(t)],
      ['explicit-user-admin-system-low', privateSddl(t, undefined, true)],
      ['explicit-logon', privateSddl(t, t.logon)],
      ['explicit-logon-low', privateSddl(t, t.logon, true)],
      ...t.capabilities[0] ? [['explicit-existing-capability-low', privateSddl(t, t.capabilities[0], true)] as [string, string]] : [],
    ];
    return variants.map(([variant, sddl]) => withDescriptor(sddl, sd => {
      const name = `\\\\.\\pipe\\dsh-gitbash-poc-${randomUUID()}`;
      const server = api.namedPipe(name, 0x00080001, 0x0000000c, 1, 0, 4096, 0,
        sd ? { nLength: securityAttributes.size, lpSecurityDescriptor: sd, bInheritHandle: 0 } : null);
      if (!valid(server)) return { variant, serverCreated: false, win32Error: api.getLastError() };
      let client: Pointer = null;
      try {
        client = api.openFile(name, 0x40000080, 0, null, 3, 0, null);
        const error = valid(client) ? 0 : api.getLastError();
        return { variant, serverCreated: true, clientOpened: valid(client), win32Error: error };
      } finally { try { close(client); } finally { close(server); } }
    }));
  }

  function objectAttributes(name: string, sd: Pointer = null) {
    const bytes = Buffer.byteLength(name, 'utf16le');
    if (bytes > 32_000) throw new Error('Object name is too long.');
    return {
      Length: attributes.size, RootDirectory: null,
      ObjectName: { Length: bytes, MaximumLength: bytes + 2, Buffer: name },
      Attributes: 0x40, SecurityDescriptor: sd, SecurityQualityOfService: null,
    };
  }

  function openNamespace(path: string, access: number) {
    const output = Buffer.alloc(8);
    const status = api.openDirectory(output, access, objectAttributes(path));
    if (status >= 0) close(ptr(output));
    return { path, access, status: ntstatus(status), opened: status >= 0 };
  }

  function createDirectory(path: string, sd: Pointer) {
    const output = Buffer.alloc(8);
    // No OBJ_OPENIF: a collision fails instead of touching any existing object.
    const status = api.createDirectory(output, 0x000f, objectAttributes(path, sd));
    return { handle: status >= 0 ? ptr(output) : null, status };
  }

  function createPrivateNamespace() {
    const t = token();
    const path = `\\BaseNamedObjects\\dsh-gitbash-poc-${randomUUID()}`;
    const result = withDescriptor(privateSddl(t, t.logon, true), sd => createDirectory(path, sd));
    let closed = false;
    return {
      path: result.status >= 0 ? path : undefined,
      result: { path, status: ntstatus(result.status), created: result.status >= 0, descriptor: 'current-user/admin/system/logon; low label; NEW object only' },
      close() {
        if (closed) return;
        closed = true;
        close(result.handle);
        if (result.status >= 0) {
          const after = openNamespace(path, 0x3);
          if (after.status !== '0xc0000034' && after.status !== '0xc000003a') {
            throw new Error(`Private namespace disappearance was not confirmed: ${after.status}`);
          }
        }
      },
    };
  }

  function namespaceMatrix(t: Token, privateNamespace: string | undefined, bash: { stderr: string }) {
    const session = Buffer.alloc(4);
    if (!api.sessionId(process.pid, session)) throw new Error(`ProcessIdToSessionId: ${api.getLastError()}`);
    const roots = ['\\BaseNamedObjects', `\\Sessions\\${session.readUInt32LE()}\\BaseNamedObjects`];
    const msys = bash.stderr.match(/NtCreateDirectoryObject\(([^)]+)\)/)?.[1];
    if (msys && /^\\BaseNamedObjects\\msys-[a-zA-Z0-9.-]+$/.test(msys)) roots.push(msys);
    if (privateNamespace) roots.push(privateNamespace);
    // 0x2000f is CYG_SHARED_DIR_ACCESS in the installed MSYS source.
    const opens = roots.flatMap(path => [openNamespace(path, 0x3), openNamespace(path, 0x0f), openNamespace(path, 0x2000f)]);
    const creation = ['\\BaseNamedObjects', ...privateNamespace ? [privateNamespace] : []].map(root => {
      const path = `${root}\\dsh-gitbash-poc-${randomUUID()}`;
      return withDescriptor(privateSddl(t, t.logon, true), sd => {
        const result = createDirectory(path, sd);
        close(result.handle);
        return { parent: root, created: result.status >= 0, status: ntstatus(result.status) };
      });
    });
    return { opens, creation };
  }

  return { token, pipeMatrix, namespaceMatrix, createPrivateNamespace, fileSecurityHash,
    namespaceStatus: (path: string) => openNamespace(path, 0x3),
  };
}
