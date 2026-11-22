import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readFile, unlink, copyFile, writeFile, mkdtemp, rm, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import koffi from 'koffi';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import { readPe } from '../src/runtime/pe.ts';
import { compilerFlags, linkerFlags, nativeToolchain } from '../scripts/build-compat-dll.ts';
import { nativeOnly, compatFixture, runFixtureCommand, success, msysHolderCommand,
  observeMsysImages, expectedMsysKey, type probeTokenLogonSid } from './fixtures.ts';

// Compile the actual static functions, with test-only syscall fault injection.
// The shipped source has no test exports, telemetry or fault switches.
const harnessSource = String.raw`
#include <windows.h>
#include <winternl.h>
#include <sddl.h>
NTSYSAPI NTSTATUS NTAPI NtProtectVirtualMemory(HANDLE, PVOID*, PSIZE_T, ULONG, PULONG);
NTSYSAPI NTSTATUS NTAPI NtQueryInformationToken(HANDLE, TOKEN_INFORMATION_CLASS, PVOID, ULONG, PULONG);
static DWORD WINAPI fakeLongPath(LPCWSTR, LPWSTR, DWORD);
NTSTATUS NTAPI fakeProtect(HANDLE, PVOID*, PSIZE_T, ULONG, PULONG);
NTSTATUS NTAPI fakeQuery(HANDLE, TOKEN_INFORMATION_CLASS, PVOID, ULONG, PULONG);
#undef NTSYSAPI
#define NTSYSAPI
#define GetLongPathNameW fakeLongPath
#define NtProtectVirtualMemory fakeProtect
#define NtQueryInformationToken fakeQuery
#define DllMain productionDllMain
#include "dsh-msys-compat.c"
#undef DllMain
#undef GetLongPathNameW
#undef NtProtectVirtualMemory
#undef NtQueryInformationToken
#define CHECK(x) do { if (!(x)) return __LINE__; } while (0)
static DWORD longResult;
static int protectCalls, protectFault;
static int tokenFault;
NTSTATUS NTAPI fakeQuery(HANDLE token, TOKEN_INFORMATION_CLASS kind, PVOID data, ULONG capacity, PULONG length) {
    NTSTATUS status = NtQueryInformationToken(token, kind, data, capacity, length);
    if (!NT_SUCCESS(status) || !tokenFault) return status;
    TOKEN_GROUPS *g = (TOKEN_GROUPS *)data;
    if (kind == TokenLogonSid) {
        if (tokenFault == 2) g->GroupCount = 0;
        if (tokenFault == 3) g->GroupCount = 2;
        if (tokenFault == 4) *length = 43;
        if (tokenFault == 5) g->Groups[0].Sid = (BYTE *)data + capacity;
        if (tokenFault == 6) g->Groups[0].Attributes = 7;
    }
    if (kind == TokenRestrictedSids && tokenFault == 1) {
        static BYTE sids[8][SECURITY_MAX_SID_SIZE]; static DWORD attrs[8];
        DWORD count = g->GroupCount;
        if (count >= 8) return (NTSTATUS)0xc000000d;
        for (DWORD i = 0; i < count; i++) { RtlCopySid(sizeof(sids[i]), sids[i], g->Groups[i].Sid); attrs[i] = g->Groups[i].Attributes; }
        size_t at = FIELD_OFFSET(TOKEN_GROUPS, Groups) + (count + 1) * sizeof(SID_AND_ATTRIBUTES);
        if (at + (count + 1) * SECURITY_MAX_SID_SIZE > capacity) return (NTSTATUS)0xc0000023;
        for (DWORD i = 0; i < count; i++) {
            ULONG size = RtlLengthSid(sids[i]); memcpy((BYTE *)data + at, sids[i], size);
            g->Groups[i].Sid = (BYTE *)data + at; g->Groups[i].Attributes = attrs[i]; at += size;
        }
        DSH_SID4 extra; build_temp_sid(&extra, 123, 456);
        memcpy((BYTE *)data + at, &extra, 20); g->Groups[count].Sid = (BYTE *)data + at;
        g->Groups[count].Attributes = 7; g->GroupCount = count + 1; *length = (ULONG)at + 20;
    }
    return status;
}
static DWORD WINAPI fakeLongPath(LPCWSTR a, LPWSTR b, DWORD c) {
    if (longResult) {
        if (longResult < c) {
            if (longResult == 14) memcpy(b, L"C:\\s\\usr\\bin\\a", 15 * sizeof(WCHAR));
            else { for (DWORD i = 0; i < longResult; i++) b[i] = L'x'; b[longResult] = 0; }
        }
        return longResult;
    }
    return GetLongPathNameW(a, b, c);
}
NTSTATUS NTAPI fakeProtect(HANDLE p, PVOID *base, PSIZE_T size, ULONG protection, PULONG old) {
    if (!protectFault) return NtProtectVirtualMemory(p, base, size, protection, old);
    *old = PAGE_READONLY;
    return ++protectCalls == 2 ? (NTSTATUS)0xc0000022 : 0;
}
BOOL WINAPI testDllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) { return TRUE; }

__declspec(dllexport) int token_checks(void) {
    DSH_SID4 temp; BOOL present;
    CHECK(compute_temp_sid_from_env(&temp, &present) && present);
    CHECK(verify_token_and_policy(MODE_WORKSPACE_WRITE, FALSE, 0, 0));
    for (tokenFault = 2; tokenFault <= 6; tokenFault++) CHECK(!verify_token_and_policy(MODE_WORKSPACE_WRITE, FALSE, 0, 0));
    tokenFault = 0;
    CHECK(SetEnvironmentVariableW(L"TEMP", NULL) && SetEnvironmentVariableW(L"TMP", NULL));
    CHECK(verify_token_and_policy(MODE_WORKSPACE_WRITE, FALSE, 0, 0));
    tokenFault = 1;
    CHECK(!verify_token_and_policy(MODE_WORKSPACE_WRITE, FALSE, 0, 0));
    CHECK(verify_token_and_policy(MODE_WORKSPACE_WRITE, TRUE, temp.SubAuthority[0], temp.SubAuthority[1]));
    tokenFault = 0;
    return 0;
}

__declspec(dllexport) int native_checks(void) {
    BOOL bound; DWORD a, b;
    CHECK(parse_view_policy(L"fa-0123456789abcdef", 19, &bound, &a, &b) == MODE_FULL_ACCESS);
    CHECK(parse_view_policy(L"ww-u-0123456789abcdef", 21, &bound, &a, &b) == MODE_WORKSPACE_WRITE && !bound);
    CHECK(parse_view_policy(L"ww-1-2-0123456789abcdef", 23, &bound, &a, &b) == MODE_WORKSPACE_WRITE && bound && a == 1 && b == 2);
    CHECK(parse_view_policy(L"ww-x-0123456789abcdef", 21, &bound, &a, &b) == MODE_UNKNOWN);
    CHECK(parse_view_policy(L"ww-1-x-0123456789abcdef", 23, &bound, &a, &b) == MODE_UNKNOWN);
    CHECK(parse_view_policy(L"ww-1073741824-2-0123456789abcdef", 32, &bound, &a, &b) == MODE_UNKNOWN);
    CHECK(parse_view_policy(L"fa-0123456789abcdeg", 19, &bound, &a, &b) == MODE_UNKNOWN);
    static WCHAR path[MAX_PATH_CHARS + 1], output[MAX_PATH_CHARS];
    UNICODE_STRING name = { 24, 26, L"MSYS-2.0.DLL" };
    CHECK(is_msys_basename(&name));
    name.Buffer = NULL; CHECK(!is_msys_basename(&name)); CHECK(!copy_loader_path(&name, output));
    name.Buffer = path; name.Length = 1; CHECK(!copy_loader_path(&name, output));
    name.Length = sizeof(path) - 2; name.MaximumLength = sizeof(path); CHECK(!copy_loader_path(&name, output));
    name.Length = 4; name.MaximumLength = 2; CHECK(!copy_loader_path(&name, output));

    __declspec(align(8)) static BYTE token[96];
    TOKEN_GROUPS *groups = (TOKEN_GROUPS *)token;
    groups->GroupCount = 1; groups->Groups[0].Sid = token + 24; groups->Groups[0].Attributes = SE_GROUP_LOGON_ID;
    DSH_SID4 sid; build_temp_sid(&sid, 1, 0x3fffffff);
    CHECK(sid_is_temp_capability((const SID *)&sid));
    for (unsigned int i = 0; i < 2; i++) {
        DWORD saved = sid.SubAuthority[i];
        sid.SubAuthority[i] = 0; CHECK(!sid_is_temp_capability((const SID *)&sid));
        sid.SubAuthority[i] = 0x40000000; CHECK(!sid_is_temp_capability((const SID *)&sid));
        sid.SubAuthority[i] = saved;
    }
    build_temp_sid(&sid, 1, 2); memcpy(token + 24, &sid, 20);
    CHECK(checked_logon_sid(token, sizeof(token), 44));
    groups->Groups[0].Attributes |= 2; CHECK(checked_logon_sid(token, sizeof(token), 44));
    groups->Groups[0].Attributes = 7; CHECK(!checked_logon_sid(token, sizeof(token), 44));
    groups->Groups[0].Attributes = SE_GROUP_LOGON_ID;
    groups->GroupCount = 0; CHECK(!checked_logon_sid(token, sizeof(token), 44));
    groups->GroupCount = 2; CHECK(!checked_logon_sid(token, sizeof(token), 44));
    groups->GroupCount = 1; CHECK(!checked_logon_sid(token, sizeof(token), 23));
    CHECK(!checked_logon_sid(token, sizeof(token), 43)); CHECK(!checked_logon_sid(token, sizeof(token), 97));
    groups->Groups[0].Sid = token + 90; CHECK(!checked_logon_sid(token, sizeof(token), 96));
    groups->Groups[0].Sid = token; CHECK(!checked_logon_sid(token, sizeof(token), 44));

    format_hex64_lower(1, g_expectedKeyHexA, g_expectedKeyHexW);
    const WCHAR *namespaces[] = {
        L"\\BaseNamedObjects\\msys-2.0S5-0000000000000001",
        L"\\BaseNamedObjects\\msys-2.0S-0000000000000001",
        L"\\BaseNamedObjects\\msys-2.0S5\\other-0000000000000001",
        L"\\BaseNamedObjects\\msys-2.0S5-0000000000000002"
    };
    for (size_t i = 0; i < ARRAYSIZE(namespaces); i++) CHECK(is_msys_namespace(namespaces[i], wlen(namespaces[i])) == (i == 0));

    const WCHAR *sddls[] = {
      L"D:(A;;GA;;;S-1-4-1-2-1)", L"D:(A;;GA;;;S-1-4-1-2-1-1)",
      L"O:S-1-4-1-2-1D:(A;;GA;;;SY)", L"D:(D;;GA;;;S-1-4-1-2-1)", L"D:(A;;GR;;;S-1-4-1-2-1)",
      L"O:SYG:BAD:PAI(A;;GA;;;SY)S:PAI(AU;SA;GA;;;WD)"
    };
    g_grantSidLen = 20; memcpy(g_grantSid, &sid, 20);
    PSECURITY_DESCRIPTOR fileAccess;
    CHECK(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:(A;;FA;;;S-1-4-1-2-1)", 1, &fileAccess, NULL));
    BOOLEAN filePresent, fileDefaulted; PACL fileDacl;
    CHECK(NT_SUCCESS(RtlGetDaclSecurityDescriptor(fileAccess, &filePresent, &fileDacl, &fileDefaulted)) && filePresent);
    CHECK(dacl_has_exact_allow_ace(fileDacl, &sid, TRUE));
    PACCESS_ALLOWED_ACE fileAce;
    CHECK(NT_SUCCESS(RtlGetAce(fileDacl, 0, (PVOID *)&fileAce)));
    fileAce->Mask |= ACCESS_SYSTEM_SECURITY;
    CHECK(!dacl_has_exact_allow_ace(fileDacl, &sid, TRUE));
    CHECK(LocalFree(fileAccess) == NULL);
    for (int i = 0; i < 6; i++) {
        PSECURITY_DESCRIPTOR original;
        CHECK(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddls[i], 1, &original, NULL));
        SECURITY_DESCRIPTOR changed; static BYTE acl[2048]; BOOL already;
        CHECK(build_extended_sd(original, &changed, acl, sizeof(acl), &already));
        CHECK(already == (i == 0));
        if (!already) {
            BOOLEAN present, defaulted; PACL dacl;
            CHECK(NT_SUCCESS(RtlGetDaclSecurityDescriptor(&changed, &present, &dacl, &defaulted)) && present);
            CHECK(dacl_has_exact_allow_ace(dacl, &sid, FALSE));
            PSID oldSid = NULL, newSid = NULL; BOOLEAN oldDefault = FALSE, newDefault = FALSE;
            CHECK(NT_SUCCESS(RtlGetOwnerSecurityDescriptor(original, &oldSid, &oldDefault)));
            CHECK(NT_SUCCESS(RtlGetOwnerSecurityDescriptor(&changed, &newSid, &newDefault)));
            CHECK(oldSid == newSid && oldDefault == newDefault);
            CHECK(NT_SUCCESS(RtlGetGroupSecurityDescriptor(original, &oldSid, &oldDefault)));
            CHECK(NT_SUCCESS(RtlGetGroupSecurityDescriptor(&changed, &newSid, &newDefault)));
            CHECK(oldSid == newSid && oldDefault == newDefault);
            PACL oldSacl = NULL, newSacl = NULL; BOOLEAN oldPresent = FALSE, newPresent = FALSE;
            CHECK(NT_SUCCESS(RtlGetSaclSecurityDescriptor(original, &oldPresent, &oldSacl, &oldDefault)));
            CHECK(NT_SUCCESS(RtlGetSaclSecurityDescriptor(&changed, &newPresent, &newSacl, &newDefault)));
            CHECK(oldPresent == newPresent && (!oldPresent || (oldSacl == newSacl && oldDefault == newDefault)));
            SECURITY_DESCRIPTOR_CONTROL oldControl, newControl; ULONG revision;
            CHECK(NT_SUCCESS(RtlGetControlSecurityDescriptor(original, &oldControl, &revision)));
            CHECK(NT_SUCCESS(RtlGetControlSecurityDescriptor(&changed, &newControl, &revision)));
            CHECK((oldControl & ~SE_SELF_RELATIVE) == newControl);
            ((SECURITY_DESCRIPTOR_RELATIVE *)original)->Control |= SE_RM_CONTROL_VALID;
            CHECK(!build_extended_sd(original, &changed, acl, sizeof(acl), &already));
        }
        CHECK(LocalFree(original) == NULL);
    }
    memcpy(g_sourceRoot, L"C:\\s", 5 * sizeof(WCHAR)); g_sourceRootLen = 4;
    memcpy(g_runtimeRoot, L"C:\\r", 5 * sizeof(WCHAR)); g_runtimeRootLen = 4;
    memcpy(g_viewRoot, L"C:\\v", 5 * sizeof(WCHAR)); g_viewRootLen = 4;
    CHECK(try_rewrite_application_path(L"C:\\s\\usr\\bin\\missing.exe", output) == PATH_REWRITE);
    CHECK(wide_eq_ci(output, L"C:\\v\\usr\\bin\\missing.exe"));
    CHECK(try_rewrite_application_path(L"C:\\s\\bin\\bash.exe", output) == PATH_NO_MATCH);
    CHECK(try_rewrite_application_path(L"C:\\elsewhere\\x.exe", output) == PATH_NO_MATCH);
    CHECK(try_rewrite_application_path(L"C:\\s\\usr\\bin\\sub\\x.exe", output) == PATH_NO_MATCH);
    CHECK(try_rewrite_application_path(L"\\\\?\\C:\\s\\usr\\bin\\a", output) == PATH_REWRITE);
    CHECK(wide_eq_ci(output, L"\\\\?\\C:\\v\\usr\\bin\\a"));
    for (int i = 0; i < MAX_PATH_CHARS; i++) path[i] = L'x'; path[MAX_PATH_CHARS] = 0;
    CHECK(try_rewrite_application_path(path, output) == PATH_ERROR && GetLastError() == ERROR_FILENAME_EXCED_RANGE);
    path[MAX_PATH_CHARS - 1] = 0; CHECK(try_rewrite_application_path(path, output) == PATH_NO_MATCH);
    longResult = 14;
    CHECK(try_rewrite_application_path(L"C:\\short~1\\a", output) == PATH_REWRITE);
    CHECK(wide_eq_ci(output, L"C:\\v\\usr\\bin\\a"));
    longResult = MAX_PATH_CHARS - 1;
    CHECK(try_rewrite_application_path(L"C:\\short~1\\a", output) == PATH_NO_MATCH);
    longResult = MAX_PATH_CHARS;
    CHECK(try_rewrite_application_path(L"C:\\short~1\\a", output) == PATH_ERROR && GetLastError() == ERROR_FILENAME_EXCED_RANGE);
    longResult = MAX_PATH_CHARS + 1;
    CHECK(try_rewrite_application_path(L"C:\\short~1\\a", output) == PATH_ERROR && GetLastError() == ERROR_FILENAME_EXCED_RANGE);
    longResult = 0; g_viewRootLen = MAX_PATH_CHARS - 11;
    for (size_t i = 4; i < g_viewRootLen; i++) g_viewRoot[i] = L'v'; g_viewRoot[g_viewRootLen] = 0;
    CHECK(try_rewrite_application_path(L"C:\\s\\usr\\bin\\a", output) == PATH_REWRITE && wlen(output) == MAX_PATH_CHARS - 1);
    g_viewRootLen++;
    CHECK(try_rewrite_application_path(L"C:\\s\\usr\\bin\\a", output) == PATH_ERROR && GetLastError() == ERROR_FILENAME_EXCED_RANGE);
    protectFault = 1; protectCalls = 0; void *slot = (void *)1, *original;
    CHECK(!patch_iat_slot(&slot, (void *)2, &original) && protectCalls == 2);
    protectFault = 0;
    return 0;
}

static volatile LONG rootCalls, originalCalls;
static BOOL rootFailure;
static DWORD WINAPI rootQuery(HANDLE h, LPWSTR path, DWORD size, DWORD flags) {
    InterlockedIncrement(&rootCalls);
    if (rootFailure) { SetLastError(ERROR_ACCESS_DENIED); return 0; }
    return GetFinalPathNameByHandleW(h, path, size, flags);
}
static BOOL WINAPI originalProcess(LPCWSTR app, LPWSTR command, LPSECURITY_ATTRIBUTES pa, LPSECURITY_ATTRIBUTES ta,
    BOOL inherit, DWORD flags, LPVOID env, LPCWSTR cwd, LPSTARTUPINFOW startup, LPPROCESS_INFORMATION info) {
    InterlockedIncrement(&originalCalls); return TRUE;
}
static DWORD WINAPI rootThread(LPVOID argument) {
    BOOL result = Hook_CreateProcessW(L"C:\\unrelated.exe", NULL, NULL, NULL, FALSE, 0, NULL, NULL, NULL, NULL);
    return rootFailure ? (!result && GetLastError() == ERROR_ACCESS_DENIED ? 0 : 1) : result ? 0 : 1;
}
__declspec(dllexport) int roots_check(LPCWSTR view, BOOL failure) {
    InitOnceInitialize(&g_rootsOnce); g_rootsError = 0; rootCalls = 0; originalCalls = 0; rootFailure = failure;
    g_viewRootLen = wlen(view); CHECK(g_viewRootLen < MAX_PATH_CHARS); memcpy(g_viewRoot, view, (g_viewRootLen + 1) * sizeof(WCHAR));
    g_origGetFinalPathNameByHandleW = rootQuery; g_origCreateProcessW = originalProcess;
    CHECK(Hook_CreateProcessW(NULL, NULL, NULL, NULL, FALSE, 0, NULL, NULL, NULL, NULL) && rootCalls == 0);
    HANDLE threads[8];
    for (int i = 0; i < 8; i++) { threads[i] = CreateThread(NULL, 0, rootThread, NULL, 0, NULL); CHECK(threads[i]); }
    for (int i = 0; i < 8; i++) { CHECK(WaitForSingleObject(threads[i], 10000) == WAIT_OBJECT_0); DWORD code;
        CHECK(GetExitCodeThread(threads[i], &code) && code == 0); CHECK(CloseHandle(threads[i])); }
    CHECK(rootCalls == (failure ? 1 : 2));
    rootFailure = FALSE;
    BOOL result = Hook_CreateProcessW(L"C:\\unrelated.exe", NULL, NULL, NULL, FALSE, 0, NULL, NULL, NULL, NULL);
    CHECK(failure ? !result && GetLastError() == ERROR_ACCESS_DENIED : result);
    CHECK(rootCalls == (failure ? 1 : 2)); CHECK(originalCalls == (failure ? 1 : 10));
    if (!failure) {
        static WCHAR oversized[MAX_PATH_CHARS + 1], matched[MAX_PATH_CHARS];
        for (int i = 0; i < MAX_PATH_CHARS; i++) oversized[i] = L'x'; oversized[MAX_PATH_CHARS] = 0;
        CHECK(!Hook_CreateProcessW(oversized, NULL, NULL, NULL, FALSE, 0, NULL, NULL, NULL, NULL));
        CHECK(GetLastError() == ERROR_FILENAME_EXCED_RANGE && originalCalls == 10);
        longResult = MAX_PATH_CHARS;
        CHECK(!Hook_CreateProcessW(L"C:\\short~1\\a", NULL, NULL, NULL, FALSE, 0, NULL, NULL, NULL, NULL));
        CHECK(GetLastError() == ERROR_FILENAME_EXCED_RANGE && originalCalls == 10); longResult = 0;
        CHECK(g_sourceRootLen + 12 < MAX_PATH_CHARS);
        memcpy(matched, g_sourceRoot, g_sourceRootLen * sizeof(WCHAR));
        memcpy(matched + g_sourceRootLen, L"\\usr\\bin\\a", 11 * sizeof(WCHAR));
        g_viewRootLen = MAX_PATH_CHARS - 1;
        CHECK(!Hook_CreateProcessW(matched, NULL, NULL, NULL, FALSE, 0, NULL, NULL, NULL, NULL));
        CHECK(GetLastError() == ERROR_FILENAME_EXCED_RANGE && originalCalls == 10);
    }
    return 0;
}

__declspec(dllexport) DWORD spawn_native(LPCWSTR bash, LPWSTR command) {
    STARTUPINFOW si = { sizeof(si) }; PROCESS_INFORMATION pi;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE); si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE); si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    if (!CreateProcessW(bash, command, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) return 0xe0000000u | GetLastError();
    DWORD code = 0xffffffff;
    if (WaitForSingleObject(pi.hProcess, 15000) == WAIT_OBJECT_0) GetExitCodeProcess(pi.hProcess, &code);
    else { TerminateProcess(pi.hProcess, 99); WaitForSingleObject(pi.hProcess, 5000); }
    if (!CloseHandle(pi.hThread) || !CloseHandle(pi.hProcess)) return 98;
    return code;
}

static DSH_LDR_ENTRY *entry_for(HMODULE module) {
    PEB *peb = (PEB *)__readgsqword(0x60); LIST_ENTRY *head = &peb->Ldr->InMemoryOrderModuleList;
    for (LIST_ENTRY *p = head->Flink; p != head; p = p->Flink) {
        DSH_LDR_ENTRY *e = CONTAINING_RECORD(p, DSH_LDR_ENTRY, InMemoryOrderLinks);
        if (e->DllBase == module) return e;
    }
    return NULL;
}
__declspec(dllexport) int loader_check(LPCWSTR runtime, LPCWSTR source, LPCWSTR shim, int scenario) {
    HMODULE good = LoadLibraryExW(runtime, NULL, DONT_RESOLVE_DLL_REFERENCES); CHECK(good);
    HMODULE foreign = scenario >= 2 ? LoadLibraryExW(source, NULL, DONT_RESOLVE_DLL_REFERENCES) : NULL;
    CHECK(scenario < 2 || foreign);
    DSH_LDR_ENTRY *entry = entry_for(foreign ? foreign : good); CHECK(entry);
    UNICODE_STRING saved = entry->FullDllName;
    static WCHAR oversized[1100];
    if (scenario == 1) { entry->FullDllName.Buffer = (PWSTR)source; entry->FullDllName.Length = (USHORT)(wlen(source) * 2); entry->FullDllName.MaximumLength = entry->FullDllName.Length + 2; }
    if (scenario == 3) { entry->FullDllName.Buffer = (PWSTR)runtime; entry->FullDllName.Length = (USHORT)(wlen(runtime) * 2); entry->FullDllName.MaximumLength = entry->FullDllName.Length + 2; }
    if (scenario == 4) entry->FullDllName.Buffer = NULL;
    if (scenario == 5) entry->FullDllName.Length |= 1;
    if (scenario == 6) { entry->FullDllName.Buffer = oversized; entry->FullDllName.Length = sizeof(oversized); entry->FullDllName.MaximumLength = sizeof(oversized); }
    // Identity-only case: keep the foreign file mapped, remove the genuine entry from candidate classification.
    DSH_LDR_ENTRY *goodEntry = entry_for(good); UNICODE_STRING goodBase = goodEntry->BaseDllName;
    if (scenario == 7) {
        goodEntry->BaseDllName.Length = 0;
        entry->FullDllName.Buffer = (PWSTR)runtime; entry->FullDllName.Length = (USHORT)(wlen(runtime) * 2); entry->FullDllName.MaximumLength = entry->FullDllName.Length + 2;
    }
    HMODULE self = LoadLibraryExW(shim, NULL, DONT_RESOLVE_DLL_REFERENCES); CHECK(self);
    BOOL admitted = resolve_and_verify_sibling_msys(self);
    entry->FullDllName = saved; goodEntry->BaseDllName = goodBase;
    CHECK(FreeLibrary(self));
    CHECK(admitted == (scenario == 0));
    if (scenario == 0) CHECK(LoadLibraryW(shim) == NULL);
    if (foreign) CHECK(FreeLibrary(foreign)); CHECK(FreeLibrary(good));
    return 0;
}
`;

async function nativeHarness(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tools = nativeToolchain(directory);
  await copyFile(new URL('../native/dsh-msys-compat.c', import.meta.url), join(directory, 'dsh-msys-compat.c'));
  await writeFile(join(directory, 'checks.c'), harnessSource);
  const options = { cwd: directory, env: tools.env, encoding: 'utf8' as const, windowsHide: true };
  execFileSync(tools.cl, [...compilerFlags, '/Fochecks.obj', 'checks.c'], options);
  execFileSync(tools.link, [...linkerFlags.filter(x => x !== '/ENTRY:DllMain'), '/ENTRY:testDllMain',
    '/OUT:checks.dll', 'checks.obj', 'kernel32.lib', 'ntdll.lib', 'advapi32.lib'], options);
  return join(directory, 'checks.dll');
}

await test('isolated native builds reproduce bytes and enforce release tools/hash with checked cleanup', nativeOnly, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-build-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const roots = [join(directory, 'a'), join(directory, 'longer-input-tree-b')];
  const inputs = ['scripts/build-compat-dll.ts', 'src/runtime/pe.ts', 'native/build.json', 'native/dsh-msys-compat.c'];
  for (const root of roots) {
    for (const path of ['scripts', 'src/runtime', 'native']) await mkdir(join(root, path), { recursive: true });
    for (const path of inputs) await copyFile(new URL('../' + path, import.meta.url), join(root, path));
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
  }
  const scratch = join(directory, 'scratch');
  await mkdir(scratch);
  const env = { ...process.env, TMP: scratch, TEMP: scratch };
  const build = (root: string, release = false) => execFileSync(process.execPath,
    [join(root, 'scripts/build-compat-dll.ts'), ...(release ? ['--release'] : [])], { env, encoding: 'utf8', stdio: 'pipe', windowsHide: true });
  const tools = nativeToolchain(scratch);
  for (const root of roots) build(root);
  const a = roots[0]!, b = roots[1]!, output = join(a, 'lib/dsh-msys-compat.dll');
  const bytes = await readFile(output), hash = createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(await readFile(join(b, 'lib/dsh-msys-compat.dll')), bytes);
  assert.deepEqual(await readFile(new URL('../lib/dsh-msys-compat.dll', import.meta.url)), bytes);
  const manifestPath = join(a, 'native/build.json');
  const manifest = { ...JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>, ...tools.versions };
  await writeFile(manifestPath, JSON.stringify({ ...manifest, sha256: '0'.repeat(64) }));
  assert.throws(() => build(a, true), /Unapproved release DLL hash/);
  assert.equal(existsSync(output), false);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, sha256: hash, compiler: '0.0.0' }));
  assert.throws(() => build(a, true), /Release compiler mismatch/);
  assert.equal(existsSync(output), false);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, sha256: hash }));
  build(a, true); assert.deepEqual(await readFile(output), bytes);

  // A valid source edit remains buildable/testable before its new hash is approved.
  const source = await readFile(join(a, 'native/dsh-msys-compat.c'), 'utf8');
  await writeFile(join(a, 'native/dsh-msys-compat.c'), source.replace('void dsh_msys_compat_anchor(void) {}', 'void dsh_msys_compat_anchor(void) { __nop(); }'));
  build(a);
  const candidate = await readFile(output);
  assert.notDeepEqual(candidate, bytes);
  assert.throws(() => build(a, true), /Unapproved release DLL hash/);
  assert.equal(existsSync(output), false);
  await writeFile(join(a, 'native/dsh-msys-compat.c'), source + '\n#error intentional compile failure\n');
  assert.throws(() => build(a)); assert.equal(existsSync(output), false);
  assert.deepEqual(await readdir(scratch), []);
  await writeFile(join(a, 'native/dsh-msys-compat.c'), source);
  const blockedScratch = join(directory, 'blocked-cleanup');
  const injection = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const remove=fs.rmSync;
    fs.mkdtempSync=()=>{fs.mkdirSync(${JSON.stringify(blockedScratch)});return ${JSON.stringify(blockedScratch)}};
    fs.rmSync=(path,...args)=>{if(path===${JSON.stringify(blockedScratch)})throw Error('fixture cleanup refusal'); return remove(path,...args)};
    syncBuiltinESMExports();
    const {buildCompatDll}=await import(${JSON.stringify(pathToFileURL(join(a, 'scripts/build-compat-dll.ts')).href)});
    buildCompatDll();`;
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', injection],
    { encoding: 'utf8', stdio: 'pipe', windowsHide: true }), /fixture cleanup refusal/);
  assert.equal(existsSync(output), false);
  await rm(blockedScratch, { recursive: true, force: true });

  const dll = join(b, 'lib/dsh-msys-compat.dll');
  const dump = (flag: string) => execFileSync(join(tools.bin, 'dumpbin.exe'), ['/nologo', flag, dll],
    { env: tools.env, encoding: 'utf8', windowsHide: true });
  const imported = [...dump('/imports').matchAll(/^\s+[0-9A-F]+\s+([A-Za-z_]\w*)\s*$/gm)].map(x => x[1]!).sort();
  assert.deepEqual(imported, readPe(bytes).imports.flatMap(x => x.symbols).sort());
  assert.match(dump('/exports'), /dsh_msys_compat_anchor/);
  const headers = dump('/headers');
  for (const text of ['High Entropy Virtual Addresses', 'Dynamic base', 'NX compatible']) assert.ok(headers.includes(text), text);
  t.diagnostic(JSON.stringify({ isolatedBuildSha256: hash, tools: tools.versions }));

  const f = await compatFixture(t), spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess);
  await writeFile(join(f.runtime, 'usr/bin/dsh-msys-compat.dll'), candidate);
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
    const spec = await f.command(mode, 'echo candidate; env -i PATH=/usr/bin bash -c "echo child"', 'candidate');
    const r = await runFixtureCommand(spawn, spec.argv, f.workspace, spec.env, t.signal);
    success(r); assert.match(r.stdout, /candidate/); assert.match(r.stdout, /child/);
  }
});

await test('optimized shim admission, forks, images and IPC under real DSH policies', nativeOnly, async t => {
  const helper = await nativeHarness(t);
  await t.test('bounded native predicates and ACL/control preservation', () => {
    const library = koffi.load(helper);
    try { assert.equal(library.func('int native_checks()')(), 0, 'native failure reports its C source line'); }
    finally { library.unload(); }
  });
  const f = await compatFixture(t), spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess);
  await t.test('TokenLogonSid agrees with TokenGroups on actual DSH tokens', async t => {
    for (const mode of ['danger-full-access', 'read-only', 'workspace-write'] as const) {
      const command = [process.execPath, '--input-type=module', '-e',
        `import { probeTokenLogonSid } from ${JSON.stringify(new URL('./fixtures.ts', import.meta.url).href)}; console.log(JSON.stringify(probeTokenLogonSid()));`];
      const argv = mode === 'danger-full-access' ? command : [...(await f.ctx.sandbox.confine(command,
        { mode, workspaceRoot: f.workspace, sessionId: 'token-probe' as SandboxExecutionPolicy['sessionId'] }, t.signal)).argv];
      const result = await runFixtureCommand(spawn, argv, f.workspace, {}, t.signal);
      success(result);
      const observation = JSON.parse(result.stdout) as ReturnType<typeof probeTokenLogonSid>;
      if (mode !== 'danger-full-access') {
        assert.equal(observation.integrityRid, 4096);
        assert.equal(observation.logonRestricted, true);
      } else assert.equal(observation.restrictedCount, 0);
      t.diagnostic(JSON.stringify({ mode, ...observation }));
    }
  });
  const runNative = async (spec: Awaited<ReturnType<typeof f.command>>, code: string) => {
    const script = `import {createRequire} from 'node:module'; const k=createRequire(${JSON.stringify(new URL('./fixtures.ts', import.meta.url).href)})('koffi'); const library=k.load(${JSON.stringify(helper)}); ${code}`;
    const result = await runFixtureCommand(spawn, [...spec.prefix, process.execPath, '--input-type=module', '-e', script],
      f.workspace, spec.env, t.signal);
    success(result);
    return result;
  };
  for (const mode of ['danger-full-access', 'read-only', 'workspace-write'] as const) {
    const command = [
      'set -eo pipefail',
      'printf "alpha\\nbeta\\n" | grep -Fx alpha',
      '[[ $(printf hi) == hi ]]',
      'env -i PATH=/usr/bin bash --noprofile --norc -c \'printf "child\\n" | grep -Fx child\'',
      'gawk -l ordchr \'BEGIN { print ord("A") }\'',
      'perl -MDigest::SHA -e \'print Digest::SHA::sha256_hex("native"), "\\n"\'',
      'base() { local span rest; found=; while read -r span rest; do case "$rest" in *"$1"*) found=${span%%-*}; return 0;; esac; done < "/proc/$BASHPID/maps"; return 1; }',
      'base msys-2.0.dll; msys=$found; base dsh-msys-compat.dll; shim=$found; parent=$BASHPID',
      'for ((i=0;i<100;i++)); do ( [[ $BASHPID != "$parent" ]] && base msys-2.0.dll && [[ $found == "$msys" ]] && base dsh-msys-compat.dll && [[ $found == "$shim" ]] ) || exit 91; done',
      'printf "READY\\n"',
    ].join('\n');
    for (const session of ['native-' + mode, undefined]) {
      const spec = await f.command(mode, command, session);
      const r = await runFixtureCommand(spawn, spec.argv, f.workspace, spec.env, t.signal);
      success(r); assert.match(r.stdout, /READY/);
    }
  }

  await t.test('native-parent TEMP precedence, TMP fallback and missing environment', async () => {
    for (const bound of [true, false]) for (const [change, allowed] of [
      ['', true], ["process.env.TMP='invalid';", true],
      ['process.env.TMP=process.env.TEMP; delete process.env.TEMP;', true],
      ['process.env.TMP=process.env.TEMP; process.env.TEMP="";', true],
      ['delete process.env.TEMP; delete process.env.TMP;', true],
      ["process.env.TMP=process.env.TEMP; process.env.TEMP='invalid';", false],
      ["process.env.TMP=process.env.TEMP; process.env.TEMP='x'.repeat(1024);", false],
      ["process.env.TEMP=String.fromCharCode(0xd800);", false],
    ] as const) {
      const spec = await f.command('workspace-write', '', bound ? 'native-parent' : undefined);
      const bash = join(spec.view, 'usr/bin/bash.exe');
      const command = `"${bash}" --noprofile --norc -c "exit 42"`;
      const r = await runNative(spec, `${change} console.log('RESULT:'+library.func('uint32 spawn_native(str16,str16)')(${JSON.stringify(bash)},${JSON.stringify(command)}));`);
      assert.match(r.stdout, new RegExp(`RESULT:${allowed ? 42 : 0xc0000142}`), `${bound}/${change}: ${r.stdout} ${r.stderr}`);
    }
  });
  await t.test('malformed logon replies and ambiguous agentless capabilities fail independently', async () => {
    const spec = await f.command('workspace-write', '', 'token-negatives');
    const r = await runNative(spec, "console.log('CHECK:'+library.func('int token_checks()')());");
    assert.match(r.stdout, /CHECK:0\s*$/, r.stdout);
  });
  await t.test('actual foreign/duplicate images and independently falsified loader names/identity reject', async () => {
    for (let scenario = 0; scenario <= 7; scenario++) {
      const spec = await f.command('danger-full-access', '', 'loader');
      const args = [join(spec.view, 'usr/bin/msys-2.0.dll'), join(f.source, 'usr/bin/msys-2.0.dll'),
        join(spec.view, 'usr/bin/dsh-msys-compat.dll')].map(x => JSON.stringify(x)).join(',');
      const r = await runNative(spec, `console.log('CHECK:'+library.func('int loader_check(str16,str16,str16,int)')(${args},${scenario}));`);
      assert.match(r.stdout, /CHECK:0\s*$/, `loader scenario ${scenario}: ${r.stdout}`);
    }
  });
  await t.test('concurrent root initialization publishes once and remembers terminal errors', async () => {
    for (const failure of [0, 1]) {
      const spec = await f.command('danger-full-access', '', 'roots');
      const r = await runNative(spec, `console.log('CHECK:'+library.func('int roots_check(str16,int)')(${JSON.stringify(spec.view)},${failure}));`);
      assert.match(r.stdout, /CHECK:0\s*$/, r.stdout);
    }
  });

  await t.test('six live namespaces, independently mapped images/read-only IAT, and four-caller access', async () => {
    const live: { mode: SandboxExecutionPolicy['mode']; session: string; view: string; child: ReturnType<typeof spawn> }[] = [];
    try {
      for (const mode of ['read-only', 'workspace-write', 'danger-full-access'] as const) for (const i of [0, 1]) {
        const session = `ipc-${mode}-${i}`, spec = await f.command(mode, msysHolderCommand, session);
        const child = spawn({ argv: spec.argv, cwd: f.workspace, env: spec.env,
          signal: AbortSignal.any([t.signal, AbortSignal.timeout(60000)]), graceMs: 500,
          stdio: { stdin: 'pipe', stdout: { maxBytes: 32768 }, stderr: { maxBytes: 32768 } } });
        live.push({ mode, session, view: spec.view, child });
      }
      const deadline = Date.now() + 20000;
      while (live.some(x => !x.child.collected.stdout!.readFrom(0).text.includes('READY')) && Date.now() < deadline) await delay(20);
      const pe = readPe(await readFile(join(f.runtime, 'usr/bin/msys-2.0.dll')));
      const hooks = ['GetFinalPathNameByHandleW', 'CreateNamedPipeA', 'CreateProcessW', 'NtSetInformationToken', 'NtCreateSection'];
      const iat = pe.imports.flatMap(entry => entry.symbols.flatMap((name, i) => hooks.includes(name) ? [entry.iat + i * 8] : []));
      assert.equal(iat.length, 5);
      const observed = live.map(x => {
        const stdout = x.child.collected.stdout!.readFrom(0).text;
        assert.match(stdout, /READY/);
        const pid = /HOLDER (\d+) (\d+)/.exec(stdout)!, namespace = /NAMESPACE (msys-\S+)/.exec(stdout)![1]!;
        assert.ok(namespace.endsWith('-' + expectedMsysKey(x.view)));
        const images = observeMsysImages(Number(pid[2]), iat);
        assert.equal(images.length, 2);
        for (const image of images) {
          assert.ok(image.path.toLowerCase().startsWith(x.view.toLowerCase() + '\\'));
          assert.ok(image.mapped.toLowerCase().endsWith(join(f.runtime, 'usr/bin', image.path.split('\\').at(-1)!).slice(2).toLowerCase()));
          if (image.iatProtections) assert.deepEqual(image.iatProtections, [2, 2, 2, 2, 2]);
        }
        return { ...x, pid: pid[1], namespace };
      });
      assert.equal(new Set(observed.map(x => x.namespace)).size, 6);
      const owner = observed.find(x => x.mode === 'workspace-write')!;
      const object = `\\BaseNamedObjects\\${owner.namespace}\\cygpid.${owner.pid}`;
      for (const row of [owner, observed.find(x => x.mode === 'workspace-write' && x !== owner)!,
        observed.find(x => x.mode === 'read-only')!, observed.find(x => x.mode === 'danger-full-access')!]) {
        const inner = [process.execPath, '--input-type=module', '-e',
          `import {sectionAccess} from ${JSON.stringify(new URL('./fixtures.ts', import.meta.url).href)}; console.log(JSON.stringify([sectionAccess(${JSON.stringify(object)},false),sectionAccess(${JSON.stringify(object)},true)]));`];
        const argv = row.mode === 'danger-full-access' ? inner : [...(await f.ctx.sandbox.confine(inner,
          { mode: row.mode, workspaceRoot: f.workspace, sessionId: row.session as SandboxExecutionPolicy['sessionId'] }, t.signal)).argv];
        const r = await runFixtureCommand(spawn, argv, f.workspace, {}, t.signal); success(r);
        assert.deepEqual(JSON.parse(r.stdout), [0, row === owner || row.mode === 'danger-full-access' ? 0 : 0xc0000022]);
      }
    } finally {
      for (const { child } of live) child.terminate();
      for (const { child } of live) assert.equal(await child.waitForExit(AbortSignal.timeout(5000)), true);
    }
  });

  await t.test('wrong policies and malformed bound syntax fail before Bash runs', async () => {
    const nonce = '1234567890abcdef';
    for (const [mode, leaf] of [
      ['danger-full-access', `ro-${nonce}`], ['danger-full-access', `ww-u-${nonce}`],
      ['read-only', `fa-${nonce}`], ['workspace-write', `fa-${nonce}`],
      ['workspace-write', `ro-${nonce}`], ['read-only', `ww-u-${nonce}`],
      ['workspace-write', `ww-1-2-${nonce}`], ['workspace-write', `ww-bad-${nonce}`],
      ['workspace-write', `ww-1-x-${nonce}`], ['danger-full-access', 'fa-short'],
    ] as const) {
      const spec = await f.command(mode, 'echo MUST_NOT_RUN', 'negative', leaf);
      const r = await runFixtureCommand(spawn, spec.argv, f.workspace, spec.env, t.signal);
      assert.equal(r.exitCode, 0xc0000142, `${mode}/${leaf}: ${r.stderr}`);
      assert.doesNotMatch(r.stdout, /MUST_NOT_RUN/);
      await unlink(spec.view);
    }
  });

  await t.test('direct source/runtime usr/bin redirect preserves argv0 and never retries a missing target', async () => {
    const sourceBash = join(f.source, 'usr/bin/bash.exe').replaceAll('\\', '/');
    const physicalBash = join(f.runtime, 'usr/bin/bash.exe').replaceAll('\\', '/');
    for (const mode of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
      const command = `set -e; '${sourceBash}' --noprofile --norc -c 'echo source'; '${physicalBash}' --noprofile --norc -c 'echo runtime'; exec -a custom sh -c 'test "$0" = custom'`;
      const spec = await f.command(mode, command, 'rewrite');
      const r = await runFixtureCommand(spawn, spec.argv, f.workspace, spec.env, t.signal); success(r);
      assert.match(r.stdout, /source/); assert.match(r.stdout, /runtime/);
    }
    const target = join(f.runtime, 'usr/bin/true.exe');
    await unlink(target);
    try {
      const command = `'${join(f.source, 'usr/bin/true.exe').replaceAll('\\', '/')}' && echo MUST_NOT_RUN`;
      const spec = await f.command('danger-full-access', command, 'missing');
      const r = await runFixtureCommand(spawn, spec.argv, f.workspace, spec.env, t.signal);
      assert.notEqual(r.exitCode, 0); assert.doesNotMatch(r.stdout, /MUST_NOT_RUN/);
    } finally { await copyFile(join(f.source, 'usr/bin/true.exe'), target); }
    execFileSync('icacls.exe', [target, '/deny', '*S-1-1-0:(X)'], { stdio: 'pipe' });
    try {
      const spec = await f.command('danger-full-access', `'${join(f.source, 'usr/bin/true.exe').replaceAll('\\', '/')}' && echo MUST_NOT_RUN`, 'denied');
      const r = await runFixtureCommand(spawn, spec.argv, f.workspace, spec.env, t.signal);
      assert.notEqual(r.exitCode, 0); assert.doesNotMatch(r.stdout, /MUST_NOT_RUN/);
    } finally { await unlink(target); await copyFile(join(f.source, 'usr/bin/true.exe'), target); }
  });
  await t.test('standalone shim loading fails', async () => {
    const spec = await f.command('danger-full-access', '', 'standalone');
    const k = koffi.load('kernel32.dll'), load = k.func('void* LoadLibraryW(str16)'), free = k.func('int FreeLibrary(void*)');
    const handle = load(join(spec.view, 'usr/bin/dsh-msys-compat.dll'));
    if (handle) assert.ok(free(handle));
    assert.equal(handle, null);
  });
});
