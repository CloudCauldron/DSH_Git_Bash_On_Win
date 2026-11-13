import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { link, lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, toNamespacedPath } from 'node:path';
import { extendWin32ProcessBindings } from '@deepseek-ai/dsh-win32-process';

export interface PrivateRuntime {
  root: string;
  source: string;
  bash: string;
  fingerprint: string;
  links: number;
}

export interface RuntimeLease extends PrivateRuntime { release(): Promise<void> }

export interface RuntimeView {
  installationRoot: string;
  release(): void;
}

export const modes = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type Mode = typeof modes[number];
export type ElevateLinks = (source: string, generation: string) => Promise<void>;
export const setupCancellationFile = 'setup-cancelled';

/** Share the same bounded retry policy without chmod or recursive fs.rm. */
export async function retryCleanup(operation: () => void, ignore: readonly string[] = []): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { operation(); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 2 || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(code)) {
        if (ignore.includes(code)) return;
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

/** Node's recursive rm may chmod on Windows EPERM. Never do that to a hardlink. */
export function removePrivateTree(path: string): void {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink()) {
    try { rmdirSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
      unlinkSync(path);
    }
  } else if (stat.isDirectory()) {
    for (const name of readdirSync(path)) removePrivateTree(join(path, name));
    rmdirSync(path);
  } else unlinkSync(path);
}

export async function runtimeFiles(source: string) {
  const files: Array<{ path: string; source: string; dev: string; ino: string; size: string; mtime: string }> = [];
  const visit = async (path: string) => {
    // Keep executable dependencies and shared data, excluding desktop metadata,
    // documentation, licenses, and the static WinPTY development library.
    if (/^(?:usr|ucrt64|mingw64)[\\/]share[\\/](?:doc|licenses|gtk-doc|icons|applications|fish|makepkg-template)(?:[\\/]|$)/.test(path)
      || path === join('usr/lib/winpty.lib')) return;
    const origin = join(source, path);
    let entry;
    try { entry = await lstat(origin, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (entry.isSymbolicLink()) throw new Error(`Refusing a source reparse point: ${origin}`);
    if (entry.isDirectory()) {
      for (const name of (await readdir(origin)).sort()) await visit(join(path, name));
    } else if (entry.isFile()) {
      if ((Number(entry.mode) & 0o200) === 0) throw new Error(`Source has the Windows read-only attribute; refusing links that cannot be safely unlinked: ${origin}`);
      files.push({ path, source: origin, dev: String(entry.dev), ino: String(entry.ino), size: String(entry.size), mtime: String(entry.mtimeNs) });
    } else throw new Error(`Unsupported Git runtime entry: ${origin}`);
  };
  const visitRoot = async (path: string) => {
    runtimeParent(join(source, path));
    await visit(path);
  };
  for (const path of ['usr/bin', 'usr/lib', 'usr/libexec', 'usr/share', 'usr/ssl']) await visitRoot(path);
  for (const architecture of ['ucrt64', 'mingw64']) {
    for (const path of ['bin', 'lib', 'libexec/git-core', 'share', 'etc']) await visitRoot(`${architecture}/${path}`);
  }
  await visitRoot('etc');
  return files;
}

/** The only elevated filesystem operation: add links into already prepared private directories. */
export async function linkRuntimeFiles(source: string, generation: string, checkOwner = () => {}): Promise<void> {
  source = await realpath(source);
  generation = await realpath(generation);
  const files = await runtimeFiles(source);
  for (const mode of modes) for (const file of files) {
    checkOwner();
    const target = join(generation, mode, file.path);
    const parent = dirname(target);
    // No reparse-point traversal and no replacement of an existing destination.
    if ((await realpath(parent)).toLowerCase() !== resolve(parent).toLowerCase() || existsSync(target)) throw new Error(`Unsafe hardlink destination: ${target}`);
    await link(file.source, target);
    const linked = await stat(target, { bigint: true });
    if (String(linked.dev) !== file.dev || String(linked.ino) !== file.ino) throw new Error(`Hardlink identity mismatch: ${target}`);
  }
}

export function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path));
}

type Handle = bigint | null;
let pathApi: {
  attributes(path: string): number;
  createFile(path: string, access: number, sharing: number, security: null, disposition: number, flags: number, template: null): Handle;
  closeHandle(handle: Handle): number;
  getLastError(): number;
} | undefined;

/** Inspect ancestors from the volume root before following or creating any path. */
function runtimeParent(path: string): string {
  path = resolve(path);
  const ancestors = [path];
  while (dirname(ancestors[0]!) !== ancestors[0]) ancestors.unshift(dirname(ancestors[0]!));
  pathApi ??= extendWin32ProcessBindings(({ kernel32, bind }) => ({
    attributes: bind(kernel32, 'GetFileAttributesW', 'uint32', ['str16']),
    createFile: bind(kernel32, 'CreateFileW', 'void *', ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'void *']),
  })) as unknown as NonNullable<typeof pathApi>;
  for (const ancestor of ancestors) {
    const attributes = pathApi.attributes(toNamespacedPath(ancestor));
    if (attributes === 0xffffffff) {
      const code = pathApi.getLastError();
      if (code === 2 || code === 3) return resolve(realpathSync(dirname(ancestor)), relative(dirname(ancestor), path));
      throw new Error(`Cannot inspect runtime parent ${ancestor} (Windows ${code}).`);
    }
    if (attributes & 0x400) throw new Error(`Refusing a runtime parent reparse point: ${ancestor}`);
    if (!(attributes & 0x10)) throw new Error(`Runtime parent is not a directory: ${ancestor}`);
  }
  return realpathSync(path);
}

function validateRuntimeLocation(parent: string, source: string, workspace: string): void {
  source = realpathSync(source);
  workspace = realpathSync(workspace);
  // DSH propagates workspace ACL grants. Those must never reach linked Git files.
  const overlaps = (a: string, b: string) => contains(a, b) || contains(b, a);
  if (overlaps(workspace, parent) || overlaps(workspace, source)) {
    throw new Error('Git Bash runtime and Git installation must be outside the workspace; workspace ACL inheritance must not reach hardlinked program files.');
  }
  if (overlaps(source, parent)) throw new Error('The private runtime must be outside the installed Git directory and must not contain it.');
}

/** Exclusive, new, delete-on-close files: Windows also releases them on owner death. */
function holdFile(path: string): () => void {
  const handle = pathApi!.createFile(toNamespacedPath(path), 0xc0010000, 0, null, 1, 0x04000000, null);
  if (handle === null || handle === 0n || BigInt.asUintN(64, handle) === 0xffffffffffffffffn) {
    const win32Code = pathApi!.getLastError();
    throw Object.assign(new Error(`Cannot acquire private runtime lease ${path} (Windows ${win32Code}).`), { win32Code });
  }
  let closed = false;
  return () => {
    if (closed) return;
    if (!pathApi!.closeHandle(handle)) throw new Error(`Cannot close private runtime lease ${path} (Windows ${pathApi!.getLastError()}).`);
    closed = true;
  };
}

async function withRuntimeLock<T>(directory: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const started = performance.now();
  let close: (() => void) | undefined;
  while (!close) {
    signal?.throwIfAborted();
    runtimeParent(directory);
    try { close = holdFile(join(directory, '.lock')); }
    catch (error) {
      if (![5, 32, 80, 183].includes((error as { win32Code?: number }).win32Code ?? 0) || performance.now() - started >= 120_000) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { return await action(); } finally { close(); }
}

const generationName = /^[a-f0-9]{24}$/;
interface CacheRecord { version: 1; generation: string; source: string; fingerprint: string }
function currentGeneration(directory: string): CacheRecord | undefined {
  const file = join(directory, 'current.json');
  try {
    const entry = lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error('Unsafe private runtime cache metadata.');
    const record = JSON.parse(readFileSync(file, 'utf8')) as CacheRecord | null;
    if (record?.version === 1 && typeof record.generation === 'string' && generationName.test(record.generation)
      && typeof record.source === 'string' && typeof record.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(record.fingerprint)) return record;
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function publish(directory: string, record: CacheRecord): void {
  const temporary = join(directory, `current-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(record), { flag: 'wx' });
    renameSync(temporary, join(directory, 'current.json'));
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

async function collectGenerations(directory: string): Promise<void> {
  const parent = join(directory, 'generations');
  runtimeParent(parent);
  if (!existsSync(parent)) return;
  const current = currentGeneration(directory)?.generation;
  const owners = new Set(readdirSync(directory).filter(name => name.startsWith('.owner-')).map(name => name.slice(7)));
  for (const name of readdirSync(parent)) {
    if (!generationName.test(name)) throw new Error(`Unexpected private runtime generation: ${name}`);
    const generation = join(parent, name);
    runtimeParent(generation);
    const views = join(generation, 'views');
    runtimeParent(views);
    if (existsSync(views)) {
      for (const owner of readdirSync(views)) if (!owners.has(owner)) await retryCleanup(() => removePrivateTree(join(views, owner)));
      await retryCleanup(() => rmdirSync(views), ['ENOENT', 'ENOTEMPTY']);
    }
    if (current && name !== current && !readdirSync(generation).some(file => file.startsWith('.lease-'))) {
      await retryCleanup(() => removePrivateTree(generation));
    }
  }
}

/** Complete removal requires all providers to have stopped; never purges a live cache. */
export async function purgeRuntime(directory: string): Promise<void> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Git Bash compatibility requires native Windows x64.');
  directory = runtimeParent(directory);
  if (!existsSync(directory)) return;
  await withRuntimeLock(directory, async () => {
    if (readdirSync(directory).some(name => name.startsWith('.owner-'))) throw new Error('Close every DSH instance using this runtime before complete uninstallation.');
    for (const name of readdirSync(directory)) if (name !== '.lock') await retryCleanup(() => removePrivateTree(join(directory, name)));
  });
  await retryCleanup(() => { runtimeParent(directory); rmdirSync(directory); }, ['ENOENT']);
}

/** Discover an actual Git installation, never the Windows/WSL bash.exe shim. */
export function gitRoot(override?: string): string {
  const candidates = override ? [override] : [
    ...['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)'].flatMap(key => process.env[key] ? [join(process.env[key]!, 'Git/bin/bash.exe')] : []),
    ...process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Programs/Git/bin/bash.exe')] : [],
  ];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || basename(candidate).toLowerCase() !== 'bash.exe' || !existsSync(candidate)) continue;
    const executable = realpathSync(candidate);
    const parent = dirname(executable);
    const root = resolve(parent, /[\\/]usr[\\/]bin$/i.test(parent) ? '../..' : '..');
    if (existsSync(join(root, 'usr/bin/msys-2.0.dll')) && existsSync(join(root, 'cmd/git.exe'))) return root;
  }
  throw new Error('Git for Windows was not found. Set gitBashPath to its absolute bin/bash.exe or usr/bin/bash.exe path.');
}

/** Only link/unlink names. Never write, chmod, or apply an ACL to a linked file. */
export class RuntimeDirectory {
  readonly directory: string;
  private readonly owner = randomUUID();
  private readonly closeOwner: () => void;
  private readonly leases = new Set<() => void>();
  private readonly views = new Map<string, RuntimeView>();
  private readonly viewDirectories = new Set<string>();
  private disposed = false;
  private closed = false;
  private preparation: Promise<unknown> = Promise.resolve();

  constructor(parent: string, source: string, workspace: string) {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Git Bash compatibility requires native Windows x64.');
    this.directory = parent = runtimeParent(parent);
    validateRuntimeLocation(parent, source, workspace);
    mkdirSync(parent, { recursive: true });
    runtimeParent(parent);
    this.closeOwner = holdFile(join(parent, `.owner-${this.owner}`));
  }

  prepare(source: string, mode: Mode, workspace: string, elevate?: ElevateLinks, signal?: AbortSignal): Promise<RuntimeLease> {
    const operation = this.preparation.then(() => {
      if (this.disposed) throw new Error('The Git Bash runtime has been disposed.');
      signal?.throwIfAborted();
      validateRuntimeLocation(runtimeParent(this.directory), source, workspace);
      return withRuntimeLock(this.directory, () => this.prepareOne(source, mode, workspace, elevate, signal), signal);
    });
    this.preparation = operation.catch(() => {});
    return operation;
  }

  private async prepareOne(source: string, mode: Mode, workspace: string, elevate?: ElevateLinks, signal?: AbortSignal): Promise<RuntimeLease> {
    if (this.disposed) throw new Error('The Git Bash runtime has been disposed.');
    source = realpathSync(source);
    validateRuntimeLocation(runtimeParent(this.directory), source, workspace);
    await retryCleanup(() => removePrivateTree(join(this.directory, '.staging')));
    const files = await runtimeFiles(source);
    const fingerprint = createHash('sha256').update(JSON.stringify({ source, files })).digest('hex');
    const parent = join(this.directory, 'generations');
    runtimeParent(parent);
    mkdirSync(parent, { recursive: true });
    const current = currentGeneration(this.directory);
    const name = current?.fingerprint === fingerprint && current.source === source ? current.generation : fingerprint.slice(0, 24);
    let generation = join(parent, name);
    const expected = JSON.stringify(files.map(({ source: _, ...file }) => file));
    const valid = async () => {
      try {
        runtimeParent(generation);
        for (const mode of modes) {
          const root = join(generation, mode);
          signal?.throwIfAborted();
          const entries = await runtimeFiles(root);
          if (JSON.stringify(entries.map(({ source: _, ...file }) => file)) !== expected) return false;
          if (!lstatSync(join(root, 'bin')).isSymbolicLink() || realpathSync(join(root, 'bin')) !== realpathSync(join(root, 'usr/bin'))) return false;
        }
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    };
    const lease = async (): Promise<RuntimeLease> => {
      signal?.throwIfAborted();
      if (current?.generation !== basename(generation) || current.fingerprint !== fingerprint || current.source !== source) {
        publish(this.directory, { version: 1, generation: basename(generation), source, fingerprint });
      }
      await collectGenerations(this.directory);
      const close = holdFile(join(generation, `.lease-${randomUUID()}`));
      this.leases.add(close);
      const root = join(generation, mode);
      return { root, source, bash: join(root, 'usr/bin/bash.exe'), fingerprint, links: files.length, release: async () => {
        close(); this.leases.delete(close);
        if (!this.disposed) await withRuntimeLock(this.directory, () => collectGenerations(this.directory));
      } };
    };
    // Metadata loss must not force fresh links when a repaired generation is
    // still valid. Every candidate is checked against the current source.
    const candidates = new Set([name, ...readdirSync(parent).filter(entry => generationName.test(entry))]);
    for (const candidate of candidates) {
      generation = join(parent, candidate);
      if (await valid()) return lease();
    }
    signal?.throwIfAborted();
    generation = join(parent, fingerprint.slice(0, 24));
    if (existsSync(generation)) generation = join(parent, randomUUID().replaceAll('-', '').slice(0, 24));
    // Only unpublished setup uses random staging directories. The fixed helper
    // retains its existing UUID/UUID admission check and never sees the cache metadata.
    const stagingParent = join(this.directory, '.staging', this.owner);
    runtimeParent(stagingParent);
    mkdirSync(stagingParent, { recursive: true });
    const staging = join(stagingParent, randomUUID());
    let promoted = false;
    const directories = async () => {
      await mkdir(staging);
      const parents = [...new Set(files.map(file => dirname(file.path)))];
      for (const mode of modes) for (const path of parents) await mkdir(join(staging, mode, path), { recursive: true });
    };
    try {
      await directories();
      try { await linkRuntimeFiles(source, staging, () => signal?.throwIfAborted()); }
      catch (error) {
        if (!elevate || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        await retryCleanup(() => removePrivateTree(staging));
        await directories();
        await elevate(source, staging);
      }
      for (const mode of modes) {
        const root = join(staging, mode);
        for (const file of files) {
          signal?.throwIfAborted();
          const linked = await stat(join(root, file.path), { bigint: true });
          if (String(linked.dev) !== file.dev || String(linked.ino) !== file.ino || String(linked.size) !== file.size || String(linked.mtimeNs) !== file.mtime) throw new Error('Source changed during hardlink setup; retry setup.');
        }
      }
      signal?.throwIfAborted();
      renameSync(staging, generation);
      promoted = true;
      for (const mode of modes) {
        const root = join(generation, mode);
        symlinkSync(join(root, 'usr/bin'), join(root, 'bin'), 'junction');
      }
      return await lease();
    } catch (cause) {
      await retryCleanup(() => removePrivateTree(staging));
      if (promoted && currentGeneration(this.directory)?.generation !== basename(generation)) await retryCleanup(() => removePrivateTree(generation));
      throw new Error(`Cannot provision the private Git Bash runtime using same-volume NTFS hardlinks. The command did not run: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    } finally {
      await retryCleanup(() => rmdirSync(stagingParent), ['ENOENT', 'ENOTEMPTY']);
      await retryCleanup(() => rmdirSync(dirname(stagingParent)), ['ENOENT', 'ENOTEMPTY']);
    }
  }

  /** A real, private junction gives each policy scope its own MSYS installation key. */
  view(runtime: PrivateRuntime, scope?: string): RuntimeView {
    if (this.disposed) throw new Error('The Git Bash runtime has been disposed.');
    const key = scope === undefined ? undefined : JSON.stringify([runtime.root, scope]);
    const existing = key === undefined ? undefined : this.views.get(key);
    if (existing && existsSync(existing.installationRoot)) return existing;
    runtimeParent(runtime.root);
    const parent = join(dirname(runtime.root), 'views', this.owner);
    runtimeParent(parent);
    mkdirSync(parent, { recursive: true });
    this.viewDirectories.add(parent);
    const installationRoot = join(parent, randomUUID().replaceAll('-', '').slice(0, 24));
    symlinkSync(runtime.root, installationRoot, 'junction');
    const view = { installationRoot, release: () => { if (key === undefined) removePrivateTree(installationRoot); } };
    if (key !== undefined) this.views.set(key, view);
    return view;
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.disposed = true;
    await this.preparation;
    // Call only after executions are terminated and joined. Only the immutable,
    // validated current generation persists; instance leases and views do not.
    await withRuntimeLock(this.directory, async () => {
      for (const directory of this.viewDirectories) {
        runtimeParent(dirname(directory));
        await retryCleanup(() => removePrivateTree(directory));
        await retryCleanup(() => rmdirSync(dirname(directory)), ['ENOENT', 'ENOTEMPTY']);
      }
      for (const close of this.leases) { close(); this.leases.delete(close); }
      await collectGenerations(this.directory);
      this.closeOwner();
      this.views.clear(); this.viewDirectories.clear();
    });
    this.closed = true;
  }
}

export function runtimeEnvironment(runtime: PrivateRuntime, ambient: NodeJS.ProcessEnv): Record<string, string> {
  const native = ['ucrt64', 'mingw64'].find(name => existsSync(join(runtime.root, name, 'bin/git.exe')));
  if (!native) throw new Error('The private runtime has no native Git executable.');
  const existing = Object.entries(ambient).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const excluded = [join(runtime.source, 'bin'), join(runtime.source, 'usr/bin'), join(runtime.source, 'cmd'), join(runtime.source, native, 'bin')];
  const tail = existing.split(';').filter(path => path && !excluded.some(item => resolve(path).toLowerCase() === resolve(item).toLowerCase()));
  return {
    PATH: [join(runtime.root, native, 'bin'), join(runtime.root, 'usr/bin'), ...tail].join(';'),
    GIT_EXEC_PATH: join(runtime.root, native, 'libexec/git-core').replaceAll('\\', '/'),
    GIT_TEMPLATE_DIR: join(runtime.root, native, 'share/git-core/templates').replaceAll('\\', '/'),
    MSYS2_PATH_TYPE: 'inherit',
  };
}
