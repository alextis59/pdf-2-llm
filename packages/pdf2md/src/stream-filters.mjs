import { bytesToLatin1, inflateFlateSync } from "./runtime.mjs";

export class PdfStreamDecodeError extends Error {
  constructor(message, { code = "pdf.stream.decode", offset = null } = {}) {
    super(message);
    this.name = "PdfStreamDecodeError";
    this.code = code;
    this.offset = offset;
  }
}

const filterAliases = new Map([
  ["Fl", "FlateDecode"],
  ["FlateDecode", "FlateDecode"],
  ["AHx", "ASCIIHexDecode"],
  ["ASCIIHexDecode", "ASCIIHexDecode"],
  ["A85", "ASCII85Decode"],
  ["ASCII85Decode", "ASCII85Decode"],
  ["RL", "RunLengthDecode"],
  ["RunLengthDecode", "RunLengthDecode"],
  ["LZW", "LZWDecode"],
  ["LZWDecode", "LZWDecode"],
  ["DCT", "DCTDecode"],
  ["DCTDecode", "DCTDecode"],
  ["JPX", "JPXDecode"],
  ["JPXDecode", "JPXDecode"],
  ["CCF", "CCITTFaxDecode"],
  ["CCITTFaxDecode", "CCITTFaxDecode"],
  ["JBIG2Decode", "JBIG2Decode"]
]);

const metadataOnlyFilters = new Map([
  ["DCTDecode", { mediaType: "image/jpeg", family: "raster-image" }],
  ["JPXDecode", { mediaType: "image/jp2", family: "raster-image" }],
  ["CCITTFaxDecode", { mediaType: "image/g3fax", family: "raster-image" }],
  ["JBIG2Decode", { mediaType: "image/jbig2", family: "raster-image" }]
]);

export function decodeStreamBytes(bytes, dictionary, { maxBytes = 50 * 1024 * 1024 } = {}) {
  const filters = readFilters(dictionary);
  const decodeParms = readDecodeParms(dictionary, filters.length);
  let output = bytes;
  const skippedFilters = [];
  if (filters.length === 0) {
    enforceMaxBytes(output, maxBytes, "unfiltered");
  }

  for (let index = 0; index < filters.length; index += 1) {
    const filter = filters[index];
    const parms = decodeParms[index];
    const metadataOnly = metadataOnlyFilters.get(filter);
    if (metadataOnly) {
      skippedFilters.push({
        filter,
        reason: "metadata-only",
        ...metadataOnly
      });
    } else {
      output = decodeOneFilter(output, filter, parms, maxBytes);
    }
    enforceMaxBytes(output, maxBytes, filter);
  }

  return {
    bytes: output,
    filters,
    decodeParms,
    skippedFilters
  };
}

function decodeOneFilter(bytes, filter, parms, maxBytes) {
  if (filter === "FlateDecode") {
    let inflated;
    try {
      inflated = inflateFlateSync(bytes);
    } catch (error) {
      throw new PdfStreamDecodeError(`FlateDecode failed: ${error.message}`, {
        code: "pdf.stream.flate_failed"
      });
    }
    return applyPredictor(inflated, parms, maxBytes);
  }

  if (filter === "ASCIIHexDecode") {
    return decodeAsciiHex(bytes, maxBytes);
  }

  if (filter === "ASCII85Decode") {
    return decodeAscii85(bytes, maxBytes);
  }

  if (filter === "RunLengthDecode") {
    return decodeRunLength(bytes, maxBytes);
  }

  if (filter === "LZWDecode") {
    return applyPredictor(decodeLzw(bytes, parms, maxBytes), parms, maxBytes);
  }

  throw new PdfStreamDecodeError(`Unsupported stream filter "${filter}".`, {
    code: "pdf.stream.filter_unsupported"
  });
}

function readFilters(dictionary) {
  const filterValue = dictionary?.entries?.Filter;
  if (!filterValue) {
    return [];
  }

  const filters = filterValue.type === "array" ? filterValue.items : [filterValue];
  return filters.map((filter) => {
    const name = filter?.type === "name" ? filter.value : null;
    const canonical = filterAliases.get(name);
    if (!canonical) {
      throw new PdfStreamDecodeError(`Unsupported stream filter "${name ?? "unknown"}".`, {
        code: "pdf.stream.filter_unsupported"
      });
    }
    return canonical;
  });
}

function readDecodeParms(dictionary, filterCount) {
  const parmsValue = dictionary?.entries?.DecodeParms ?? dictionary?.entries?.DP;
  if (!parmsValue) {
    return Array(filterCount).fill(null);
  }

  if (parmsValue.type === "array") {
    return Array.from({ length: filterCount }, (_, index) => parmsValue.items[index] ?? null);
  }

  return Array(filterCount).fill(parmsValue);
}

function decodeAsciiHex(bytes, maxBytes) {
  const text = bytesToLatin1(bytes);
  let hex = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/\s/.test(char)) {
      continue;
    }
    if (char === ">") {
      break;
    }
    if (!/[0-9a-fA-F]/.test(char)) {
      throw new PdfStreamDecodeError("ASCIIHexDecode encountered a non-hex character.", {
        code: "pdf.stream.asciihex_invalid"
      });
    }
    hex += char;
  }

  if (hex.length % 2 === 1) {
    hex += "0";
  }

  enforceOutputLength(hex.length / 2, maxBytes, "ASCIIHexDecode");
  const output = new Uint8Array(hex.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

function decodeAscii85(bytes, maxBytes) {
  const text = bytesToLatin1(bytes);
  const output = [];
  let group = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/\s/.test(char)) {
      continue;
    }
    if (char === "<" && text[index + 1] === "~") {
      index += 1;
      continue;
    }
    if (char === "~" && text[index + 1] === ">") {
      break;
    }
    if (char === "z") {
      if (group.length !== 0) {
        throw new PdfStreamDecodeError("ASCII85 z shortcut appeared inside a group.", {
          code: "pdf.stream.ascii85_invalid_z"
        });
      }
      appendOutputBytes(output, [0, 0, 0, 0], maxBytes, "ASCII85Decode");
      continue;
    }
    if (char < "!" || char > "u") {
      throw new PdfStreamDecodeError("ASCII85Decode encountered an invalid character.", {
        code: "pdf.stream.ascii85_invalid"
      });
    }

    group += char;
    if (group.length === 5) {
      appendOutputBytes(output, decodeAscii85Group(group, 4), maxBytes, "ASCII85Decode");
      group = "";
    }
  }

  if (group.length > 0) {
    if (group.length === 1) {
      throw new PdfStreamDecodeError("ASCII85Decode ended with an invalid partial group.", {
        code: "pdf.stream.ascii85_partial"
      });
    }
    const outputBytes = group.length - 1;
    appendOutputBytes(
      output,
      decodeAscii85Group(group.padEnd(5, "u"), outputBytes),
      maxBytes,
      "ASCII85Decode"
    );
  }

  return new Uint8Array(output);
}

function decodeAscii85Group(group, outputBytes) {
  let value = 0;
  for (let index = 0; index < group.length; index += 1) {
    value = value * 85 + (group.charCodeAt(index) - 33);
  }
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ].slice(0, outputBytes);
}

function decodeRunLength(bytes, maxBytes) {
  const output = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const length = bytes[index];
    if (length === 128) {
      return new Uint8Array(output);
    }
    if (length <= 127) {
      const count = length + 1;
      if (index + count >= bytes.length) {
        throw new PdfStreamDecodeError("RunLengthDecode literal run is truncated.", {
          code: "pdf.stream.runlength_truncated"
        });
      }
      enforceOutputLength(output.length + count, maxBytes, "RunLengthDecode");
      for (let cursor = 0; cursor < count; cursor += 1) {
        output.push(bytes[index + 1 + cursor]);
      }
      index += count;
      continue;
    }

    const count = 257 - length;
    if (index + 1 >= bytes.length) {
      throw new PdfStreamDecodeError("RunLengthDecode repeat run is truncated.", {
        code: "pdf.stream.runlength_truncated"
      });
    }
    enforceOutputLength(output.length + count, maxBytes, "RunLengthDecode");
    for (let cursor = 0; cursor < count; cursor += 1) {
      output.push(bytes[index + 1]);
    }
    index += 1;
  }

  throw new PdfStreamDecodeError("RunLengthDecode missing EOD marker.", {
    code: "pdf.stream.runlength_eod_missing"
  });
}

function decodeLzw(bytes, parms, maxBytes) {
  const earlyChange = numberParm(parms, "EarlyChange", 1);
  if (earlyChange !== 0 && earlyChange !== 1) {
    throw new PdfStreamDecodeError(`Unsupported LZW EarlyChange value ${earlyChange}.`, {
      code: "pdf.stream.lzw_early_change_unsupported"
    });
  }

  let dictionary = createLzwDictionary();
  let codeSize = 9;
  let nextCode = 258;
  let previous = null;
  let sawEod = false;
  const output = [];
  const reader = {
    bitOffset: 0
  };

  while (true) {
    const code = readLzwCode(bytes, reader, codeSize);
    if (code === null) {
      break;
    }

    if (code === 256) {
      dictionary = createLzwDictionary();
      codeSize = 9;
      nextCode = 258;
      previous = null;
      continue;
    }

    if (code === 257) {
      sawEod = true;
      break;
    }

    let entry = dictionary[code] ?? null;
    if (!entry && previous && code === nextCode) {
      entry = concatLzwEntry(previous, previous[0]);
    }
    if (!entry) {
      throw new PdfStreamDecodeError("LZWDecode referenced an invalid code.", {
        code: "pdf.stream.lzw_code_invalid"
      });
    }

    appendOutputBytes(output, entry, maxBytes, "LZWDecode");
    if (previous && nextCode <= 4095) {
      dictionary[nextCode] = concatLzwEntry(previous, entry[0]);
      nextCode += 1;
      if (codeSize < 12 && nextCode + earlyChange >= 1 << codeSize) {
        codeSize += 1;
      }
    }
    previous = entry;
  }

  if (!sawEod) {
    throw new PdfStreamDecodeError("LZWDecode missing EOD marker.", {
      code: "pdf.stream.lzw_eod_missing"
    });
  }
  return new Uint8Array(output);
}

function createLzwDictionary() {
  const dictionary = Array(258).fill(null);
  for (let value = 0; value < 256; value += 1) {
    dictionary[value] = new Uint8Array([value]);
  }
  return dictionary;
}

function concatLzwEntry(prefix, byte) {
  const entry = new Uint8Array(prefix.length + 1);
  entry.set(prefix);
  entry[prefix.length] = byte;
  return entry;
}

function readLzwCode(bytes, reader, codeSize) {
  if (reader.bitOffset + codeSize > bytes.byteLength * 8) {
    return null;
  }

  let code = 0;
  for (let index = 0; index < codeSize; index += 1) {
    const byte = bytes[reader.bitOffset >> 3];
    const bit = (byte >> (7 - (reader.bitOffset & 7))) & 1;
    code = (code << 1) | bit;
    reader.bitOffset += 1;
  }
  return code;
}

function applyPredictor(bytes, parms, maxBytes) {
  const predictor = numberParm(parms, "Predictor", 1);
  if (predictor === 1) {
    return bytes;
  }

  const colors = numberParm(parms, "Colors", 1);
  const bitsPerComponent = numberParm(parms, "BitsPerComponent", 8);
  const columns = numberParm(parms, "Columns", 1);
  const bytesPerPixel = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8));
  const rowLength = Math.ceil((columns * colors * bitsPerComponent) / 8);

  if (predictor === 2) {
    return applyTiffPredictor(bytes, {
      bitsPerComponent,
      bytesPerPixel,
      rowLength,
      maxBytes
    });
  }

  if (predictor < 10 || predictor > 15) {
    throw new PdfStreamDecodeError(`Unsupported predictor ${predictor}.`, {
      code: "pdf.stream.predictor_unsupported"
    });
  }

  const rowWithFilterLength = rowLength + 1;

  if (rowLength <= 0 || bytes.length % rowWithFilterLength !== 0) {
    throw new PdfStreamDecodeError("PNG predictor data does not align with row size.", {
      code: "pdf.stream.predictor_row_mismatch"
    });
  }

  const output = new Uint8Array((bytes.length / rowWithFilterLength) * rowLength);
  enforceMaxBytes(output, maxBytes, "Predictor");
  let inputOffset = 0;
  let outputOffset = 0;
  let previousRow = new Uint8Array(rowLength);

  while (inputOffset < bytes.length) {
    const rowFilter = bytes[inputOffset];
    const filter = predictor === 15 ? rowFilter : predictor - 10;
    inputOffset += 1;
    const encoded = bytes.subarray(inputOffset, inputOffset + rowLength);
    const decoded = decodePngRow(encoded, previousRow, filter, bytesPerPixel);
    output.set(decoded, outputOffset);
    previousRow = decoded;
    inputOffset += rowLength;
    outputOffset += rowLength;
  }

  return output;
}

function applyTiffPredictor(bytes, { bitsPerComponent, bytesPerPixel, rowLength, maxBytes }) {
  if (bitsPerComponent !== 8) {
    throw new PdfStreamDecodeError(
      `Unsupported TIFF predictor bit depth ${bitsPerComponent}.`,
      {
        code: "pdf.stream.predictor_unsupported"
      }
    );
  }
  if (rowLength <= 0 || bytes.length % rowLength !== 0) {
    throw new PdfStreamDecodeError("TIFF predictor data does not align with row size.", {
      code: "pdf.stream.predictor_row_mismatch"
    });
  }

  const output = new Uint8Array(bytes);
  enforceMaxBytes(output, maxBytes, "Predictor");
  for (let rowOffset = 0; rowOffset < output.length; rowOffset += rowLength) {
    for (let index = bytesPerPixel; index < rowLength; index += 1) {
      output[rowOffset + index] =
        (output[rowOffset + index] + output[rowOffset + index - bytesPerPixel]) & 0xff;
    }
  }
  return output;
}

function decodePngRow(encoded, previousRow, filter, bytesPerPixel) {
  const decoded = new Uint8Array(encoded.length);
  for (let index = 0; index < encoded.length; index += 1) {
    const left = index >= bytesPerPixel ? decoded[index - bytesPerPixel] : 0;
    const up = previousRow[index] ?? 0;
    const upLeft = index >= bytesPerPixel ? previousRow[index - bytesPerPixel] ?? 0 : 0;

    if (filter === 0) {
      decoded[index] = encoded[index];
    } else if (filter === 1) {
      decoded[index] = (encoded[index] + left) & 0xff;
    } else if (filter === 2) {
      decoded[index] = (encoded[index] + up) & 0xff;
    } else if (filter === 3) {
      decoded[index] = (encoded[index] + Math.floor((left + up) / 2)) & 0xff;
    } else if (filter === 4) {
      decoded[index] = (encoded[index] + paeth(left, up, upLeft)) & 0xff;
    } else {
      throw new PdfStreamDecodeError(`Unsupported PNG row filter ${filter}.`, {
        code: "pdf.stream.predictor_filter_unsupported"
      });
    }
  }
  return decoded;
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left;
  }
  if (upDistance <= upLeftDistance) {
    return up;
  }
  return upLeft;
}

function numberParm(parms, key, fallback) {
  if (!parms || parms.type !== "dict") {
    return fallback;
  }
  const value = parms.entries[key];
  return typeof value === "number" ? value : fallback;
}

function enforceMaxBytes(bytes, maxBytes, filter) {
  enforceOutputLength(bytes.byteLength, maxBytes, filter);
}

function appendOutputBytes(output, bytes, maxBytes, filter) {
  enforceOutputLength(output.length + bytes.length, maxBytes, filter);
  for (const byte of bytes) {
    output.push(byte);
  }
}

function enforceOutputLength(length, maxBytes, filter) {
  if (length > maxBytes) {
    throw new PdfStreamDecodeError(`${filter} decoded output exceeds byte limit.`, {
      code: "pdf.stream.decoded_too_large"
    });
  }
}
