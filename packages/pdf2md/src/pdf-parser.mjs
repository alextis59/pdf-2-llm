import { PdfCMapParseError, parseToUnicodeCMap } from "./font-encoding.mjs";
import {
  bytesToHex,
  bytesToLatin1,
  hexToBytes,
  int32LittleEndianBytes,
  latin1ToBytes,
  md5Digest,
  now
} from "./runtime.mjs";
import { PdfStreamDecodeError, decodeStreamBytes } from "./stream-filters.mjs";

const standardPasswordPadding = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41,
  0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
  0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a
]);

export class PdfSyntaxError extends Error {
  constructor(message, { offset = null, code = "pdf.syntax" } = {}) {
    super(message);
    this.name = "PdfSyntaxError";
    this.offset = offset;
    this.code = code;
  }
}

export class ByteReader {
  constructor(bytes, { maxBytes = 100 * 1024 * 1024 } = {}) {
    if (bytes.byteLength > maxBytes) {
      throw new PdfSyntaxError("PDF input exceeds parser byte limit.", {
        offset: maxBytes,
        code: "pdf.input_too_large"
      });
    }
    this.bytes = bytes;
    this.offset = 0;
  }

  get length() {
    return this.bytes.byteLength;
  }

  eof() {
    return this.offset >= this.length;
  }

  peek() {
    return this.eof() ? null : this.bytes[this.offset];
  }

  read() {
    if (this.eof()) {
      return null;
    }
    const value = this.bytes[this.offset];
    this.offset += 1;
    return value;
  }
}

export function parsePdfDocument(bytes, options = {}) {
  const reader = new ByteReader(bytes, options);
  const maxDecodedStreamBytes = options.maxDecodedStreamBytes ?? options.maxBytes ?? 50 * 1024 * 1024;
  const maxTotalDecodedStreamBytes = readMaxTotalDecodedStreamBytes(options.maxTotalDecodedStreamBytes);
  const decodedStreamBudget = {
    max: maxTotalDecodedStreamBytes,
    used: 0,
    byObject: new Map()
  };
  const maxObjects = readMaxObjects(options.maxObjects);
  const maxDepth = readMaxDepth(options.maxDepth);
  const maxCMapMappings = readMaxCMapMappings(options.maxCMapMappings);
  const mode = options.mode ?? options.parseMode ?? "strict";
  const source = bytesToLatin1(reader.bytes);
  const version = readPdfVersion(source);
  throwIfParserTimedOut(options.deadline);
  const xref = readXrefData(source, reader.bytes, {
    maxDecodedStreamBytes,
    decodedStreamBudget,
    maxObjects,
    maxDepth,
    deadline: options.deadline,
    mode
  });
  const { startXref, entries, trailer, xrefMode, sections, repaired = false, repairReason = null } = xref;
  enforceObjectLimit(entries.length, maxObjects);
  const encryption = createEncryptionContext(trailer, entries, source, reader.bytes, {
    maxDecodedStreamBytes,
    decodedStreamBudget,
    mode,
    password: options.password
  });
  const objects = new Map();
  const streams = [];

  for (const entry of entries) {
    throwIfParserTimedOut(options.deadline);
    if (!entry.inUse || entry.offset <= 0) {
      continue;
    }
    const object = parseIndirectObjectAt(source, reader.bytes, entry.offset, {
      maxDecodedStreamBytes,
      decodedStreamBudget,
      maxDepth,
      mode,
      encryption,
      entries
    });
    objects.set(objectKey(object.objectNumber, object.generationNumber), object);
    if (object.stream) {
      streams.push(object.stream);
    }
  }
  loadCompressedObjectStreams(objects, entries, { maxDepth });

  function getObject(referenceOrNumber, generationNumber = 0) {
    if (typeof referenceOrNumber === "object" && referenceOrNumber?.type === "ref") {
      return objects.get(objectKey(referenceOrNumber.objectNumber, referenceOrNumber.generationNumber));
    }
    return objects.get(objectKey(referenceOrNumber, generationNumber));
  }

  const catalog = resolveCatalog(trailer, getObject);
  const outlines = resolveOutlines(catalog.outlinesRef, getObject, maxDepth);
  const pages = resolvePages(catalog, getObject, maxDepth, maxCMapMappings);
  const structure = resolveStructureTree(catalog.structureTreeRootRef, getObject, pages, maxDepth);

  return {
    version,
    startXref,
    repaired,
    repairReason,
    xrefMode,
    xrefSections: sections,
    trailer,
    xrefEntries: entries,
    objects,
    streams,
    catalog,
    outlines,
    structure,
    pages,
    decodedStreamBytes: decodedStreamBudget.used,
    getObject
  };
}

function isEncryptedTrailer(trailer) {
  return isDict(trailer) && trailer.entries.Encrypt != null;
}

function createEncryptionContext(trailer, entries, source, bytes, options) {
  if (!isEncryptedTrailer(trailer)) {
    return null;
  }

  if (typeof options.password !== "string") {
    throw new PdfSyntaxError("Encrypted PDFs require a password before parsing.", {
      code: "pdf.encryption.password_required"
    });
  }

  const { dictionary, objectNumber, generationNumber } = resolveEncryptionDictionary(
    trailer.entries.Encrypt,
    entries,
    source,
    bytes,
    options
  );
  const fileKey = computeStandardRevision2FileKey(dictionary, trailer, options.password);
  const encryptionDictionaryKey = Number.isInteger(objectNumber)
    ? objectKey(objectNumber, generationNumber ?? 0)
    : null;

  function decryptObjectBytes(objectNumberValue, generationNumberValue, input) {
    const key = computeObjectRc4Key(fileKey, objectNumberValue, generationNumberValue);
    return rc4(key, input);
  }

  return {
    shouldDecryptObject(objectNumberValue, generationNumberValue, value) {
      return (
        objectKey(objectNumberValue, generationNumberValue) !== encryptionDictionaryKey &&
        nameValue(value?.entries?.Type) !== "XRef"
      );
    },
    decryptStringBytes(objectNumberValue, generationNumberValue, stringBytes) {
      return decryptObjectBytes(objectNumberValue, generationNumberValue, stringBytes);
    },
    decryptStreamBytes(objectNumber, generationNumber, streamBytes) {
      return decryptObjectBytes(objectNumber, generationNumber, streamBytes);
    }
  };
}

function resolveEncryptionDictionary(encryptValue, entries, source, bytes, options) {
  if (isDict(encryptValue)) {
    return {
      dictionary: encryptValue,
      objectNumber: null,
      generationNumber: null
    };
  }

  if (encryptValue?.type !== "ref") {
    throwUnsupportedEncryption();
  }

  const entry = entries.find(
    (item) =>
      item.inUse &&
      item.objectNumber === encryptValue.objectNumber &&
      item.generationNumber === encryptValue.generationNumber &&
      item.offset > 0 &&
      !item.compressed
  );
  if (!entry) {
    throwUnsupportedEncryption();
  }

  const object = parseIndirectObjectAt(source, bytes, entry.offset, {
    maxDecodedStreamBytes: options.maxDecodedStreamBytes,
    decodedStreamBudget: options.decodedStreamBudget,
    mode: options.mode
  });
  if (!isDict(object.value)) {
    throwUnsupportedEncryption();
  }

  return {
    dictionary: object.value,
    objectNumber: object.objectNumber,
    generationNumber: object.generationNumber
  };
}

function computeStandardRevision2FileKey(dictionary, trailer, password) {
  if (nameValue(dictionary.entries.Filter) !== "Standard") {
    throwUnsupportedEncryption();
  }

  const revision = dictionary.entries.R;
  const version = dictionary.entries.V;
  const lengthBits = version === 1 ? 40 : dictionary.entries.Length ?? 40;
  if (revision !== 2 || ![1, 2].includes(version) || lengthBits !== 40) {
    throwUnsupportedEncryption();
  }

  const ownerKey = bytesFromPdfString(dictionary.entries.O);
  const userKey = bytesFromPdfString(dictionary.entries.U);
  const permission = dictionary.entries.P;
  const fileId = firstTrailerFileId(trailer);
  if (
    !ownerKey ||
    ownerKey.byteLength < 32 ||
    !userKey ||
    userKey.byteLength < 32 ||
    !Number.isInteger(permission) ||
    !fileId
  ) {
    throwUnsupportedEncryption();
  }

  const fileKey = md5Digest(
    concatBytes(
      padPassword(password),
      ownerKey.subarray(0, 32),
      permissionBytes(permission),
      fileId
    )
  ).subarray(0, lengthBits / 8);
  const expectedUserKey = rc4(fileKey, standardPasswordPadding);
  if (!constantTimePrefixEquals(userKey, expectedUserKey, 32)) {
    throw new PdfSyntaxError("Encrypted PDF password is incorrect.", {
      code: "pdf.encryption.password_incorrect"
    });
  }

  return fileKey;
}

function throwUnsupportedEncryption() {
  throw new PdfSyntaxError(
    "Encrypted PDF decryption is not implemented for this security handler.",
    {
      code: "pdf.encryption.unsupported"
    }
  );
}

function padPassword(password) {
  const passwordBytes = latin1ToBytes(password).subarray(0, 32);
  const padded = new Uint8Array(32);
  padded.set(passwordBytes, 0);
  padded.set(
    standardPasswordPadding.subarray(0, 32 - passwordBytes.byteLength),
    passwordBytes.byteLength
  );
  return padded;
}

function permissionBytes(permission) {
  return int32LittleEndianBytes(permission);
}

function concatBytes(...parts) {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function firstTrailerFileId(trailer) {
  const id = trailer.entries.ID;
  if (id?.type !== "array" || id.items.length === 0) {
    return null;
  }
  return bytesFromPdfString(id.items[0]);
}

function bytesFromPdfString(value) {
  if (typeof value === "string") {
    return latin1ToBytes(value);
  }

  if (value?.type === "hex-string") {
    const hex = value.value.length % 2 === 0 ? value.value : `${value.value}0`;
    if (!/^[0-9a-fA-F]*$/.test(hex)) {
      return null;
    }
    return hexToBytes(hex);
  }

  return null;
}

function decryptPdfValueStrings(value, decryptBytes, maxDepth = 100, depth = 0) {
  enforceDepthLimit(depth, maxDepth, null);
  if (typeof value === "string") {
    return bytesToLatin1(decryptBytes(latin1ToBytes(value)));
  }
  if (value?.type === "hex-string") {
    const encryptedBytes = bytesFromPdfString(value);
    if (encryptedBytes) {
      value.value = bytesToHex(decryptBytes(encryptedBytes));
    }
    return value;
  }
  if (value?.type === "array") {
    for (let index = 0; index < value.items.length; index += 1) {
      value.items[index] = decryptPdfValueStrings(
        value.items[index],
        decryptBytes,
        maxDepth,
        depth + 1
      );
    }
    return value;
  }
  if (isDict(value)) {
    for (const [key, item] of Object.entries(value.entries)) {
      value.entries[key] = decryptPdfValueStrings(item, decryptBytes, maxDepth, depth + 1);
    }
  }
  return value;
}

function computeObjectRc4Key(fileKey, objectNumber, generationNumber) {
  const seed = new Uint8Array(fileKey.byteLength + 5);
  seed.set(fileKey, 0);
  seed[fileKey.byteLength] = objectNumber & 0xff;
  seed[fileKey.byteLength + 1] = (objectNumber >> 8) & 0xff;
  seed[fileKey.byteLength + 2] = (objectNumber >> 16) & 0xff;
  seed[fileKey.byteLength + 3] = generationNumber & 0xff;
  seed[fileKey.byteLength + 4] = (generationNumber >> 8) & 0xff;
  return md5Digest(seed).subarray(0, Math.min(fileKey.byteLength + 5, 16));
}

function rc4(key, input) {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let index = 0; index < 256; index += 1) {
    j = (j + state[index] + key[index % key.byteLength]) & 0xff;
    swap(state, index, j);
  }

  const output = new Uint8Array(input.byteLength);
  let i = 0;
  j = 0;
  for (let index = 0; index < input.byteLength; index += 1) {
    i = (i + 1) & 0xff;
    j = (j + state[i]) & 0xff;
    swap(state, i, j);
    const keyByte = state[(state[i] + state[j]) & 0xff];
    output[index] = input[index] ^ keyByte;
  }
  return output;
}

function swap(bytes, left, right) {
  const value = bytes[left];
  bytes[left] = bytes[right];
  bytes[right] = value;
}

function constantTimePrefixEquals(left, right, length) {
  if (left.byteLength < length || right.byteLength < length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

function loadCompressedObjectStreams(objects, entries, options = {}) {
  const compressedEntries = entries.filter((entry) => entry.compressed);
  if (compressedEntries.length === 0) {
    return;
  }

  const entriesByStream = new Map();
  for (const entry of compressedEntries) {
    const group = entriesByStream.get(entry.objectStreamNumber) ?? [];
    group.push(entry);
    entriesByStream.set(entry.objectStreamNumber, group);
  }

  for (const [objectStreamNumber, group] of entriesByStream) {
    const objectStream = objects.get(objectKey(objectStreamNumber, 0));
    if (!objectStream) {
      throw new PdfSyntaxError("XRef stream references a missing object stream.", {
        code: "pdf.object_stream.missing"
      });
    }
    const compressedObjects = parseObjectStream(objectStream, group, options);
    for (const object of compressedObjects) {
      objects.set(objectKey(object.objectNumber, object.generationNumber), object);
    }
  }
}

export function parsePdfValue(input, offset = 0, options = {}) {
  if (typeof offset === "object" && offset !== null) {
    options = offset;
    offset = 0;
  }
  const source = typeof input === "string" ? input : bytesToLatin1(input);
  return new ObjectParser(source, offset, { maxDepth: readMaxDepth(options.maxDepth) }).parseValue();
}

function readXrefData(source, bytes, options = {}) {
  throwIfParserTimedOut(options.deadline);
  try {
    const startXref = readStartXref(source);
    return {
      startXref,
      ...parseXrefChain(source, bytes, startXref, options),
      repaired: false,
      repairReason: null
    };
  } catch (error) {
    if (options.mode !== "tolerant" || !(error instanceof PdfSyntaxError)) {
      throw error;
    }
    return scanObjectsForRepair(source, bytes, options, error);
  }
}

function scanObjectsForRepair(source, bytes, options, cause) {
  const entriesByKey = new Map();
  const objectHeaderPattern = /(\d+)\s+(\d+)\s+obj\b/g;
  let match;

  while ((match = objectHeaderPattern.exec(source)) !== null) {
    throwIfParserTimedOut(options.deadline);
    const offset = match.index;
    if (!isObjectHeaderBoundary(source, offset)) {
      continue;
    }

    try {
      const object = parseIndirectObjectAt(source, bytes, offset, {
        maxDecodedStreamBytes: options.maxDecodedStreamBytes,
        decodedStreamBudget: options.decodedStreamBudget,
        maxDepth: options.maxDepth,
        mode: options.mode
      });
      entriesByKey.set(objectKey(object.objectNumber, object.generationNumber), {
        objectNumber: object.objectNumber,
        generationNumber: object.generationNumber,
        offset,
        inUse: true
      });
      enforceObjectLimit(entriesByKey.size, options.maxObjects);
      objectHeaderPattern.lastIndex = Math.max(objectHeaderPattern.lastIndex, object.endOffset);
    } catch (error) {
      if (isRepairFatalError(error)) {
        throw error;
      }
      objectHeaderPattern.lastIndex = offset + match[0].length;
    }
  }

  const entries = [...entriesByKey.values()].sort(
    (left, right) => left.objectNumber - right.objectNumber || left.generationNumber - right.generationNumber
  );
  const trailer = findLastTrailerDictionary(source, options);
  if (entries.length === 0 || !trailer) {
    throw new PdfSyntaxError("Unable to repair PDF object index from scanned objects.", {
      code: "pdf.repair.failed"
    });
  }

  return {
    startXref: null,
    entries,
    trailer,
    xrefMode: "object-scan-repair",
    sections: [
      {
        offset: null,
        mode: "object-scan-repair",
        entries: entries.length,
        repaired: true,
        reason: cause.code
      }
    ],
    repaired: true,
    repairReason: cause.code
  };
}

function isObjectHeaderBoundary(source, offset) {
  return offset === 0 || isWhitespace(source[offset - 1]) || source[offset - 1] === "%";
}

function findLastTrailerDictionary(source, options = {}) {
  let offset = source.lastIndexOf("trailer");
  while (offset !== -1) {
    try {
      const parsed = parsePdfValue(source, offset + "trailer".length, { maxDepth: options.maxDepth });
      if (isDict(parsed.value)) {
        return parsed.value;
      }
    } catch {
      // Keep searching older trailer markers.
    }
    offset = source.lastIndexOf("trailer", offset - 1);
  }
  return null;
}

function readMaxObjects(maxObjects) {
  const value = maxObjects ?? 100000;
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError("maxObjects must be a non-negative integer");
  }
  return value;
}

function readMaxTotalDecodedStreamBytes(maxTotalDecodedStreamBytes) {
  const value = maxTotalDecodedStreamBytes ?? 200 * 1024 * 1024;
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError("maxTotalDecodedStreamBytes must be a non-negative integer");
  }
  return value;
}

function readMaxDepth(maxDepth) {
  const value = maxDepth ?? 100;
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError("maxDepth must be a non-negative integer");
  }
  return value;
}

function readMaxCMapMappings(maxCMapMappings) {
  const value = maxCMapMappings ?? 65_536;
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError("maxCMapMappings must be a non-negative integer");
  }
  return value;
}

function enforceDepthLimit(depth, maxDepth, offset) {
  if (depth > maxDepth) {
    throw new PdfSyntaxError("PDF nesting depth exceeds parser depth limit.", {
      offset,
      code: "pdf.depth_limit_exceeded"
    });
  }
}

function enforceObjectLimit(count, maxObjects) {
  if (count > maxObjects) {
    throw new PdfSyntaxError("PDF object count exceeds parser object limit.", {
      code: "pdf.object_limit_exceeded"
    });
  }
}

function throwIfParserTimedOut(deadline) {
  if (Number.isFinite(deadline) && now() >= deadline) {
    throw new DOMException("Operation timed out", "TimeoutError");
  }
}

function isRepairFatalError(error) {
  return (
    error instanceof DOMException ||
    (error instanceof PdfSyntaxError &&
      (error.code === "pdf.object_limit_exceeded" ||
        error.code === "pdf.depth_limit_exceeded" ||
        error.code === "pdf.stream.total_decoded_too_large"))
  );
}

function parseXrefChain(source, bytes, startOffset, options = {}) {
  const parsedSections = [];
  const sectionSummaries = [];
  const seenOffsets = new Set();
  let offset = startOffset;

  while (Number.isInteger(offset) && offset >= 0) {
    if (seenOffsets.has(offset)) {
      throw new PdfSyntaxError("XRef Prev chain contains a cycle.", {
        offset,
        code: "pdf.xref.prev_cycle"
      });
    }
    seenOffsets.add(offset);

    const section = parseHybridXrefSection(source, bytes, parseXref(source, bytes, offset, options), options);
    parsedSections.push(section);
    sectionSummaries.push({
      offset,
      mode: section.xrefMode,
      entries: section.entries.length
    });

    const previousOffset = section.trailer?.entries?.Prev;
    if (!Number.isInteger(previousOffset)) {
      return {
        entries: mergeXrefEntries(parsedSections),
        trailer: parsedSections[0].trailer,
        xrefMode: formatXrefMode(sectionSummaries),
        sections: sectionSummaries
      };
    }
    offset = previousOffset;
  }

  throw new PdfSyntaxError("XRef Prev offset is malformed.", {
    offset: startOffset,
    code: "pdf.xref.prev_malformed"
  });
}

function mergeXrefEntries(sections) {
  const entries = [];
  const seen = new Set();
  for (const section of sections) {
    for (const entry of section.entries) {
      const key = objectKey(entry.objectNumber, entry.generationNumber);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entries.push(entry);
    }
  }
  return entries;
}

function formatXrefMode(sections) {
  const modes = [...new Set(sections.map((section) => section.mode))];
  const mode = modes.length === 1 ? modes[0] : modes.join("+");
  return sections.length > 1 ? `${mode}+prev` : mode;
}

function readPdfVersion(source) {
  const match = source.slice(0, 32).match(/^%PDF-(\d\.\d)/);
  if (!match) {
    throw new PdfSyntaxError("Missing PDF header.", {
      offset: 0,
      code: "pdf.header.missing"
    });
  }
  return match[1];
}

function readStartXref(source) {
  const markerOffset = source.lastIndexOf("startxref");
  if (markerOffset === -1) {
    throw new PdfSyntaxError("Missing startxref marker.", {
      offset: source.length,
      code: "pdf.startxref.missing"
    });
  }

  const match = source.slice(markerOffset).match(/^startxref\s+(\d+)/);
  if (!match) {
    throw new PdfSyntaxError("Malformed startxref marker.", {
      offset: markerOffset,
      code: "pdf.startxref.malformed"
    });
  }

  return Number.parseInt(match[1], 10);
}

function parseXref(source, bytes, offset, options = {}) {
  if (source.startsWith("xref", offset)) {
    return parseClassicXref(source, offset, options);
  }
  return parseXrefStream(source, bytes, offset, options);
}

function parseHybridXrefSection(source, bytes, section, options = {}) {
  const xrefStreamOffset = section.trailer?.entries?.XRefStm;
  if (!Number.isInteger(xrefStreamOffset)) {
    return section;
  }

  const streamSection = parseXrefStream(source, bytes, xrefStreamOffset, options);
  return {
    entries: mergeXrefEntries([streamSection, section]),
    trailer: section.trailer,
    xrefMode: `${section.xrefMode}+hybrid-xref-stream`
  };
}

function parseClassicXref(source, offset, { mode = "strict", maxDepth = 100 } = {}) {
  let cursor = offset;
  if (!source.startsWith("xref", cursor)) {
    if (mode === "tolerant") {
      const recoveredOffset = source.indexOf("xref", offset);
      if (recoveredOffset !== -1) {
        cursor = recoveredOffset;
      }
    }
    if (!source.startsWith("xref", cursor)) {
      throw new PdfSyntaxError("Only classic xref tables are supported by this parser slice.", {
        offset,
        code: "pdf.xref.unsupported"
      });
    }
  }

  cursor += "xref".length;
  const entries = [];

  while (cursor < source.length) {
    cursor = skipWhitespaceAndComments(source, cursor);
    if (source.startsWith("trailer", cursor)) {
      cursor += "trailer".length;
      const parsed = parsePdfValue(source, cursor, { maxDepth });
      return {
        entries,
        trailer: parsed.value,
        xrefMode: "classic-xref"
      };
    }

    const firstObject = readInteger(source, cursor, "xref subsection first object");
    cursor = skipWhitespaceAndComments(source, firstObject.offset);
    const count = readInteger(source, cursor, "xref subsection count");
    cursor = count.offset;

    for (let index = 0; index < count.value; index += 1) {
      cursor = skipWhitespaceAndComments(source, cursor);
      const line = source.slice(cursor).match(/^(\d{10})\s+(\d{5})\s+([nf])/);
      if (!line) {
        throw new PdfSyntaxError("Malformed xref entry.", {
          offset: cursor,
          code: "pdf.xref.entry_malformed"
        });
      }
      entries.push({
        objectNumber: firstObject.value + index,
        generationNumber: Number.parseInt(line[2], 10),
        offset: Number.parseInt(line[1], 10),
        inUse: line[3] === "n"
      });
      cursor += line[0].length;
    }
  }

  throw new PdfSyntaxError("Missing xref trailer.", {
    offset: cursor,
    code: "pdf.xref.trailer_missing"
  });
}

function parseXrefStream(source, bytes, offset, options = {}) {
  const object = parseIndirectObjectAt(source, bytes, offset, options);
  if (!isDict(object.value) || nameValue(object.value.entries.Type) !== "XRef" || !object.stream) {
    throw new PdfSyntaxError("startxref does not point to a supported xref table or stream.", {
      offset,
      code: "pdf.xref.unsupported"
    });
  }

  return {
    entries: readXrefStreamEntries(object.value, object.stream.bytes, object.offset),
    trailer: object.value,
    xrefMode: "xref-stream"
  };
}

function readXrefStreamEntries(dictionary, bytes, offset) {
  const size = dictionary.entries.Size;
  if (!Number.isInteger(size) || size < 0) {
    throw new PdfSyntaxError("XRef stream is missing a valid Size entry.", {
      offset,
      code: "pdf.xref.stream_size_malformed"
    });
  }

  const widths = numberArray(dictionary.entries.W);
  if (!widths || widths.length !== 3 || !widths.every((value) => Number.isInteger(value) && value >= 0)) {
    throw new PdfSyntaxError("XRef stream is missing a valid W array.", {
      offset,
      code: "pdf.xref.stream_w_malformed"
    });
  }

  const index = numberArray(dictionary.entries.Index) ?? [0, size];
  if (index.length % 2 !== 0 || !index.every((value) => Number.isInteger(value) && value >= 0)) {
    throw new PdfSyntaxError("XRef stream has a malformed Index array.", {
      offset,
      code: "pdf.xref.stream_index_malformed"
    });
  }

  const entryWidth = widths[0] + widths[1] + widths[2];
  if (entryWidth <= 0) {
    throw new PdfSyntaxError("XRef stream entry width must be positive.", {
      offset,
      code: "pdf.xref.stream_w_malformed"
    });
  }

  const entries = [];
  let cursor = 0;
  for (let pairIndex = 0; pairIndex < index.length; pairIndex += 2) {
    const firstObject = index[pairIndex];
    const count = index[pairIndex + 1];
    for (let itemIndex = 0; itemIndex < count; itemIndex += 1) {
      if (cursor + entryWidth > bytes.byteLength) {
        throw new PdfSyntaxError("XRef stream ended before all entries were decoded.", {
          offset,
          code: "pdf.xref.stream_truncated"
        });
      }
      const type = widths[0] === 0 ? 1 : readBigEndianInteger(bytes, cursor, widths[0]);
      cursor += widths[0];
      const field2 = readBigEndianInteger(bytes, cursor, widths[1]);
      cursor += widths[1];
      const field3 = readBigEndianInteger(bytes, cursor, widths[2]);
      cursor += widths[2];
      entries.push(xrefStreamEntry(firstObject + itemIndex, type, field2, field3));
    }
  }
  return entries;
}

function readBigEndianInteger(bytes, offset, width) {
  let value = 0;
  for (let index = 0; index < width; index += 1) {
    value = value * 256 + bytes[offset + index];
  }
  return value;
}

function xrefStreamEntry(objectNumber, type, field2, field3) {
  if (type === 0) {
    return {
      objectNumber,
      generationNumber: field3,
      offset: field2,
      inUse: false
    };
  }
  if (type === 1) {
    return {
      objectNumber,
      generationNumber: field3,
      offset: field2,
      inUse: true
    };
  }
  return {
    objectNumber,
    generationNumber: 0,
    offset: 0,
    inUse: false,
    compressed: true,
    objectStreamNumber: field2,
    objectStreamIndex: field3
  };
}

function parseIndirectObjectAt(source, bytes, offset, options = {}) {
  const parsedObject = parseIndirectObjectHeaderAndValue(source, offset, options);
  const { objectNumber, generationNumber } = parsedObject;
  const decryptObject =
    options.encryption?.shouldDecryptObject(
      objectNumber,
      generationNumber,
      parsedObject.value
    ) === true;
  if (decryptObject) {
    parsedObject.value = decryptPdfValueStrings(
      parsedObject.value,
      (stringBytes) =>
        options.encryption.decryptStringBytes(objectNumber, generationNumber, stringBytes),
      options.maxDepth
    );
  }
  let cursor = skipWhitespaceAndComments(source, parsedObject.valueEndOffset);

  let stream = null;
  if (source.startsWith("stream", cursor)) {
    const streamMarkerOffset = cursor;
    cursor += "stream".length;
    if (source[cursor] === "\r" && source[cursor + 1] === "\n") {
      cursor += 2;
    } else if (source[cursor] === "\n" || source[cursor] === "\r") {
      cursor += 1;
    } else {
      throw new PdfSyntaxError("Malformed stream line ending.", {
        offset: streamMarkerOffset,
        code: "pdf.stream.line_ending"
      });
    }

    const streamStart = cursor;
    const streamEnd = resolveStreamEnd(source, bytes, streamStart, parsedObject.value, {
      mode: options.mode,
      entries: options.entries,
      maxDepth: options.maxDepth,
      streamLengthStack: new Set([objectKey(objectNumber, generationNumber)])
    });

    const streamBytes = bytes.subarray(streamStart, streamEnd);
    const decodedInputBytes =
      decryptObject && shouldDecryptStream(parsedObject.value)
        ? options.encryption.decryptStreamBytes(objectNumber, generationNumber, streamBytes)
        : streamBytes;
    const maxDecodedStreamBytes = options.maxDecodedStreamBytes ?? 50 * 1024 * 1024;
    const maxDecodedBytesForObject = remainingDecodedBytesForObject(
      options.decodedStreamBudget,
      objectNumber,
      generationNumber
    );
    const effectiveMaxDecodedStreamBytes = Math.min(
      maxDecodedStreamBytes,
      maxDecodedBytesForObject
    );
    const boundedDecoderMaxBytes = Math.max(1, effectiveMaxDecodedStreamBytes);
    let decoded;
    try {
      decoded = decodeStreamBytes(decodedInputBytes, parsedObject.value, {
        maxBytes: boundedDecoderMaxBytes
      });
    } catch (error) {
      if (error instanceof PdfStreamDecodeError) {
        const totalLimitExceeded =
          error.code === "pdf.stream.decoded_too_large" &&
          maxDecodedBytesForObject < maxDecodedStreamBytes;
        throw new PdfSyntaxError(
          totalLimitExceeded ? "PDF decoded streams exceed document byte limit." : error.message,
          {
          offset: error.offset ?? streamStart,
          code: totalLimitExceeded ? "pdf.stream.total_decoded_too_large" : error.code
          }
        );
      }
      throw error;
    }
    if (decoded.bytes.byteLength > effectiveMaxDecodedStreamBytes) {
      const totalLimitExceeded = maxDecodedBytesForObject < maxDecodedStreamBytes;
      throw new PdfSyntaxError(
        totalLimitExceeded
          ? "PDF decoded streams exceed document byte limit."
          : "Decoded stream output exceeds byte limit.",
        {
          offset: streamStart,
          code: totalLimitExceeded
            ? "pdf.stream.total_decoded_too_large"
            : "pdf.stream.decoded_too_large"
        }
      );
    }
    consumeDecodedStreamBudget(
      options.decodedStreamBudget,
      objectNumber,
      generationNumber,
      decoded.bytes.byteLength,
      streamStart
    );
    let decodedText;
    stream = {
      objectNumber,
      generationNumber,
      offset: streamStart,
      length: streamBytes.byteLength,
      rawBytes: streamBytes,
      rawLength: streamBytes.byteLength,
      bytes: decoded.bytes,
      decodedBytes: decoded.bytes,
      decodedLength: decoded.bytes.byteLength,
      filters: decoded.filters,
      decodeParms: decoded.decodeParms,
      skippedFilters: decoded.skippedFilters,
      get text() {
        decodedText ??= bytesToLatin1(decoded.bytes);
        return decodedText;
      }
    };

    const endstreamOffset = source.indexOf("endstream", streamEnd);
    if (endstreamOffset === -1) {
      throw new PdfSyntaxError("Missing endstream marker.", {
        offset: streamEnd,
        code: "pdf.stream.end_missing"
      });
    }
    cursor = endstreamOffset + "endstream".length;
  }

  const endObjectOffset = source.indexOf("endobj", cursor);
  if (endObjectOffset === -1) {
    throw new PdfSyntaxError("Missing endobj marker.", {
      offset: cursor,
      code: "pdf.object.end_missing"
    });
  }

  return {
    objectNumber,
    generationNumber,
    value: parsedObject.value,
    stream,
    offset,
    endOffset: endObjectOffset + "endobj".length
  };
}

function consumeDecodedStreamBudget(budget, objectNumber, generationNumber, decodedBytes, offset) {
  if (!budget) {
    return;
  }
  const key = objectKey(objectNumber, generationNumber);
  const previousBytes = budget.byObject.get(key) ?? 0;
  const retainedBytes = Math.max(previousBytes, decodedBytes);
  const additionalBytes = retainedBytes - previousBytes;
  if (additionalBytes > budget.max - budget.used) {
    throw new PdfSyntaxError("PDF decoded streams exceed document byte limit.", {
      offset,
      code: "pdf.stream.total_decoded_too_large"
    });
  }
  budget.byObject.set(key, retainedBytes);
  budget.used += additionalBytes;
}

function remainingDecodedBytesForObject(budget, objectNumber, generationNumber) {
  if (!budget) {
    return Number.POSITIVE_INFINITY;
  }
  const previousBytes = budget.byObject.get(objectKey(objectNumber, generationNumber)) ?? 0;
  return budget.max - budget.used + previousBytes;
}

function parseIndirectObjectHeaderAndValue(source, offset, options = {}) {
  const header = source.slice(offset).match(/^(\d+)\s+(\d+)\s+obj\b/);
  if (!header) {
    throw new PdfSyntaxError("Expected indirect object.", {
      offset,
      code: "pdf.object.expected"
    });
  }

  const objectNumber = Number.parseInt(header[1], 10);
  const generationNumber = Number.parseInt(header[2], 10);
  const cursor = offset + header[0].length;
  const parsed = parsePdfValue(source, cursor, { maxDepth: options.maxDepth });
  return {
    objectNumber,
    generationNumber,
    value: parsed.value,
    offset,
    valueEndOffset: parsed.offset
  };
}

function parseObjectStream(objectStream, requestedEntries, options = {}) {
  if (!isDict(objectStream.value) || nameValue(objectStream.value.entries.Type) !== "ObjStm" || !objectStream.stream) {
    throw new PdfSyntaxError("XRef stream entry references an invalid object stream.", {
      offset: objectStream.offset,
      code: "pdf.object_stream.invalid"
    });
  }

  const count = objectStream.value.entries.N;
  const first = objectStream.value.entries.First;
  if (!Number.isInteger(count) || count < 0 || !Number.isInteger(first) || first < 0) {
    throw new PdfSyntaxError("Object stream is missing valid N or First entries.", {
      offset: objectStream.offset,
      code: "pdf.object_stream.header_malformed"
    });
  }

  const text = objectStream.stream.text;
  const offsets = readObjectStreamOffsets(text, count, objectStream.offset);
  const requestedByIndex = new Map(requestedEntries.map((entry) => [entry.objectStreamIndex, entry]));
  const objects = [];

  for (const entry of requestedEntries) {
    if (!offsets[entry.objectStreamIndex]) {
      throw new PdfSyntaxError("XRef stream references an object-stream index outside the stream.", {
        offset: objectStream.offset,
        code: "pdf.object_stream.index_out_of_bounds"
      });
    }
  }

  for (let index = 0; index < offsets.length; index += 1) {
    const requested = requestedByIndex.get(index);
    if (!requested) {
      continue;
    }
    if (requested.objectNumber !== offsets[index].objectNumber) {
      throw new PdfSyntaxError("Object stream header does not match xref stream entry.", {
        offset: objectStream.offset,
        code: "pdf.object_stream.object_number_mismatch"
      });
    }
    const objectOffset = first + offsets[index].offset;
    if (objectOffset < first || objectOffset >= text.length) {
      throw new PdfSyntaxError("Object stream entry offset is outside the stream.", {
        offset: objectStream.offset,
        code: "pdf.object_stream.entry_offset_malformed"
      });
    }
    const parsed = parsePdfValue(text, objectOffset, { maxDepth: options.maxDepth });
    objects.push({
      objectNumber: requested.objectNumber,
      generationNumber: 0,
      value: parsed.value,
      stream: null,
      offset: objectStream.offset + objectOffset,
      endOffset: objectStream.offset + parsed.offset,
      compressed: true,
      objectStreamNumber: objectStream.objectNumber,
      objectStreamIndex: index
    });
  }

  return objects;
}

function readObjectStreamOffsets(text, count, offset) {
  let cursor = 0;
  const offsets = [];
  for (let index = 0; index < count; index += 1) {
    const objectNumber = readInteger(text, cursor, "object stream object number");
    cursor = objectNumber.offset;
    const objectOffset = readInteger(text, cursor, "object stream object offset");
    cursor = objectOffset.offset;
    offsets.push({
      objectNumber: objectNumber.value,
      offset: objectOffset.value
    });
  }
  if (offsets.length !== count) {
    throw new PdfSyntaxError("Object stream header ended early.", {
      offset,
      code: "pdf.object_stream.header_malformed"
    });
  }
  return offsets;
}

function resolveStreamEnd(source, bytes, streamStart, dictionary, options = {}) {
  const mode = options.mode ?? "strict";
  const { length: streamLength, error: lengthError } = readStreamLength(dictionary, source, options);
  if (Number.isInteger(streamLength) && streamLength >= 0) {
    const streamEnd = streamStart + streamLength;
    if (streamEnd <= bytes.byteLength) {
      return streamEnd;
    }
    if (mode !== "tolerant") {
      throw new PdfSyntaxError("Stream length exceeds file bounds.", {
        offset: streamStart,
        code: "pdf.stream.length_out_of_bounds"
      });
    }
  }
  if (lengthError && mode !== "tolerant") {
    throw lengthError;
  }

  const endstreamOffset = source.indexOf("endstream", streamStart);
  if (endstreamOffset === -1) {
    throw new PdfSyntaxError("Missing endstream marker.", {
      offset: streamStart,
      code: "pdf.stream.end_missing"
    });
  }
  return trimTrailingLineEnding(source, endstreamOffset);
}

function readStreamLength(dictionary, source, options = {}) {
  const streamLength = readDirectStreamLength(dictionary);
  if (Number.isInteger(streamLength) && streamLength >= 0) {
    return {
      length: streamLength,
      error: null
    };
  }

  if (!isDict(dictionary) || dictionary.entries.Length?.type !== "ref") {
    return {
      length: null,
      error: null
    };
  }

  return readIndirectStreamLength(dictionary.entries.Length, source, options);
}

function readDirectStreamLength(value) {
  if (!value || value.type !== "dict") {
    return null;
  }
  const length = value.entries.Length;
  return typeof length === "number" ? length : null;
}

function readIndirectStreamLength(reference, source, options = {}) {
  const stack = options.streamLengthStack ?? new Set();
  const key = objectKey(reference.objectNumber, reference.generationNumber);
  if (stack.has(key)) {
    return {
      length: null,
      error: new PdfSyntaxError("Indirect stream Length contains a reference cycle.", {
        code: "pdf.stream.length_cycle"
      })
    };
  }

  const offset = findIndirectStreamLengthObjectOffset(reference, source, options.entries);
  if (!Number.isInteger(offset)) {
    return {
      length: null,
      error: new PdfSyntaxError("Indirect stream Length object is unavailable.", {
        code: "pdf.stream.length_unresolved"
      })
    };
  }

  let object;
  try {
    object = parseIndirectObjectHeaderAndValue(source, offset, { maxDepth: options.maxDepth });
  } catch (error) {
    if (!(error instanceof PdfSyntaxError)) {
      throw error;
    }
    return {
      length: null,
      error: new PdfSyntaxError("Indirect stream Length object could not be parsed.", {
        offset,
        code: "pdf.stream.length_unresolved"
      })
    };
  }

  if (Number.isInteger(object.value) && object.value >= 0) {
    return {
      length: object.value,
      error: null
    };
  }

  if (object.value?.type === "ref") {
    const nextStack = new Set(stack);
    nextStack.add(key);
    return readIndirectStreamLength(object.value, source, {
      ...options,
      streamLengthStack: nextStack
    });
  }

  return {
    length: null,
    error: new PdfSyntaxError("Indirect stream Length object must resolve to a non-negative integer.", {
      offset: object.offset,
      code: "pdf.stream.length_invalid"
    })
  };
}

function findIndirectStreamLengthObjectOffset(reference, source, entries) {
  if (Array.isArray(entries)) {
    const entry = entries.find(
      (item) =>
        item.inUse &&
        item.objectNumber === reference.objectNumber &&
        item.generationNumber === reference.generationNumber &&
        item.offset > 0 &&
        !item.compressed
    );
    return entry?.offset ?? null;
  }

  return findIndirectObjectOffset(source, reference);
}

function findIndirectObjectOffset(source, reference) {
  const pattern = new RegExp(`${reference.objectNumber}\\s+${reference.generationNumber}\\s+obj\\b`, "g");
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (isObjectHeaderBoundary(source, match.index)) {
      return match.index;
    }
  }
  return null;
}

function shouldDecryptStream(dictionary) {
  return nameValue(dictionary?.entries?.Type) !== "XRef";
}

function resolveCatalog(trailer, getObject) {
  if (!isDict(trailer)) {
    throw new PdfSyntaxError("Trailer is not a dictionary.", {
      code: "pdf.trailer.not_dict"
    });
  }

  const rootObject = getObject(trailer.entries.Root);
  if (!rootObject || !isDict(rootObject.value)) {
    throw new PdfSyntaxError("Catalog object is missing or invalid.", {
      code: "pdf.catalog.missing"
    });
  }

  return {
    objectNumber: rootObject.objectNumber,
    generationNumber: rootObject.generationNumber,
    value: rootObject.value,
    pagesRef: rootObject.value.entries.Pages,
    outlinesRef: rootObject.value.entries.Outlines ?? null,
    structureTreeRootRef: rootObject.value.entries.StructTreeRoot ?? null
  };
}

function resolveOutlines(outlinesRef, getObject, maxDepth = 100) {
  const root = resolveOutlineObject(outlinesRef, getObject);
  if (!root || !isDict(root.value)) {
    return [];
  }

  const outlines = [];
  walkOutlineSiblings(root.value.entries.First, 1, getObject, outlines, new Set(), maxDepth);
  return outlines;
}

function walkOutlineSiblings(itemRef, depth, getObject, outlines, seen, maxDepth) {
  enforceDepthLimit(depth, maxDepth, null);
  let currentRef = itemRef;
  while (currentRef) {
    const item = resolveOutlineObject(currentRef, getObject);
    const key = outlineObjectKey(item, currentRef);
    if (!item || !isDict(item.value) || (key && seen.has(key))) {
      break;
    }
    if (key) {
      seen.add(key);
    }

    const title = normalizeOutlineTitle(pdfTextValue(item.value.entries.Title) ?? "");
    if (title) {
      outlines.push({
        title,
        depth,
        objectNumber: item.objectNumber ?? null,
        generationNumber: item.generationNumber ?? null
      });
    }
    if (item.value.entries.First) {
      walkOutlineSiblings(item.value.entries.First, depth + 1, getObject, outlines, seen, maxDepth);
    }
    currentRef = item.value.entries.Next ?? null;
  }
}

function resolveOutlineObject(value, getObject) {
  if (value?.type === "ref") {
    return getObject(value) ?? null;
  }
  if (isDict(value)) {
    return {
      value,
      objectNumber: null,
      generationNumber: null
    };
  }
  return null;
}

function outlineObjectKey(item, source) {
  if (item && Number.isInteger(item.objectNumber)) {
    return objectKey(item.objectNumber, item.generationNumber ?? 0);
  }
  if (source?.type === "ref") {
    return objectKey(source.objectNumber, source.generationNumber);
  }
  return null;
}

function pdfTextValue(value) {
  const bytes = bytesFromPdfString(value);
  if (!bytes) {
    return null;
  }
  return decodePdfTextBytes(bytes);
}

function decodePdfTextBytes(bytes) {
  if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeUtf16Bytes(bytes, 2, false);
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodeUtf16Bytes(bytes, 2, true);
  }
  return bytesToLatin1(bytes);
}

function decodeUtf16Bytes(bytes, startOffset, littleEndian) {
  let output = "";
  for (let offset = startOffset; offset + 1 < bytes.byteLength; offset += 2) {
    const codeUnit = littleEndian
      ? bytes[offset] | (bytes[offset + 1] << 8)
      : (bytes[offset] << 8) | bytes[offset + 1];
    output += String.fromCharCode(codeUnit);
  }
  return output;
}

function normalizeOutlineTitle(value) {
  return value.replace(/\s+/g, " ").trim();
}

function resolveStructureTree(structureTreeRootRef, getObject, pages, maxDepth = 100) {
  const root = resolveStructureObject(structureTreeRootRef, getObject);
  const empty = {
    tagged: false,
    roleMap: {},
    elements: [],
    markedContent: []
  };
  if (!root || !isDict(root.value)) {
    return empty;
  }

  const structure = {
    tagged: true,
    roleMap: resolveRoleMap(root.value.entries.RoleMap, getObject),
    elements: [],
    markedContent: []
  };
  const pageIndexByObjectNumber = new Map(
    pages
      .filter((page) => Number.isInteger(page.objectNumber))
      .map((page) => [page.objectNumber, page.pageIndex])
  );

  walkStructureItem(root.value.entries.K, {
    getObject,
    pageIndexByObjectNumber,
    roleMap: structure.roleMap,
    elements: structure.elements,
    markedContent: structure.markedContent,
    seen: new Set(),
    path: [],
    role: null,
    rawRole: null,
    pageRef: null,
    altText: null,
    actualText: null,
    language: null,
    maxDepth,
    depth: 0
  });

  return structure;
}

function walkStructureItem(value, context) {
  enforceDepthLimit(context.depth ?? 0, context.maxDepth, null);
  if (value == null) {
    return;
  }
  if (typeof value === "number") {
    recordMarkedContent(value, null, context);
    return;
  }
  if (value.type === "array") {
    for (const item of value.items) {
      walkStructureItem(item, {
        ...context,
        depth: (context.depth ?? 0) + 1
      });
    }
    return;
  }

  const object = resolveStructureObject(value, context.getObject);
  const dict = object?.value ?? value;
  if (!isDict(dict)) {
    return;
  }

  const key = structureObjectKey(object, value);
  if (key && context.seen.has(key)) {
    return;
  }
  if (key) {
    context.seen.add(key);
  }

  if (nameValue(dict.entries.Type) === "MCR" || typeof dict.entries.MCID === "number") {
    recordMarkedContent(dict.entries.MCID, dict.entries.Pg ?? null, context);
    return;
  }

  const rawRole = nameValue(dict.entries.S);
  if (rawRole) {
    const role = mapStructureRole(rawRole, context.roleMap);
    const path = [...context.path, role];
    const attributes = structureAttributesFromDictionary(dict);
    context.elements.push({
      role,
      rawRole,
      depth: path.length,
      objectNumber: object?.objectNumber ?? null,
      generationNumber: object?.generationNumber ?? null,
      ...structureAttributeProperties(attributes)
    });
    walkStructureItem(dict.entries.K, {
      ...context,
      depth: (context.depth ?? 0) + 1,
      path,
      role,
      rawRole,
      pageRef: dict.entries.Pg ?? context.pageRef,
      altText: attributes.altText ?? context.altText ?? null,
      actualText: attributes.actualText ?? context.actualText ?? null,
      language: attributes.language ?? context.language ?? null
    });
    return;
  }

  walkStructureItem(dict.entries.K, {
    ...context,
    depth: (context.depth ?? 0) + 1,
    pageRef: dict.entries.Pg ?? context.pageRef
  });
}

function recordMarkedContent(mcid, pageRef, context) {
  if (!Number.isInteger(mcid)) {
    return;
  }
  const resolvedPageRef = pageRef ?? context.pageRef;
  const pageObjectNumber = resolvedPageRef?.type === "ref" ? resolvedPageRef.objectNumber : null;
  context.markedContent.push({
    mcid,
    pageObjectNumber,
    pageIndex: Number.isInteger(pageObjectNumber)
      ? context.pageIndexByObjectNumber.get(pageObjectNumber) ?? null
      : null,
    role: context.role,
    rawRole: context.rawRole,
    path: context.path,
    ...structureAttributeProperties(context)
  });
}

function structureAttributesFromDictionary(dict) {
  return {
    altText: normalizeStructureText(pdfTextValue(dict.entries.Alt)),
    actualText: normalizeStructureText(pdfTextValue(dict.entries.ActualText)),
    language: normalizeStructureText(pdfTextValue(dict.entries.Lang))
  };
}

function structureAttributeProperties(attributes) {
  return {
    ...(attributes.altText ? { altText: attributes.altText } : {}),
    ...(attributes.actualText ? { actualText: attributes.actualText } : {}),
    ...(attributes.language ? { language: attributes.language } : {})
  };
}

function normalizeStructureText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function resolveStructureObject(value, getObject) {
  if (value?.type === "ref") {
    return getObject(value) ?? null;
  }
  if (isDict(value)) {
    return {
      value,
      objectNumber: null,
      generationNumber: null
    };
  }
  return null;
}

function structureObjectKey(object, source) {
  if (object && Number.isInteger(object.objectNumber)) {
    return objectKey(object.objectNumber, object.generationNumber ?? 0);
  }
  if (source?.type === "ref") {
    return objectKey(source.objectNumber, source.generationNumber);
  }
  return null;
}

function resolveRoleMap(roleMapValue, getObject) {
  const roleMap = {};
  const roleMapDict = resolveValue(roleMapValue, getObject);
  if (!isDict(roleMapDict)) {
    return roleMap;
  }
  for (const [role, mappedRole] of Object.entries(roleMapDict.entries)) {
    const value = nameValue(mappedRole);
    if (value) {
      roleMap[role] = value;
    }
  }
  return roleMap;
}

function mapStructureRole(role, roleMap) {
  let current = role;
  const seen = new Set();
  while (roleMap[current] && !seen.has(current)) {
    seen.add(current);
    current = roleMap[current];
  }
  return current;
}

function resolvePages(catalog, getObject, maxDepth = 100, maxCMapMappings = 65_536) {
  const rootPages = getObject(catalog.pagesRef);
  if (!rootPages || !isDict(rootPages.value)) {
    throw new PdfSyntaxError("Pages tree root is missing or invalid.", {
      code: "pdf.pages.missing"
    });
  }

  const pages = [];
  walkPageNode(rootPages, {}, getObject, pages, {
    depth: 0,
    maxDepth,
    maxCMapMappings,
    seen: new Set()
  });
  return pages.map((page, index) => ({
    ...page,
    pageIndex: index
  }));
}

function walkPageNode(object, inherited, getObject, pages, context) {
  enforceDepthLimit(context.depth, context.maxDepth, object.offset);
  if (!isDict(object.value)) {
    throw new PdfSyntaxError("Page tree node is not a dictionary.", {
      offset: object.offset,
      code: "pdf.pages.node_not_dict"
    });
  }

  const dict = object.value;
  const key = Number.isInteger(object.objectNumber)
    ? objectKey(object.objectNumber, object.generationNumber ?? 0)
    : null;
  if (key && context.seen.has(key)) {
    throw new PdfSyntaxError("Pages tree contains a cycle.", {
      offset: object.offset,
      code: "pdf.pages.cycle"
    });
  }
  if (key) {
    context.seen.add(key);
  }
  const type = nameValue(dict.entries.Type);
  const nextInherited = mergeInherited(inherited, dict, getObject);

  if (type === "Pages") {
    const kids = dict.entries.Kids;
    if (!kids || kids.type !== "array") {
      throw new PdfSyntaxError("Pages node is missing Kids array.", {
        offset: object.offset,
        code: "pdf.pages.kids_missing"
      });
    }
    for (const kidRef of kids.items) {
      const kid = getObject(kidRef);
      if (!kid) {
        throw new PdfSyntaxError("Pages tree references a missing child.", {
          offset: object.offset,
          code: "pdf.pages.kid_missing"
        });
      }
      walkPageNode(kid, nextInherited, getObject, pages, {
        ...context,
        depth: context.depth + 1
      });
    }
    if (key) {
      context.seen.delete(key);
    }
    return;
  }

  if (type !== "Page") {
    throw new PdfSyntaxError(`Unexpected page tree node type "${type ?? "unknown"}".`, {
      offset: object.offset,
      code: "pdf.pages.type_unexpected"
    });
  }

  const mediaBox = numberArray(nextInherited.mediaBox);
  const cropBox = numberArray(nextInherited.cropBox);
  const visibleBox = cropBox ?? mediaBox;
  const rotation = typeof nextInherited.rotate === "number" ? nextInherited.rotate : 0;
  const userUnit = typeof nextInherited.userUnit === "number" ? nextInherited.userUnit : 1;
  const contentStreams = resolveContentStreams(dict.entries.Contents, getObject);
  const resources = resolveResources(
    nextInherited.resources,
    getObject,
    context.maxCMapMappings,
    {
      depth: 0,
      maxDepth: context.maxDepth,
      formCache: new Map()
    }
  );

  pages.push({
    objectNumber: object.objectNumber,
    generationNumber: object.generationNumber,
    mediaBox,
    cropBox,
    widthPt: visibleBox ? Math.abs(visibleBox[2] - visibleBox[0]) * userUnit : null,
    heightPt: visibleBox ? Math.abs(visibleBox[3] - visibleBox[1]) * userUnit : null,
    rotation,
    userUnit,
    resources,
    annotationsRef: dict.entries.Annots ?? null,
    contentStreams
  });
  if (key) {
    context.seen.delete(key);
  }
}

function mergeInherited(inherited, dict, getObject) {
  return {
    resources: dict.entries.Resources ?? inherited.resources ?? null,
    mediaBox: dict.entries.MediaBox ?? inherited.mediaBox ?? null,
    cropBox: dict.entries.CropBox ?? inherited.cropBox ?? null,
    rotate: resolveScalar(dict.entries.Rotate ?? inherited.rotate ?? 0, getObject),
    userUnit: resolveScalar(dict.entries.UserUnit ?? inherited.userUnit ?? 1, getObject)
  };
}

function resolveContentStreams(contents, getObject) {
  if (!contents) {
    return [];
  }

  const values = contents.type === "array" ? contents.items : [contents];
  const streams = [];
  for (const value of values) {
    const object = getObject(value);
    if (object?.stream) {
      streams.push(object.stream);
    }
  }
  return streams;
}

function resolveResources(resourcesValue, getObject, maxCMapMappings, options = {}) {
  const depth = options.depth ?? 0;
  const maxDepth = options.maxDepth ?? 100;
  const formCache = options.formCache ?? new Map();
  enforceDepthLimit(depth, maxDepth, null);
  const resources = resolveValue(resourcesValue, getObject);
  const fonts = {};
  const xobjects = {};

  if (!isDict(resources)) {
    return {
      fonts,
      xobjects
    };
  }

  const fontDictionary = resolveValue(resources.entries.Font, getObject);
  if (isDict(fontDictionary)) {
    for (const [name, fontValue] of Object.entries(fontDictionary.entries)) {
      const fontObject = getObject(fontValue);
      const fontDict = resolveValue(fontValue, getObject);
      const toUnicodeObject = getObject(fontDict?.entries?.ToUnicode);
      let toUnicode = null;
      if (toUnicodeObject?.stream) {
        try {
          toUnicode = parseToUnicodeCMap(toUnicodeObject.stream.text, {
            maxMappings: maxCMapMappings
          });
        } catch (error) {
          if (error instanceof PdfCMapParseError) {
            throw new PdfSyntaxError(error.message, {
              offset: toUnicodeObject.offset,
              code: error.code
            });
          }
          throw error;
        }
      }
      const encoding = fontEncoding(fontDict, getObject);
      fonts[name] = {
        objectNumber: fontObject?.objectNumber ?? null,
        generationNumber: fontObject?.generationNumber ?? null,
        subtype: nameValue(fontDict?.entries?.Subtype),
        baseFont: nameValue(fontDict?.entries?.BaseFont),
        encoding: encoding.name,
        ...(encoding.differences ? { encodingDifferences: encoding.differences } : {}),
        firstChar: fontFirstChar(fontDict, getObject),
        lastChar: fontLastChar(fontDict, getObject),
        widths: fontWidths(fontDict, getObject),
        hasToUnicode: Boolean(toUnicodeObject?.stream),
        toUnicode,
        toUnicodeEntries: toUnicode?.entries ?? 0
      };
    }
  }

  const xObjectDictionary = resolveValue(resources.entries.XObject, getObject);
  if (isDict(xObjectDictionary)) {
    for (const [name, xObjectValue] of Object.entries(xObjectDictionary.entries)) {
      const xObject = getObject(xObjectValue);
      const xObjectDict = resolveValue(xObjectValue, getObject);
      if (!isDict(xObjectDict)) {
        continue;
      }

      const filters = xObject?.stream?.filters ?? filterNames(xObjectDict);
      const summary = {
        objectNumber: xObject?.objectNumber ?? null,
        generationNumber: xObject?.generationNumber ?? null,
        subtype: nameValue(xObjectDict.entries.Subtype),
        width: numberValue(xObjectDict.entries.Width),
        height: numberValue(xObjectDict.entries.Height),
        bitsPerComponent: numberValue(xObjectDict.entries.BitsPerComponent),
        colorSpace: summarizeColorSpace(xObjectDict.entries.ColorSpace),
        filters,
        skippedFilters: xObject?.stream?.skippedFilters ?? [],
        mediaType: imageMediaType(filters),
        rawLength: xObject?.stream?.rawLength ?? null,
        decodedLength: xObject?.stream?.decodedLength ?? null
      };
      if (summary.subtype !== "Form" || !xObject?.stream) {
        xobjects[name] = summary;
        continue;
      }

      const key = Number.isInteger(xObject.objectNumber)
        ? objectKey(xObject.objectNumber, xObject.generationNumber ?? 0)
        : null;
      const cached = key ? formCache.get(key) : null;
      if (cached) {
        xobjects[name] = cached;
        continue;
      }

      summary.matrix = formMatrix(xObjectDict.entries.Matrix, getObject);
      summary.bbox = formBoundingBox(xObjectDict.entries.BBox, getObject);
      Object.defineProperties(summary, {
        stream: {
          value: xObject.stream,
          enumerable: false
        },
        resources: {
          value: null,
          writable: true,
          enumerable: false
        }
      });
      if (key) {
        formCache.set(key, summary);
      }
      summary.resources = xObjectDict.entries.Resources
        ? resolveResources(xObjectDict.entries.Resources, getObject, maxCMapMappings, {
            depth: depth + 1,
            maxDepth,
            formCache
          })
        : null;
      xobjects[name] = summary;
    }
  }

  return {
    fonts,
    xobjects
  };
}

function filterNames(dictionary) {
  const filterValue = dictionary?.entries?.Filter;
  if (!filterValue) {
    return [];
  }
  const values = filterValue.type === "array" ? filterValue.items : [filterValue];
  return values.map((value) => nameValue(value)).filter(Boolean);
}

function imageMediaType(filters) {
  if (filters.includes("DCTDecode")) {
    return "image/jpeg";
  }
  if (filters.includes("JPXDecode")) {
    return "image/jp2";
  }
  if (filters.includes("JBIG2Decode")) {
    return "image/jbig2";
  }
  if (filters.includes("CCITTFaxDecode")) {
    return "image/g3fax";
  }
  return null;
}

function numberValue(value) {
  return typeof value === "number" ? value : null;
}

function summarizeColorSpace(value) {
  if (value?.type === "name") {
    return value.value;
  }
  if (value?.type === "array") {
    const first = value.items[0];
    return first?.type === "name" ? first.value : "array";
  }
  if (value?.type === "ref") {
    return "indirect";
  }
  return null;
}

function resolveValue(value, getObject) {
  if (value?.type === "ref") {
    return getObject(value)?.value ?? null;
  }
  return value ?? null;
}

function resolveScalar(value, getObject) {
  const resolved = resolveValue(value, getObject);
  return typeof resolved === "number" ? resolved : value;
}

function fontFirstChar(fontDict, getObject) {
  const firstChar = resolveScalar(fontDict?.entries?.FirstChar, getObject);
  return Number.isInteger(firstChar) ? firstChar : null;
}

function fontLastChar(fontDict, getObject) {
  const lastChar = resolveScalar(fontDict?.entries?.LastChar, getObject);
  return Number.isInteger(lastChar) ? lastChar : null;
}

function fontWidths(fontDict, getObject) {
  const widths = numberArray(resolveValue(fontDict?.entries?.Widths, getObject));
  return widths?.length > 0 ? widths : null;
}

function fontEncoding(fontDict, getObject) {
  const encoding = resolveValue(fontDict?.entries?.Encoding, getObject);
  if (encoding?.type === "name") {
    return { name: encoding.value, differences: null };
  }
  if (!isDict(encoding)) {
    return { name: null, differences: null };
  }
  const baseEncoding = resolveValue(encoding.entries.BaseEncoding, getObject);
  const differencesValue = resolveValue(encoding.entries.Differences, getObject);
  const differences = {};
  let code = null;
  if (differencesValue?.type === "array") {
    for (const item of differencesValue.items) {
      const resolved = resolveValue(item, getObject);
      if (Number.isInteger(resolved)) {
        code = resolved >= 0 && resolved <= 255 ? resolved : null;
        continue;
      }
      if (resolved?.type === "name" && Number.isInteger(code) && code <= 255) {
        differences[code] = resolved.value;
        code += 1;
      }
    }
  }
  return {
    name: nameValue(baseEncoding),
    differences: Object.keys(differences).length > 0 ? differences : null
  };
}

function formMatrix(value, getObject) {
  const matrix = numberArray(resolveValue(value, getObject));
  return matrix?.length === 6 ? [...matrix] : [1, 0, 0, 1, 0, 0];
}

function formBoundingBox(value, getObject) {
  const bbox = numberArray(resolveValue(value, getObject));
  return bbox?.length === 4 ? [...bbox] : null;
}

function numberArray(value) {
  if (!value || value.type !== "array") {
    return null;
  }
  if (!value.items.every((item) => typeof item === "number")) {
    return null;
  }
  return value.items;
}

function isDict(value) {
  return value?.type === "dict" && value.entries && typeof value.entries === "object";
}

function nameValue(value) {
  return value?.type === "name" ? value.value : null;
}

export function isPdfDictionary(value) {
  return isDict(value);
}

export function pdfNameValue(value) {
  return nameValue(value);
}

export function pdfTextStringValue(value) {
  return pdfTextValue(value);
}

export function resolvePdfValue(value, getObject) {
  return resolveValue(value, getObject);
}

function trimTrailingLineEnding(source, offset) {
  if (source[offset - 2] === "\r" && source[offset - 1] === "\n") {
    return offset - 2;
  }
  if (source[offset - 1] === "\n" || source[offset - 1] === "\r") {
    return offset - 1;
  }
  return offset;
}

class ObjectParser {
  constructor(source, offset = 0, { maxDepth = 100 } = {}) {
    this.source = source;
    this.offset = offset;
    this.maxDepth = maxDepth;
  }

  parseValue(depth = 0) {
    enforceDepthLimit(depth, this.maxDepth, this.offset);
    this.offset = skipWhitespaceAndComments(this.source, this.offset);
    const start = this.offset;
    const char = this.source[this.offset];

    if (char === undefined) {
      throw new PdfSyntaxError("Unexpected end of input.", {
        offset: this.offset,
        code: "pdf.value.eof"
      });
    }

    if (char === "[" ) {
      return this.parseArray(depth);
    }
    if (char === "<" && this.source[this.offset + 1] === "<") {
      return this.parseDictionary(depth);
    }
    if (char === "<") {
      return this.parseHexString();
    }
    if (char === "(") {
      return this.parseLiteralString();
    }
    if (char === "/") {
      return this.parseName();
    }
    if (isNumberStart(char)) {
      return this.parseNumberOrReference();
    }

    const word = this.readWord();
    if (word === "true") {
      return { value: true, offset: this.offset };
    }
    if (word === "false") {
      return { value: false, offset: this.offset };
    }
    if (word === "null") {
      return { value: null, offset: this.offset };
    }

    throw new PdfSyntaxError(`Unexpected token "${word}".`, {
      offset: start,
      code: "pdf.value.unexpected"
    });
  }

  parseArray(depth) {
    const items = [];
    this.offset += 1;
    while (this.offset < this.source.length) {
      this.offset = skipWhitespaceAndComments(this.source, this.offset);
      if (this.source[this.offset] === "]") {
        this.offset += 1;
        return {
          value: {
            type: "array",
            items
          },
          offset: this.offset
        };
      }
      const parsed = this.parseValue(depth + 1);
      items.push(parsed.value);
      this.offset = parsed.offset;
    }
    throw new PdfSyntaxError("Unterminated array.", {
      offset: this.offset,
      code: "pdf.array.unterminated"
    });
  }

  parseDictionary(depth) {
    const entries = {};
    this.offset += 2;
    while (this.offset < this.source.length) {
      this.offset = skipWhitespaceAndComments(this.source, this.offset);
      if (this.source.startsWith(">>", this.offset)) {
        this.offset += 2;
        return {
          value: {
            type: "dict",
            entries
          },
          offset: this.offset
        };
      }

      const key = this.parseName().value.value;
      const parsed = this.parseValue(depth + 1);
      entries[key] = parsed.value;
      this.offset = parsed.offset;
    }

    throw new PdfSyntaxError("Unterminated dictionary.", {
      offset: this.offset,
      code: "pdf.dict.unterminated"
    });
  }

  parseLiteralString() {
    this.offset += 1;
    let depth = 1;
    let value = "";

    while (this.offset < this.source.length) {
      const char = this.source[this.offset];
      if (char === "\\") {
        const next = this.source[this.offset + 1];
        if (next === undefined) {
          this.offset += 1;
          continue;
        }
        value += char + next;
        this.offset += 2;
        continue;
      }
      if (char === "(") {
        depth += 1;
      }
      if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          this.offset += 1;
          return {
            value: decodePdfString(value),
            offset: this.offset
          };
        }
      }
      value += char;
      this.offset += 1;
    }

    throw new PdfSyntaxError("Unterminated literal string.", {
      offset: this.offset,
      code: "pdf.string.unterminated"
    });
  }

  parseHexString() {
    const start = this.offset;
    this.offset += 1;
    const end = this.source.indexOf(">", this.offset);
    if (end === -1) {
      throw new PdfSyntaxError("Unterminated hex string.", {
        offset: start,
        code: "pdf.hex_string.unterminated"
      });
    }
    const value = this.source.slice(this.offset, end).replace(/\s+/g, "");
    this.offset = end + 1;
    return {
      value: {
        type: "hex-string",
        value
      },
      offset: this.offset
    };
  }

  parseName() {
    const start = this.offset;
    if (this.source[this.offset] !== "/") {
      throw new PdfSyntaxError("Expected name.", {
        offset: this.offset,
        code: "pdf.name.expected"
      });
    }
    this.offset += 1;
    while (
      this.offset < this.source.length &&
      !isWhitespace(this.source[this.offset]) &&
      !isDelimiter(this.source[this.offset])
    ) {
      this.offset += 1;
    }
    return {
      value: {
        type: "name",
        value: decodeName(this.source.slice(start + 1, this.offset))
      },
      offset: this.offset
    };
  }

  parseNumberOrReference() {
    const first = this.readNumber();
    const afterFirst = this.offset;
    const refOffset = skipWhitespaceAndComments(this.source, this.offset);

    if (Number.isInteger(first.value)) {
      try {
        const secondParser = new ObjectParser(this.source, refOffset, { maxDepth: this.maxDepth });
        const second = secondParser.readNumber();
        const afterSecond = skipWhitespaceAndComments(this.source, secondParser.offset);
        if (
          Number.isInteger(second.value) &&
          this.source[afterSecond] === "R" &&
          isTokenBoundary(this.source[afterSecond + 1])
        ) {
          this.offset = afterSecond + 1;
          return {
            value: {
              type: "ref",
              objectNumber: first.value,
              generationNumber: second.value
            },
            offset: this.offset
          };
        }
      } catch (error) {
        if (!(error instanceof PdfSyntaxError)) {
          throw error;
        }
      }
    }

    this.offset = afterFirst;
    return first;
  }

  readNumber() {
    const match = this.source.slice(this.offset).match(/^[-+]?(?:\d+\.\d+|\d+|\.\d+)/);
    if (!match) {
      throw new PdfSyntaxError("Expected number.", {
        offset: this.offset,
        code: "pdf.number.expected"
      });
    }
    this.offset += match[0].length;
    return {
      value: Number(match[0]),
      offset: this.offset
    };
  }

  readWord() {
    const start = this.offset;
    while (
      this.offset < this.source.length &&
      !isWhitespace(this.source[this.offset]) &&
      !isDelimiter(this.source[this.offset])
    ) {
      this.offset += 1;
    }
    return this.source.slice(start, this.offset);
  }
}

function readInteger(source, offset, label) {
  const cursor = skipWhitespaceAndComments(source, offset);
  const match = source.slice(cursor).match(/^\d+/);
  if (!match) {
    throw new PdfSyntaxError(`Expected ${label}.`, {
      offset: cursor,
      code: "pdf.integer.expected"
    });
  }
  return {
    value: Number.parseInt(match[0], 10),
    offset: cursor + match[0].length
  };
}

function skipWhitespaceAndComments(source, offset) {
  while (offset < source.length) {
    const char = source[offset];
    if (isWhitespace(char)) {
      offset += 1;
      continue;
    }
    if (char === "%") {
      while (offset < source.length && source[offset] !== "\n" && source[offset] !== "\r") {
        offset += 1;
      }
      continue;
    }
    break;
  }
  return offset;
}

function isWhitespace(char) {
  return char === "\0" || char === "\t" || char === "\n" || char === "\f" || char === "\r" || char === " ";
}

function isDelimiter(char) {
  return char === "(" || char === ")" || char === "<" || char === ">" || char === "[" || char === "]" || char === "{" || char === "}" || char === "/" || char === "%";
}

function isTokenBoundary(char) {
  return char === undefined || isWhitespace(char) || isDelimiter(char);
}

function isNumberStart(char) {
  return char === "+" || char === "-" || char === "." || /\d/.test(char);
}

function decodeName(value) {
  return value.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function decodePdfString(value) {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      output += character;
      continue;
    }

    const next = value[index + 1];
    if (next === undefined) {
      continue;
    }

    if (/[0-7]/.test(next)) {
      const octal = value.slice(index + 1).match(/^[0-7]{1,3}/)?.[0] ?? "";
      output += String.fromCharCode(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }

    const escapes = {
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      "(": "(",
      ")": ")",
      "\\": "\\"
    };
    output += escapes[next] ?? next;
    index += 1;
  }
  return output;
}

function objectKey(objectNumber, generationNumber) {
  return `${objectNumber}:${generationNumber}`;
}
