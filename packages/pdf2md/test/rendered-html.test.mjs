import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeRenderedHtml,
  evaluateRenderedHtml
} from "../../../scripts/qa/check-rendered-html.mjs";
import { renderMarkdownToHtml } from "../../../scripts/qa/render-markdown.mjs";

test("rendered HTML analyzer counts readable structure", () => {
  const html = renderMarkdownToHtml(`# Title

First paragraph.

Second paragraph with & detail.
`);

  assert.deepEqual(analyzeRenderedHtml(html), {
    textChars: 54,
    headingCount: 1,
    paragraphCount: 2,
    listCount: 0,
    tableCount: 0,
    maxParagraphChars: 31
  });
});

test("renderer preserves raw HTML table blocks", () => {
  const html = renderMarkdownToHtml(`<table>
  <tbody>
    <tr>
      <td colspan="2">Merged</td>
    </tr>
  </tbody>
</table>
`);

  assert.match(html, /<td colspan="2">Merged<\/td>/);
  assert.equal(analyzeRenderedHtml(html).tableCount, 1);
});

test("rendered HTML evaluator passes configured readability thresholds", () => {
  const result = evaluateRenderedHtml(
    {
      textChars: 100,
      headingCount: 2,
      paragraphCount: 5,
      listCount: 0,
      tableCount: 0,
      maxParagraphChars: 80
    },
    {
      minRenderedHtmlTextChars: 90,
      minRenderedHtmlHeadings: 1,
      minRenderedHtmlParagraphs: 4,
      maxRenderedHtmlParagraphChars: 100
    }
  );

  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test("rendered HTML evaluator reports collapsed paragraph failures", () => {
  const result = evaluateRenderedHtml(
    {
      textChars: 100,
      headingCount: 0,
      paragraphCount: 1,
      listCount: 0,
      tableCount: 0,
      maxParagraphChars: 5000
    },
    {
      minRenderedHtmlTextChars: 90,
      minRenderedHtmlHeadings: 1,
      minRenderedHtmlParagraphs: 2,
      maxRenderedHtmlParagraphChars: 1000
    }
  );

  assert.equal(result.passed, false);
  assert.deepEqual(
    result.failures.map(({ metric, operator, limit }) => ({ metric, operator, limit })),
    [
      { metric: "headingCount", operator: ">=", limit: 1 },
      { metric: "paragraphCount", operator: ">=", limit: 2 },
      { metric: "maxParagraphChars", operator: "<=", limit: 1000 }
    ]
  );
});
