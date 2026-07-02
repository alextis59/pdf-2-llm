import { convertPdfToMarkdown } from "../src/index.mjs";

const inputPath = new URL("../../../corpus/generated/synthetic-simple-text.pdf", import.meta.url);
const result = await convertPdfToMarkdown(inputPath.pathname);

console.log(JSON.stringify(result.diagnostics, null, 2));
