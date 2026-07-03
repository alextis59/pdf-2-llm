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
