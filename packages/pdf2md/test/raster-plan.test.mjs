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
  assert.equal(plan.renderer.status, "selected");
  assert.deepEqual(plan.pages, [
    {
      pageIndex: 0,
      status: "planned",
      sourceBox: "cropBox",
      widthPt: 468,
      heightPt: 648,
      rotation: 90,
      userUnit: 1
    }
  ]);
});

test("createRasterPlan keeps pages empty while raster planning is disabled", () => {
  const plan = createRasterPlan([{ pageIndex: 0, widthPt: 612, heightPt: 792 }]);

  assert.equal(plan.enabled, false);
  assert.equal(plan.renderer.status, "selected");
  assert.deepEqual(plan.pages, []);
});
