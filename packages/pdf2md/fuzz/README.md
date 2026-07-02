# pdf2md Fuzz Targets

This directory contains deterministic JavaScript fuzz target skeletons. They are
not a replacement for future coverage-guided Rust or native JS fuzzing, but they
give CI and local agents a stable smoke mode for parser surfaces that should
never crash on malformed input.

Run all smoke targets from the repository root:

```sh
npm run fuzz:smoke
```

Each target accepts `--iterations <n>` and `--seed <number>` when run directly.
