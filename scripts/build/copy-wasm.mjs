import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const sourcePath = resolve("target/wasm32-unknown-unknown/release/pdf2md_core.wasm");
const targetPath = resolve("packages/pdf2md/src/wasm/pdf2md_core.wasm");

const sourceStats = await stat(sourcePath);
if (!sourceStats.isFile()) {
  throw new Error(`WASM build output is not a file: ${sourcePath}`);
}

await mkdir(dirname(targetPath), { recursive: true });
await copyFile(sourcePath, targetPath);

console.log(
  JSON.stringify(
    {
      sourcePath,
      targetPath,
      bytes: sourceStats.size
    },
    null,
    2
  )
);
