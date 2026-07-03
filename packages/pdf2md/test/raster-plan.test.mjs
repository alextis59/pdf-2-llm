import assert from "node:assert/strict";
import test from "node:test";
import { createRasterPlan, selectRasterRenderer } from "../src/raster-plan.mjs";

test("selectRasterRenderer chooses the scoped internal path by default", () => {
  const renderer = selectRasterRenderer();

  assert.equal(renderer.id, "internal-page-geometry");
  assert.equal(renderer.kind, "scoped-internal");
  assert.equal(renderer.dependency, null);
  assert.equal(renderer.output, "raster-plan");
  assert.equal(renderer.status, "selected");
  assert.deepEqual(renderer.environments, ["browser", "node"]);
});

test("createRasterPlan records parser-backed page plans when enabled", () => {
  const plan = createRasterPlan(
    [
      {
        pageIndex: 0,
        mediaBox: [0, 0, 612, 792],
        cropBox: [72, 72, 540, 720],
        widthPt: 468,
        heightPt: 648,
        rotation: 90,
        userUnit: 1
      }
    ],
    { enabled: true }
  );

  assert.equal(plan.enabled, true);
  assert.equal(plan.dpi, 300);
  assert.equal(plan.thumbnailDpi, 36);
  assert.equal(plan.maxPixels, 100_000_000);
  assert.equal(plan.limitedPages, 0);
  assert.equal(plan.limitedThumbnails, 0);
  assert.equal(plan.renderer.status, "selected");
  assert.deepEqual(plan.pages, [
    {
      pageIndex: 0,
      status: "planned",
      sourceBox: "cropBox",
      boxPt: [72, 72, 540, 720],
      sourceWidthPt: 468,
      sourceHeightPt: 648,
      widthPt: 648,
      heightPt: 468,
      dpi: 300,
      scale: 300 / 72,
      widthPx: 2700,
      heightPx: 1950,
      pixelCount: 5265000,
      maxPixels: 100_000_000,
      exceedsPixelLimit: false,
      thumbnail: {
        status: "planned",
        dpi: 36,
        scale: 0.5,
        widthPx: 324,
        heightPx: 234,
        pixelCount: 75816,
        maxPixels: 100_000_000,
        exceedsPixelLimit: false
      },
      rotation: 90,
      quarterTurn: true,
      userUnit: 1
    }
  ]);
});

test("createRasterPlan honors configured DPI", () => {
  const plan = createRasterPlan(
    [
      {
        pageIndex: 0,
        mediaBox: [0, 0, 612, 792],
        widthPt: 612,
        heightPt: 792
      }
    ],
    { enabled: true, dpi: 144 }
  );

  assert.equal(plan.dpi, 144);
  assert.equal(plan.thumbnailDpi, 36);
  assert.equal(plan.maxPixels, 100_000_000);
  assert.equal(plan.limitedPages, 0);
  assert.equal(plan.limitedThumbnails, 0);
  assert.equal(plan.pages[0].dpi, 144);
  assert.equal(plan.pages[0].scale, 2);
  assert.equal(plan.pages[0].widthPx, 1224);
  assert.equal(plan.pages[0].heightPx, 1584);
  assert.equal(plan.pages[0].pixelCount, 1938816);
  assert.equal(plan.pages[0].maxPixels, 100_000_000);
  assert.equal(plan.pages[0].exceedsPixelLimit, false);
  assert.equal(plan.pages[0].thumbnail.dpi, 36);
  assert.equal(plan.pages[0].thumbnail.widthPx, 306);
  assert.equal(plan.pages[0].thumbnail.heightPx, 396);
  assert.equal(plan.pages[0].thumbnail.pixelCount, 121176);
  assert.equal(plan.pages[0].sourceBox, "mediaBox");
  assert.deepEqual(plan.pages[0].boxPt, [0, 0, 612, 792]);
  assert.equal(plan.pages[0].quarterTurn, false);
});

test("createRasterPlan honors configured thumbnail DPI", () => {
  const plan = createRasterPlan(
    [
      {
        pageIndex: 0,
        mediaBox: [0, 0, 612, 792],
        widthPt: 612,
        heightPt: 792
      }
    ],
    { enabled: true, dpi: 144, thumbnailDpi: 72 }
  );

  assert.equal(plan.thumbnailDpi, 72);
  assert.equal(plan.pages[0].thumbnail.status, "planned");
  assert.equal(plan.pages[0].thumbnail.dpi, 72);
  assert.equal(plan.pages[0].thumbnail.scale, 1);
  assert.equal(plan.pages[0].thumbnail.widthPx, 612);
  assert.equal(plan.pages[0].thumbnail.heightPx, 792);
  assert.equal(plan.pages[0].thumbnail.pixelCount, 484704);
});

test("createRasterPlan normalizes rotation before computing render dimensions", () => {
  const plan = createRasterPlan(
    [
      {
        pageIndex: 0,
        mediaBox: [0, 0, 200, 100],
        widthPt: 200,
        heightPt: 100,
        rotation: -90
      }
    ],
    { enabled: true, dpi: 72 }
  );

  assert.equal(plan.pages[0].rotation, 270);
  assert.equal(plan.pages[0].quarterTurn, true);
  assert.equal(plan.pages[0].sourceWidthPt, 200);
  assert.equal(plan.pages[0].sourceHeightPt, 100);
  assert.equal(plan.pages[0].widthPt, 100);
  assert.equal(plan.pages[0].heightPt, 200);
  assert.equal(plan.pages[0].widthPx, 100);
  assert.equal(plan.pages[0].heightPx, 200);
});

test("createRasterPlan skips pages that exceed the configured pixel limit", () => {
  const plan = createRasterPlan(
    [
      {
        pageIndex: 0,
        mediaBox: [0, 0, 612, 792],
        widthPt: 612,
        heightPt: 792
      }
    ],
    { enabled: true, dpi: 144, maxPixels: 200000 }
  );

  assert.equal(plan.maxPixels, 200000);
  assert.equal(plan.limitedPages, 1);
  assert.equal(plan.limitedThumbnails, 0);
  assert.equal(plan.pages[0].status, "skipped-pixel-limit");
  assert.equal(plan.pages[0].pixelCount, 1938816);
  assert.equal(plan.pages[0].maxPixels, 200000);
  assert.equal(plan.pages[0].exceedsPixelLimit, true);
  assert.equal(plan.pages[0].thumbnail.status, "planned");
});

test("createRasterPlan rejects invalid DPI values", () => {
  assert.throws(() => createRasterPlan([], { dpi: 0 }), /positive finite number/);
  assert.throws(() => createRasterPlan([], { dpi: Number.POSITIVE_INFINITY }), /positive finite number/);
});

test("createRasterPlan rejects invalid pixel limits", () => {
  assert.throws(() => createRasterPlan([], { maxPixels: 0 }), /maxImagePixels/);
  assert.throws(() => createRasterPlan([], { maxPixels: Number.POSITIVE_INFINITY }), /maxImagePixels/);
});

test("createRasterPlan keeps pages empty while raster planning is disabled", () => {
  const plan = createRasterPlan([{ pageIndex: 0, widthPt: 612, heightPt: 792 }]);

  assert.equal(plan.enabled, false);
  assert.equal(plan.dpi, 300);
  assert.equal(plan.thumbnailDpi, 36);
  assert.equal(plan.maxPixels, 100_000_000);
  assert.equal(plan.limitedPages, 0);
  assert.equal(plan.limitedThumbnails, 0);
  assert.equal(plan.renderer.status, "selected");
  assert.deepEqual(plan.pages, []);
});
