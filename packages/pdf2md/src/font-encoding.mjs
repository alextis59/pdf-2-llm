import {
  isSupportedSimpleEncoding,
  simpleEncodingCodePoint,
  unicodeForGlyphName
} from "./simple-font-encodings.mjs";

export class PdfCMapParseError extends Error {
  constructor(message, { code = "pdf.cmap_parse_failed" } = {}) {
    super(message);
    this.name = "PdfCMapParseError";
    this.code = code;
  }
}

export function parseToUnicodeCMap(cmapText, { maxMappings = 65_536 } = {}) {
  if (!Number.isInteger(maxMappings) || maxMappings < 0) {
    throw new RangeError("maxMappings must be a non-negative integer");
  }
  const map = new Map();
  const codespaces = [];
  const mappingBudget = { used: 0, max: maxMappings };

  for (const block of readCMapBlocks(cmapText, "begincodespacerange", "endcodespacerange")) {
    for (const match of block.matchAll(/<([0-9a-fA-F\s]+)>\s*<([0-9a-fA-F\s]+)>/g)) {
      const start = normalizeHex(match[1]);
      const end = normalizeHex(match[2]);
      if (start.length > 0 && start.length === end.length && start.length % 2 === 0) {
        codespaces.push({
          start,
          end,
          length: start.length / 2
        });
      }
    }
  }

  for (const block of readCMapBlocks(cmapText, "beginbfchar", "endbfchar")) {
    for (const match of block.matchAll(/<([0-9a-fA-F\s]+)>\s*<([0-9a-fA-F\s]+)>/g)) {
      consumeMappingBudget(mappingBudget, 1);
      map.set(normalizeHex(match[1]), utf16BeHexToString(match[2]));
    }
  }

  for (const block of readCMapBlocks(cmapText, "beginbfrange", "endbfrange")) {
    parseBfRangeBlock(block, map, mappingBudget);
  }

  if (codespaces.length === 0) {
    for (const length of new Set([...map.keys()].map((key) => key.length / 2))) {
      codespaces.push({
        start: "00".repeat(length),
        end: "FF".repeat(length),
        length
      });
    }
  }

  return {
    codespaces,
    entries: map.size,
    map
  };
}

export function decodePdfStringWithFont(token, font) {
  return decodePdfGlyphsWithFont(token, font)
    .map((glyph) => glyph.text)
    .join("");
}

export function decodePdfGlyphsWithFont(token, font) {
  if (!token || token.type !== "string") {
    return [];
  }

  const bytes = token.bytes ?? latin1Bytes(token.value);
  const toUnicode = font?.toUnicode;
  if (!toUnicode?.map || toUnicode.map.size === 0) {
    return isSupportedSimpleEncoding(font?.encoding)
      ? decodeBytesWithSimpleEncodingGlyphs(bytes, font)
      : [...bytes].map((byte) => decodedGlyph(fallbackByteToText(byte), [byte]));
  }

  return decodeBytesWithCMapGlyphs(bytes, toUnicode);
}

export function isTrustedSimpleEncoding(font) {
  return (
    isSupportedSimpleEncoding(font?.encoding) &&
    Object.values(font?.encodingDifferences ?? {}).every(
      (glyphName) => unicodeForGlyphName(glyphName) !== null
    )
  );
}

function decodeBytesWithSimpleEncodingGlyphs(bytes, font) {
  const differences = font.encodingDifferences ?? {};
  return [...bytes]
    .map((byte) => {
      const glyphName = differences[byte];
      if (glyphName !== undefined) {
        return decodedGlyph(unicodeForGlyphName(glyphName) ?? fallbackByteToText(byte), [byte]);
      }
      const codePoint = simpleEncodingCodePoint(font.encoding, byte);
      const text = codePoint >= 0 ? String.fromCodePoint(codePoint) : fallbackByteToText(byte);
      return decodedGlyph(text, [byte]);
    });
}

function parseBfRangeBlock(block, map, mappingBudget) {
  const rangePattern =
    /<([0-9a-fA-F\s]+)>\s*<([0-9a-fA-F\s]+)>\s*(?:<([0-9a-fA-F\s]+)>|\[((?:\s*<[\dA-Fa-f\s]+>\s*)+)\])/g;

  for (const match of block.matchAll(rangePattern)) {
    const startHex = normalizeHex(match[1]);
    const endHex = normalizeHex(match[2]);
    const startCode = Number.parseInt(startHex, 16);
    const endCode = Number.parseInt(endHex, 16);
    if (!Number.isSafeInteger(startCode) || !Number.isSafeInteger(endCode) || endCode < startCode) {
      continue;
    }

    if (match[3]) {
      const destinationStart = normalizeHex(match[3]);
      const destinationCode = Number.parseInt(destinationStart, 16);
      if (!Number.isSafeInteger(destinationCode)) {
        continue;
      }
      const rangeMappings = endCode - startCode + 1;
      consumeMappingBudget(mappingBudget, rangeMappings);
      for (let code = startCode; code <= endCode; code += 1) {
        const source = code.toString(16).padStart(startHex.length, "0").toUpperCase();
        const destination = (destinationCode + code - startCode)
          .toString(16)
          .padStart(destinationStart.length, "0")
          .toUpperCase();
        map.set(source, utf16BeHexToString(destination));
      }
      continue;
    }

    let index = 0;
    for (const destination of match[4].matchAll(/<([0-9a-fA-F\s]+)>/g)) {
      if (startCode + index > endCode) {
        break;
      }
      consumeMappingBudget(mappingBudget, 1);
      const source = (startCode + index).toString(16).padStart(startHex.length, "0").toUpperCase();
      map.set(source, utf16BeHexToString(normalizeHex(destination[1])));
      index += 1;
    }
  }
}

function consumeMappingBudget(budget, count) {
  if (!Number.isSafeInteger(count) || count < 0 || count > budget.max - budget.used) {
    throw new PdfCMapParseError("ToUnicode CMap mappings exceed parser limit.", {
      code: "pdf.cmap_mapping_limit_exceeded"
    });
  }
  budget.used += count;
}

function decodeBytesWithCMapGlyphs(bytes, cmap) {
  const candidates = cmap.codespaces
    .filter((codespace) => Number.isInteger(codespace.length) && codespace.length > 0)
    .sort((left, right) => right.length - left.length);
  const output = [];
  let offset = 0;

  while (offset < bytes.length) {
    let matched = false;
    for (const codespace of candidates) {
      if (offset + codespace.length > bytes.length) {
        continue;
      }

      const codeBytes = bytes.slice(offset, offset + codespace.length);
      const key = bytesToHex(codeBytes);
      if (!codeFallsInCodespace(key, codespace)) {
        continue;
      }

      const mapped = cmap.map.get(key);
      if (mapped !== undefined) {
        output.push(decodedGlyph(mapped, codeBytes));
        offset += codespace.length;
        matched = true;
        break;
      }
    }

    if (!matched) {
      output.push(decodedGlyph(fallbackByteToText(bytes[offset]), [bytes[offset]]));
      offset += 1;
    }
  }

  return output;
}

function decodedGlyph(text, bytes) {
  const sourceCodeHex = bytesToHex(bytes);
  const sourceCode = Number.parseInt(sourceCodeHex, 16);
  return {
    text,
    sourceCode: Number.isSafeInteger(sourceCode) ? sourceCode : null,
    sourceCodeHex
  };
}

function readCMapBlocks(text, beginMarker, endMarker) {
  const blocks = [];
  let offset = 0;
  while (offset < text.length) {
    const begin = text.indexOf(beginMarker, offset);
    if (begin === -1) {
      break;
    }
    const blockStart = begin + beginMarker.length;
    const end = text.indexOf(endMarker, blockStart);
    if (end === -1) {
      break;
    }
    blocks.push(text.slice(blockStart, end));
    offset = end + endMarker.length;
  }
  return blocks;
}

function codeFallsInCodespace(hex, codespace) {
  if (hex.length !== codespace.start.length || hex.length !== codespace.end.length) {
    return false;
  }
  return hex >= codespace.start && hex <= codespace.end;
}

function utf16BeHexToString(value) {
  const hex = normalizeHex(value);
  const codeUnits = [];
  for (let index = 0; index + 3 < hex.length; index += 4) {
    codeUnits.push(Number.parseInt(hex.slice(index, index + 4), 16));
  }
  return String.fromCharCode(...codeUnits);
}

function normalizeHex(value) {
  return value.replace(/\s+/g, "").toUpperCase();
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join("");
}

function fallbackByteToText(byte) {
  if (byte >= 0 && byte <= 0x1f) {
    return String.fromCodePoint(0x2400 + byte);
  }
  if (byte === 0x7f) {
    return "\u2421";
  }
  return String.fromCharCode(byte);
}

function latin1Bytes(value) {
  return [...value].map((char) => char.charCodeAt(0) & 0xff);
}
