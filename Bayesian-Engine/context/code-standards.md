# Code Standards

## Stack

Electron + React + TypeScript + Vite; React Flow; CodeMirror 6; Zustand; Vitest; Playwright.

## Rules

- TypeScript `strict`; no `any` without a documented boundary.
- Domain/XML modules are framework-free, pure where practical, and fully unit tested.
- UI never manipulates flattened CPT arrays directly; call domain tensor helpers.
- Prefer small named functions, explicit types, early returns, and immutable updates.
- No swallowed errors. Convert expected failures to typed diagnostics; unexpected failures reach the error boundary/log.
- Keep dependencies minimal; do not add a library for trivial logic.
- Electron: `contextIsolation: true`, `nodeIntegration: false`, narrow typed preload IPC allowlist.
- File/XML input is untrusted. Do not resolve external entities/URLs or execute embedded content.
- Format/lint/test must pass before a Plan step is marked complete.

## Tests

- Unit: parser, serializer, validator, CPT transforms, store mutations.
- Component: inspector/CPT/code diagnostics where logic exists.
- E2E: only cross-layer user workflows.
- Every bug fix gets a regression test.
