# Agent Coordination Protocol

This repository allows independent agents to work on corpus, parser, layout,
table, OCR, WebGPU, Markdown, and QA modules. Every agent must follow this
protocol before marking a workstream complete.

## Start Of Work

- Read `docs/pdf-to-markdown-webassembly-study.md`.
- Read `docs/pdf-to-markdown-implementation-plan.md`.
- Identify the phase, gate, metrics, and acceptance files affected by the
  change before editing.

## Tests And Completion

- Add or update focused unit, integration, corpus, or QA tests for the changed
  behavior.
- Run the narrow test for the changed behavior before broad validation.
- Run the relevant corpus or benchmark gate before marking a module complete.
- Do not check a plan item unless the implementation and validation command are
  both present in the repository.

## Contracts

- Change cross-agent contracts only through versioned IR, schema, warning, or
  diagnostics updates.
- Update schema declarations and schema tests when serialized public shapes
  change.
- Preserve backwards-compatible warning and diagnostics codes unless the plan
  explicitly calls for a breaking contract change.

## Performance

- Performance changes must include before/after benchmark reports or an
  explicit not-applicable rationale.
- Store representative report outputs under `corpus/reports/` when they are
  part of release evidence.
- Keep CPU fallback as the correctness baseline for WebGPU, threaded WASM, and
  future accelerated paths.
