export function inspectExecutableBinary(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64) throw new Error("Executable binary is too small to contain a valid header.");

  if (bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const peOffset = bytes.readUInt32LE(0x3c);
    if (peOffset < 0x40 || peOffset > bytes.length - 24 || bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") throw new Error("Invalid PE signature.");
    const sectionCount = bytes.readUInt16LE(peOffset + 6);
    const optionalHeaderSize = bytes.readUInt16LE(peOffset + 20);
    const optionalHeaderOffset = peOffset + 24;
    if (sectionCount < 1 || optionalHeaderSize < 112 || optionalHeaderOffset + optionalHeaderSize > bytes.length) throw new Error("Invalid PE COFF or optional header.");
    if (![0x10b, 0x20b].includes(bytes.readUInt16LE(optionalHeaderOffset))) throw new Error("Invalid PE optional header magic.");
    if (optionalHeaderOffset + optionalHeaderSize + sectionCount * 40 > bytes.length) throw new Error("Invalid PE section table.");
    return { format: "pe", machine: bytes.readUInt16LE(peOffset + 4) };
  }

  if (bytes[0] === 0x7f && bytes.toString("ascii", 1, 4) === "ELF") {
    if (bytes[4] !== 2 || bytes[6] !== 1) throw new Error("BrainPet requires a current 64-bit ELF executable.");
    const littleEndian = bytes[5] === 1;
    if (!littleEndian && bytes[5] !== 2) throw new Error("Unsupported ELF byte order.");
    const read16 = littleEndian ? Buffer.prototype.readUInt16LE : Buffer.prototype.readUInt16BE;
    const read32 = littleEndian ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE;
    const read64 = littleEndian ? Buffer.prototype.readBigUInt64LE : Buffer.prototype.readBigUInt64BE;
    const fileType = read16.call(bytes, 16);
    const programHeaderOffset = Number(read64.call(bytes, 32));
    const headerSize = read16.call(bytes, 52);
    const programHeaderEntrySize = read16.call(bytes, 54);
    const programHeaderCount = read16.call(bytes, 56);
    if (![2, 3].includes(fileType) || read32.call(bytes, 20) !== 1 || headerSize < 64) throw new Error("Invalid ELF executable header.");
    if (programHeaderOffset < headerSize || programHeaderEntrySize < 56 || programHeaderCount < 1 || !Number.isSafeInteger(programHeaderOffset) || programHeaderOffset + programHeaderEntrySize * programHeaderCount > bytes.length) throw new Error("Invalid ELF program header table.");
    return { format: "elf", machine: read16.call(bytes, 18) };
  }

  const littleEndianMachO = bytes.readUInt32LE(0) === 0xfeedfacf;
  const bigEndianMachO = bytes.readUInt32BE(0) === 0xfeedfacf;
  if (littleEndianMachO || bigEndianMachO) {
    const read32 = littleEndianMachO ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE;
    const machine = read32.call(bytes, 4);
    const fileType = read32.call(bytes, 12);
    const loadCommandCount = read32.call(bytes, 16);
    const loadCommandsSize = read32.call(bytes, 20);
    if (fileType !== 2 || loadCommandCount < 1 || loadCommandsSize < 8 || 32 + loadCommandsSize > bytes.length) throw new Error("Invalid Mach-O executable header.");
    const firstCommandSize = read32.call(bytes, 36);
    if (firstCommandSize < 8 || firstCommandSize > loadCommandsSize) throw new Error("Invalid Mach-O load command.");
    return { format: "mach-o", machine };
  }

  throw new Error("Unsupported executable binary format.");
}

export function assertBrainPetBinary(bytes, target, label = target.id) {
  const actual = inspectExecutableBinary(bytes);
  if (actual.format !== target.binaryFormat || actual.machine !== target.machine) {
    throw new Error(`${label} has ${actual.format}/${actual.machine}; expected ${target.binaryFormat}/${target.machine}.`);
  }
  return actual;
}
