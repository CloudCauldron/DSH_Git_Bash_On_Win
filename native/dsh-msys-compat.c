/* Zero-CRT, x64 MSYS compatibility for DSH's private Windows views.
 * Attach verifies exact sibling path/file identity and independent policy/token
 * admission before replacing five IAT slots and restoring read-only protection.
 * No loader, thread or heap initialization under loader lock. Native children
 * receive no injection; DSH retains process, token and managed-range ownership.
 */

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <winternl.h>
#include <intrin.h>

#pragma warning(disable: 4100) /* unreferenced formal parameter */
#pragma warning(disable: 4201) /* nameless struct/union */

/* Minimal CRT-free memory helpers                                            */

#pragma function(memcpy, memset)

void * __cdecl memcpy(void *dst, const void *src, size_t n) {
    unsigned char *d = (unsigned char *)dst;
    const unsigned char *s = (const unsigned char *)src;
    while (n--) *d++ = *s++;
    return dst;
}

void * __cdecl memset(void *dst, int val, size_t n) {
    unsigned char *d = (unsigned char *)dst;
    while (n--) *d++ = (unsigned char)val;
    return dst;
}

static size_t wlen(const WCHAR *s) {
    size_t n = 0;
    while (s[n]) n++;
    return n;
}

static char ascii_lower(char c) {
    return (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c;
}

static BOOL ascii_eq_ci(const char *a, const char *b) {
    while (*a && *b) {
        if (ascii_lower(*a) != ascii_lower(*b)) return FALSE;
        a++; b++;
    }
    return *a == 0 && *b == 0;
}

static BOOL ascii_eq(const char *a, const char *b) {
    while (*a && *a == *b) { a++; b++; }
    return *a == *b;
}

static BOOL ascii_starts_ci(const char *s, const char *prefix) {
    while (*prefix) {
        if (ascii_lower(*s) != ascii_lower(*prefix)) return FALSE;
        s++; prefix++;
    }
    return TRUE;
}

/* NTDLL native declarations (all statically linked via ntdll.lib)            */

#ifndef NT_SUCCESS
#define NT_SUCCESS(Status) (((NTSTATUS)(Status)) >= 0)
#endif

#define NT_CURRENT_PROCESS ((HANDLE)(LONG_PTR)-1)
#define MEMORY_MAPPED_FILENAME_INFORMATION 2
#define OBJECT_NAME_INFORMATION_CLASS 1
#define FILE_ALL_ACCESS_MASK 0x001F01FFu

NTSYSAPI NTSTATUS NTAPI NtOpenProcessToken(HANDLE ProcessHandle, ACCESS_MASK DesiredAccess, PHANDLE TokenHandle);
NTSYSAPI NTSTATUS NTAPI NtQueryInformationToken(HANDLE TokenHandle, TOKEN_INFORMATION_CLASS TokenInformationClass, PVOID TokenInformation, ULONG TokenInformationLength, PULONG ReturnLength);
NTSYSAPI NTSTATUS NTAPI NtProtectVirtualMemory(HANDLE ProcessHandle, PVOID *BaseAddress, PSIZE_T RegionSize, ULONG NewProtect, PULONG OldProtect);
NTSYSAPI NTSTATUS NTAPI NtQueryVirtualMemory(HANDLE ProcessHandle, PVOID BaseAddress, ULONG MemoryInformationClass, PVOID MemoryInformation, SIZE_T MemoryInformationLength, PSIZE_T ReturnLength);

NTSYSAPI WCHAR NTAPI RtlUpcaseUnicodeChar(WCHAR SourceCharacter);
NTSYSAPI BOOLEAN NTAPI RtlEqualSid(PSID Sid1, PSID Sid2);
NTSYSAPI ULONG NTAPI RtlLengthSid(PSID Sid);
NTSYSAPI NTSTATUS NTAPI RtlCopySid(ULONG DestinationSidLength, PSID DestinationSid, PSID SourceSid);
NTSYSAPI BOOLEAN NTAPI RtlValidSid(PSID Sid);

NTSYSAPI NTSTATUS NTAPI RtlCreateAcl(PACL Acl, ULONG AclLength, ULONG AclRevision);
NTSYSAPI NTSTATUS NTAPI RtlGetAce(PACL Acl, ULONG AceIndex, PVOID *Ace);
NTSYSAPI NTSTATUS NTAPI RtlAddAce(PACL Acl, ULONG AceRevision, ULONG StartingAceIndex, PVOID AceList, ULONG AceListLength);
NTSYSAPI NTSTATUS NTAPI RtlAddAccessAllowedAce(PACL Acl, ULONG AclRevision, ACCESS_MASK AccessMask, PSID Sid);

NTSYSAPI NTSTATUS NTAPI RtlCreateSecurityDescriptor(PSECURITY_DESCRIPTOR SecurityDescriptor, ULONG Revision);
NTSYSAPI NTSTATUS NTAPI RtlGetControlSecurityDescriptor(PSECURITY_DESCRIPTOR SecurityDescriptor, PSECURITY_DESCRIPTOR_CONTROL Control, PULONG Revision);
NTSYSAPI NTSTATUS NTAPI RtlSetControlSecurityDescriptor(PSECURITY_DESCRIPTOR SecurityDescriptor, SECURITY_DESCRIPTOR_CONTROL ControlBitsOfInterest, SECURITY_DESCRIPTOR_CONTROL ControlBitsToSet);
NTSYSAPI NTSTATUS NTAPI RtlGetOwnerSecurityDescriptor(PSECURITY_DESCRIPTOR SecurityDescriptor, PSID *Owner, PBOOLEAN OwnerDefaulted);
NTSYSAPI NTSTATUS NTAPI RtlSetOwnerSecurityDescriptor(PSECURITY_DESCRIPTOR SecurityDescriptor, PSID Owner, BOOLEAN OwnerDefaulted);
NTSYSAPI NTSTATUS NTAPI RtlGetGroupSecurityDescriptor(PSECURITY_DESCRIPTOR SecurityDescriptor, PSID *Group, PBOOLEAN GroupDefaulted);
NTSYSAPI NTSTATUS NTAPI RtlSetGroupSecurityDescriptor(PSECURITY_DESCRIPTOR SecurityDescriptor, PSID Group, BOOLEAN GroupDefaulted);
NTSYSAPI NTSTATUS NTAPI RtlGetDaclSecurityDescriptor(PSECURITY_DESCRIPTOR SecurityDescriptor, PBOOLEAN DaclPresent, PACL *Dacl, PBOOLEAN DaclDefaulted);
NTSYSAPI NTSTATUS NTAPI RtlSetDaclSecurityDescriptor(PSECURITY_DESCRIPTOR SecurityDescriptor, BOOLEAN DaclPresent, PACL Dacl, BOOLEAN DaclDefaulted);
NTSYSAPI NTSTATUS NTAPI RtlGetSaclSecurityDescriptor(PSECURITY_DESCRIPTOR SecurityDescriptor, PBOOLEAN SaclPresent, PACL *Sacl, PBOOLEAN SaclDefaulted);
NTSYSAPI NTSTATUS NTAPI RtlSetSaclSecurityDescriptor(PSECURITY_DESCRIPTOR SecurityDescriptor, BOOLEAN SaclPresent, PACL Sacl, BOOLEAN SaclDefaulted);

/* Full LDR_DATA_TABLE_ENTRY prefix layout (x64 ABI-stable across Win7..Win11). */
typedef struct _DSH_LDR_ENTRY {
    LIST_ENTRY InLoadOrderLinks;
    LIST_ENTRY InMemoryOrderLinks;
    LIST_ENTRY InInitializationOrderLinks;
    PVOID DllBase;
    PVOID EntryPoint;
    ULONG SizeOfImage;
    ULONG _pad0;
    UNICODE_STRING FullDllName;
    UNICODE_STRING BaseDllName;
} DSH_LDR_ENTRY;
C_ASSERT(FIELD_OFFSET(DSH_LDR_ENTRY, InMemoryOrderLinks) == 16);
C_ASSERT(FIELD_OFFSET(DSH_LDR_ENTRY, FullDllName) == 72);
C_ASSERT(FIELD_OFFSET(DSH_LDR_ENTRY, BaseDllName) == 88);
C_ASSERT(sizeof(UNICODE_STRING) == 16);
C_ASSERT(FIELD_OFFSET(TOKEN_GROUPS, Groups) == 8);
C_ASSERT(sizeof(SID_AND_ATTRIBUTES) == 16);

/* Inline SHA-256 (for exact tempWriteSid verification without bcrypt/advapi) */

typedef struct {
    UINT32 state[8];
    UINT64 bitlen;
    UINT8  data[64];
    size_t datalen;
} SHA256_CTX;

static const UINT32 k_sha256[64] = {
    0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
    0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
    0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
    0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
    0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
    0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
    0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
    0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u
};

static UINT32 rotr32(UINT32 x, UINT32 n) { return (x >> n) | (x << (32u - n)); }

static void sha256_transform(SHA256_CTX *ctx, const UINT8 block[64]) {
    UINT32 m[64];
    for (int i = 0; i < 16; i++) {
        m[i] = ((UINT32)block[i * 4] << 24) | ((UINT32)block[i * 4 + 1] << 16)
             | ((UINT32)block[i * 4 + 2] << 8) | (UINT32)block[i * 4 + 3];
    }
    for (int i = 16; i < 64; i++) {
        UINT32 s0 = rotr32(m[i - 15], 7) ^ rotr32(m[i - 15], 18) ^ (m[i - 15] >> 3);
        UINT32 s1 = rotr32(m[i - 2], 17) ^ rotr32(m[i - 2], 19) ^ (m[i - 2] >> 10);
        m[i] = m[i - 16] + s0 + m[i - 7] + s1;
    }
    UINT32 a = ctx->state[0], b = ctx->state[1], c = ctx->state[2], d = ctx->state[3];
    UINT32 e = ctx->state[4], f = ctx->state[5], g = ctx->state[6], h = ctx->state[7];
    for (int i = 0; i < 64; i++) {
        UINT32 S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
        UINT32 ch = (e & f) ^ ((~e) & g);
        UINT32 t1 = h + S1 + ch + k_sha256[i] + m[i];
        UINT32 S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
        UINT32 maj = (a & b) ^ (a & c) ^ (b & c);
        UINT32 t2 = S0 + maj;
        h = g; g = f; f = e; e = d + t1;
        d = c; c = b; b = a; a = t1 + t2;
    }
    ctx->state[0] += a; ctx->state[1] += b; ctx->state[2] += c; ctx->state[3] += d;
    ctx->state[4] += e; ctx->state[5] += f; ctx->state[6] += g; ctx->state[7] += h;
}

static void sha256_init(SHA256_CTX *ctx) {
    ctx->datalen = 0;
    ctx->bitlen = 0;
    ctx->state[0] = 0x6a09e667u; ctx->state[1] = 0xbb67ae85u;
    ctx->state[2] = 0x3c6ef372u; ctx->state[3] = 0xa54ff53au;
    ctx->state[4] = 0x510e527fu; ctx->state[5] = 0x9b05688cu;
    ctx->state[6] = 0x1f83d9abu; ctx->state[7] = 0x5be0cd19u;
}

static void sha256_update(SHA256_CTX *ctx, const UINT8 *data, size_t len) {
    for (size_t i = 0; i < len; i++) {
        ctx->data[ctx->datalen++] = data[i];
        if (ctx->datalen == 64) {
            sha256_transform(ctx, ctx->data);
            ctx->bitlen += 512;
            ctx->datalen = 0;
        }
    }
}

static void sha256_final(SHA256_CTX *ctx, UINT8 hash[32]) {
    size_t i = ctx->datalen;
    ctx->data[i++] = 0x80;
    if (i > 56) {
        while (i < 64) ctx->data[i++] = 0;
        sha256_transform(ctx, ctx->data);
        i = 0;
    }
    while (i < 56) ctx->data[i++] = 0;
    ctx->bitlen += (UINT64)ctx->datalen * 8u;
    for (int j = 0; j < 8; j++) {
        ctx->data[63 - j] = (UINT8)(ctx->bitlen >> (j * 8));
    }
    sha256_transform(ctx, ctx->data);
    for (int j = 0; j < 8; j++) {
        hash[j * 4 + 0] = (UINT8)(ctx->state[j] >> 24);
        hash[j * 4 + 1] = (UINT8)(ctx->state[j] >> 16);
        hash[j * 4 + 2] = (UINT8)(ctx->state[j] >> 8);
        hash[j * 4 + 3] = (UINT8)(ctx->state[j]);
    }
}

/* Binary SID construction & comparison helpers                               */

typedef struct {
    BYTE  Revision;
    BYTE  SubAuthorityCount;
    BYTE  IdentifierAuthority[6];
    DWORD SubAuthority[4];
} DSH_SID4;

static void build_sid1(DSH_SID4 *out, BYTE authLow, DWORD sub0) {
    memset(out, 0, sizeof(*out));
    out->Revision = 1;
    out->SubAuthorityCount = 1;
    out->IdentifierAuthority[5] = authLow;
    out->SubAuthority[0] = sub0;
}

static void build_temp_sid(DSH_SID4 *out, DWORD first, DWORD second) {
    memset(out, 0, sizeof(*out));
    out->Revision = 1;
    out->SubAuthorityCount = 3;
    out->IdentifierAuthority[5] = 4; /* SECURITY_NON_UNIQUE_AUTHORITY (S-1-4-*) */
    out->SubAuthority[0] = first;
    out->SubAuthority[1] = second;
    out->SubAuthority[2] = 1;
}

static BOOL sid_is_authority(PSID sid, BYTE authLow) {
    const BYTE *b = (const BYTE *)sid;
    if (!sid || !RtlValidSid(sid)) return FALSE;
    return b[0] == 1 && b[2] == 0 && b[3] == 0 && b[4] == 0 && b[5] == 0 && b[6] == 0 && b[7] == authLow;
}

/* Called for a validated S-1-4 SID from the restricting list. */
static BOOL sid_is_temp_capability(const SID *sid) {
    return sid->SubAuthorityCount == 3 && sid->SubAuthority[2] == 1
        && sid->SubAuthority[0] > 0 && sid->SubAuthority[0] <= 0x3fffffffu
        && sid->SubAuthority[1] > 0 && sid->SubAuthority[1] <= 0x3fffffffu;
}

static BOOL sid_list_contains(const TOKEN_GROUPS *groups, PSID target) {
    for (DWORD i = 0; i < groups->GroupCount; i++) {
        if (groups->Groups[i].Sid && RtlEqualSid(groups->Groups[i].Sid, target)) return TRUE;
    }
    return FALSE;
}

/* Wide path comparison & normalization helpers                               */

static BOOL wide_eq_n_ci(const WCHAR *a, const WCHAR *b, size_t n) {
    for (size_t i = 0; i < n; i++) {
        if (RtlUpcaseUnicodeChar(a[i]) != RtlUpcaseUnicodeChar(b[i])) return FALSE;
    }
    return TRUE;
}

static BOOL wide_eq_ci(const WCHAR *a, const WCHAR *b) {
    while (*a && *b) {
        if (RtlUpcaseUnicodeChar(*a) != RtlUpcaseUnicodeChar(*b)) return FALSE;
        a++; b++;
    }
    return *a == 0 && *b == 0;
}

static BOOL wide_ends_ci(const WCHAR *s, size_t sLen, const WCHAR *suffix, size_t sufLen) {
    if (sLen < sufLen) return FALSE;
    return wide_eq_n_ci(s + (sLen - sufLen), suffix, sufLen);
}

static const WCHAR *strip_extended_prefix(const WCHAR *p, size_t *outLen) {
    size_t len = wlen(p);
    if (len >= 4 && p[0] == L'\\' && (p[1] == L'\\' || p[1] == L'?') && p[2] == L'?' && p[3] == L'\\') {
        p += 4;
        len -= 4;
    }
    if (outLen) *outLen = len;
    return p;
}

static UINT64 cygwin_hash_path_name(const WCHAR *ntPath) {
    UINT64 h = 0;
    for (size_t i = 0; ntPath[i]; i++) {
        UINT64 ch = (UINT64)RtlUpcaseUnicodeChar(ntPath[i]);
        h = ch + (h << 6) + (h << 16) - h;
    }
    return h;
}

static void format_hex64_lower(UINT64 v, char outA[17], WCHAR outW[17]) {
    static const char hex[] = "0123456789abcdef";
    for (int i = 15; i >= 0; i--) {
        char c = hex[v & 0xFu];
        outA[i] = c;
        outW[i] = (WCHAR)c;
        v >>= 4;
    }
    outA[16] = 0;
    outW[16] = 0;
}

/* Global immutable process state (initialized strictly once in DllMain)      */

#define MAX_PATH_CHARS 1024
static BOOL inside(const void *buffer, size_t size, const void *pointer, size_t length);
static BOOL bounded_sid(const void *buffer, size_t size, PSID sid);

typedef DWORD  (WINAPI *PFN_GetFinalPathNameByHandleW)(HANDLE, LPWSTR, DWORD, DWORD);
typedef HANDLE (WINAPI *PFN_CreateNamedPipeA)(LPCSTR, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, LPSECURITY_ATTRIBUTES);
typedef BOOL   (WINAPI *PFN_CreateProcessW)(LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION);
typedef NTSTATUS (NTAPI *PFN_NtSetInformationToken)(HANDLE, TOKEN_INFORMATION_CLASS, PVOID, ULONG);
typedef NTSTATUS (NTAPI *PFN_NtCreateSection)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PLARGE_INTEGER, ULONG, ULONG, HANDLE);

static HMODULE g_hMsys = NULL;
static ULONG g_msysImageSize;

static WCHAR  g_viewRoot[MAX_PATH_CHARS];
static size_t g_viewRootLen = 0;

static WCHAR  g_msysDosPath[MAX_PATH_CHARS]; /* \\?\<viewRoot>\usr\bin\msys-2.0.dll */
static size_t g_msysDosPathLen = 0;

static DWORD  g_msysVolSerial = 0;
static DWORD  g_msysFileIdxHigh = 0;
static DWORD  g_msysFileIdxLow = 0;

static char   g_expectedKeyHexA[17];
static WCHAR  g_expectedKeyHexW[17];

static BYTE   g_grantSid[SECURITY_MAX_SID_SIZE];
static ULONG  g_grantSidLen = 0; /* 0 in danger-full-access */

/* Resolved lazily on first CreateProcessW (guaranteed outside Loader Lock). */
static INIT_ONCE g_rootsOnce = INIT_ONCE_STATIC_INIT;
static DWORD g_rootsError;
static WCHAR  g_runtimeRoot[MAX_PATH_CHARS];
static size_t g_runtimeRootLen = 0;
static WCHAR  g_sourceRoot[MAX_PATH_CHARS];
static size_t g_sourceRootLen = 0;

/* Original IAT pointers saved from sibling msys-2.0.dll. */
static PFN_GetFinalPathNameByHandleW g_origGetFinalPathNameByHandleW = NULL;
static PFN_CreateNamedPipeA          g_origCreateNamedPipeA          = NULL;
static PFN_CreateProcessW            g_origCreateProcessW            = NULL;
static PFN_NtSetInformationToken     g_origNtSetInformationToken     = NULL;
static PFN_NtCreateSection           g_origNtCreateSection           = NULL;

/* ACL / Security Descriptor helpers (pure ntdll Rtl*, stack buffers)         */

static BOOL dacl_has_exact_allow_ace(PACL dacl, PSID sid, BOOL acceptFileAll) {
    if (!dacl || dacl->AclSize < sizeof(ACL) || dacl->AclSize > 8192) return FALSE;
    for (DWORD i = 0; i < dacl->AceCount; i++) {
        PVOID acePtr = NULL;
        if (!NT_SUCCESS(RtlGetAce(dacl, i, &acePtr)) || !acePtr) return FALSE;
        PACE_HEADER hdr = (PACE_HEADER)acePtr;
        if (!inside(dacl, dacl->AclSize, hdr, sizeof(ACE_HEADER))
         || !inside(dacl, dacl->AclSize, hdr, hdr->AceSize)) return FALSE;
        if (hdr->AceType != ACCESS_ALLOWED_ACE_TYPE) continue;
        if ((hdr->AceFlags & INHERIT_ONLY_ACE) != 0) continue;
        PACCESS_ALLOWED_ACE allowAce = (PACCESS_ALLOWED_ACE)acePtr;
        if (hdr->AceSize < FIELD_OFFSET(ACCESS_ALLOWED_ACE, SidStart)
         || !bounded_sid((BYTE *)hdr + FIELD_OFFSET(ACCESS_ALLOWED_ACE, SidStart),
                          hdr->AceSize - FIELD_OFFSET(ACCESS_ALLOWED_ACE, SidStart), &allowAce->SidStart)) return FALSE;
        BOOL maskOk = (allowAce->Mask == GENERIC_ALL)
                   || (acceptFileAll && allowAce->Mask == FILE_ALL_ACCESS_MASK);
        if (!maskOk) continue;
        if (RtlEqualSid((PSID)&allowAce->SidStart, sid)) return TRUE;
    }
    return FALSE;
}

static BOOL build_extended_acl(PACL origDacl, BYTE *outBuf, ULONG outBufSize, PACL *outAcl) {
    if (!origDacl || origDacl->AclSize < sizeof(ACL) || origDacl->AclSize > 8192) return FALSE;
    if (origDacl->AclRevision != ACL_REVISION && origDacl->AclRevision != ACL_REVISION_DS) return FALSE;
    ULONG newAceSize = (ULONG)(sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + g_grantSidLen);
    ULONG needed = ((ULONG)origDacl->AclSize + newAceSize + 3u) & ~3u;
    if (needed > outBufSize) return FALSE;

    PACL newAcl = (PACL)outBuf;
    if (!NT_SUCCESS(RtlCreateAcl(newAcl, needed, origDacl->AclRevision))) return FALSE;
    for (DWORD i = 0; i < origDacl->AceCount; i++) {
        PVOID acePtr = NULL;
        if (!NT_SUCCESS(RtlGetAce(origDacl, i, &acePtr)) || !acePtr) return FALSE;
        PACE_HEADER hdr = (PACE_HEADER)acePtr;
        if (!inside(origDacl, origDacl->AclSize, hdr, sizeof(ACE_HEADER))
         || hdr->AceSize < sizeof(ACE_HEADER) || !inside(origDacl, origDacl->AclSize, hdr, hdr->AceSize)) return FALSE;
        if (!NT_SUCCESS(RtlAddAce(newAcl, origDacl->AclRevision, MAXDWORD, acePtr, hdr->AceSize))) return FALSE;
    }
    if (!NT_SUCCESS(RtlAddAccessAllowedAce(newAcl, origDacl->AclRevision, GENERIC_ALL, (PSID)g_grantSid))) {
        return FALSE;
    }
    *outAcl = newAcl;
    return TRUE;
}

static BOOL build_extended_sd(
    PSECURITY_DESCRIPTOR origSd,
    SECURITY_DESCRIPTOR *outSd,
    BYTE *aclBuf,
    ULONG aclBufSize,
    BOOL *outAlreadyHadAce
) {
    *outAlreadyHadAce = FALSE;
    if (!origSd) return FALSE;

    BOOLEAN daclPresent = FALSE, daclDefaulted = FALSE;
    PACL origDacl = NULL;
    if (!NT_SUCCESS(RtlGetDaclSecurityDescriptor(origSd, &daclPresent, &origDacl, &daclDefaulted))) return FALSE;
    if (!daclPresent || !origDacl) return FALSE; /* Never alter a NULL / absent DACL. */

    if (dacl_has_exact_allow_ace(origDacl, (PSID)g_grantSid, FALSE)) {
        *outAlreadyHadAce = TRUE;
        return TRUE;
    }

    PACL newAcl = NULL;
    if (!build_extended_acl(origDacl, aclBuf, aclBufSize, &newAcl)) return FALSE;

    if (!NT_SUCCESS(RtlCreateSecurityDescriptor(outSd, SECURITY_DESCRIPTOR_REVISION))) return FALSE;

    PSID owner = NULL, group = NULL;
    BOOLEAN ownerDefaulted = FALSE, groupDefaulted = FALSE;
    if (!NT_SUCCESS(RtlGetOwnerSecurityDescriptor(origSd, &owner, &ownerDefaulted))
     || !NT_SUCCESS(RtlSetOwnerSecurityDescriptor(outSd, owner, ownerDefaulted))) return FALSE;
    if (!NT_SUCCESS(RtlGetGroupSecurityDescriptor(origSd, &group, &groupDefaulted))
     || !NT_SUCCESS(RtlSetGroupSecurityDescriptor(outSd, group, groupDefaulted))) return FALSE;

    BOOLEAN saclPresent = FALSE, saclDefaulted = FALSE;
    PACL sacl = NULL;
    if (!NT_SUCCESS(RtlGetSaclSecurityDescriptor(origSd, &saclPresent, &sacl, &saclDefaulted))
     || !NT_SUCCESS(RtlSetSaclSecurityDescriptor(outSd, saclPresent, sacl, saclDefaulted))) return FALSE;

    if (!NT_SUCCESS(RtlSetDaclSecurityDescriptor(outSd, TRUE, newAcl, daclDefaulted))) return FALSE;

    SECURITY_DESCRIPTOR_CONTROL origControl = 0;
    ULONG origRev = 0;
    if (!NT_SUCCESS(RtlGetControlSecurityDescriptor(origSd, &origControl, &origRev))) return FALSE;
    SECURITY_DESCRIPTOR_CONTROL mask = SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ
                                     | SE_SACL_PROTECTED | SE_SACL_AUTO_INHERITED | SE_SACL_AUTO_INHERIT_REQ;
    if (!NT_SUCCESS(RtlSetControlSecurityDescriptor(outSd, mask, (SECURITY_DESCRIPTOR_CONTROL)(origControl & mask)))) return FALSE;
    /* Keep the original descriptor if conversion would drop any other control information. */
    return outSd->Control == (origControl & ~SE_SELF_RELATIVE);
}

/* Hook 1: GetFinalPathNameByHandleW                                          */

static DWORD WINAPI Hook_GetFinalPathNameByHandleW(
    HANDLE hFile,
    LPWSTR lpszFilePath,
    DWORD cchFilePath,
    DWORD dwFlags
) {
    if (dwFlags == 0 && hFile && hFile != INVALID_HANDLE_VALUE) {
        BY_HANDLE_FILE_INFORMATION info;
        if (GetFileInformationByHandle(hFile, &info)) {
            if (info.dwVolumeSerialNumber == g_msysVolSerial
             && info.nFileIndexHigh == g_msysFileIdxHigh
             && info.nFileIndexLow == g_msysFileIdxLow) {
                if (cchFilePath >= (DWORD)(g_msysDosPathLen + 1) && lpszFilePath != NULL) {
                    memcpy(lpszFilePath, g_msysDosPath, (g_msysDosPathLen + 1) * sizeof(WCHAR));
                    return (DWORD)g_msysDosPathLen;
                }
                return (DWORD)(g_msysDosPathLen + 1);
            }
        }
    }
    return g_origGetFinalPathNameByHandleW(hFile, lpszFilePath, cchFilePath, dwFlags);
}

/* Hook 2: CreateNamedPipeA (strict signal-pipe predicate)                    */

static BOOL parse_own_sigwait_pipe(LPCSTR name) {
    if (!name) return FALSE;
    const char *p = NULL;
    if (ascii_starts_ci(name, "\\\\.\\pipe\\msys-")) p = name + 14;
    else return FALSE;

    /* Match exact 16-hex-char expected installation key. */
    for (int i = 0; i < 16; i++) {
        if (!p[i] || ascii_lower(p[i]) != g_expectedKeyHexA[i]) return FALSE;
    }
    p += 16;
    if (*p != '-') return FALSE;
    p++;

    /* Match decimal current Windows PID. */
    if (*p < '1' || *p > '9') return FALSE;
    UINT64 pid = 0;
    while (*p >= '0' && *p <= '9') {
        pid = pid * 10u + (UINT64)(*p - '0');
        if (pid > 0xFFFFFFFFu) return FALSE;
        p++;
    }
    if ((DWORD)pid != GetCurrentProcessId()) return FALSE;

    return ascii_eq_ci(p, "-sigwait");
}

static HANDLE WINAPI Hook_CreateNamedPipeA(
    LPCSTR lpName,
    DWORD dwOpenMode,
    DWORD dwPipeMode,
    DWORD nMaxInstances,
    DWORD nOutBufferSize,
    DWORD nInBufferSize,
    DWORD nDefaultTimeOut,
    LPSECURITY_ATTRIBUTES lpSecurityAttributes
) {
    if (g_grantSidLen > 0
     && lpSecurityAttributes != NULL
     && lpSecurityAttributes->nLength == sizeof(SECURITY_ATTRIBUTES)
     && lpSecurityAttributes->lpSecurityDescriptor != NULL
     && (dwOpenMode & FILE_FLAG_FIRST_PIPE_INSTANCE) != 0
     && (dwPipeMode & PIPE_REJECT_REMOTE_CLIENTS) != 0
     && nMaxInstances == 1
     && parse_own_sigwait_pipe(lpName)) {
        SECURITY_DESCRIPTOR newSd;
        BYTE aclBuf[2048];
        BOOL alreadyHad = FALSE;
        if (build_extended_sd(lpSecurityAttributes->lpSecurityDescriptor, &newSd, aclBuf, sizeof(aclBuf), &alreadyHad)
         && !alreadyHad) {
            SECURITY_ATTRIBUTES newSa = *lpSecurityAttributes;
            newSa.lpSecurityDescriptor = &newSd;
            return g_origCreateNamedPipeA(
                lpName, dwOpenMode, dwPipeMode, nMaxInstances,
                nOutBufferSize, nInBufferSize, nDefaultTimeOut, &newSa
            );
        }
    }
    return g_origCreateNamedPipeA(
        lpName, dwOpenMode, dwPipeMode, nMaxInstances,
        nOutBufferSize, nInBufferSize, nDefaultTimeOut, lpSecurityAttributes
    );
}

/* Hook 3: NtSetInformationToken (TokenDefaultDacl)                           */

static NTSTATUS NTAPI Hook_NtSetInformationToken(
    HANDLE TokenHandle,
    TOKEN_INFORMATION_CLASS TokenInformationClass,
    PVOID TokenInformation,
    ULONG TokenInformationLength
) {
    if (g_grantSidLen > 0
     && TokenInformationClass == TokenDefaultDacl
     && TokenInformationLength == sizeof(TOKEN_DEFAULT_DACL)
     && TokenInformation != NULL) {
        PACL origDacl = ((PTOKEN_DEFAULT_DACL)TokenInformation)->DefaultDacl;
        if (origDacl != NULL && !dacl_has_exact_allow_ace(origDacl, (PSID)g_grantSid, FALSE)) {
            BYTE aclBuf[2048];
            PACL newAcl = NULL;
            if (build_extended_acl(origDacl, aclBuf, sizeof(aclBuf), &newAcl)) {
                TOKEN_DEFAULT_DACL newInfo;
                newInfo.DefaultDacl = newAcl;
                return g_origNtSetInformationToken(TokenHandle, TokenInformationClass, &newInfo, sizeof(newInfo));
            }
        }
    }
    return g_origNtSetInformationToken(TokenHandle, TokenInformationClass, TokenInformation, TokenInformationLength);
}

/* Hook 4: NtCreateSection (cygpid.<digits> inside our verified namespace)    */

static BOOL unicode_is_cygpid(const UNICODE_STRING *us) {
    if (!us || !us->Buffer || us->Length > us->MaximumLength || (us->Length % sizeof(WCHAR)) != 0) return FALSE;
    size_t len = us->Length / sizeof(WCHAR);
    if (len < 8) return FALSE; /* "cygpid." (7) + at least 1 digit */
    static const WCHAR prefix[7] = { L'c',L'y',L'g',L'p',L'i',L'd',L'.' };
    for (size_t i = 0; i < 7; i++) {
        if (us->Buffer[i] != prefix[i]) return FALSE;
    }
    for (size_t i = 7; i < len; i++) {
        if (us->Buffer[i] < L'0' || us->Buffer[i] > L'9') return FALSE;
    }
    return TRUE;
}

static BOOL is_msys_namespace(const WCHAR *name, size_t len) {
    static const WCHAR prefix[] = L"\\BaseNamedObjects\\msys-2.0S";
    const size_t prefixLen = ARRAYSIZE(prefix) - 1;
    if (len < prefixLen + 1 + 17 || !wide_eq_n_ci(name, prefix, prefixLen)) return FALSE;
    for (size_t i = prefixLen; i < len - 17; i++) {
        if (name[i] < L'0' || name[i] > L'9') return FALSE;
    }
    return name[len - 17] == L'-' && wide_eq_n_ci(name + len - 16, g_expectedKeyHexW, 16);
}

static BOOL root_dir_matches_expected_namespace(HANDLE rootDir) {
    BYTE buf[1024];
    ULONG retLen = 0;
    NTSTATUS st = NtQueryObject(rootDir, (OBJECT_INFORMATION_CLASS)OBJECT_NAME_INFORMATION_CLASS, buf, sizeof(buf), &retLen);
    if (!NT_SUCCESS(st) || retLen < sizeof(UNICODE_STRING) || retLen > sizeof(buf)) return FALSE;
    const UNICODE_STRING *name = (const UNICODE_STRING *)buf;
    if (!name->Buffer || name->Length > name->MaximumLength || (name->Length % sizeof(WCHAR)) != 0
     || !inside(buf + sizeof(UNICODE_STRING), retLen - sizeof(UNICODE_STRING), name->Buffer, name->Length)) return FALSE;
    return is_msys_namespace(name->Buffer, name->Length / sizeof(WCHAR));
}

static NTSTATUS NTAPI Hook_NtCreateSection(
    PHANDLE SectionHandle,
    ACCESS_MASK DesiredAccess,
    POBJECT_ATTRIBUTES ObjectAttributes,
    PLARGE_INTEGER MaximumSize,
    ULONG SectionPageProtection,
    ULONG AllocationAttributes,
    HANDLE FileHandle
) {
    if (g_grantSidLen > 0
     && FileHandle == NULL
     && ObjectAttributes != NULL
     && ObjectAttributes->Length == sizeof(OBJECT_ATTRIBUTES)
     && ObjectAttributes->RootDirectory != NULL
     && ObjectAttributes->ObjectName != NULL
     && ObjectAttributes->SecurityDescriptor != NULL
     && unicode_is_cygpid(ObjectAttributes->ObjectName)
     && root_dir_matches_expected_namespace(ObjectAttributes->RootDirectory)) {
        SECURITY_DESCRIPTOR newSd;
        BYTE aclBuf[2048];
        BOOL alreadyHad = FALSE;
        if (build_extended_sd(ObjectAttributes->SecurityDescriptor, &newSd, aclBuf, sizeof(aclBuf), &alreadyHad)
         && !alreadyHad) {
            OBJECT_ATTRIBUTES newOa = *ObjectAttributes;
            newOa.SecurityDescriptor = &newSd;
            return g_origNtCreateSection(
                SectionHandle, DesiredAccess, &newOa, MaximumSize,
                SectionPageProtection, AllocationAttributes, FileHandle
            );
        }
    }
    return g_origNtCreateSection(
        SectionHandle, DesiredAccess, ObjectAttributes, MaximumSize,
        SectionPageProtection, AllocationAttributes, FileHandle
    );
}

/* Hook 5: CreateProcessW (strictly <source|runtime>\usr\bin\<leaf> rewrite)  */

static DWORD resolve_root(const WCHAR *suffix, WCHAR *out, size_t *outLen) {
    static WCHAR probe[MAX_PATH_CHARS], finalBuf[MAX_PATH_CHARS];
    size_t suffixLen = wlen(suffix);
    if (4 + g_viewRootLen + suffixLen + 1 > MAX_PATH_CHARS) return ERROR_FILENAME_EXCED_RANGE;
    memcpy(probe, L"\\\\?\\", 4 * sizeof(WCHAR));
    memcpy(probe + 4, g_viewRoot, g_viewRootLen * sizeof(WCHAR));
    memcpy(probe + 4 + g_viewRootLen, suffix, (suffixLen + 1) * sizeof(WCHAR));
    HANDLE h = CreateFileW(probe, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
    if (h == INVALID_HANDLE_VALUE) return GetLastError();
    DWORD n = g_origGetFinalPathNameByHandleW(h, finalBuf, MAX_PATH_CHARS, 0);
    DWORD error = n == 0 ? GetLastError() : n >= MAX_PATH_CHARS ? ERROR_FILENAME_EXCED_RANGE : 0;
    if (!CloseHandle(h) && !error) error = GetLastError();
    if (error) return error;
    if (!n) return ERROR_INVALID_DATA;
    size_t len;
    const WCHAR *clean = strip_extended_prefix(finalBuf, &len);
    if (len <= suffixLen || !wide_ends_ci(clean, len, suffix, suffixLen)) return ERROR_INVALID_DATA;
    len -= suffixLen;
    memcpy(out, clean, len * sizeof(WCHAR));
    out[len] = 0;
    *outLen = len;
    return 0;
}

static BOOL CALLBACK resolve_redirect_roots(PINIT_ONCE once, PVOID parameter, PVOID *context) {
    g_rootsError = resolve_root(L"", g_runtimeRoot, &g_runtimeRootLen);
    if (!g_rootsError) g_rootsError = resolve_root(L"\\etc", g_sourceRoot, &g_sourceRootLen);
    if (!g_rootsError && (wide_eq_ci(g_runtimeRoot, g_viewRoot) || wide_eq_ci(g_sourceRoot, g_viewRoot)
                       || wide_eq_ci(g_sourceRoot, g_runtimeRoot))) g_rootsError = ERROR_INVALID_DATA;
    return TRUE; /* A terminal failure also completes the once operation: never retry. */
}

/* Match <root>\usr\bin\<directLeaf> (no subdirectory, no traversal, never \bin\*). */
static const WCHAR *match_root_usr_bin_leaf(const WCHAR *normPath, size_t normLen, const WCHAR *root, size_t rootLen) {
    if (rootLen == 0) return NULL;
    static const WCHAR mid[] = L"\\usr\\bin\\";
    const size_t midLen = 9;
    if (normLen <= rootLen + midLen) return NULL;
    if (!wide_eq_n_ci(normPath, root, rootLen)) return NULL;
    if (!wide_eq_n_ci(normPath + rootLen, mid, midLen)) return NULL;
    const WCHAR *leaf = normPath + rootLen + midLen;
    if (!leaf[0]) return NULL;
    if (leaf[0] == L'.' && (leaf[1] == 0 || (leaf[1] == L'.' && leaf[2] == 0))) return NULL;
    for (const WCHAR *q = leaf; *q; q++) {
        if (*q == L'\\' || *q == L'/') return NULL;
    }
    return leaf;
}

enum { PATH_ERROR = -1, PATH_NO_MATCH = 0, PATH_REWRITE = 1 };

__declspec(noinline) static int try_rewrite_application_path(LPCWSTR lpApplicationName, WCHAR rewritten[MAX_PATH_CHARS]) {
    size_t appLen = 0;
    while (appLen < MAX_PATH_CHARS && lpApplicationName[appLen]) appLen++;
    if (appLen >= MAX_PATH_CHARS) { SetLastError(ERROR_FILENAME_EXCED_RANGE); return PATH_ERROR; }
    if (!appLen) return PATH_NO_MATCH;

    WCHAR norm[MAX_PATH_CHARS];
    BOOL hasTilde = FALSE;
    for (size_t i = 0; i < appLen; i++) {
        WCHAR c = lpApplicationName[i];
        norm[i] = c == L'/' ? L'\\' : c;
        if (c == L'~') hasTilde = TRUE;
    }
    norm[appLen] = 0;

    size_t normLen;
    const WCHAR *path = strip_extended_prefix(norm, &normLen);
    BOOL hadExtPrefix = path != norm;
    const WCHAR *leaf = match_root_usr_bin_leaf(path, normLen, g_sourceRoot, g_sourceRootLen);
    if (!leaf) leaf = match_root_usr_bin_leaf(path, normLen, g_runtimeRoot, g_runtimeRootLen);

    if (!leaf && hasTilde) {
        /* Preserve extended-length semantics. Win32 takes \\?\ for either prefix. */
        if (hadExtPrefix) norm[1] = L'\\';
        DWORD ln = GetLongPathNameW(norm, norm, MAX_PATH_CHARS);
        if (!ln) return PATH_ERROR;
        if (ln >= MAX_PATH_CHARS) { SetLastError(ERROR_FILENAME_EXCED_RANGE); return PATH_ERROR; }
        path = strip_extended_prefix(norm, &normLen);
        leaf = match_root_usr_bin_leaf(path, normLen, g_sourceRoot, g_sourceRootLen);
        if (!leaf) leaf = match_root_usr_bin_leaf(path, normLen, g_runtimeRoot, g_runtimeRootLen);
    }

    if (!leaf) return PATH_NO_MATCH;
    size_t leafLen = wlen(leaf);
    size_t prefixLen = hadExtPrefix ? 4 : 0;
    if (prefixLen + g_viewRootLen + 9 + leafLen + 1 > MAX_PATH_CHARS) {
        SetLastError(ERROR_FILENAME_EXCED_RANGE); return PATH_ERROR;
    }

    size_t pos = 0;
    if (hadExtPrefix) {
        memcpy(rewritten, L"\\\\?\\", 4 * sizeof(WCHAR));
        pos = 4;
    }
    memcpy(rewritten + pos, g_viewRoot, g_viewRootLen * sizeof(WCHAR));
    pos += g_viewRootLen;
    memcpy(rewritten + pos, L"\\usr\\bin\\", 9 * sizeof(WCHAR));
    pos += 9;
    memcpy(rewritten + pos, leaf, (leafLen + 1) * sizeof(WCHAR));

    return PATH_REWRITE;
}

static BOOL WINAPI Hook_CreateProcessW(
    LPCWSTR lpApplicationName,
    LPWSTR lpCommandLine,
    LPSECURITY_ATTRIBUTES lpProcessAttributes,
    LPSECURITY_ATTRIBUTES lpThreadAttributes,
    BOOL bInheritHandles,
    DWORD dwCreationFlags,
    LPVOID lpEnvironment,
    LPCWSTR lpCurrentDirectory,
    LPSTARTUPINFOW lpStartupInfo,
    LPPROCESS_INFORMATION lpProcessInformation
) {
    WCHAR rewritten[MAX_PATH_CHARS];
    if (lpApplicationName) {
        if (!InitOnceExecuteOnce(&g_rootsOnce, resolve_redirect_roots, NULL, NULL)) return FALSE;
        if (g_rootsError) { SetLastError(g_rootsError); return FALSE; }
        int result = try_rewrite_application_path(lpApplicationName, rewritten);
        if (result == PATH_ERROR) return FALSE;
        if (result == PATH_REWRITE) lpApplicationName = rewritten;
    }

    return g_origCreateProcessW(
        lpApplicationName, lpCommandLine, lpProcessAttributes, lpThreadAttributes,
        bInheritHandles, dwCreationFlags, lpEnvironment, lpCurrentDirectory,
        lpStartupInfo, lpProcessInformation
    );
}

/* DllMain initialization helpers (100% Loader-Lock safe)                     */

enum {
    MODE_UNKNOWN = 0,
    MODE_FULL_ACCESS = 1,
    MODE_READ_ONLY = 2,
    MODE_WORKSPACE_WRITE = 3
};

static BOOL parse_decimal_u32(const WCHAR *p, const WCHAR **endOut, DWORD *valOut) {
    if (*p < L'0' || *p > L'9') return FALSE;
    UINT64 v = 0;
    while (*p >= L'0' && *p <= L'9') {
        v = v * 10u + (UINT64)(*p - L'0');
        if (v > 0x3FFFFFFFu) return FALSE;
        p++;
    }
    if (v == 0) return FALSE;
    *endOut = p;
    *valOut = (DWORD)v;
    return TRUE;
}

static BOOL valid_nonce(const WCHAR *p) {
    for (int i = 0; i < 16; i++) {
        if (!((p[i] >= L'0' && p[i] <= L'9') || (p[i] >= L'a' && p[i] <= L'f'))) return FALSE;
    }
    return p[16] == 0;
}

static int parse_view_policy(const WCHAR *viewRoot, size_t viewRootLen, BOOL *hasBoundSid, DWORD *boundSub0, DWORD *boundSub1) {
    *hasBoundSid = FALSE; *boundSub0 = 0; *boundSub1 = 0;
    const WCHAR *leaf = viewRoot + viewRootLen;
    while (leaf > viewRoot && leaf[-1] != L'\\') leaf--;
    if (viewRoot + viewRootLen - leaf < 19 || leaf[2] != L'-') return MODE_UNKNOWN;
    if (leaf[0] == L'f' && leaf[1] == L'a') return valid_nonce(leaf + 3) ? MODE_FULL_ACCESS : MODE_UNKNOWN;
    if (leaf[0] == L'r' && leaf[1] == L'o') return valid_nonce(leaf + 3) ? MODE_READ_ONLY : MODE_UNKNOWN;
    if (leaf[0] != L'w' || leaf[1] != L'w') return MODE_UNKNOWN;
    const WCHAR *p = leaf + 3;
    if (p[0] == L'u' && p[1] == L'-') return valid_nonce(p + 2) ? MODE_WORKSPACE_WRITE : MODE_UNKNOWN;
    if (*p == L'0' || !parse_decimal_u32(p, &p, boundSub0) || *p++ != L'-') return MODE_UNKNOWN;
    if (*p == L'0' || !parse_decimal_u32(p, &p, boundSub1) || *p++ != L'-' || !valid_nonce(p)) return MODE_UNKNOWN;
    *hasBoundSid = TRUE;
    return MODE_WORKSPACE_WRITE;
}

static BOOL inside(const void *buffer, size_t size, const void *pointer, size_t length) {
    ULONG_PTR start = (ULONG_PTR)buffer, p = (ULONG_PTR)pointer;
    return p >= start && p - start <= size && length <= size - (p - start);
}

static BOOL bounded_sid(const void *buffer, size_t size, PSID sid) {
    if (!sid || !inside(buffer, size, sid, 8)) return FALSE;
    const BYTE *p = (const BYTE *)sid;
    return p[0] == 1 && p[1] <= SID_MAX_SUB_AUTHORITIES
        && inside(buffer, size, sid, 8 + (size_t)p[1] * 4) && RtlValidSid(sid);
}

static BOOL bounded_groups(const BYTE *buffer, ULONG capacity, ULONG length) {
    if (length < (ULONG)FIELD_OFFSET(TOKEN_GROUPS, Groups) || length > capacity) return FALSE;
    const TOKEN_GROUPS *groups = (const TOKEN_GROUPS *)buffer;
    size_t head = FIELD_OFFSET(TOKEN_GROUPS, Groups);
    if (groups->GroupCount > (length - head) / sizeof(SID_AND_ATTRIBUTES)) return FALSE;
    head += groups->GroupCount * sizeof(SID_AND_ATTRIBUTES);
    for (DWORD i = 0; i < groups->GroupCount; i++) {
        if (!bounded_sid(buffer + head, length - head, groups->Groups[i].Sid)) return FALSE;
    }
    return TRUE;
}

static PSID checked_logon_sid(BYTE *buffer, ULONG capacity, ULONG length) {
    if (!bounded_groups(buffer, capacity, length)) return NULL;
    TOKEN_GROUPS *groups = (TOKEN_GROUPS *)buffer;
    if (groups->GroupCount != 1 || (groups->Groups[0].Attributes & SE_GROUP_LOGON_ID) != SE_GROUP_LOGON_ID) return NULL;
    return groups->Groups[0].Sid;
}

static BOOL compute_temp_sid_from_env(DSH_SID4 *outSid, BOOL *outEnvPresent) {
    *outEnvPresent = FALSE;
    static WCHAR tempW[MAX_PATH_CHARS];
    SetLastError(ERROR_SUCCESS);
    DWORD len = GetEnvironmentVariableW(L"TEMP", tempW, MAX_PATH_CHARS);
    if (len == 0) {
        if (GetLastError() != ERROR_SUCCESS && GetLastError() != ERROR_ENVVAR_NOT_FOUND) return FALSE;
        SetLastError(ERROR_SUCCESS);
        len = GetEnvironmentVariableW(L"TMP", tempW, MAX_PATH_CHARS);
    }
    if (len == 0) return GetLastError() == ERROR_SUCCESS || GetLastError() == ERROR_ENVVAR_NOT_FOUND;
    if (len >= MAX_PATH_CHARS) return FALSE;
    *outEnvPresent = TRUE;

    static char tempUtf8[MAX_PATH_CHARS * 3];
    int u8Len = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, tempW, (int)len, tempUtf8, (int)sizeof(tempUtf8), NULL, NULL);
    if (u8Len <= 0) return FALSE;

    SHA256_CTX sha;
    UINT8 digest[32];
    static const UINT8 domainSep[5] = { 't','e','m','p',0 };
    sha256_init(&sha);
    sha256_update(&sha, domainSep, sizeof(domainSep));
    sha256_update(&sha, (const UINT8 *)tempUtf8, (size_t)u8Len);
    sha256_final(&sha, digest);

    UINT32 raw0 = ((UINT32)digest[0]) | ((UINT32)digest[1] << 8) | ((UINT32)digest[2] << 16) | ((UINT32)digest[3] << 24);
    UINT32 raw1 = ((UINT32)digest[4]) | ((UINT32)digest[5] << 8) | ((UINT32)digest[6] << 16) | ((UINT32)digest[7] << 24);
    DWORD first  = (DWORD)((raw0 % 0x3FFFFFFFu) + 1u);
    DWORD second = (DWORD)((raw1 % 0x3FFFFFFFu) + 1u);
    build_temp_sid(outSid, first, second);
    return TRUE;
}

static BOOL verify_token_and_policy(int expectedMode, BOOL hasBoundSid, DWORD boundSub0, DWORD boundSub1) {
    HANDLE hToken = NULL;
    if (!NT_SUCCESS(NtOpenProcessToken(NT_CURRENT_PROCESS, TOKEN_QUERY, &hToken)) || !hToken) {
        return FALSE;
    }

    BOOL ok = FALSE;
    __declspec(align(8)) static BYTE restrictedBuf[2048];
    DSH_SID4 boundSid, envSid;
    ULONG retLen = 0;
    if (!NT_SUCCESS(NtQueryInformationToken(hToken, TokenRestrictedSids, restrictedBuf, sizeof(restrictedBuf), &retLen))) {
        goto done;
    }
    if (!bounded_groups(restrictedBuf, sizeof(restrictedBuf), retLen)) goto done;
    const TOKEN_GROUPS *restricted = (const TOKEN_GROUPS *)restrictedBuf;
    BOOL isRestricted = (restricted->GroupCount > 0);

    if (expectedMode == MODE_FULL_ACCESS) {
        if (isRestricted) goto done;
        g_grantSidLen = 0;
        ok = TRUE;
        goto done;
    }

    /* Confined modes (read-only / workspace-write) require a restricted Low-IL token. */
    if (!isRestricted) goto done;

    __declspec(align(8)) static BYTE userBuf[256], logonBuf[96], ilBuf[256], daclBuf[4096];
    if (!NT_SUCCESS(NtQueryInformationToken(hToken, TokenUser, userBuf, sizeof(userBuf), &retLen))
     || retLen < sizeof(TOKEN_USER) || retLen > sizeof(userBuf)) goto done;
    PSID userSid = ((const TOKEN_USER *)userBuf)->User.Sid;
    if (!bounded_sid(userBuf + sizeof(TOKEN_USER), retLen - sizeof(TOKEN_USER), userSid)) goto done;
    if (!NT_SUCCESS(NtQueryInformationToken(hToken, TokenLogonSid, logonBuf, sizeof(logonBuf), &retLen))) goto done;
    PSID logonSid = checked_logon_sid(logonBuf, sizeof(logonBuf), retLen);
    if (!logonSid) goto done;
    if (!NT_SUCCESS(NtQueryInformationToken(hToken, TokenIntegrityLevel, ilBuf, sizeof(ilBuf), &retLen))
     || retLen < sizeof(TOKEN_MANDATORY_LABEL) || retLen > sizeof(ilBuf)) goto done;
    PSID ilSid = ((const TOKEN_MANDATORY_LABEL *)ilBuf)->Label.Sid;
    if (!bounded_sid(ilBuf + sizeof(TOKEN_MANDATORY_LABEL), retLen - sizeof(TOKEN_MANDATORY_LABEL), ilSid)) goto done;
    if (!NT_SUCCESS(NtQueryInformationToken(hToken, TokenDefaultDacl, daclBuf, sizeof(daclBuf), &retLen))
     || retLen < sizeof(TOKEN_DEFAULT_DACL) || retLen > sizeof(daclBuf)) goto done;
    PACL defaultDacl = ((const TOKEN_DEFAULT_DACL *)daclBuf)->DefaultDacl;
    if (!defaultDacl || !inside(daclBuf + sizeof(TOKEN_DEFAULT_DACL), retLen - sizeof(TOKEN_DEFAULT_DACL), defaultDacl, sizeof(ACL))
     || defaultDacl->AclSize < sizeof(ACL) || !inside(daclBuf, retLen, defaultDacl, defaultDacl->AclSize)) goto done;

    /* Require exact Low integrity S-1-16-4096. */
    DSH_SID4 lowIlSid, authUsersSid;
    build_sid1(&lowIlSid, 16, 0x1000u);
    build_sid1(&authUsersSid, 5, 11u);
    if (!RtlEqualSid(ilSid, &lowIlSid)) goto done;

    /* Enforce exact DSH restricting-SID invariants. */
    if (!sid_list_contains(restricted, logonSid)) goto done;
    if (sid_list_contains(restricted, userSid)) goto done;
    if (sid_list_contains(restricted, &authUsersSid)) goto done;

    DWORD capCount = 0;
    DWORD tempShapeCount = 0;
    PSID onlyTempShapeSid = NULL;
    for (DWORD i = 0; i < restricted->GroupCount; i++) {
        PSID s = restricted->Groups[i].Sid;
        if (sid_is_authority(s, 4)) {
            capCount++;
            if (sid_is_temp_capability(s)) {
                tempShapeCount++;
                onlyTempShapeSid = s;
            }
        }
    }

    PSID chosenGrant = NULL;
    if (expectedMode == MODE_READ_ONLY) {
        if (capCount != 0) goto done;
        chosenGrant = logonSid;
    } else if (expectedMode == MODE_WORKSPACE_WRITE) {
        if (capCount == 0 || tempShapeCount == 0) goto done;

        if (hasBoundSid) {
            build_temp_sid(&boundSid, boundSub0, boundSub1);
            if (!sid_list_contains(restricted, &boundSid)) goto done;
        }

        BOOL envPresent = FALSE;
        if (!compute_temp_sid_from_env(&envSid, &envPresent)) goto done;

        if (envPresent) {
            if (!sid_list_contains(restricted, &envSid)) goto done;
            if (hasBoundSid && !RtlEqualSid(&envSid, &boundSid)) goto done;
            chosenGrant = &envSid;
        } else {
            /* env -i path: TEMP/TMP absent. Require view-bound SID or unique temp SID backed by TokenDefaultDacl. */
            if (hasBoundSid) {
                if (!dacl_has_exact_allow_ace(defaultDacl, &boundSid, TRUE)) goto done;
                chosenGrant = &boundSid;
            } else {
                if (tempShapeCount != 1 || !onlyTempShapeSid) goto done;
                if (!dacl_has_exact_allow_ace(defaultDacl, onlyTempShapeSid, TRUE)) goto done;
                chosenGrant = onlyTempShapeSid;
            }
        }
    } else {
        goto done;
    }

    ULONG sidLen = RtlLengthSid(chosenGrant);
    if (sidLen == 0 || sidLen > sizeof(g_grantSid)) goto done;
    if (!NT_SUCCESS(RtlCopySid(sizeof(g_grantSid), g_grantSid, chosenGrant))) goto done;
    g_grantSidLen = sidLen;
    ok = TRUE;

done:
    if (!NT_SUCCESS(NtClose(hToken))) return FALSE;
    return ok;
}

static BOOL copy_loader_path(const UNICODE_STRING *name, WCHAR out[MAX_PATH_CHARS]) {
    if (!name->Buffer || !name->Length || name->Length % sizeof(WCHAR)
     || name->Length > name->MaximumLength || name->Length / sizeof(WCHAR) >= MAX_PATH_CHARS) return FALSE;
    size_t count = name->Length / sizeof(WCHAR);
    for (size_t i = 0; i < count; i++) { if (!name->Buffer[i]) return FALSE; out[i] = name->Buffer[i]; }
    out[count] = 0;
    return TRUE;
}

static BOOL is_msys_basename(const UNICODE_STRING *name) {
    return name->Buffer && name->Length == sizeof(L"msys-2.0.dll") - sizeof(WCHAR)
        && name->MaximumLength >= name->Length && wide_eq_n_ci(name->Buffer, L"msys-2.0.dll", 12);
}

static BOOL resolve_and_verify_sibling_msys(HMODULE hSelf) {
    PEB *peb = (PEB *)__readgsqword(0x60);
    if (!peb || !peb->Ldr) return FALSE;

    LIST_ENTRY *head = &peb->Ldr->InMemoryOrderModuleList;
    const WCHAR *selfClean = NULL;
    static WCHAR raw[MAX_PATH_CHARS];
    static WCHAR expectedMsys[MAX_PATH_CHARS];
    static WCHAR msysNtPath[MAX_PATH_CHARS];
    static BYTE mapNameBuf[2048];
    size_t selfCleanLen = 0;

    for (LIST_ENTRY *cur = head->Flink; cur && cur != head; cur = cur->Flink) {
        DSH_LDR_ENTRY *ent = CONTAINING_RECORD(cur, DSH_LDR_ENTRY, InMemoryOrderLinks);
        if (ent->DllBase == hSelf) {
            if (!copy_loader_path(&ent->FullDllName, raw)) return FALSE;
            selfClean = strip_extended_prefix(raw, &selfCleanLen);
            break;
        }
    }
    if (!selfClean) return FALSE;

    static const WCHAR suffix[] = L"\\usr\\bin\\dsh-msys-compat.dll";
    const size_t suffixLen = 28;
    if (!wide_ends_ci(selfClean, selfCleanLen, suffix, suffixLen)) return FALSE;

    g_viewRootLen = selfCleanLen - suffixLen;
    if (g_viewRootLen < 3 || g_viewRootLen + 32 >= MAX_PATH_CHARS) return FALSE;
    memcpy(g_viewRoot, selfClean, g_viewRootLen * sizeof(WCHAR));
    g_viewRoot[g_viewRootLen] = 0;

    /* Expected exact sibling msys-2.0.dll path (without \\?\). */
    memcpy(expectedMsys, g_viewRoot, g_viewRootLen * sizeof(WCHAR));
    memcpy(expectedMsys + g_viewRootLen, L"\\usr\\bin\\msys-2.0.dll", 22 * sizeof(WCHAR));

    /* Build \\?\ and \??\ forms and compute MSYS2's exact installation_key. */
    memcpy(g_msysDosPath, L"\\\\?\\", 4 * sizeof(WCHAR));
    memcpy(g_msysDosPath + 4, expectedMsys, (g_viewRootLen + 22) * sizeof(WCHAR));
    g_msysDosPathLen = 4 + g_viewRootLen + 21;

    memcpy(msysNtPath, L"\\??\\", 4 * sizeof(WCHAR));
    memcpy(msysNtPath + 4, expectedMsys, (g_viewRootLen + 22) * sizeof(WCHAR));
    format_hex64_lower(cygwin_hash_path_name(msysNtPath), g_expectedKeyHexA, g_expectedKeyHexW);

    /* Walk PEB->Ldr: locate exact sibling msys-2.0.dll and reject any foreign msys-2.0.dll. */
    HMODULE foundMsys = NULL;
    for (LIST_ENTRY *cur = head->Flink; cur && cur != head; cur = cur->Flink) {
        DSH_LDR_ENTRY *ent = CONTAINING_RECORD(cur, DSH_LDR_ENTRY, InMemoryOrderLinks);
        if (!is_msys_basename(&ent->BaseDllName)) continue;
        if (!ent->DllBase || !copy_loader_path(&ent->FullDllName, raw)) return FALSE;
        size_t cleanLen;
        const WCHAR *clean = strip_extended_prefix(raw, &cleanLen);
        if (!wide_eq_ci(clean, expectedMsys) || foundMsys) return FALSE;
        foundMsys = (HMODULE)ent->DllBase;
        g_msysImageSize = ent->SizeOfImage;
    }

    if (!foundMsys) return FALSE;

    /* Capture on-disk identity of expected sibling msys-2.0.dll. */
    HANDLE hDisk = CreateFileW(g_msysDosPath, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                               NULL, OPEN_EXISTING, 0, NULL);
    if (hDisk == INVALID_HANDLE_VALUE) return FALSE;
    BY_HANDLE_FILE_INFORMATION diskInfo;
    BOOL gotDisk = GetFileInformationByHandle(hDisk, &diskInfo);
    if (!CloseHandle(hDisk) || !gotDisk) return FALSE;

    /* Independently verify the actually mapped image section's file identity matches on-disk sibling. */
    SIZE_T mapRet = 0;
    if (!NT_SUCCESS(NtQueryVirtualMemory(NT_CURRENT_PROCESS, foundMsys, MEMORY_MAPPED_FILENAME_INFORMATION,
                                         mapNameBuf, sizeof(mapNameBuf), &mapRet))) {
        return FALSE;
    }
    if (mapRet < sizeof(UNICODE_STRING) || mapRet > sizeof(mapNameBuf)) return FALSE;
    UNICODE_STRING *mappedUs = (UNICODE_STRING *)mapNameBuf;
    if (!mappedUs->Buffer || !mappedUs->Length || mappedUs->Length % sizeof(WCHAR)
     || mappedUs->Length > mappedUs->MaximumLength
     || !inside(mapNameBuf + sizeof(UNICODE_STRING), mapRet - sizeof(UNICODE_STRING), mappedUs->Buffer, mappedUs->Length)) return FALSE;
    OBJECT_ATTRIBUTES oa;
    InitializeObjectAttributes(&oa, mappedUs, OBJ_CASE_INSENSITIVE, NULL, NULL);
    IO_STATUS_BLOCK iosb;
    HANDLE hMapped = NULL;
    if (!NT_SUCCESS(NtOpenFile(&hMapped, FILE_READ_ATTRIBUTES, &oa, &iosb,
                               FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, 0)) || !hMapped) {
        return FALSE;
    }
    BY_HANDLE_FILE_INFORMATION mappedInfo;
    BOOL gotMapped = GetFileInformationByHandle(hMapped, &mappedInfo);
    if (!NT_SUCCESS(NtClose(hMapped)) || !gotMapped) return FALSE;

    if (mappedInfo.dwVolumeSerialNumber != diskInfo.dwVolumeSerialNumber
     || mappedInfo.nFileIndexHigh != diskInfo.nFileIndexHigh
     || mappedInfo.nFileIndexLow != diskInfo.nFileIndexLow) {
        return FALSE;
    }

    g_msysVolSerial = diskInfo.dwVolumeSerialNumber;
    g_msysFileIdxHigh = diskInfo.nFileIndexHigh;
    g_msysFileIdxLow = diskInfo.nFileIndexLow;
    g_hMsys = foundMsys;
    return TRUE;
}

static BOOL patch_iat_slot(void **slot, void *replacement, void **originalOut) {
    PVOID pageBase = (PVOID)slot;
    SIZE_T regionSize = sizeof(void *);
    ULONG oldProt = 0;
    if (!NT_SUCCESS(NtProtectVirtualMemory(NT_CURRENT_PROCESS, &pageBase, &regionSize, PAGE_READWRITE, &oldProt))) {
        return FALSE;
    }
    if (oldProt != PAGE_READONLY) {
        ULONG ignored;
        NtProtectVirtualMemory(NT_CURRENT_PROCESS, &pageBase, &regionSize, oldProt, &ignored);
        return FALSE;
    }
    *originalOut = *slot;
    *slot = replacement;
    ULONG dummy = 0;
    return NT_SUCCESS(NtProtectVirtualMemory(NT_CURRENT_PROCESS, &pageBase, &regionSize, oldProt, &dummy));
}

static void *image_at(ULONG_PTR rva, size_t length) {
    if (rva > g_msysImageSize || length > g_msysImageSize - rva) return NULL;
    return (BYTE *)g_hMsys + rva;
}

static const char *image_string(ULONG_PTR rva) {
    const char *p = (const char *)image_at(rva, 1);
    if (!p) return NULL;
    for (size_t i = 0; i < g_msysImageSize - rva; i++) if (!p[i]) return p;
    return NULL;
}

static BOOL install_msys_iat_hooks(void) {
    PIMAGE_DOS_HEADER dos = (PIMAGE_DOS_HEADER)image_at(0, sizeof(IMAGE_DOS_HEADER));
    if (!dos || dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew < 0) return FALSE;
    PIMAGE_NT_HEADERS64 nt = (PIMAGE_NT_HEADERS64)image_at((ULONG)dos->e_lfanew, sizeof(IMAGE_NT_HEADERS64));
    if (!nt || nt->Signature != IMAGE_NT_SIGNATURE || nt->FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64
     || nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC
     || nt->OptionalHeader.SizeOfImage != g_msysImageSize || nt->OptionalHeader.NumberOfRvaAndSizes <= IMAGE_DIRECTORY_ENTRY_IMPORT) return FALSE;
    IMAGE_DATA_DIRECTORY imp = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!imp.VirtualAddress || imp.Size < sizeof(IMAGE_IMPORT_DESCRIPTOR) || !image_at(imp.VirtualAddress, imp.Size)) return FALSE;
    void **slots[5] = { NULL, NULL, NULL, NULL, NULL };
    const char *names[5] = { "GetFinalPathNameByHandleW", "CreateNamedPipeA", "CreateProcessW", "NtSetInformationToken", "NtCreateSection" };
    BOOL terminated = FALSE;
    for (ULONG off = 0; off <= imp.Size - sizeof(IMAGE_IMPORT_DESCRIPTOR); off += sizeof(IMAGE_IMPORT_DESCRIPTOR)) {
        PIMAGE_IMPORT_DESCRIPTOR d = (PIMAGE_IMPORT_DESCRIPTOR)image_at((ULONG_PTR)imp.VirtualAddress + off, sizeof(*d));
        if (!d->Name && !d->OriginalFirstThunk && !d->FirstThunk && !d->TimeDateStamp && !d->ForwarderChain) { terminated = TRUE; break; }
        const char *dll = image_string(d->Name);
        if (!dll || !d->OriginalFirstThunk || !d->FirstThunk) return FALSE;
        BOOL kernel = ascii_eq_ci(dll, "kernel32.dll"), native = ascii_eq_ci(dll, "ntdll.dll");
        for (ULONG_PTR i = 0; ; i += sizeof(ULONG_PTR)) {
            ULONG_PTR *ilt = (ULONG_PTR *)image_at((ULONG_PTR)d->OriginalFirstThunk + i, sizeof(ULONG_PTR));
            void **iat = (void **)image_at((ULONG_PTR)d->FirstThunk + i, sizeof(void *));
            if (!ilt || !iat) return FALSE;
            if (!*ilt) break;
            if (IMAGE_SNAP_BY_ORDINAL64(*ilt)) continue;
            if (*ilt > MAXDWORD - 2) return FALSE;
            const char *fn = image_string(*ilt + 2);
            if (!fn) return FALSE;
            for (int n = 0; n < 5; n++) if ((n < 3 ? kernel : native) && ascii_eq(fn, names[n])) {
                if (slots[n]) return FALSE;
                slots[n] = iat;
            }
        }
    }
    if (!terminated) return FALSE;
    for (int n = 0; n < 5; n++) if (!slots[n]) return FALSE;
    return patch_iat_slot(slots[0], (void *)Hook_GetFinalPathNameByHandleW, (void **)&g_origGetFinalPathNameByHandleW)
        && patch_iat_slot(slots[1], (void *)Hook_CreateNamedPipeA, (void **)&g_origCreateNamedPipeA)
        && patch_iat_slot(slots[2], (void *)Hook_CreateProcessW, (void **)&g_origCreateProcessW)
        && patch_iat_slot(slots[3], (void *)Hook_NtSetInformationToken, (void **)&g_origNtSetInformationToken)
        && patch_iat_slot(slots[4], (void *)Hook_NtCreateSection, (void **)&g_origNtCreateSection);
}

/* Exported anchor symbol & DllMain entry point                               */

__declspec(dllexport) void dsh_msys_compat_anchor(void) {}

BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpvReserved) {
    if (fdwReason == DLL_PROCESS_ATTACH) {
        /* DSH's private MSYS imports the shim at process startup. */
        if (!lpvReserved || !DisableThreadLibraryCalls(hinstDLL)) return FALSE;
        if (!resolve_and_verify_sibling_msys(hinstDLL)) return FALSE;

        BOOL hasBoundSid = FALSE;
        DWORD boundSub0 = 0, boundSub1 = 0;
        int mode = parse_view_policy(g_viewRoot, g_viewRootLen, &hasBoundSid, &boundSub0, &boundSub1);
        if (mode == MODE_UNKNOWN) return FALSE;

        if (!verify_token_and_policy(mode, hasBoundSid, boundSub0, boundSub1)) return FALSE;

        if (!install_msys_iat_hooks()) return FALSE;
    }
    return TRUE;
}
