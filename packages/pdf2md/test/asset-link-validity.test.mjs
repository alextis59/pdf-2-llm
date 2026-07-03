import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssetLinkValidityReport,
  evaluateAssetLinkValidity,
  extractMarkdownAssetLinks,
  normalizeMarkdownLinkTarget,
  validateAssetPath
} from "../../../scripts/qa/check-asset-links.mjs";

test("extractMarkdownAssetLinks reads image and link references under assets", () => {
  assert.deepEqual(
    extractMarkdownAssetLinks(
      [
        "![Figure 1](assets/figure-1.png)",
        "[CSV](assets/table-1.csv \"download\")",
        "[External](https://example.test/report.pdf)"
      ].join("\n")
    ),
    [
      {
        type: "image",
        target: "assets/figure-1.png",
        raw: "![Figure 1](assets/figure-1.png)"
      },
      {
        type: "link",
        target: "assets/table-1.csv",
        raw: "[CSV](assets/table-1.csv \"download\")"
      }
    ]
  );
});

test("normalizeMarkdownLinkTarget supports bracketed targets", () => {
  assert.equal(normalizeMarkdownLinkTarget("<assets/figure one.png>"), "assets/figure one.png");
});

test("validateAssetPath accepts relative assets paths only", () => {
  assert.deepEqual(validateAssetPath("assets/figure-1.png"), []);
  assert.deepEqual(validateAssetPath("../figure-1.png"), [
    "outside-assets-root",
    "unsafe-segment"
  ]);
  assert.deepEqual(validateAssetPath("/tmp/figure-1.png"), [
    "outside-assets-root",
    "absolute-path",
    "unsafe-segment"
  ]);
  assert.deepEqual(validateAssetPath("assets/../secret.txt"), ["unsafe-segment"]);
});

test("evaluateAssetLinkValidity passes when Markdown asset links resolve", () => {
  assert.deepEqual(
    evaluateAssetLinkValidity("![Figure](assets/figure-1.png)\n", [
      {
        id: "figure-1",
        kind: "figure-preview",
        path: "assets/figure-1.png",
        mediaType: "image/png"
      }
    ]),
    {
      assets: 1,
      links: 1,
      validAssetPaths: 1,
      resolvedLinkedAssets: 1,
      assetPathValidity: 1,
      linkResolution: 1,
      duplicateAssetIds: [],
      duplicateAssetPaths: [],
      invalidAssets: [],
      invalidMarkdownTargets: [],
      missingLinkedAssets: [],
      passed: true
    }
  );
});

test("evaluateAssetLinkValidity reports invalid assets, duplicates, and missing links", () => {
  const result = evaluateAssetLinkValidity("![Figure](assets/missing.png)\n", [
    {
      id: "figure-1",
      path: "assets/../secret.png",
      mediaType: "image/png"
    },
    {
      id: "figure-1",
      path: "assets/../secret.png",
      mediaType: ""
    }
  ]);

  assert.equal(result.passed, false);
  assert.deepEqual(result.duplicateAssetIds, ["figure-1"]);
  assert.deepEqual(result.duplicateAssetPaths, ["assets/../secret.png"]);
  assert.deepEqual(
    result.invalidAssets.map((asset) => asset.failures),
    [["unsafe-segment"], ["missing-media-type", "unsafe-segment"]]
  );
  assert.deepEqual(
    result.missingLinkedAssets.map((link) => link.target),
    ["assets/missing.png"]
  );
});

test("createAssetLinkValidityReport summarizes aggregate validity", () => {
  const report = createAssetLinkValidityReport([
    evaluateAssetLinkValidity("![Figure](assets/figure-1.png)\n", [
      {
        id: "figure-1",
        path: "assets/figure-1.png",
        mediaType: "image/png"
      }
    ]),
    evaluateAssetLinkValidity("[Missing](assets/missing.csv)\n", [])
  ]);

  assert.equal(report.passed, false);
  assert.equal(report.caseCount, 2);
  assert.equal(report.assetPathValidity, 1);
  assert.equal(report.linkResolution, 0.5);
});
