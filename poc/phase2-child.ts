import { loadRuntime } from './runtime.ts';
import { createNativeDiagnostics } from './windows.ts';
import { debugPrivateBash } from './debugger.ts';
import { tmpdir } from 'node:os';

const input = JSON.parse(process.argv[2] ?? '') as { manifest: string; privateRoot: string; bash: string; workspace: string; command: string; repair: boolean; repairDefaultDacl?: boolean; repairMappings?: boolean; followFamily?: boolean };
const runtime = await loadRuntime(input.manifest);
const native = await createNativeDiagnostics(runtime);
const before = native.token();
if (!before.public.restricted || before.public.integrity !== 'S-1-16-4096' || !before.public.inJob
  || before.public.userSidInRestrictingList || before.public.authenticatedUsersInRestrictingList) {
  throw new Error('Observer must already be confined by the original DSH runner.');
}
const { tempWriteSid } = await runtime.load(runtime.baseRequire, '@deepseek-ai/dsh-sandbox-windows-acl');
const privateTempSid: string = tempWriteSid(tmpdir());
if (before.capabilities.length > 0 && !before.capabilities.includes(privateTempSid)) throw new Error('The original private-temp capability is missing.');
const pipeSid = before.capabilities.length > 0 ? privateTempSid : before.logon;
const result = await debugPrivateBash(runtime, { privateRoot: input.privateRoot, bash: input.bash, cwd: input.workspace,
  command: input.command, pipeSid, repairPipe: input.repair,
  repairDefaultDacl: input.repairDefaultDacl, repairMappings: input.repairMappings, followFamily: input.followFamily });
const after = native.token();
const namespacesAfterExit = result.privateNamespaces.map(path => native.namespaceStatus(path));
console.log('@@DSH_POC_DEBUG@@' + JSON.stringify({ ...result, sourceToken: before.public,
  ipcSidScope: before.capabilities.length > 0 ? 'original-private-temp-capability' : 'existing-logon-sid',
  observerTokenUnchanged: after.public.fingerprint === before.public.fingerprint,
  observerDefaultDaclUnchanged: after.public.defaultDaclHash === before.public.defaultDaclHash,
  namespacesAfterExit,
}));
