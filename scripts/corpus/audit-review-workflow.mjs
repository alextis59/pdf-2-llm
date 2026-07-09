import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

const args = process.argv.slice(2);
const maxPreviewFileBytes = 32 * 1024 * 1024;
const maxPreviewDecodedBytes = 256 * 1024 * 1024;
const maxPreviewPixels = 50_000_000;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pngCrcTable = createPngCrcTable();

export async function auditAcceptanceReviewWorkflow({ root = process.cwd() } = {}) {
  const repoRoot = path.resolve(root);
  const acceptedDir = path.join(repoRoot, "corpus", "accepted");
  const files = (await readdir(acceptedDir))
    .filter((file) => file.endsWith(".yaml"))
    .sort();
  const cases = [];
  for (const file of files) {
    const text = await readFile(path.join(acceptedDir, file), "utf8");
    const id = readScalar(text, "id");
    const gating = readScalar(text, "gating") === "true";
    if (!gating) {
      continue;
    }
    const checks = await auditGatingCase(repoRoot, id, text);
    cases.push({
      id,
      passed: checks.every((check) => check.passed),
      checks
    });
  }
  return {
    passed: cases.every((entry) => entry.passed),
    gatingCaseCount: cases.length,
    cases
  };
}

async function auditGatingCase(repoRoot, id, text) {
  const oracleDir = path.join(repoRoot, "corpus", "baselines", id, "oracles");
  const previewDir = path.join(repoRoot, "corpus", "baselines", id, "previews");
  const oracleFiles = await listExistingFiles(oracleDir);
  const previewEvidence = await auditRenderedPreviews(repoRoot, previewDir);
  const successfulOracleFiles = oracleFiles.filter(
    (file) => file.endsWith(".txt") && !file.endsWith(".error.txt")
  );

  return [
    {
      id: "rendered-previews",
      passed: previewEvidence.failures.length === 0 && previewEvidence.validPreviews > 0,
      details: previewEvidence
    },
    {
      id: "two-text-oracles",
      passed: successfulOracleFiles.length >= 2
    },
    {
      id: "reading-order-and-structure",
      passed: hasSection(text, "structure") && hasListItem(text, "structure")
    },
    {
      id: "running-content-captions-tables-figures-forms-scripts",
      passed: hasAnySection(text, ["runningContent", "structure", "assets"])
    },
    {
      id: "warnings-recorded",
      passed: hasSection(text, "warnings") && /^\s+allowed:/m.test(text)
    },
    {
      id: "representative-snippets",
      passed: hasSection(text, "snippets") && /contains:\s*"/m.test(text)
    },
    {
      id: "metric-rationale",
      passed: !hasSection(text, "metrics") || readNestedScalar(text, "review", "notes").length >= 40
    },
    {
      id: "review-before-gating",
      passed:
        readNestedScalar(text, "review", "humanReviewedBy").length > 0 &&
        /^\d{4}-\d{2}-\d{2}$/.test(readNestedScalar(text, "review", "reviewedAt"))
    }
  ];
}

async function auditRenderedPreviews(repoRoot, previewDir) {
  const indexPath = path.join(previewDir, "index.json");
  let index;
  try {
    index = JSON.parse(await readFile(indexPath, "utf8"));
  } catch (error) {
    return {
      declaredPreviews: 0,
      validPreviews: 0,
      failures: [`invalid-index: ${error.message}`]
    };
  }
  if (!Array.isArray(index.previews) || index.previews.length === 0) {
    return {
      declaredPreviews: 0,
      validPreviews: 0,
      failures: ["index-has-no-previews"]
    };
  }

  const results = [];
  for (const [previewIndex, preview] of index.previews.entries()) {
    results.push(await validateDeclaredPreview(repoRoot, previewDir, preview, previewIndex));
  }
  return {
    declaredPreviews: results.length,
    validPreviews: results.filter((result) => result === null).length,
    failures: results.filter(Boolean)
  };
}

async function validateDeclaredPreview(repoRoot, previewDir, preview, previewIndex) {
  const label = `preview-${previewIndex + 1}`;
  if (typeof preview?.path !== "string" || preview.path.length === 0) {
    return `${label}: missing-path`;
  }
  if (path.isAbsolute(preview.path)) {
    return `${label}: absolute-path`;
  }
  const previewPath = path.resolve(repoRoot, preview.path);
  const relativePath = path.relative(previewDir, previewPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return `${label}: outside-preview-directory`;
  }

  let previewStat;
  try {
    previewStat = await stat(previewPath);
  } catch {
    return `${label}: missing-file`;
  }
  if (!previewStat.isFile()) {
    return `${label}: not-a-file`;
  }
  if (previewStat.size === 0 || previewStat.size > maxPreviewFileBytes) {
    return `${label}: invalid-file-size-${previewStat.size}`;
  }

  const bytes = await readFile(previewPath);
  const extension = path.extname(previewPath).toLowerCase();
  const validationFailure =
    extension === ".png"
      ? validatePng(bytes)
      : extension === ".jpg" || extension === ".jpeg"
        ? validateJpeg(bytes)
        : "unsupported-image-extension";
  return validationFailure ? `${label}: ${validationFailure}` : null;
}

function validatePng(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
    return "invalid-png-signature";
  }

  let offset = pngSignature.length;
  let header = null;
  let sawImageData = false;
  let imageDataEnded = false;
  let sawEnd = false;
  const imageData = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      return "truncated-png-chunk";
    }
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.length) {
      return "truncated-png-chunk";
    }
    const type = bytes.toString("ascii", typeStart, dataStart);
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    if (pngCrc32(bytes.subarray(typeStart, dataEnd)) !== expectedCrc) {
      return `invalid-png-${type}-crc`;
    }
    if (header === null && type !== "IHDR") {
      return "png-ihdr-not-first";
    }
    if (type === "IHDR") {
      if (header !== null || length !== 13) {
        return "invalid-png-ihdr";
      }
      header = readPngHeader(bytes.subarray(dataStart, dataEnd));
      if (typeof header === "string") {
        return header;
      }
    } else if (type === "IDAT") {
      if (imageDataEnded) {
        return "invalid-png-idat";
      }
      sawImageData = true;
      imageData.push(bytes.subarray(dataStart, dataEnd));
    } else if (sawImageData) {
      imageDataEnded = true;
    }
    if (type === "IEND") {
      if (length !== 0 || chunkEnd !== bytes.length) {
        return "invalid-png-iend";
      }
      sawEnd = true;
      break;
    }
    offset = chunkEnd;
  }
  if (!header || !sawImageData || !sawEnd) {
    return "incomplete-png";
  }

  const scanlines = pngScanlineGeometry(header);
  const decodedBytes = scanlines.reduce(
    (total, pass) => total + (pass.rowBytes + 1) * pass.rows,
    0
  );
  if (decodedBytes <= 0 || decodedBytes > maxPreviewDecodedBytes) {
    return "png-decoded-size-out-of-range";
  }
  let decoded;
  try {
    decoded = inflateSync(Buffer.concat(imageData), { maxOutputLength: decodedBytes });
  } catch {
    return "invalid-png-compressed-data";
  }
  if (decoded.length !== decodedBytes) {
    return "invalid-png-scanline-size";
  }
  let scanlineOffset = 0;
  for (const pass of scanlines) {
    for (let row = 0; row < pass.rows; row += 1) {
      if (decoded[scanlineOffset] > 4) {
        return "invalid-png-filter";
      }
      scanlineOffset += pass.rowBytes + 1;
    }
  }
  return null;
}

function readPngHeader(bytes) {
  const width = bytes.readUInt32BE(0);
  const height = bytes.readUInt32BE(4);
  const bitDepth = bytes[8];
  const colorType = bytes[9];
  const compression = bytes[10];
  const filter = bytes[11];
  const interlace = bytes[12];
  const allowedBitDepths = new Map([
    [0, [1, 2, 4, 8, 16]],
    [2, [8, 16]],
    [3, [1, 2, 4, 8]],
    [4, [8, 16]],
    [6, [8, 16]]
  ]);
  if (
    width === 0 ||
    height === 0 ||
    width * height > maxPreviewPixels ||
    !allowedBitDepths.get(colorType)?.includes(bitDepth) ||
    compression !== 0 ||
    filter !== 0 ||
    ![0, 1].includes(interlace)
  ) {
    return "invalid-png-ihdr-values";
  }
  return { width, height, bitDepth, colorType, interlace };
}

function pngScanlineGeometry(header) {
  const channels = new Map([
    [0, 1],
    [2, 3],
    [3, 1],
    [4, 2],
    [6, 4]
  ]).get(header.colorType);
  const bitsPerPixel = channels * header.bitDepth;
  const passes =
    header.interlace === 0
      ? [[0, 0, 1, 1]]
      : [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2]
        ];
  return passes
    .map(([xStart, yStart, xStep, yStep]) => {
      const columns = passLength(header.width, xStart, xStep);
      const rows = passLength(header.height, yStart, yStep);
      return {
        rowBytes: Math.ceil((columns * bitsPerPixel) / 8),
        rows
      };
    })
    .filter((pass) => pass.rowBytes > 0 && pass.rows > 0);
}

function passLength(length, start, step) {
  return length <= start ? 0 : Math.ceil((length - start) / step);
}

function validateJpeg(bytes) {
  if (
    bytes.length < 12 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  ) {
    return "invalid-jpeg-markers";
  }
  let offset = 2;
  let sawDimensions = false;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) {
      return "invalid-jpeg-segment";
    }
    while (bytes[offset] === 0xff) {
      offset += 1;
    }
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x00) {
      return "invalid-jpeg-segment";
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      continue;
    }
    if (offset + 2 > bytes.length) {
      return "truncated-jpeg-segment";
    }
    const length = bytes.readUInt16BE(offset);
    const segmentEnd = offset + length;
    if (length < 2 || segmentEnd > bytes.length) {
      return "truncated-jpeg-segment";
    }
    if (isJpegStartOfFrame(marker)) {
      if (
        length < 8 ||
        bytes.readUInt16BE(offset + 3) === 0 ||
        bytes.readUInt16BE(offset + 5) === 0
      ) {
        return "invalid-jpeg-dimensions";
      }
      sawDimensions = true;
    }
    if (marker === 0xda) {
      return sawDimensions && segmentEnd < bytes.length - 2 ? null : "invalid-jpeg-scan";
    }
    offset = segmentEnd;
  }
  return "jpeg-missing-scan";
}

function isJpegStartOfFrame(marker) {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    ![0xc4, 0xc8, 0xcc].includes(marker)
  );
}

function createPngCrcTable() {
  return Uint32Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    return crc >>> 0;
  });
}

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = pngCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function listExistingFiles(directory) {
  try {
    const stats = await stat(directory);
    if (!stats.isDirectory()) {
      return [];
    }
    return await readdir(directory);
  } catch {
    return [];
  }
}

function readScalar(text, key) {
  const match = text.match(new RegExp(`^${escapeRegExp(key)}:\\s*([^\\n#]+)`, "m"));
  return match ? stripQuotes(match[1].trim()) : "";
}

function readNestedScalar(text, section, key) {
  const pattern = new RegExp(`^${escapeRegExp(section)}:\\n(?:  .+\\n)*?  ${escapeRegExp(key)}:\\s*([^\\n#]+)`, "m");
  const match = text.match(pattern);
  return match ? stripQuotes(match[1].trim()) : "";
}

function stripQuotes(value) {
  return value.replace(/^["']|["']$/g, "");
}

function hasSection(text, section) {
  return new RegExp(`^${escapeRegExp(section)}:`, "m").test(text);
}

function hasAnySection(text, sections) {
  return sections.some((section) => hasSection(text, section));
}

function hasListItem(text, section) {
  const pattern = new RegExp(`^${escapeRegExp(section)}:\\n(?:  .+\\n)*?\\s+-\\s+`, "m");
  return pattern.test(text);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readOption(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

async function main() {
  const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
  const summaryPath = readOption("--summary");
  const summary = await auditAcceptanceReviewWorkflow({ root: repoRoot });
  if (summaryPath) {
    const resolvedSummaryPath = path.resolve(summaryPath);
    await mkdir(path.dirname(resolvedSummaryPath), { recursive: true });
    await writeFile(resolvedSummaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  }

  for (const entry of summary.cases) {
    for (const check of entry.checks) {
      console.log(`${check.passed ? "PASS" : "FAIL"} ${entry.id} ${check.id}`);
    }
  }
  if (!summary.passed) {
    process.exit(1);
  }
  console.log(`Acceptance review workflow passed: ${summary.gatingCaseCount} gating case(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
