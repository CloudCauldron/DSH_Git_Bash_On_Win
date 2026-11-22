/** Bounded x64 PE reader shared by the fixed MSYS patch and build-time verification. */
export interface PeSection {
    name: string;
    header: number;
    va: number;
    virtualSize: number;
    raw: number;
    rawSize: number;
    characteristics: number;
}
export interface PeImport {
    dll: string;
    symbols: string[];
    descriptor: number;
    iat: number;
}
export declare function readPe(bytes: Buffer): {
    bytes: Buffer<ArrayBufferLike>;
    coff: number;
    optional: number;
    directories: number;
    sectionTable: number;
    sections: PeSection[];
    imports: PeImport[];
    directory: (index: number) => {
        rva: number;
        size: number;
    };
    offset: (rva: number, length?: number) => number;
    string: (rva: number) => string;
    sectionAlignment: number;
    fileAlignment: number;
    sizeOfHeaders: number;
    sizeOfImage: number;
    dllCharacteristics: number;
    exports: {
        rva: number;
        size: number;
    };
};
/** Append one fixed static import without moving existing sections or normalizing debug accounting. */
export declare function patchMsysDll(input: Buffer): Buffer;
