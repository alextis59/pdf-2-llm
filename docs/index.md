# Documentation Index

Start with `README.md` for product overview, quick start, and common commands.
Use this index to find implementation, security, quality, and workflow details.

## Agent And Architecture Docs

- [Agent Instructions](../AGENTS.md): repository-specific working rules,
  validation guidance, and documentation expectations.
- [Architecture](../ARCHITECTURE.md): runtime surfaces, conversion flow, module
  map, corpus architecture, CI shape, and current boundaries.
- [Agent Coordination Protocol](agent-coordination.md): cross-agent contract for
  phase/gate work, tests, performance evidence, and schema/warning changes.

## Public API And User Workflows

- [API Reference](api.md): `convertPdfToMarkdown()` inputs, options, outputs,
  schemas, warnings, and operational notes.
- [CLI Reference](cli.md): local-file `pdf-2-llm` and `pdf2md` command usage.
- [Workflow Specs](workflows.md): practical CLI, JavaScript API, corpus, and
  release-verification workflows.
- [WASM Loading For Bundlers](wasm-loading.md): browser, worker, Node, and
  package-relative WASM asset loading.

## Behavior And Limits

- [Security](SECURITY.md): repository security invariants and hostile-input
  handling.
- [Security Limits](security-limits.md): supported resource limits, warnings,
  timeout behavior, and focused validation commands.
- [Warnings And Confidence Scores](warnings-confidence.md): warning-code policy
  and downstream gating guidance.
- [OCR Model Loading](ocr-model-loading.md): current OCR planning contract and
  injected-result behavior.
- [WebGPU Behavior And Fallback](webgpu-behavior.md): optional acceleration,
  CPU fallback, diagnostics, and browser validation behavior.

## Quality And Delivery

- [Quality](QUALITY.md): validation ladder from focused checks through release
  proof.
- [Tech Debt Tracker](tech-debt-tracker.md): known practical gaps and next
  validation steps.
- [Execution Plan Template](exec-plans/template.md): template for scoped plans
  that need implementation and validation evidence.
- [Release Notes](release-notes.md): release-readiness snapshot, known
  limitations, and integrator notes.

## Corpus And Implementation Studies

- [Corpus README](../corpus/README.md): corpus entry policy, redistribution
  rules, acceptance rules, and storage policy.
- [Acceptance Criteria README](../corpus/accepted/README.md): gate labels,
  accepted YAML rules, and metric requirements.
- [PDF-to-Markdown Implementation Plan](pdf-to-markdown-implementation-plan.md):
  phase plan and acceptance checklist.
- [WebAssembly + WebGPU Study](pdf-to-markdown-webassembly-study.md): source
  study behind the package architecture and long-term direction.

## Package And Module READMEs

- [JavaScript Workspace README](../packages/pdf2md/README.md): package-local
  layout, scripts, module boundaries, and tests.
- [Rust/WASM Core README](../crates/pdf2md-core/README.md): current preflight
  bridge scope and validation.
- [Fuzz Targets README](../packages/pdf2md/fuzz/README.md): deterministic fuzz
  smoke target coverage.
