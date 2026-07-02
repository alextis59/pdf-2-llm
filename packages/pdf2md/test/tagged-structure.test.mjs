import assert from "node:assert/strict";
import test from "node:test";
import { compareTaggedStructure } from "../../../scripts/qa/compare-tagged-structure.mjs";

test("tagged structure comparison passes reliable tagged content", () => {
  assert.deepEqual(
    compareTaggedStructure(
      {
        structure: {
          tagged: true,
          markedContent: 12,
          roles: { H1: 1, P: 11 }
        },
        taggedStructureConflicts: 0
      },
      {
        minTaggedMarkedContent: 1,
        maxTaggedStructureConflicts: 0
      }
    ),
    {
      tagged: true,
      markedContent: 12,
      minTaggedMarkedContent: 1,
      taggedStructureConflicts: 0,
      maxTaggedStructureConflicts: 0,
      roles: { H1: 1, P: 11 },
      passedTagged: true,
      passedMarkedContent: true,
      passedConflicts: true,
      passed: true
    }
  );
});

test("tagged structure comparison fails when expected tags are absent", () => {
  const result = compareTaggedStructure(
    {
      structure: {
        tagged: false,
        markedContent: 0,
        roles: {}
      },
      taggedStructureConflicts: 0
    },
    {
      minTaggedMarkedContent: 1,
      maxTaggedStructureConflicts: 0
    }
  );

  assert.equal(result.passed, false);
  assert.equal(result.passedTagged, false);
  assert.equal(result.passedMarkedContent, false);
  assert.equal(result.passedConflicts, true);
});

test("tagged structure comparison fails when tag conflicts exceed fallback threshold", () => {
  const result = compareTaggedStructure(
    {
      structure: {
        tagged: true,
        markedContent: 3,
        roles: { H1: 1, P: 2 }
      },
      taggedStructureConflicts: 2
    },
    {
      minTaggedMarkedContent: 1,
      maxTaggedStructureConflicts: 0
    }
  );

  assert.equal(result.passed, false);
  assert.equal(result.passedTagged, true);
  assert.equal(result.passedMarkedContent, true);
  assert.equal(result.passedConflicts, false);
});
