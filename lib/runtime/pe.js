function requirePe(condition, message) {
    if (!condition)
        throw new Error(`Unsupported PE image: ${message}`);
}
function uint32(value) {
    requirePe(Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff, '32-bit size overflow');
    return value;
}
function align(value, alignment) { return uint32(Math.ceil(value / alignment) * alignment); }
export function readPe(bytes) {
    const range = (offset, length) => {
        requirePe(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(length)
            && length >= 0 && offset <= bytes.length - length, 'truncated file');
        return offset;
    };
    range(0, 64);
    requirePe(bytes.readUInt16LE(0) === 0x5a4d, 'missing DOS signature');
    const nt = range(bytes.readUInt32LE(0x3c), 24), coff = nt + 4, optional = nt + 24;
    requirePe(nt >= 64 && nt % 8 === 0, 'invalid NT header offset');
    requirePe(bytes.readUInt32LE(nt) === 0x4550, 'missing NT signature');
    requirePe(bytes.readUInt16LE(coff) === 0x8664 && (bytes.readUInt16LE(coff + 18) & 0x2000), 'expected AMD64 DLL');
    const count = bytes.readUInt16LE(coff + 2), optionalSize = bytes.readUInt16LE(coff + 16);
    requirePe(count > 0 && count <= 96 && optionalSize >= 112, 'header sizes');
    range(optional, optionalSize);
    requirePe(bytes.readUInt16LE(optional) === 0x20b, 'expected PE32+');
    const directories = optional + 112, directoryCount = bytes.readUInt32LE(optional + 108);
    requirePe(directoryCount >= 13 && directoryCount <= 16 && optionalSize >= 112 + directoryCount * 8, 'directory count');
    const directory = (index) => index < directoryCount
        ? { rva: bytes.readUInt32LE(directories + index * 8), size: bytes.readUInt32LE(directories + index * 8 + 4) }
        : { rva: 0, size: 0 };
    const sectionAlignment = bytes.readUInt32LE(optional + 32), fileAlignment = bytes.readUInt32LE(optional + 36);
    const powerOfTwo = (n) => n > 0 && (n & (n - 1)) === 0;
    requirePe(powerOfTwo(fileAlignment) && fileAlignment >= 512 && fileAlignment <= 65536
        && powerOfTwo(sectionAlignment) && sectionAlignment >= fileAlignment, 'alignments');
    const sizeOfImage = bytes.readUInt32LE(optional + 56), sizeOfHeaders = bytes.readUInt32LE(optional + 60);
    const sectionTable = range(optional + optionalSize, count * 40);
    requirePe(sectionTable + count * 40 <= sizeOfHeaders && sizeOfHeaders <= bytes.length, 'SizeOfHeaders');
    const sections = [];
    let virtualEnd = align(sizeOfHeaders, sectionAlignment);
    for (let i = 0; i < count; i++) {
        const header = sectionTable + i * 40;
        const section = { header, name: bytes.subarray(header, header + 8).toString('ascii').replace(/\0.*$/, ''),
            virtualSize: bytes.readUInt32LE(header + 8), va: bytes.readUInt32LE(header + 12),
            rawSize: bytes.readUInt32LE(header + 16), raw: bytes.readUInt32LE(header + 20),
            characteristics: bytes.readUInt32LE(header + 36) };
        const span = align(Math.max(section.virtualSize, section.rawSize), sectionAlignment);
        requirePe(span > 0, 'empty section');
        requirePe(section.va === virtualEnd, 'virtual sections must be adjacent and ordered');
        virtualEnd = uint32(section.va + span);
        if (section.rawSize) {
            requirePe(section.raw >= sizeOfHeaders && section.raw % fileAlignment === 0
                && section.rawSize % fileAlignment === 0, 'section raw range');
            range(section.raw, section.rawSize);
        }
        for (const prior of sections) {
            requirePe(!section.rawSize || !prior.rawSize || section.raw >= prior.raw + prior.rawSize
                || prior.raw >= section.raw + section.rawSize, 'overlapping raw sections');
        }
        sections.push(section);
    }
    requirePe(virtualEnd === sizeOfImage, 'SizeOfImage must cover exactly the mapped sections');
    const sectionAt = (rva, length) => {
        uint32(rva + length);
        const s = sections.find(s => rva >= s.va && rva - s.va <= s.rawSize - length);
        requirePe(s && length >= 0, 'unmapped RVA or uninitialized section tail');
        return s;
    };
    const offset = (rva, length = 1) => { const s = sectionAt(rva, length); return s.raw + rva - s.va; };
    const string = (rva) => {
        const s = sectionAt(rva, 1), start = s.raw + rva - s.va;
        const data = bytes.subarray(start, s.raw + s.rawSize);
        const end = data.indexOf(0);
        requirePe(end > 0, 'empty or unterminated name');
        requirePe(data.subarray(0, end).every(x => x >= 0x20 && x < 0x7f), 'non-ASCII import/export name');
        return data.toString('ascii', 0, end);
    };
    const imports = [], imp = directory(1);
    if (imp.rva || imp.size) {
        requirePe(imp.rva && imp.size >= 20, 'import directory');
        const start = offset(imp.rva, imp.size);
        const tables = [];
        let terminated = false;
        for (let d = start; d + 20 <= start + imp.size; d += 20) {
            if (bytes.subarray(d, d + 20).every(x => x === 0)) {
                terminated = true;
                break;
            }
            const ilt = bytes.readUInt32LE(d), iat = bytes.readUInt32LE(d + 16), name = bytes.readUInt32LE(d + 12);
            requirePe(iat && name, 'incomplete import descriptor');
            const symbols = [], table = ilt || iat;
            for (let i = 0;; i++) {
                const item = bytes.readBigUInt64LE(offset(table + i * 8, 8));
                const target = offset(iat + i * 8, 8);
                requirePe((item === 0n) === (bytes.readBigUInt64LE(target) === 0n), 'import tables terminate at different entries');
                if (!item)
                    break;
                if (item & 0x8000000000000000n) {
                    requirePe((item & 0x7fffffffffff0000n) === 0n, 'invalid ordinal thunk');
                    symbols.push(`#${item & 0xffffn}`);
                }
                else {
                    requirePe(item <= 0xffffffffn, 'import RVA overflow');
                    offset(Number(item), 3);
                    symbols.push(string(Number(item) + 2));
                }
            }
            const length = (symbols.length + 1) * 8;
            for (const rva of ilt ? [ilt, iat] : [iat]) {
                offset(rva, length);
                tables.push({ start: rva, end: rva + length });
            }
            imports.push({ dll: string(name).toLowerCase(), symbols, descriptor: d, iat });
        }
        requirePe(terminated, 'unterminated descriptors');
        tables.sort((a, b) => a.start - b.start);
        for (let i = 1; i < tables.length; i++)
            requirePe(tables[i - 1].end <= tables[i].start, 'overlapping import thunks');
    }
    return { coff, optional, directories, sectionTable, sections, imports, directory, offset, string,
        sectionAlignment, fileAlignment, sizeOfHeaders, sizeOfImage,
        dllCharacteristics: bytes.readUInt16LE(optional + 70), exports: directory(0) };
}
function peChecksum(bytes, checksumOffset) {
    let sum = 0;
    for (let i = 0; i < bytes.length; i += 2) {
        if (i === checksumOffset || i === checksumOffset + 2)
            continue;
        sum += i + 1 < bytes.length ? bytes.readUInt16LE(i) : bytes[i];
        sum = (sum & 0xffff) + (sum >>> 16);
    }
    return ((sum & 0xffff) + (sum >>> 16) + bytes.length) >>> 0;
}
/** Append one fixed static import without moving existing sections or normalizing debug accounting. */
export function patchMsysDll(input) {
    const pe = readPe(input), { sections, imports, coff, optional, directories } = pe;
    requirePe(sections.length < 96, 'section count limit');
    requirePe(pe.sectionAlignment >= 4096, 'IAT protections require page-aligned sections');
    for (const { descriptor } of imports) {
        requirePe(input.readUInt32LE(descriptor) !== 0, 'missing import lookup table');
        requirePe(input.readUInt32LE(descriptor + 4) === 0 && input.readUInt32LE(descriptor + 8) === 0, 'bound import descriptor');
    }
    for (const s of sections)
        requirePe(input.subarray(s.header + 24, s.header + 36).every(x => x === 0), 'unsupported section relocation/line table');
    const security = pe.directory(4);
    requirePe(!security.rva && !security.size, 'signed image');
    requirePe(!sections.some(s => s.name === '.dshimp') && !imports.some(i => i.dll === 'dsh-msys-compat.dll'), 'already patched');
    for (const [dll, names] of Object.entries({ 'kernel32.dll': ['GetFinalPathNameByHandleW', 'CreateNamedPipeA', 'CreateProcessW'],
        'ntdll.dll': ['NtSetInformationToken', 'NtCreateSection'] })) {
        for (const name of names)
            requirePe(imports.filter(i => i.dll === dll).flatMap(i => i.symbols).filter(n => n === name).length === 1, `expected one ${dll}!${name}`);
    }
    const header = pe.sectionTable + sections.length * 40;
    const firstRaw = Math.min(...sections.filter(s => s.rawSize).map(s => s.raw));
    requirePe(header + 40 <= Math.min(firstRaw, pe.sizeOfHeaders), 'no section header room');
    requirePe(input.subarray(header, header + 40).every(x => x === 0), 'nonzero section header padding');
    const insert = Math.max(...sections.filter(s => s.rawSize).map(s => s.raw + s.rawSize));
    const symbols = input.readUInt32LE(coff + 8), symbolCount = input.readUInt32LE(coff + 12);
    if (symbols) {
        requirePe(symbols === insert && symbols + symbolCount * 18 + 4 <= input.length, 'unsupported COFF tail');
        const strings = symbols + symbolCount * 18, length = input.readUInt32LE(strings);
        requirePe(length >= 4 && strings + length === input.length, 'unsupported string table/overlay');
        for (const s of sections)
            if (/^\/\d+$/.test(s.name)) {
                const index = Number(s.name.slice(1));
                requirePe(index >= 4 && index < length, 'COFF section name');
                const end = input.indexOf(0, strings + index);
                requirePe(end >= strings + index && end < input.length, 'unterminated COFF section name');
            }
    }
    else
        requirePe(!symbolCount && insert === input.length, 'unsupported overlay');
    const debug = pe.directory(6);
    if (debug.rva || debug.size) {
        requirePe(debug.rva && debug.size && debug.size % 28 === 0, 'debug directory');
        const start = pe.offset(debug.rva, debug.size);
        for (let d = start; d < start + debug.size; d += 28) {
            const size = input.readUInt32LE(d + 16), rva = input.readUInt32LE(d + 20), raw = input.readUInt32LE(d + 24);
            requirePe(!size || (rva && raw && raw + size <= insert && pe.offset(rva, size) === raw), 'unsupported debug relocation');
        }
    }
    const va = pe.sizeOfImage, descriptorSize = (imports.length + 2) * 20;
    const ilt = align(descriptorSize, 8), iat = ilt + 16, dll = iat + 16;
    const dllBytes = Buffer.from('dsh-msys-compat.dll\0'), anchor = Buffer.from('dsh_msys_compat_anchor\0');
    const hint = align(dll + dllBytes.length, 2), virtualSize = hint + 2 + anchor.length;
    const rawSize = align(virtualSize, pe.fileAlignment), payload = Buffer.alloc(rawSize);
    for (const [i, entry] of imports.entries())
        input.copy(payload, i * 20, entry.descriptor, entry.descriptor + 20);
    const d = imports.length * 20;
    payload.writeUInt32LE(uint32(va + ilt), d);
    payload.writeUInt32LE(uint32(va + dll), d + 12);
    payload.writeUInt32LE(uint32(va + iat), d + 16);
    payload.writeBigUInt64LE(BigInt(uint32(va + hint)), ilt);
    payload.writeBigUInt64LE(BigInt(va + hint), iat);
    dllBytes.copy(payload, dll);
    anchor.copy(payload, hint + 2);
    const iatStart = imports.reduce((start, entry) => Math.min(start, entry.iat), va + iat);
    const iatEnd = va + iat + 16;
    for (const s of sections)
        if (s.va < iatEnd && s.va + align(Math.max(s.virtualSize, s.rawSize), pe.sectionAlignment) > iatStart) {
            requirePe((s.characteristics & 0xe0000000) >>> 0 === 0x40000000, 'IAT span must be readable, nonwritable and nonexecutable');
        }
    const output = Buffer.concat([input.subarray(0, insert), payload, input.subarray(insert)]);
    output.write('.dshimp\0', header, 'ascii');
    output.writeUInt32LE(virtualSize, header + 8);
    output.writeUInt32LE(va, header + 12);
    output.writeUInt32LE(rawSize, header + 16);
    output.writeUInt32LE(insert, header + 20);
    output.writeUInt32LE(0x40000040, header + 36);
    output.writeUInt16LE(sections.length + 1, coff + 2);
    if (symbols)
        output.writeUInt32LE(uint32(symbols + rawSize), coff + 8);
    output.writeUInt32LE(uint32(input.readUInt32LE(optional + 8) + rawSize), optional + 8);
    output.writeUInt32LE(align(va + virtualSize, pe.sectionAlignment), optional + 56);
    output.writeUInt32LE(va, directories + 8);
    output.writeUInt32LE(descriptorSize, directories + 12);
    output.fill(0, directories + 11 * 8, directories + 12 * 8);
    output.writeUInt32LE(iatStart, directories + 12 * 8);
    output.writeUInt32LE(iatEnd - iatStart, directories + 12 * 8 + 4);
    output.writeUInt32LE(peChecksum(output, optional + 64), optional + 64);
    readPe(output);
    return output;
}
