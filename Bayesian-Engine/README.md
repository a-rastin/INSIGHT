# Bayes Engine

Local Electron desktop editor for discrete XMLBIF 0.3 Bayesian networks and influence diagrams.

## Scope

- Visually create and connect `nature`, `decision`, and `utility` nodes.
- Edit nature CPTs with probability controls.
- Edit decision tables as unrestricted finite values.
- Edit utility tables as one unrestricted finite value per parent configuration.
- Utility nodes have no outcomes and cannot have outgoing arcs.
- Lossy decision/utility dimension removal requires confirmation and resets affected raw tables to zero.
- No variable type conversion, inference, learning, or policy optimization.

XMLBIF table order follows historical 0.3 semantics: ordered parents first, rightmost axis fastest. `chance` input is accepted as `nature`; canonical output uses `nature`.

## Requirements

- Node.js 20+ and npm 10+

## Development

```bash
npm ci
npm run dev
```

## Checks

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
```

Electron E2E tests build first, launch Electron, and use only temporary files:

```bash
npm run test:e2e
# Headless Linux:
xvfb-run -a npm run test:e2e
```

## Production

```bash
npm run build             # bundled main, preload, and renderer in out/
npm run package:dir       # unpacked app for current platform
npm run package:linux     # Linux AppImage
npm run package:windows   # Windows NSIS installer
npm run package:mac       # macOS DMG
npm run package           # current-platform distributable
```
