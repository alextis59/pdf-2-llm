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
  assert.equal(plan.renderer.status, "selected");
  assert.deepEqual(plan.pages, [
    {
      pageIndex: 0,
      status: "planned",
      sourceBox: "cropBox",
      widthPt: 468,
      heightPt: 648,
      dpi: 300,
      scale: 300 / 72,
      widthPx: 1950,
      heightPx: 2700,
      pixelCount: 5265000,
      rotation: 90,
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
  assert.equal(plan.pages[0].dpi, 144);
  assert.equal(plan.pages[0].scale, 2);
  assert.equal(plan.pages[0].widthPx, 1224);
  assert.equal(plan.pages[0].heightPx, 1584);
  assert.equal(plan.pages[0].pixelCount, 1938816);
});

test("createRasterPlan rejects invalid DPI values", () => {
  assert.throws(() => createRasterPlan([], { dpi: 0 }), /positive finite number/);
  assert.throws(() => createRasterPlan([], { dpi: Number.POSITIVE_INFINITY }), /positive finite number/);
});

test("createRasterPlan keeps pages empty while raster planning is disabled", () => {
  const plan = createRasterPlan([{ pageIndex: 0, widthPt: 612, heightPt: 792 }]);

  assert.equal(plan.enabled, false);
  assert.equal(plan.dpi, 300);
  assert.equal(plan.renderer.status, "selected");
  assert.deepEqual(plan.pages, []);
});
