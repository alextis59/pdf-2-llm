import { bytesToLatin1 as runtimeBytesToLatin1 } from "./runtime.mjs";

export function parseToUnicodeCMap(cmapText) {
  const map = new Map();
  const codespaces = [];

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
      map.set(normalizeHex(match[1]), utf16BeHexToString(match[2]));
    }
  }

  for (const block of readCMapBlocks(cmapText, "beginbfrange", "endbfrange")) {
    parseBfRangeBlock(block, map);
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
  if (!token || token.type !== "string") {
    return "";
  }

  const bytes = token.bytes ?? latin1Bytes(token.value);
  const toUnicode = font?.toUnicode;
  if (!toUnicode?.map || toUnicode.map.size === 0) {
    return bytesToLatin1(bytes);
  }

  return decodeBytesWithCMap(bytes, toUnicode);
}

export function isTrustedSimpleEncoding(font) {
  return (
    font?.encoding === "WinAnsiEncoding" ||
    font?.encoding === "StandardEncoding" ||
    font?.encoding === "MacRomanEncoding"
  );
}

function parseBfRangeBlock(block, map) {
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

    const destinations = [...match[4].matchAll(/<([0-9a-fA-F\s]+)>/g)].map((item) =>
      normalizeHex(item[1])
    );
    for (let index = 0; index < destinations.length && startCode + index <= endCode; index += 1) {
      const source = (startCode + index).toString(16).padStart(startHex.length, "0").toUpperCase();
      map.set(source, utf16BeHexToString(destinations[index]));
    }
  }
}

function decodeBytesWithCMap(bytes, cmap) {
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
        output.push(mapped);
        offset += codespace.length;
        matched = true;
        break;
      }
    }

    if (!matched) {
      output.push(String.fromCharCode(bytes[offset]));
      offset += 1;
    }
  }

  return output.join("");
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

function bytesToLatin1(bytes) {
  return runtimeBytesToLatin1(bytes);
}

function latin1Bytes(value) {
  return [...value].map((char) => char.charCodeAt(0) & 0xff);
}
