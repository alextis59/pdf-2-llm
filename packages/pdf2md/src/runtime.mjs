export function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export async function readFileBytes(path) {
  const fs = getNodeBuiltin("fs");
  if (!fs?.promises?.readFile) {
    throw new TypeError("String path input is only supported in Node runtimes.");
  }
  return new Uint8Array(await fs.promises.readFile(path));
}

export async function sha256Hex(input) {
  const bytes = toUint8Array(input);
  const crypto = getNodeBuiltin("crypto");
  if (crypto?.createHash) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
  }

  const subtle = globalThis.crypto?.subtle;
  if (!subtle?.digest) {
    throw new Error("SHA-256 hashing is unavailable in this runtime.");
  }
  const digest = await subtle.digest("SHA-256", exactArrayBuffer(bytes));
  return bytesToHex(new Uint8Array(digest));
}

export function md5Digest(input) {
  const bytes = toUint8Array(input);
  const crypto = getNodeBuiltin("crypto");
  if (crypto?.createHash) {
    return new Uint8Array(crypto.createHash("md5").update(bytes).digest());
  }
  return md5DigestFallback(bytes);
}

export function inflateFlateSync(input, { maxOutputLength } = {}) {
  const zlib = getNodeBuiltin("zlib");
  if (!zlib?.inflateSync) {
    throw new Error("FlateDecode requires a synchronous inflater in this runtime.");
  }
  return new Uint8Array(zlib.inflateSync(toUint8Array(input), { maxOutputLength }));
}

export function bytesToLatin1(input) {
  const bytes = toUint8Array(input);
  const chunkSize = 0x8000;
  let output = "";
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return output;
}

export function bytesToAscii(input) {
  return bytesToLatin1(input).replace(/[\x80-\xff]/g, "?");
}

export function latin1ToBytes(value) {
  const output = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    output[index] = value.charCodeAt(index) & 0xff;
  }
  return output;
}

export function hexToBytes(value) {
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

export function bytesToHex(input) {
  const bytes = toUint8Array(input);
  let output = "";
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, "0");
  }
  return output;
}

export function bytesToBase64(input) {
  const bytes = toUint8Array(input);
  const buffer = getGlobalBuffer();
  if (buffer) {
    return buffer.from(bytes).toString("base64");
  }
  return btoa(bytesToLatin1(bytes));
}

export function int32LittleEndianBytes(value) {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setInt32(0, value, true);
  return output;
}

export function toUint8Array(input) {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return Uint8Array.from(input);
}

function exactArrayBuffer(bytes) {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

function getNodeBuiltin(name) {
  return globalThis.process?.getBuiltinModule?.(name) ?? null;
}

function getGlobalBuffer() {
  return typeof globalThis.Buffer === "function" ? globalThis.Buffer : null;
}

const md5Shift = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

const md5Table = Uint32Array.from(
  { length: 64 },
  (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0
);

function md5DigestFallback(input) {
  const bytes = toUint8Array(input);
  const paddedLength = Math.ceil((bytes.byteLength + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.byteLength] = 0x80;

  const view = new DataView(data.buffer);
  const bitLength = bytes.byteLength * 8;
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const words = new Uint32Array(16);
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, true);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let index = 0; index < 64; index += 1) {
      let f;
      let g;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }

      const rotated = rotateLeft((a + f + md5Table[index] + words[g]) >>> 0, md5Shift[index]);
      a = d;
      d = c;
      c = b;
      b = (b + rotated) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const output = new Uint8Array(16);
  const outputView = new DataView(output.buffer);
  outputView.setUint32(0, a0, true);
  outputView.setUint32(4, b0, true);
  outputView.setUint32(8, c0, true);
  outputView.setUint32(12, d0, true);
  return output;
}

function rotateLeft(value, count) {
  return ((value << count) | (value >>> (32 - count))) >>> 0;
}
