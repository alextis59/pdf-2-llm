import assert from "node:assert/strict";
import test from "node:test";
import { createOcrLanguageConfig } from "../src/ocr-language.mjs";

test("createOcrLanguageConfig maps page overrides to routed OCR pages", () => {
  const config = createOcrLanguageConfig({
    adapter: {
      enabled: true,
      status: "selected",
      languages: ["eng"],
      modelLoading: {
        languages: ["eng", "spa"]
      }
    },
    options: {
      pageLanguages: [
        {
          pageIndex: 1,
          languages: ["spa", "eng", "spa"]
        }
      ]
    },
    scanDetection: {
      pages: [
        {
          pageIndex: 0,
          sourceType: "digital"
        },
        {
          pageIndex: 1,
          sourceType: "scanned"
        }
      ]
    }
  });

  assert.deepEqual(config, {
    enabled: true,
    status: "configured",
    defaultLanguages: ["eng"],
    modelLanguages: ["eng", "spa"],
    workerLanguage: "eng",
    pageOverrides: [
      {
        pageIndex: 1,
        languages: ["spa", "eng"],
        workerLanguage: "spa+eng",
        modelFiles: ["spa.traineddata", "eng.traineddata"]
      }
    ],
    pages: [
      {
        pageIndex: 1,
        sourceType: "scanned",
        languages: ["spa", "eng"],
        workerLanguage: "spa+eng",
        modelFiles: ["spa.traineddata", "eng.traineddata"]
      }
    ]
  });
});

test("createOcrLanguageConfig expands global and page script hints", () => {
  const config = createOcrLanguageConfig({
    adapter: {
      enabled: true,
      status: "selected",
      languages: ["eng"],
      modelLoading: {
        languages: ["eng", "jpn", "jpn_vert", "ara", "heb"]
      }
    },
    options: {
      scripts: ["japanese", "vertical"],
      pageLanguages: [
        {
          pageIndex: 0,
          scripts: ["rtl"]
        }
      ]
    },
    scanDetection: {
      pages: [
        {
          pageIndex: 0,
          sourceType: "scanned"
        }
      ]
    }
  });

  assert.deepEqual(config.defaultLanguages, ["eng", "jpn", "jpn_vert"]);
  assert.deepEqual(config.modelLanguages, ["eng", "jpn", "jpn_vert", "ara", "heb"]);
  assert.deepEqual(config.pageOverrides, [
    {
      pageIndex: 0,
      languages: ["ara", "heb"],
      workerLanguage: "ara+heb",
      modelFiles: ["ara.traineddata", "heb.traineddata"]
    }
  ]);
  assert.deepEqual(config.pages, [
    {
      pageIndex: 0,
      sourceType: "scanned",
      languages: ["ara", "heb"],
      workerLanguage: "ara+heb",
      modelFiles: ["ara.traineddata", "heb.traineddata"]
    }
  ]);
});
