import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

const retrieveScriptPath = fileURLToPath(
  new URL("../../../scripts/corpus/retrieve.mjs", import.meta.url)
);
const validPdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

test("corpus retrieval bounds declared and chunked downloads before atomic publish", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf2md-retrieve-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "corpus"), { recursive: true });

  const server = createServer((request, response) => {
    if (request.url === "/declared-too-large.pdf") {
      const body = Buffer.concat([validPdf, Buffer.alloc(64, 0x41)]);
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": String(body.length)
      });
      response.end(body);
      return;
    }
    if (request.url === "/chunked-too-large.pdf") {
      response.writeHead(200, { "Content-Type": "application/pdf" });
      response.write(validPdf);
      response.end(Buffer.alloc(64, 0x42));
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Length": String(validPdf.length)
    });
    response.end(validPdf);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const targetPath = path.join(root, "corpus", "raw", "_incoming", "sample.pdf");

  await writeRegistry(root, `${baseUrl}/declared-too-large.pdf`);
  const declared = await runRetrieve(root, 32);
  assert.notEqual(declared.code, 0);
  assert.match(declared.stderr, /Content-Length \d+ exceeds max download size 32/);
  await assert.rejects(() => stat(targetPath), { code: "ENOENT" });
  assert.deepEqual(await temporaryFiles(root), []);

  await writeRegistry(root, `${baseUrl}/chunked-too-large.pdf`);
  const chunked = await runRetrieve(root, 32);
  assert.notEqual(chunked.code, 0);
  assert.match(chunked.stderr, /streamed body exceeds max download size 32/);
  await assert.rejects(() => stat(targetPath), { code: "ENOENT" });
  assert.deepEqual(await temporaryFiles(root), []);

  await writeRegistry(root, `${baseUrl}/valid.pdf`);
  const valid = await runRetrieve(root, 1024);
  assert.equal(valid.code, 0, valid.stderr);
  assert.deepEqual(await readFile(targetPath), validPdf);
  assert.deepEqual(await temporaryFiles(root), []);

  const record = JSON.parse(await readFile(`${targetPath}.retrieval.json`, "utf8"));
  assert.equal(record.bytes, validPdf.length);
  assert.equal(record.sha256, createHash("sha256").update(validPdf).digest("hex"));
});

function writeRegistry(root, url) {
  const registry = {
    schemaVersion: 1,
    groups: [
      {
        id: "test-retrieval",
        kind: "born-digital",
        minimumCount: 1,
        strategy: "Local HTTP regression server.",
        why: "Exercises bounded streaming retrieval.",
        candidates: [
          {
            id: "sample",
            sourceType: "url",
            url,
            targetPath: "corpus/raw/_incoming/sample.pdf",
            licenseName: "Test fixture",
            licenseNotes: "Generated in the test process.",
            redistributable: true,
            disposition: "commit-ok",
            retrievalCommand: "test-only",
            notes: "Bounded retrieval fixture."
          }
        ]
      }
    ]
  };
  return writeFile(
    path.join(root, "corpus", "candidates.json"),
    `${JSON.stringify(registry, null, 2)}\n`
  );
}

function runRetrieve(root, maxDownloadBytes) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        retrieveScriptPath,
        "--root",
        root,
        "--candidate-file",
        path.join(root, "corpus", "candidates.json"),
        "--id",
        "sample",
        "--max-download-bytes",
        String(maxDownloadBytes)
      ],
      { timeout: 5_000 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error?.code ?? 0, stdout, stderr });
      }
    );
  });
}

async function temporaryFiles(root) {
  try {
    const files = await readdir(path.join(root, "corpus", "raw", "_incoming"));
    return files.filter((file) => file.includes(".tmp-"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
