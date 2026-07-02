import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { convertPdfToMarkdown } from "../../packages/pdf2md/src/index.mjs";

const args = process.argv.slice(2);

function hasFlag(name) {
  return args.includes(name);
}

function readOption(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function usage() {
  return `Usage:
  node scripts/qa/render-layout-overlays.mjs --id <manifest-id> [--out-dir <dir>]
  node scripts/qa/render-layout-overlays.mjs --pdf <path> [--name <id>] [--out-dir <dir>]

Options:
  --manifest <path>          Manifest path. Defaults to corpus/manifest.json.
  --root <path>              Repository root. Defaults to cwd.
  --out-dir <dir>            Output directory. Defaults to .temp/layout-overlays.
`;
}

async function resolveInput(repoRoot) {
  const pdfPath = readOption("--pdf");
  if (pdfPath) {
    return {
      id: readOption("--name") ?? path.basename(pdfPath, path.extname(pdfPath)),
      path: path.resolve(pdfPath)
    };
  }

  const id = readOption("--id");
  if (!id) {
    console.error(usage());
    process.exit(1);
  }

  const manifestPath = path.resolve(
    readOption("--manifest") ?? path.join(repoRoot, "corpus", "manifest.json")
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entry = manifest.entries.find((item) => item.id === id);
  if (!entry) {
    throw new Error(`unknown manifest id "${id}"`);
  }
  return {
    id,
    path: path.join(repoRoot, entry.path)
  };
}

function pageSize(page) {
  return {
    width: finiteOr(page.widthPt, 612),
    height: finiteOr(page.heightPt, 792)
  };
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function pageRegions(sourceMap, pageIndex) {
  const entries = [];
  for (let index = 0; index < sourceMap.entries.length; index += 1) {
    const entry = sourceMap.entries[index];
    if (entry.kind === "page_anchor") {
      continue;
    }
    const regions = entry.regions.filter((region) => region.pageIndex === pageIndex);
    if (regions.length > 0) {
      entries.push({
        order: index + 1,
        kind: entry.kind,
        regions
      });
    }
  }
  return entries;
}

function regionBounds(regions) {
  const boxes = regions
    .filter((region) => Number.isFinite(region.x) && Number.isFinite(region.y))
    .map((region) => {
      const height = finiteOr(region.height, 10);
      return {
        left: region.x,
        right: region.x + Math.max(1, finiteOr(region.width, 1)),
        bottom: region.y,
        top: region.y + Math.max(1, height)
      };
    });

  if (boxes.length === 0) {
    return null;
  }

  return {
    left: Math.min(...boxes.map((box) => box.left)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.min(...boxes.map((box) => box.bottom)),
    top: Math.max(...boxes.map((box) => box.top))
  };
}

function renderPageSvg({ page, sourceMap }) {
  const { width, height } = pageSize(page);
  const overlays = pageRegions(sourceMap, page.pageIndex)
    .map((entry) => ({ ...entry, bounds: regionBounds(entry.regions) }))
    .filter((entry) => entry.bounds);
  const shapes = overlays.map((entry) => renderOverlay(entry, height)).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#fff"/>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#222" stroke-width="1"/>
${shapes}
</svg>
`;
}

function renderOverlay(entry, pageHeight) {
  const { left, right, bottom, top } = entry.bounds;
  const x = round(left);
  const y = round(pageHeight - top);
  const width = round(right - left);
  const height = round(top - bottom);
  const color = colorForKind(entry.kind);
  const label = `${entry.order} ${entry.kind}`;
  return `  <g>
    <rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-width="1.5"/>
    <circle cx="${x + 9}" cy="${Math.max(10, y - 8)}" r="8" fill="${color}"/>
    <text x="${x + 9}" y="${Math.max(13, y - 5)}" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#fff">${entry.order}</text>
    <text x="${x}" y="${Math.max(24, y - 18)}" font-family="sans-serif" font-size="10" fill="${color}">${escapeXml(label)}</text>
  </g>`;
}

function colorForKind(kind) {
  const colors = {
    heading: "#1f77b4",
    paragraph: "#2ca02c",
    list: "#9467bd",
    table: "#d62728"
  };
  return colors[kind] ?? "#ff7f0e";
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }

  const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
  const input = await resolveInput(repoRoot);
  const outDir = path.resolve(readOption("--out-dir") ?? path.join(repoRoot, ".temp", "layout-overlays"));
  const result = await convertPdfToMarkdown(input.path, {
    ocr: { enabled: false }
  });

  await mkdir(outDir, { recursive: true });
  for (const page of result.diagnostics.pages) {
    const svg = renderPageSvg({ page, sourceMap: result.sourceMap });
    const outputPath = path.join(
      outDir,
      `${input.id}-page-${String(page.pageIndex + 1).padStart(4, "0")}-block-order.svg`
    );
    await writeFile(outputPath, svg);
    console.log(`WROTE ${path.relative(repoRoot, outputPath)}`);
  }
}

await main();
