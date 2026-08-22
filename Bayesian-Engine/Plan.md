# Bayes Engine — Detailed Build Plan

This file is the execution plan for an AI coding agent. **Do exactly one unchecked session per chat/session.** Do not start later sessions early.

## How every coding session must work

Before changing code:

1. Read `AGENTS.md` and every file in `context/`.
2. Read this whole session prompt, not only its checklist title.
3. Inspect the current repository, tests, package scripts, and existing public types.
4. If the repository already satisfies part of the session, keep the working implementation and finish only the missing parts. Do not rewrite working code just to match suggested filenames.
5. Stay inside this session's scope. Later-session features may be stubbed only when required to compile.

Before finishing:

1. Run the session's tests plus `lint`, `typecheck`, and relevant build checks.
2. Fix the implementation; never weaken tests or validation to get green output.
3. Mark only this session `[x]` after all acceptance criteria pass.
4. Report changed files, commands run, test results, and remaining risk; then stop.

## Project rules that every session must preserve

These are repeated here so an agent does not need to infer XMLBIF behavior.

- Product: **Bayes Engine**, a local Electron desktop editor for XMLBIF 0.3 files.
- v1 fully edits discrete `nature`, `decision`, and `utility` nodes. It parses `chance` as a compatibility alias. Inference and policy optimization are out of scope.
- Historical XMLBIF 0.3 wire semantics are authoritative when the two supplied XMLBIF guides disagree.
- Canonical probabilistic serialization uses `TYPE="nature"`.
- A variable has an ordered `OUTCOME[]`. **Outcome order is semantic.**
- A definition has one effective `FOR`, ordered `GIVEN[]`, and one effective `TABLE`.
- `GIVEN P` means graph edge `P -> FOR`; there is no independent edge list in persisted domain state.
- **Parent order is semantic.** Never reorder `GIVEN` entries without transposing the CPT.
- Historical table axes are `[parent1, parent2, ..., child]` with the **rightmost axis changing fastest**. Therefore all child outcomes are contiguous for one fixed parent configuration.
- Nature and decision tables use axes `[P1, ..., Pk, X]` and expected length `|X| * product(|Pi|)`.
- Utility tables use parent-only axes `[P1, ..., Pk]` and expected length `product(|Pi|)`; a root utility has one value.
- For probabilistic nodes, each fixed parent configuration must contain finite values `>= 0` summing to `1` within tolerance `1e-9`.
- Decision and utility tables accept any finite real values and are never normalized.
- Nature and decision nodes may parent any node type. Utility nodes are sinks with no outcomes.
- Lossy raw-table dimension removal requires confirmation, resets affected raw tables to zero, and emits warnings. No type conversion is supported.
- The graph must be acyclic.
- Preserve arbitrary `PROPERTY` strings. Interpret `position = (x, y)` only as a UI hint; do not treat arbitrary properties as standard semantics.
- Loadable legacy identifiers may be preserved even if they do not match the editor's creation rule. Newly created/renamed identifiers must match `^[A-Za-z_][A-Za-z0-9_]*$` and be unique in the network.
- New nature node: unique `NodeN`, outcomes `State0`, `State1`, root CPT `[0.5, 0.5]`.
- Visual/domain edits must create a valid model before serialization.
- Invalid XML code remains editable. Graph/code synchronization rules are implemented later; do not improvise them early.
- Renderer has no direct Node.js/filesystem access. Electron privileged operations go through typed preload IPC only.

## Default implementation file map

Use existing equivalent paths if they already exist; do not rename working modules merely to match this map.

```text
src/
  domain/
    model.ts                 # XMLBIF domain types + read-only queries
    diagnostics.ts           # typed diagnostics
    parser.ts                # XML -> domain
    validator.ts             # structure + probability validation
    cptTensor.ts             # flat-index/tensor permutation logic
    mutations.ts             # immutable visual-edit operations
    serializer.ts            # domain -> canonical XMLBIF
  store/
    documentStore.ts         # source/model/sync/dirty state
  components/
    GraphView.tsx
    NodeInspector.tsx
    CptEditor.tsx
    XmlCodeView.tsx
    DiagnosticsPanel.tsx
  renderer/
    commands.ts              # shared UI commands
    App.tsx
  preload/
    api.ts
    index.ts
  main/
    main.ts
    ipc.ts
tests/
  fixtures/
  e2e/
```

Keep domain modules free of React/Electron. Components call store/domain APIs; they do not patch XML or flattened CPT arrays themselves.

## Source conflict note

The supplied historical XMLBIF specification uses `nature|decision|utility` and describes table ordering with `GIVEN` variables before `FOR`, rightmost changing fastest. The supplied explanatory `xmlbif.md` contains some alternate terminology/examples. This repository deliberately follows the historical specification for wire semantics, while accepting `chance` as an input alias for interoperability. Do not “fix” this choice during implementation.

---

# Session checklist

- [x] **01 — Bootstrap desktop shell and tooling**
- [x] **02 — Domain types, fixtures, and pure helpers**
- [x] **03 — XMLBIF parser: XML → ordered domain model**
- [x] **04 — Structural/reference diagnostics**
- [x] **05 — Probabilistic/CPT semantic validation**
- [x] **06 — Generic CPT tensor indexing and permutation helpers**
- [x] **07 — Safe domain mutation API**
- [x] **08 — Deterministic XMLBIF serializer and round-trip tests**
- [x] **09 — Renderer document store and synchronization state machine**
- [x] **10 — Electron New/Open/Save/Save As lifecycle**
- [x] **11 — Read-only Graph View projection**
- [x] **12 — Graph node creation, selection, dragging, deletion, and positions**
- [x] **13 — Node Inspector: name, outcomes, and raw properties**
- [x] **14 — Outcome add/remove/reorder with CPT-safe transforms**
- [x] **15 — Arc creation/removal with DAG and CPT-safe transforms**
- [x] **16 — CPT table editor with Normalize and Complement**
- [x] **17 — XML Code editor and diagnostics UI**
- [x] **18 — Two-way Graph/Domain ↔ XML Code synchronization**
- [x] **19 — Multiple NETWORK support and network-level editing**
- [x] **20 — Undo/redo, commands, menus, shortcuts, and unsaved-close UX**
- [x] **21 — XML fidelity warnings, unsupported content, and robustness hardening**
- [x] **22 — Full integration/E2E regression suite**
- [x] **23 — Packaging, production build, and repository handoff**

---

# Session 01 — Bootstrap desktop shell and tooling

## Copy/paste prompt for the coding agent

You are implementing **Session 01 only** of Bayes Engine.

### Goal

Create a clean Electron + React + TypeScript + Vite desktop project that launches a window titled **Bayes Engine** and has the testing/lint/typecheck foundation required by later sessions. Do not implement XMLBIF logic yet.

### Required stack

Use the repository standards: Electron, React, TypeScript strict mode, Vite, Zustand (may remain unused now), Vitest, Playwright, React Flow package, and CodeMirror 6 dependencies. If the repository is empty, prefer a simple `electron-vite` setup because it gives separate main/preload/renderer builds. If a working equivalent setup already exists, do not migrate it.

Recommended packages for an empty repo:

- runtime: `react`, `react-dom`, `zustand`, `@xyflow/react`, `@uiw/react-codemirror`, `@codemirror/lang-xml`
- dev/build: `electron`, `electron-vite`, `vite`, `typescript`, `@vitejs/plugin-react`, `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`, `eslint`, `prettier`, `playwright`

Do not add a UI framework. Plain CSS is enough.

### Target structure

Use this shape unless the chosen bootstrap already has equivalent locations:

```text
src/
  main/
    main.ts
  preload/
    index.ts
    api.ts
  renderer/
    main.tsx
    App.tsx
    app.css
  domain/
  store/
  components/
tests/
  e2e/
```

Create empty domain/store/component directories only if the repo convention permits tracked placeholders; otherwise create them in later sessions.

### Implementation steps

1. Configure TypeScript with `strict: true`. Do not use global `any` escapes.
2. Configure Electron main process to create one `BrowserWindow` with:
   - title `Bayes Engine`
   - `contextIsolation: true`
   - `nodeIntegration: false`
   - preload script enabled
   - sensible minimum size such as 900x600
3. Preload must expose only a typed placeholder object, e.g. `window.bayesEngine`, with no filesystem methods yet. Do not expose `ipcRenderer` directly.
4. Renderer must show a minimal shell:
   - app title `Bayes Engine`
   - placeholder toolbar row
   - placeholder main content saying `Graph`
   - no fake functionality
5. Add CSS reset/basic layout only. Do not design the final UI yet.
6. Add package scripts with equivalent behavior:
   - `dev`
   - `build`
   - `typecheck`
   - `lint`
   - `format` or `format:check`
   - `test`
   - `test:e2e`
7. Configure Vitest + jsdom and create one renderer smoke test verifying `Bayes Engine` appears.
8. Configure Playwright Electron smoke test. It must launch the packaged/dev Electron entry in a test-safe way and verify a window with title `Bayes Engine` exists. If Playwright Electron setup is too environment-specific for CI, create the test and document the exact command; do not delete it.
9. Add `.gitignore` for `node_modules`, build output, coverage, Playwright artifacts, OS/editor noise.
10. Do not create parser/model/UI business logic.

### Security checks

- Renderer cannot call `require`, `fs`, or direct Electron APIs.
- `window.bayesEngine` is typed through a global declaration.
- No IPC channel accepts arbitrary command names.

### Tests/commands to run

Run the repository equivalents of:

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

If E2E cannot run because the host lacks a display/system dependency, document the exact environment error, but all code/config must still be present and unit/build checks must pass.

### Acceptance criteria

- `npm run dev` opens an Electron window titled `Bayes Engine`.
- Renderer displays the app title without console errors.
- TypeScript strict mode is enabled.
- Electron security settings match the required values.
- Unit smoke test passes.
- Production build succeeds.
- No XMLBIF or graph behavior was prematurely implemented.

At completion, mark Session 01 `[x]`, summarize results, and stop.

---

# Session 02 — Domain types, fixtures, and pure helpers

## Copy/paste prompt for the coding agent

You are implementing **Session 02 only**.

### Goal

Create a framework-free TypeScript domain model that can represent XMLBIF 0.3 without losing `VARIABLE`, `OUTCOME`, `GIVEN`, `TABLE`, or `PROPERTY` ordering. Add reusable fixtures for later parser/serializer/CPT tests.

### Do not do yet

Do not parse XML, serialize XML, render React UI, mutate CPT dimensions, access files, or implement inference.

### Required domain types

Create types under `src/domain/` with names close to these. Adjust filenames, not semantics, if the repo already has conventions.

```ts
export type VariableType = "nature" | "decision" | "utility";
export type SourceVariableType = VariableType | "chance";

export interface XmlProperty {
  text: string;
}

export interface XmlBifVariable {
  name: string;
  type: VariableType;
  sourceType?: SourceVariableType; // optional: only if useful for diagnostics/fidelity
  outcomes: string[]; // ordered
  properties: XmlProperty[]; // ordered
}

export interface XmlBifDefinition {
  for: string;
  given: string[]; // ordered parents
  table: number[]; // flattened historical XMLBIF order
  properties: XmlProperty[];
}

export interface XmlBifNetwork {
  name: string;
  properties: XmlProperty[];
  variables: XmlBifVariable[]; // ordered
  definitions: XmlBifDefinition[]; // ordered
}

export interface XmlBifFile {
  version: string;
  networks: XmlBifNetwork[];
}
```

You may add small metadata fields only when they have a concrete later use. Do not add a second persisted edge list. Do not store parents separately on variables; parents are derived from definitions.

### Pure query helpers

Implement and unit-test small read-only helpers:

- `findVariable(network, name)`
- `findDefinition(network, childName)`
- `parentsOf(network, childName)` derived from `definition.given`
- `edgesOf(network)` returning `{ source: parent, target: child }[]`
- `cardinality(network, variableName)`
- `parentConfigurationCount(network, definition)`
- `expectedTableLength(network, definition)`

For `edgesOf`, preserve definition order and `GIVEN` order. Do not sort.

### Position property helper

Implement a conservative parser for a property string matching the JavaBayes-style hint:

```text
position = (73, 165)
```

Requirements:

- Ignore surrounding whitespace.
- Accept signed/decimal numeric coordinates if the parser can safely parse them.
- Return `null` for unrelated properties.
- Do not rewrite arbitrary property text here.
- Add a formatter for Bayes Engine-generated position properties using one deterministic style, e.g. `position = (100, 200)`.

### Fixtures

Create test fixtures for at least:

1. `Rain` root node with 2 outcomes and table `[0.2, 0.8]`.
2. Two-node network `Rain -> WetGrass`.
3. A multi-parent child with non-binary cardinalities so table-order tests cannot accidentally pass only for binary nodes.
4. A network containing arbitrary properties.
5. Decision and utility variables that can be preserved without advanced semantics.

Fixtures should be plain TypeScript objects and reusable by later sessions.

### Tests

At minimum verify:

- ordered outcomes are not converted to sets/maps;
- ordered parents remain ordered;
- `GIVEN` produces parent→child edges;
- expected table length equals child cardinality × parent cardinalities;
- position property parser does not consume unrelated property strings.

### Acceptance criteria

- Domain module imports no React/Electron/browser code.
- No independent persisted edge list exists.
- All ordered XMLBIF collections use arrays.
- Helpers are pure and typed.
- Fixtures cover root, one-parent, multi-parent, properties, decision, utility.
- Unit tests, typecheck, lint pass.

Mark Session 02 `[x]` and stop.

---

# Session 03 — XMLBIF parser: XML → ordered domain model

## Copy/paste prompt for the coding agent

You are implementing **Session 03 only**.

### Goal

Implement a secure XMLBIF reader that converts XML text into the Session 02 domain model while preserving semantic order. This session handles syntactic parsing and extraction. Deep semantic validation is deferred to Sessions 04–05.

### Parser dependency

Use one XML parser that does not fetch external resources. Prefer a parser that can safely handle XML declarations and internal DOCTYPE text without resolving external entities. Configure it so renderer input cannot cause network/file entity loading. Do not implement a regex-only XML parser.

### Public API

Create an API similar to:

```ts
export interface ParseSuccess {
  ok: true;
  file: XmlBifFile;
  warnings: Diagnostic[];
}

export interface ParseFailure {
  ok: false;
  diagnostics: Diagnostic[];
}

export type ParseResult = ParseSuccess | ParseFailure;

export function parseXmlBif(source: string): ParseResult;
```

If `Diagnostic` is not yet centralized, create the minimal shared type needed now; Session 04 can expand it.

### Extraction rules

Implement these rules exactly:

1. XML must be well formed.
2. Root element must be `BIF`.
3. Read `BIF@VERSION` as a string. Do not silently replace it with `0.3`.
4. Read every direct `NETWORK` child in source order.
5. In each network, read its direct `NAME` text.
6. Read direct `PROPERTY`, `VARIABLE`, and `DEFINITION` blocks. Preserve order within each collection.
7. Variable:
   - direct `NAME`
   - ordered direct `OUTCOME` texts
   - ordered direct `PROPERTY` texts
   - `TYPE`: canonical `nature|decision|utility`; input alias `chance` maps to domain `nature`
   - missing TYPE defaults to `nature` only if consistent with XMLBIF 0.3 default semantics; record source/default info only if useful
8. Definition:
   - effective `FOR`
   - ordered `GIVEN[]`
   - effective `TABLE`
   - ordered `PROPERTY[]`
9. TABLE numbers are whitespace-separated real numbers. Accept normal decimals, integers, signed values, and scientific notation supported by JavaScript `Number` parsing. Do not reject negatives here; Session 05 handles probability semantics.
10. If a DEFINITION contains multiple `TABLE` tags, historical XMLBIF says the **last** table is effective. Use the last one and emit a warning diagnostic.
11. Do not sort variables, outcomes, definitions, parents, or numbers.
12. Decode normal XML text/entities through the XML library. Do not execute content.

### Parsing vs validation boundary

This session may fail on malformed XML or impossible structural extraction such as no BIF root. It should not yet reject:

- duplicate variable names;
- missing references;
- cycles;
- table length mismatch;
- negative probability;
- non-normalized probability.
  Those belong to Sessions 04–05.

### Important compatibility rule

Historical XMLBIF uses `TYPE="nature"`. Some ecosystem files use `TYPE="chance"`. Parse both. Domain canonical type is `nature`. Later serializer writes `nature`.

### Test inputs

Add parser tests containing literal XML strings for:

- minimal valid `BIF VERSION="0.3"` with one network;
- multiple networks;
- nature variable with ordered outcomes;
- `chance` alias mapping to nature;
- decision/utility variable types;
- one and multiple `GIVEN`s preserving order;
- table with line breaks/tabs/scientific notation;
- arbitrary `PROPERTY` text;
- multiple TABLE tags where the last wins + warning;
- malformed XML;
- wrong root element;
- unsupported TYPE returning a diagnostic rather than crashing.

Use at least one fixture where parent order `A, B` would produce a different meaning from `B, A`; assert the parser preserves `A, B` exactly.

### Acceptance criteria

- Parser is framework-free and unit tested.
- No external entity/network resolution is possible through the chosen parser configuration.
- `chance` input becomes canonical domain `nature`.
- Source `OUTCOME` and `GIVEN` order is preserved exactly.
- Scientific notation parses correctly.
- Last TABLE wins with a warning.
- No probabilistic normalization logic is mixed into the parser.

Run unit tests, typecheck, lint. Mark Session 03 `[x]` and stop.

---

# Session 04 — Structural/reference diagnostics

## Copy/paste prompt for the coding agent

You are implementing **Session 04 only**.

### Goal

Build a typed structural validator that answers: “Can this parsed XMLBIF be safely interpreted as a graph/model?” It must not yet enforce probability normalization; that is Session 05.

### Diagnostic model

Create/extend a central diagnostic type similar to:

```ts
export type DiagnosticSeverity = "error" | "warning";
export type DiagnosticCategory =
  | "xml"
  | "structure"
  | "reference"
  | "probability"
  | "compatibility";

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  category: DiagnosticCategory;
  message: string;
  networkIndex?: number;
  variableName?: string;
  definitionFor?: string;
  path?: string;
  line?: number;
  column?: number;
}
```

Exact shape may differ, but diagnostics must have stable machine-readable `code` values and human-readable messages. UI later must not parse message strings to understand error kinds.

### Structural validation API

Implement something like:

```ts
export function validateStructure(file: XmlBifFile): Diagnostic[];
export function hasBlockingStructuralErrors(diagnostics: Diagnostic[]): boolean;
```

### Required errors/warnings

For every network, detect:

- missing/blank network name → error;
- duplicate variable names → error;
- blank variable name → error;
- zero outcomes on a nature node → error;
- duplicate outcome labels within one variable → warning or error; choose one documented policy and test it;
- duplicate definitions for the same `FOR` → error for v1 because there is no unambiguous editable domain behavior;
- definition `FOR` does not reference an existing variable → error;
- any `GIVEN` does not reference an existing variable → error;
- duplicate `GIVEN` parent in one definition → error;
- self-parent (`FOR` also in `GIVEN`) → error;
- duplicate edge generated by structure → error;
- graph cycle → error;
- missing definition for a nature node → error for editable v1;
- more than one definition for a nature node → error;
- a definition for an unsupported/ambiguous structure should produce a clear diagnostic rather than throw.

### DAG check

Implement a pure graph cycle detector using the edges derived from definitions. Kahn or DFS is fine. Do not add a graph library only for cycle detection.

The validator must not maintain a second topology. Always derive edges from `definition.given`.

### Identifier policy

Do **not** reject a loaded variable only because its name does not match the editor creation regex. Instead emit a compatibility warning such as `LEGACY_IDENTIFIER`. New/renamed names will be restricted in mutation sessions.

Recommended editor regex:

```regex
^[A-Za-z_][A-Za-z0-9_]*$
```

### Tests

Create focused tests for every required rule, especially:

- `A -> B -> C -> A` cycle;
- self-edge;
- unknown parent;
- unknown FOR;
- duplicate variables;
- duplicate definition;
- missing nature definition;
- loadable legacy identifier warning but no blocking error.

Also test a valid multi-network file returns no structural errors.

### Acceptance criteria

- Structural validator never mutates the model.
- Errors are deterministic and stable-coded.
- Graph cycles are rejected.
- Existing legacy names are preserved with warnings rather than silently renamed.
- No probability sum/bounds logic is implemented here.
- Tests, typecheck, lint pass.

Mark Session 04 `[x]` and stop.

---

# Session 05 — Probabilistic/CPT semantic validation

## Copy/paste prompt for the coding agent

You are implementing **Session 05 only**.

### Goal

Validate whether nature-node TABLE values form usable conditional probability tables under the historical XMLBIF axis order.

### Preconditions

Use the parsed domain model from Session 03 and structural diagnostics from Session 04. Do not duplicate parsing or graph validation.

### Required CPT ordering

For definition:

```text
FOR = X
GIVEN = [A, B]
```

serialized axes are:

```text
[A, B, X]
```

and the rightmost axis changes fastest. If `X` has 3 outcomes, every consecutive group of 3 values is one `P(X | fixed parents)` distribution.

### Public API

Implement something close to:

```ts
export const PROBABILITY_TOLERANCE = 1e-9;
export function validateProbabilities(file: XmlBifFile): Diagnostic[];
export function validateFile(file: XmlBifFile): Diagnostic[]; // combines structural + probability diagnostics
```

### Nature node checks

For each nature variable with a structurally resolvable definition:

1. Expected table size = child cardinality × product(parent cardinalities).
2. Empty table when values are expected → error.
3. Any non-finite number (`NaN`, `Infinity`, `-Infinity`) → error.
4. Any value `< 0` → error.
5. Each parent configuration's child distribution must sum to 1 within absolute tolerance `1e-9` → error if outside tolerance.
6. Values greater than 1 are naturally caught by non-negative + normalized sum in most cases, but emit a specific bounds error for `value > 1 + tolerance` for clearer UX.

Do not validate decision/utility tables as probabilities. Preserve them and, at most, emit a v1 informational/warning diagnostic if advanced editing is unsupported. Do not invent influence-diagram semantics.

### Distribution grouping helper

Implement a helper that can iterate distributions without UI knowledge:

```ts
forEachDistribution(network, definition, (values, parentStateIndexes) => ...)
```

or an equivalent pure function returning grouped rows. It must use historical axis order, not the alternate guide's order.

### Tests

Cover:

- valid root distribution `[0.2, 0.8]`;
- valid one-parent table with two contiguous child values per parent state;
- valid child cardinality 3;
- multi-parent non-binary table length;
- too short/too long table;
- negative value;
- `NaN`/Infinity through direct domain fixture even if parser cannot create them from XML text;
- normalization error;
- tolerance case that differs only by tiny floating-point error;
- decision/utility table not treated as probability.

### Acceptance criteria

- CPT validation uses child-contiguous historical ordering.
- No UI code.
- Diagnostics identify the affected child and, where practical, parent configuration index.
- Decision/utility are not falsely normalized.
- Full valid fixture has zero errors.
- Tests, typecheck, lint pass.

Mark Session 05 `[x]` and stop.

---

# Session 06 — Generic CPT tensor indexing and permutation helpers

## Copy/paste prompt for the coding agent

You are implementing **Session 06 only**.

### Goal

Create the low-level, heavily tested tensor utilities that later edits must use. This is the most correctness-sensitive session. UI code must never directly reshape flattened TABLE arrays.

### Canonical tensor definition

For child `X` with ordered parents `[P1, P2, ..., Pk]`, axes are:

```text
[P1, P2, ..., Pk, X]
```

Rightmost axis `X` changes fastest.

For cardinalities `[c1, c2, ..., ck, cx]` and indexes `[i1, i2, ..., ik, ix]`, flattened row-major index is:

```text
index = (((i1 * c2 + i2) * c3 + i3) ... * cx + ix)
```

For no parents, index is simply child outcome index.

### Utilities to implement

Create a module such as `src/domain/cptTensor.ts` with pure functions:

- `product(cardinalities)`
- `stridesFor(cardinalities)`
- `coordinatesToFlatIndex(coords, cardinalities)`
- `flatIndexToCoordinates(index, cardinalities)`
- `permuteAxes(values, oldCardinalities, axisPermutation)`
- `permuteAxisStates(values, cardinalities, axisIndex, newOrder)`
- `insertAxis(values, cardinalities, axisIndex, newCardinality, strategy)` or smaller helpers sufficient for later add-parent logic
- `removeAxisIfLossless(...)` or a generic comparison helper
- `groupChildDistributions(values, parentCardinalities, childCardinality)`

Prefer a few composable generic functions over many special-case nested loops.

### Mandatory invariants

Every helper must:

- reject cardinality 0/negative;
- reject wrong value-array length;
- reject invalid permutations (duplicates/out-of-range/wrong length);
- never mutate input arrays;
- work for 0, 1, 2, and 3+ parent axes;
- work for non-binary cardinalities.

### Required test example

Use a deliberately identifiable tensor, not probabilities, to test ordering. Example axes `[A=2, B=3, X=2]` with values equal to their original flat index `[0,1,2,...,11]`. Verify exact results after:

- swapping A and B axes;
- reversing B state order;
- reversing X outcome order;
- round-tripping coordinate↔flat index.

Also include a probability-shaped example and confirm permutation preserves each original number exactly; permutation must not normalize or average.

### Do not do

- no network mutations yet;
- no React;
- no XML serialization;
- no implicit sorting by name;
- no “best effort” behavior when dimensions are invalid—throw/return typed failure.

### Acceptance criteria

- All tensor operations are deterministic and pure.
- Non-binary tests prove correct axis semantics.
- Invalid input is rejected explicitly.
- These helpers are suitable for use by all later state/parent reorder operations.
- Tests, typecheck, lint pass.

Mark Session 06 `[x]` and stop.

---

# Session 07 — Safe domain mutation API

## Copy/paste prompt for the coding agent

You are implementing **Session 07 only**.

### Goal

Implement immutable network/model mutation functions that enforce identifier/reference rules and use Session 06 CPT helpers. These become the only supported path for visual editor changes.

### Mutation result type

Use a typed result so UI can show warnings without catching arbitrary exceptions:

```ts
export interface MutationSuccess<T> {
  ok: true;
  value: T;
  warnings: Diagnostic[];
}
export interface MutationFailure {
  ok: false;
  diagnostics: Diagnostic[];
}
export type MutationResult<T> = MutationSuccess<T> | MutationFailure;
```

Exact naming may differ.

### Implement in this session

1. `renameNetwork`
2. `renameVariable`
3. `setVariableProperties`
4. `setVariablePosition`
5. `addNatureVariable`
6. `deleteVariable`

Do **not** implement outcome reorder/add/remove or arc edits yet; those get dedicated sessions.

### Rename variable behavior

- New name must match `^[A-Za-z_][A-Za-z0-9_]*$`.
- Must be unique in the network.
- Rename the variable.
- Update every matching definition `for`.
- Update every matching parent string in every definition `given`.
- Do not change TABLE values.
- Do not reorder anything.
- Validate resulting structure before returning success.

### Add nature variable behavior

- If caller omits a name, choose smallest/next deterministic unique `NodeN` (e.g. `Node1`, then `Node2`).
- Outcomes exactly `State0`, `State1`.
- Add one definition with `for = NodeN`, no parents, table `[0.5, 0.5]`.
- `type = 'nature'`.
- Add a position property only if caller supplies a canvas position.
- New node must immediately pass full structural + probability validation.

### Delete variable behavior

Deleting a node must:

- remove the variable;
- remove its own definition;
- remove it from `given` arrays of child definitions;
- safely transform affected child CPTs because a parent dimension is being removed.

For this session, implement a conservative rule using Session 06:

- If all distributions across the removed parent's states are identical for every remaining parent configuration, collapse that axis losslessly.
- Otherwise replace affected child distributions with uniform distributions and return a clear warning such as `CPT_RESET_PARENT_REMOVAL`.
- Resulting nature CPTs must be normalized and dimensionally correct.

This rule matches the repository architecture: never silently choose an arbitrary marginalization.

### Position behavior

`setVariablePosition` must update only the recognized Bayes Engine position property. Preserve unrelated properties and their order. If an existing recognized position property exists, replace it in place; otherwise append one.

### Tests

Cover:

- rename updates `FOR` and all `GIVEN` references;
- rename does not alter TABLE array;
- invalid/duplicate rename fails without mutation;
- add node creates valid uniform definition;
- delete isolated node;
- delete parent with identical child rows collapses losslessly;
- delete parent with differing child rows resets child CPT to uniform + warning;
- properties unrelated to position are preserved byte-for-text in domain strings;
- original input object remains unchanged.

### Acceptance criteria

- Mutation API is immutable.
- Every successful visual-domain mutation returns a structurally/probabilistically valid model for nature nodes.
- No UI manually edits references or CPT arrays.
- Warnings are explicit when information is reset.
- Tests, typecheck, lint pass.

Mark Session 07 `[x]` and stop.

---

# Session 08 — Deterministic XMLBIF serializer and round-trip tests

## Copy/paste prompt for the coding agent

You are implementing **Session 08 only**.

### Goal

Serialize the domain model to deterministic XMLBIF 0.3 and prove parse→serialize→parse preserves model semantics and ordering.

### Serializer API

Implement:

```ts
export function serializeXmlBif(file: XmlBifFile): string;
```

Before serializing domain edits, call validation at the service/store layer; serializer itself may also assert required structure but must not silently repair invalid data.

### Canonical output rules

Use deterministic formatting, for example:

- XML declaration `<?xml version="1.0" encoding="UTF-8"?>`
- `<BIF VERSION="0.3">` when domain version is 0.3. If parser preserved another version, decide whether serializer rejects it or writes it; document/test the choice. v1 editing support is 0.3.
- two-space indentation;
- one element per logical line;
- XML-escape text values;
- network content order canonicalized as: NAME, network PROPERTYs, VARIABLEs, DEFINITIONs;
- variable: `<VARIABLE TYPE="nature|decision|utility">`, NAME, OUTCOMEs, PROPERTYs;
- definition: FOR, GIVENs in exact stored order, TABLE, PROPERTYs;
- new/edited probabilistic nodes serialize as `TYPE="nature"`, never `chance`.

### TABLE formatting

- Preserve numeric value order exactly.
- Do not transpose or regroup values in serializer.
- Use a deterministic number formatter that round-trips JavaScript finite numbers. `String(number)` is acceptable if tests prove expected behavior.
- A single line TABLE is acceptable for modest arrays. If wrapping long tables, wrapping must be whitespace-only and not change number order.

### Fidelity boundary

This serializer is canonical, not source-format-preserving. It need not preserve comments, original indentation, DTD formatting, attribute order, or arbitrary unknown tags. Session 21 will warn before destructive canonicalization when needed. It **must** preserve all supported domain semantics and `PROPERTY` text.

### Round-trip tests

Create semantic equality helpers that ignore irrelevant source formatting/sourceType metadata but compare:

- BIF version;
- network order/name/properties;
- variable order/type/name/outcome order/properties;
- definition order/FOR/GIVEN order/TABLE numeric sequence/properties.

Tests:

1. serialize fixture → parse → semantic equality;
2. parse canonical historical-style XML → serialize → parse → equality;
3. `chance` input parses as nature and serializes as `nature`;
4. XML special characters in NAME/OUTCOME/PROPERTY round-trip correctly;
5. multi-parent/non-binary TABLE keeps exact order;
6. multiple networks preserve network order.

### Acceptance criteria

- Serializer is deterministic: serializing the same model twice produces byte-identical text.
- Parse/serialize round-trip preserves supported semantics.
- No CPT transposition occurs in serializer.
- XML escaping is correct.
- Tests, typecheck, lint pass.

Mark Session 08 `[x]` and stop.

---

# Session 09 — Renderer document store and synchronization state machine

## Copy/paste prompt for the coding agent

You are implementing **Session 09 only**.

### Goal

Create the Zustand document store that owns source text, current model, diagnostics, dirty state, active network, and graph/code sync state. No filesystem dialogs yet.

### Canonical document state

Implement the architecture state, close to:

```ts
export type SyncState = "synced" | "code-invalid" | "dirty-domain";

export interface DocumentState {
  sourceText: string;
  model: XmlBifFile | null;
  diagnostics: Diagnostic[];
  sync: SyncState;
  path?: string;
  dirty: boolean;
  activeNetworkIndex: number;
}
```

You may add `lastValidModel` only if needed, but avoid duplicate state that can diverge. Architecture intent: `model` is the last structurally usable model; `sourceText` is always what code editor displays.

### Store actions to implement

- `newDocument()` creates one valid blank/default network. Choose deterministic network name such as `NewNetwork`; document this choice.
- `loadSource(sourceText, path?)` parses + validates and initializes state.
- `applyDomainMutation(mutator)` applies a Session 07 mutation, validates, serializes, updates source text, marks dirty.
- `setActiveNetworkIndex(index)` with bounds check.
- `markSaved(path?)` clears dirty and records path.
- `resetDocument()` if needed for tests.

Do **not** implement free-form code editing sync yet; Session 18 owns that behavior. `loadSource` is for opening/initialization.

### New document requirements

A new document must be structurally and probabilistically valid immediately. It may contain:

- BIF 0.3
- one network named `NewNetwork`
- zero variables/definitions
  This is valid if network without variables is allowed by the project model. If validator currently requires something else, align validator to the source/project rules rather than inventing a dummy node.

### Domain mutation flow

On successful visual/domain mutation:

1. apply pure mutation to current active network/model;
2. run full validation;
3. if blocking error occurs, reject and keep previous state;
4. serialize deterministic XML;
5. set model to new model;
6. set sourceText to serialized text;
7. set sync to `dirty-domain` or `synced` according to architecture naming; use `dirty-domain` until code-view sync session formalizes it;
8. set dirty true;
9. surface mutation warnings in diagnostics/status.

### Store tests

Test transitions, not UI:

- new document valid + not dirty;
- load valid source sets model/path and not dirty;
- failed open/parse returns a controlled result and does not leave half-initialized state;
- successful rename mutation updates model/sourceText and sets dirty;
- rejected mutation leaves previous model/sourceText unchanged;
- markSaved clears dirty;
- active network index bounds.

### Acceptance criteria

- Store contains no Electron direct calls.
- Store delegates XML/domain logic to domain modules.
- No React component owns a second copy of the document model.
- Failed mutations are atomic.
- Tests, typecheck, lint pass.

Mark Session 09 `[x]` and stop.

---

# Session 10 — Electron New/Open/Save/Save As lifecycle

## Copy/paste prompt for the coding agent

You are implementing **Session 10 only**.

### Goal

Add secure desktop file operations through Electron main + preload and connect them to the Session 09 store.

### Allowed file extensions

Open/save filters should include:

- `.xml`
- `.xmlbif`
- `.bifxml`

Do not assume extension proves file type. Parser determines whether content is XMLBIF.

### Typed preload API

Expose narrow methods similar to:

```ts
interface BayesEngineApi {
  openXmlBifFile(): Promise<
    { canceled: true } | { canceled: false; path: string; text: string }
  >;
  saveXmlBifFile(args: {
    path?: string;
    text: string;
  }): Promise<{ canceled: true } | { canceled: false; path: string }>;
  confirmDiscardChanges(): Promise<"save" | "discard" | "cancel">;
}
```

Exact split between `save` and `saveAs` is flexible. Renderer must never receive raw `ipcRenderer` or arbitrary filesystem paths from untrusted channels.

### Main-process behavior

- Use native `dialog.showOpenDialog` and `dialog.showSaveDialog`.
- Read/write UTF-8 text using Node filesystem only in main process.
- Catch I/O errors and return typed failures or route them through a narrow error shape.
- No arbitrary path read IPC. Only paths chosen through dialog or current document path may be used.
- Set main window title to reflect filename and dirty state later; for this session it is enough to expose data needed.

### Renderer commands

Add command/service functions for:

- New
- Open
- Save
- Save As

Rules:

- Open: after file read, call store `loadSource`. If parse/structural load fails, show diagnostics and keep existing document unchanged.
- Save: write current `sourceText`, not a separately reconstructed model.
- Save success calls `markSaved`.
- Save As chooses path even if one already exists.
- Canceling dialogs is not an error.

### Minimal UI

Wire toolbar/menu buttons for New/Open/Save/Save As. They may be visually plain. Do not implement final menus/shortcuts yet.

### Tests

Unit/component tests with mocked preload API:

- open canceled;
- valid open;
- invalid XML open keeps previous document;
- save existing path;
- save without path invokes save dialog;
- save canceled preserves dirty state;
- save success clears dirty;
- I/O failure produces user-visible error state.

If feasible, add one Playwright Electron test that opens a fixture by using a test-specific dialog stub. Do not build a broad E2E harness yet.

### Acceptance criteria

- Renderer has zero direct `fs` imports.
- Preload API is typed and narrow.
- User can New/Open/Save/Save As valid XMLBIF text.
- Invalid open does not destroy current work.
- Unit tests/build/typecheck/lint pass.

Mark Session 10 `[x]` and stop.

---

# Session 11 — Read-only Graph View projection

## Copy/paste prompt for the coding agent

You are implementing **Session 11 only**.

### Goal

Render the active XMLBIF network as an interactive **read-only topology view** using React Flow (`@xyflow/react`). Pan/zoom/select are allowed; no graph mutations yet.

### Domain→graph projection

Create a pure adapter, not ad hoc React mapping:

```ts
projectNetworkToFlow(network): { nodes: Node[]; edges: Edge[] }
```

Rules:

- one flow node per XMLBIF variable;
- stable React Flow node id may use variable `name` for v1;
- one edge per `GIVEN`, source parent, target child;
- edge id deterministic, e.g. `${parent}->${child}` plus disambiguator if needed;
- never infer edges from visual state;
- labels show variable name/identifier;
- nature node shape: rounded rectangle;
- decision: rectangle;
- utility: diamond or visually distinct diamond-like style;
- no inference/probability bars.

### Position rules

For each variable:

1. search its properties for recognized `position = (x, y)`;
2. use that position when present;
3. if missing, generate deterministic layout positions without mutating the domain yet.

Keep auto-layout dependency-free if possible. A simple layered/topological grid is enough. Do not add a heavy layout library unless necessary.

### Graph component

Implement:

- pan;
- zoom;
- fit view;
- click/select one node;
- box selection if React Flow supports it with simple config;
- selected node name available to parent/store UI state;
- read-only edges and nodes (dragging disabled in this session).

Add a `Fit` toolbar action.

### Empty/invalid states

- Empty network: show blank canvas + small hint, not an error.
- No model because source is unusable: show a clear “No synchronized graph” placeholder.
- Semantic CPT errors should not prevent topology rendering if structure is usable.

### Tests

Prefer pure adapter tests plus one component smoke test:

- `GIVEN` becomes parent→child edge;
- two parent order does not get sorted;
- position property used;
- missing positions receive deterministic distinct positions;
- decision/utility get distinct node types/classes;
- empty network renders without crash.

### Acceptance criteria

- Graph is a projection of domain state only.
- No independent edge mutations/state are persisted.
- Parent→child direction is correct.
- Position hints work.
- Pan/zoom/fit/select work.
- Tests/typecheck/lint pass.

Mark Session 11 `[x]` and stop.

---

# Session 12 — Graph node creation, selection, dragging, deletion, and positions

## Copy/paste prompt for the coding agent

You are implementing **Session 12 only**.

### Goal

Make Graph View editable for node-level actions using the Session 07 domain mutation API. Do not add arc editing yet.

### Toolbar modes

Add explicit modes:

- Select
- Add Node
- Delete

Behavior inspired by GeNIe but kept simple:

- Select is default.
- Add Node: click empty canvas to create one nature node at that position, then return to Select mode.
- Optional sticky node mode is out of scope unless trivial; do not add it just because GeNIe has it.
- Delete key/button removes selected node(s). If multi-delete is difficult to make transactionally safe, support one selected node first and test it.

### Dragging

Enable node drag. On drag end:

- convert screen/flow position correctly using React Flow coordinates;
- call `setVariablePosition` domain mutation;
- update source XML through store mutation flow;
- mark document dirty;
- do not write position on every mousemove; only persist on drag end.

### Add node

Use `addNatureVariable` only. Do not manually construct XML or CPT in React.
Expected result:

- unique `NodeN`;
- `State0`, `State1`;
- root CPT 0.5/0.5;
- position property from click point;
- node immediately visible and selected.

### Delete node

Use `deleteVariable`. If deleting a parent forces child CPT reset, show the returned warning in status/error panel. Do not hide it.

### Double-click

Double-clicking a node should select/focus it and prepare for the inspector introduced next session. If inspector placeholder exists, open it; do not implement fields yet.

### Tests

- click Add Node + canvas produces valid new node via store;
- created position becomes property and survives serialize→parse;
- drag-end updates only position property and preserves unrelated properties;
- delete isolated node removes variable + definition;
- deleting a parent updates children through domain helper, not UI array logic;
- warning is visible when CPT reset occurs;
- Delete does nothing destructive with no selection.

### Acceptance criteria

- React components never manipulate TABLE arrays.
- Node actions are store/domain transactions.
- Every successful action yields valid serialized XML.
- Dirty state updates.
- Tests/typecheck/lint pass.

Mark Session 12 `[x]` and stop.

---

# Session 13 — Node Inspector: name, outcomes, and raw properties

## Copy/paste prompt for the coding agent

You are implementing **Session 13 only**.

### Goal

Create the right-side inspector for the selected node. This session edits name and raw properties; it displays outcomes but does not yet add/remove/reorder them.

### Inspector layout

For selected variable show:

- Type (`nature`, `decision`, `utility`) read-only in v1 unless safely changeable later; do not add unsupported type-conversion logic.
- Identifier/Name text field (XMLBIF has one `NAME`; label it clearly as “Name / identifier” if necessary).
- Ordered outcomes list with index numbers.
- Raw properties list, each as a text field or textarea.
- Add Property / Remove Property controls.
- CPT section placeholder for nature nodes; actual table comes Session 16.

### Name edit behavior

Use `renameVariable` mutation:

- validate regex for new edits;
- validate uniqueness;
- show inline error before/after submit;
- on success update all references, graph label, XML source, dirty state;
- pressing Escape/reverting field should not commit;
- avoid committing on every keystroke if it creates invalid intermediate names; prefer explicit blur/Enter commit.

### Property edit behavior

- Preserve property order.
- Raw property text can be arbitrary Unicode text.
- Editing one property changes only that property.
- Removing property is explicit.
- If user edits a recognized position property manually, graph should reflect it on next projection if valid.
- Do not interpret arbitrary property keys.

### Outcomes in this session

Display exact order and values. Allow rename of an outcome **without changing its index** if mutation is straightforward:

- outcome rename changes only text, not TABLE values;
- reject blank outcome if validator policy requires it;
- duplicate outcome behavior must match Session 04 policy.
  Do not add/remove/reorder yet.

### Tests

- selecting node populates inspector;
- valid rename updates FOR/GIVEN refs and source XML;
- invalid rename shows inline diagnostic and leaves model unchanged;
- outcome rename preserves TABLE numeric sequence;
- property edit preserves property order;
- arbitrary property text round-trips.

### Acceptance criteria

- Inspector always edits through domain/store APIs.
- No direct XML string patching.
- Rename/reference behavior remains correct.
- Raw properties are not normalized/reinterpreted.
- Tests/typecheck/lint pass.

Mark Session 13 `[x]` and stop.

---

# Session 14 — Outcome add/remove/reorder with CPT-safe transforms

## Copy/paste prompt for the coding agent

You are implementing **Session 14 only**.

### Goal

Allow editing ordered outcomes while preserving or explicitly resetting every affected CPT. This must work when the edited variable is a child and when it is a parent of other nodes.

### Domain mutations to add

Implement:

- `addOutcome(network, variableName, outcomeName, insertIndex?)`
- `removeOutcome(network, variableName, outcomeIndex)`
- `reorderOutcomes(network, variableName, newOrder)`
- `renameOutcome(...)` if not already done

All must return typed mutation results/warnings and never mutate input.

### Reorder outcome semantics

If variable `V` outcomes are reordered:

1. If `V` has its own nature definition, permute the **child axis** of V's TABLE.
2. For every child definition where V appears in `GIVEN`, permute the corresponding **parent axis**.
3. Do not alter numeric values except by permutation.
4. Revalidate all affected tables.

This is why Session 06 exists. Do not write separate ad hoc loops for child vs parent if generic tensor helpers can handle them.

### Add outcome semantics

Adding an outcome to variable V affects:

- V as child: expand child axis. Preserve old probabilities and assign new state's probability `0` for every parent configuration. This keeps each old distribution normalized and preserves existing probabilities.
- V as parent: each child's tensor gets a new parent-state slice. There is no known conditional distribution for the new parent state, so initialize **only the new slice** uniformly across that child’s outcomes and emit warning `CPT_INITIALIZED_NEW_PARENT_STATE`.

If any affected node is decision/utility with unsupported table semantics, block the visual operation with a clear v1 diagnostic rather than guessing.

### Remove outcome semantics

- V as parent: remove the corresponding parent-state slice from each child table. Remaining slices keep exact values. This is lossless for the remaining domain.
- V as child: if removed state's probability is effectively zero (within tolerance) for every parent configuration, remove it losslessly. Otherwise initialize each affected remaining child distribution uniformly and emit `CPT_RESET_CHILD_OUTCOME_REMOVAL`.
- Never allow a nature variable to end with zero outcomes. Prefer requiring at least one; if UI requires two minimum, document and test that stricter v1 rule.

### UI

Add inspector buttons:

- Add outcome
- Remove selected outcome
- Move up/down (or drag reorder if robust)

Show warning toast/status when any CPT slice is initialized/reset.

### High-value tests

Use non-binary tensors. Test exact arrays after:

- child outcome reorder;
- parent outcome reorder;
- variable that is both child and parent;
- add child outcome adds zeros in correct child-axis positions;
- add parent outcome creates uniform new slices at correct positions;
- remove parent state removes only matching slices;
- remove nonzero child state triggers uniform reset warning;
- round-trip serialize/parse after each mutation.

### Acceptance criteria

- No outcome reorder can silently change probability meaning.
- All affected definitions are transformed.
- New/removed state policy is deterministic and warned when information is invented/reset.
- UI does not manipulate flattened tables.
- Tests/typecheck/lint pass.

Mark Session 14 `[x]` and stop.

---

# Session 15 — Arc creation/removal with DAG and CPT-safe transforms

## Copy/paste prompt for the coding agent

You are implementing **Session 15 only**.

### Goal

Allow users to draw/remove arcs. Persist arcs by editing the child definition's ordered `GIVEN` list and transforming its CPT safely.

### Domain mutations

Implement:

- `addParent(network, childName, parentName, insertIndex?)`
- `removeParent(network, childName, parentName)`
- optional `reorderParents(...)` only if UI exposes it; otherwise still create/test helper for future safety.

### Add arc validation

Reject without mutation:

- parent==child;
- duplicate existing parent;
- unknown nodes;
- edge that would create a directed cycle;
- visual edit involving unsupported decision/utility semantics when CPT transform cannot be defined safely.

### Add parent CPT rule

Adding `P -> X` adds a new parent axis. Preserve the old `P(X | oldParents)` by **replicating the old distribution for every state of P**. This represents X initially independent of the new parent and is a lossless embedding of the old CPT.

The new parent must be inserted in deterministic `GIVEN` position. Default: append to end. If caller supplies insert index, use generic axis permutation correctly.

### Remove parent CPT rule

Removing `P -> X` collapses a parent axis.

- If X's distributions are identical across every state of P for each remaining parent configuration, collapse losslessly.
- Otherwise reset each remaining X distribution to uniform and emit `CPT_RESET_PARENT_REMOVAL`.
- Do not average/marginalize because no prior distribution for P is available.

### Graph UI

Implement `Add Arc` mode:

- user chooses/connects source parent then target child using React Flow connection interaction;
- mutation decides whether valid;
- invalid connection shows diagnostic and graph reverts/does not add edge;
- successful connection immediately appears, source XML updates, dirty true;
- Delete selected edge calls `removeParent`.

Do not keep optimistic edge state that can diverge from domain. After any mutation, re-project graph from model.

### Tests

- root→child add replicates old child distribution across parent states;
- adding second parent preserves prior distribution across new dimension;
- parent insertion/reorder has exact historical axis order;
- duplicate/self/cycle rejected;
- remove parent lossless identical slices;
- remove parent differing slices resets uniform + warning;
- edge deletion updates GIVEN and TABLE dimensions;
- graph direction source parent→target child.

### Acceptance criteria

- Every visible edge is derived from `GIVEN`.
- Cycle creation is impossible through visual UI.
- CPT dimensions remain correct after arc edits.
- No marginalization guess is made on parent removal.
- Tests/typecheck/lint pass.

Mark Session 15 `[x]` and stop.

---

# Session 16 — CPT table editor with Normalize and Complement

## Copy/paste prompt for the coding agent

You are implementing **Session 16 only**.

### Goal

Build a human-readable CPT editor for selected nature nodes. Users should never need to understand the flattened TABLE ordering to edit probabilities, but the UI must visibly show parent/state order.

### Table projection

Create a pure adapter from definition tensor to table rows:

- one row per parent configuration;
- parent columns in exact `GIVEN` order;
- one probability column per child outcome in exact outcome order;
- root node has one row with no parent columns;
- every row maps back to exact flattened indices using Session 06 helpers.

Example for child `Wet` outcomes `[true,false]`, parents `[Rain, Sprinkler]`:

```text
Rain | Sprinkler | P(true) | P(false)
... exact parent state order ...
```

Do not sort parents/outcomes alphabetically.

### Editing behavior

- Numeric cells accept decimal/scientific notation input but commit only finite numbers.
- Prefer local draft text so intermediate `.` or `1e` does not corrupt model.
- On commit, update one TABLE cell through a domain mutation helper.
- Resulting domain can temporarily contain a non-normalized row only if the project explicitly allows code-level semantic invalidity; **visual editing should remain valid**. Therefore either:
  1. use an edit transaction that immediately requires user to Normalize before commit, or
  2. allow row draft values locally and commit the whole row only when normalized.
     Prefer option 2 for correctness.

### Normalize action

For one selected row/distribution:

- all draft values must be finite and non-negative;
- sum must be >0;
- replace each with `value / sum`;
- commit resulting normalized row.
- If sum==0, show error and do not mutate.

This mirrors the useful GeNIe normalization workflow.

### Complement action

For selected cell in a row:

- compute `1 - sum(other cells)`;
- if result is within tolerance of `[0,1]`, set selected draft cell to complement and commit normalized row;
- if result would be negative/out of bounds, show error;
- do not apply when row/selected value context is ambiguous.

### Validation feedback

Show:

- row sum;
- inline error for negative/non-finite/out-of-range;
- global diagnostics panel still receives validator errors;
- CPT editor disabled with explanation when table dimensions are already invalid due to code edits.

### Decision/utility behavior

For v1:

- do not show probability-normalization controls for decision/utility;
- preserve their tables and tell user advanced semantic editing is available only in XML Code view.

### Tests

- root CPT editing;
- one-parent/multi-parent row mapping exact indices;
- normalize `[20,80]` → `[0.2,0.8]`;
- complement when other values sum to 0.3 gives 0.7;
- normalize zero-sum rejected;
- invalid drafts do not mutate domain;
- child outcome order visible and exact;
- parent configuration order matches historical tensor order;
- serialized TABLE after edit has correct flattened order.

### Acceptance criteria

- UI never directly reasons by `rowIndex * childCount` unless helper encapsulates and tests it.
- Visual commits always leave nature CPT valid.
- Normalize/Complement are deterministic and tested.
- Invalid-dimension CPT is blocked rather than misrendered.
- Tests/typecheck/lint pass.

Mark Session 16 `[x]` and stop.

---

# Session 17 — XML Code editor and diagnostics UI

## Copy/paste prompt for the coding agent

You are implementing **Session 17 only**.

### Goal

Add a CodeMirror 6 XML editor tab that displays/edits `sourceText` and shows parse/validation diagnostics. Do not implement graph synchronization from free-form code yet; Session 18 owns the state machine.

### UI layout

Main area has tabs:

- `Graph`
- `XML Code`

XML Code tab:

- CodeMirror 6 with XML syntax highlighting;
- full-height editor;
- current document `sourceText`;
- readable monospace font;
- no direct filesystem access.

Bottom/status area:

- parse/validation summary;
- list diagnostics with severity + concise message;
- where line/column exists, clicking diagnostic should move cursor there;
- if semantic diagnostic has no exact source location, show it without inventing a fake precise line.

### Editor state in this session

Introduce a local/code draft action such as `setCodeDraft(text)` in store or component state, but do **not** replace graph model automatically yet. The UI should clearly show code is “pending synchronization” if text differs from store's synchronized source.

Avoid duplicate uncontrolled copies that will make Session 18 difficult. Prefer store-owned `sourceText` plus a specific sync status.

### Diagnostics

On debounce (e.g. 200–400ms):

- parse draft using parser;
- if parse succeeds, run structural + probability validators;
- display diagnostics;
- do not crash on every keystroke;
- malformed XML remains in editor.

If parser library provides syntax line/column, wire it into CodeMirror marker. Do not spend the session building a custom source mapper for every semantic field.

### Tests

- Code tab renders current XML;
- editing malformed XML leaves text visible;
- syntax error diagnostic appears;
- valid XML diagnostics update after debounce (use fake timers if needed);
- switching tabs does not lose draft;
- diagnostic with location can focus corresponding line if implementation exposes it.

### Acceptance criteria

- XML Code view is usable even with invalid XML.
- Diagnostics are debounced and do not freeze UI.
- Graph model is not yet silently replaced from code edits.
- No direct XML string editing occurs outside code editor/store.
- Tests/typecheck/lint pass.

Mark Session 17 `[x]` and stop.

---

# Session 18 — Two-way Graph/Domain ↔ XML Code synchronization

## Copy/paste prompt for the coding agent

You are implementing **Session 18 only**.

### Goal

Complete the document synchronization state machine so graphical edits and code edits are two views of one document without data loss.

### Required synchronization rules

#### A. Open/New

- sourceText and model start synchronized.
- sync = `synced`.

#### B. Visual/domain edit

1. apply domain mutation;
2. require resulting model to pass structural + nature probability validation;
3. serialize deterministic XML;
4. replace `sourceText` with serialized XML;
5. set model to new model;
6. sync returns to `synced` (or use `dirty-domain` only transiently internally);
7. dirty=true.

#### C. Code edit: malformed XML or blocking structural error

1. keep exact typed `sourceText`/draft;
2. update diagnostics;
3. **do not replace the graph model**;
4. graph continues showing last structurally usable model;
5. sync=`code-invalid`;
6. show clear banner `Graph not synchronized with XML code`;
7. dirty=true because user changed document text.

#### D. Code edit: structurally usable XML

1. parse to new model;
2. replace graph model with it;
3. run probability diagnostics;
4. semantic probability errors may remain visible, but topology can still update because structure is usable;
5. sync=`synced` if the source text exactly corresponds to current model view;
6. dirty=true.

If code has invalid CPT dimensions, Graph topology may render, but CPT editor must show “cannot edit until table dimensions are fixed”.

### Critical data-loss rule

When code is invalid, **do not allow a visual edit to silently serialize the stale graph model over the user's invalid code text.** Choose one explicit UX:

- disable visual mutations while `sync='code-invalid'` with message “Fix XML code or discard code changes first”; OR
- offer explicit “Discard invalid code and return to graph model” action.
  Implement at least the disable behavior; optional discard action is helpful.

### Debounce/race safety

Code parse is debounced. Guard against stale async results:

- use monotonically increasing edit version/token;
- only latest parse result may update store.
  Even if parser is synchronous, debounce callbacks can race with newer state.

### Save behavior

Saving writes exact current `sourceText`, including invalid XML if the user explicitly chooses Save. Do not silently serialize stale model on save. Optionally warn that file has errors, but allow saving typed source unless product context says otherwise.

### Tests

State-machine tests are mandatory:

- valid code edit updates graph model;
- malformed code keeps last graph model + exact invalid text;
- visual edit disabled while code-invalid;
- fixing code resynchronizes graph;
- semantic normalization error can update topology but CPT editor blocks unsafe table edit;
- stale debounce result cannot overwrite newer code;
- save while code-invalid writes exact typed text;
- visual edit after valid code regenerates deterministic XML.

### Acceptance criteria

- No silent loss of invalid code.
- Graph never pretends to show invalid/unparsed source.
- User always sees sync status.
- Two-way editing passes tests.
- Tests/typecheck/lint pass.

Mark Session 18 `[x]` and stop.

---

# Session 19 — Multiple NETWORK support and network-level editing

## Copy/paste prompt for the coding agent

You are implementing **Session 19 only**.

### Goal

Make files containing multiple `<NETWORK>` blocks usable. Parser already preserves them; now expose safe selection and basic network-level editing.

### UI behavior

- If file has one network, do not waste space with a selector.
- If file has >1 networks, show a network selector near tabs/toolbar.
- Selection uses `activeNetworkIndex`; do not identify networks only by name because names may be edited.
- Graph, inspector, and CPT editor all operate on active network only.
- XML Code always shows whole file.

### Network actions

Implement:

- Rename active network.
- Add network with deterministic unique name such as `NetworkN`.
- Delete network with confirmation if it contains variables.
- Ensure active index is adjusted after deletion.

Historical XMLBIF can contain zero or more NETWORK elements at DTD level. For editor UX, decide whether Bayes Engine requires at least one network in an open editable document. Recommended: New creates one; deleting the last network is blocked to keep UI simple. Document/test this as a v1 editor constraint rather than a source-format claim.

### Synchronization

Every network-level visual edit must use the same domain→serialize path. Code edits containing multiple networks must update selector count/names after successful structural parse.

### Tests

- parse/open two networks, selector appears;
- switching network changes graph/inspector only;
- rename active network updates XML;
- add network;
- delete non-last network adjusts index safely;
- code edit adding/removing network updates selector after sync;
- one-network file hides selector.

### Acceptance criteria

- No model data from inactive networks is lost during edits.
- Serialization preserves network order.
- Active index is always valid.
- Tests/typecheck/lint pass.

Mark Session 19 `[x]` and stop.

---

# Session 20 — Undo/redo, commands, menus, shortcuts, and unsaved-close UX

## Copy/paste prompt for the coding agent

You are implementing **Session 20 only**.

### Goal

Turn the feature set into a coherent desktop editor: command layer, keyboard shortcuts, undo/redo for domain edits, status feedback, and close protection.

### Command layer

Create centralized commands so toolbar, menu, and shortcuts call the same functions. Commands should include:

- New
- Open
- Save
- Save As
- Undo
- Redo
- Delete selected
- Select mode
- Add Node mode
- Add Arc mode
- Fit graph
- switch Graph/XML tabs if useful

Do not duplicate behavior in each UI entry point.

### Keyboard shortcuts

Implement at least:

- Ctrl/Cmd+N New
- Ctrl/Cmd+O Open
- Ctrl/Cmd+S Save
- Ctrl/Cmd+Shift+S Save As
- Ctrl/Cmd+Z Undo
- Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y Redo
- Delete/Backspace delete selected graph element when focus is not inside text input/editor
- F12 or a documented shortcut for Fit if cross-platform safe; otherwise toolbar-only Fit is acceptable

When CodeMirror/text input has focus, typing/delete/undo should operate on editor text, not graph commands.

### Undo/redo scope

Undo/redo must cover **visual/domain edits** as atomic transactions:

- rename;
- property edit;
- node add/delete/move;
- outcome edit;
- arc edit;
- CPT row commit;
- network add/delete/rename.

Simplest reliable approach: history snapshots of `model + sourceText + relevant selection`, bounded to e.g. 50 entries. Do not include file path or saved baseline incorrectly.

Free-form CodeMirror has its own undo history; do not force domain history into it. When valid code sync replaces model, clear or rebase visual history to avoid undoing into unrelated source states. Document/test the chosen rule.

### Dirty tracking

Dirty should mean current source differs from last saved/opened source. If current implementation only toggles boolean, improve it using `savedSourceText` or a stable hash/reference. Undoing back to exact saved text should clear dirty automatically.

### Unsaved close/new/open

Before destructive New/Open/window close when dirty:

- show Save / Discard / Cancel;
- Save attempts save; if canceled/fails, abort destructive action;
- Discard proceeds;
- Cancel does nothing.

Electron `beforeunload` alone is not enough; coordinate with main window close event and typed IPC/dialog.

### Menus/status

Add native or app menu entries for File/Edit/View essentials. Keep toolbar.
Bottom status bar should show:

- filename or Untitled;
- dirty marker;
- sync state;
- error/warning count.

### Tests

- shortcut routes to command once;
- Delete ignored while typing in input/CodeMirror;
- undo/redo domain edit restores exact XML semantics;
- undo to saved source clears dirty;
- valid code sync clears/rebases visual history according to policy;
- close dirty + Cancel keeps window;
- close dirty + Save then successful write closes;
- save canceled keeps window;
- new/open dirty prompt behavior.

### Acceptance criteria

- Commands are centralized.
- Unsaved work cannot be lost without explicit discard.
- Undo never corrupts CPT ordering.
- Dirty state reflects source equality with saved baseline.
- Tests/typecheck/lint/build pass.

Mark Session 20 `[x]` and stop.

---

# Session 21 — XML fidelity warnings, unsupported content, and robustness hardening

## Copy/paste prompt for the coding agent

You are implementing **Session 21 only**.

### Goal

Harden Bayes Engine against real-world XMLBIF files and make canonicalization loss visible. Do not expand v1 into inference or GeNIe/XDSL support.

### Canonicalization/fidelity problem

Bayes Engine preserves exact opened `sourceText` until a visual/domain edit. Once it serializes the domain, unsupported source details such as comments, DTD formatting, unknown elements, or original whitespace may be lost.

Implement detection and warning before the **first** visual edit that would canonicalize such a file.

### Detect source features

At open/code parse time, record whether source contains any supported-risk features such as:

- XML comments;
- DOCTYPE/internal DTD;
- unknown elements/attributes not represented in domain;
- processing instructions beyond XML declaration;
- other content parser intentionally ignores.

Do not call normal known XMLBIF PROPERTY text “unsupported”.

### UX

If no lossy source features: visual edit proceeds normally.
If lossy features exist and this is first visual edit since open/code sync:

- show confirmation: “Graphical editing will rewrite XML in Bayes Engine's canonical XMLBIF format and may remove comments/unknown XML formatting. Continue?”
- Continue → perform edit and remember acknowledgment for this source revision.
- Cancel → no mutation/no dirty change.

A code edit that introduces new unsupported features should reset acknowledgment.

### Input hardening

Add reasonable protections:

- cap file size or warn for very large files before rendering; choose documented practical limit, e.g. 10–25 MB, rather than allowing accidental UI freeze;
- parser errors must never crash renderer;
- extremely large TABLE arrays should show a performance-safe CPT UI (virtualize or show warning/limit rows). Do not prematurely optimize small tables;
- reject non-finite numeric results;
- no external entity/network resolution;
- no execution of XML content;
- file paths are displayed as text only, never injected as HTML.

### Compatibility tests

Add fixtures for:

- XML declaration + internal DOCTYPE;
- comments;
- arbitrary PROPERTY values;
- chance alias;
- scientific notation;
- legacy identifier warning;
- unknown safe element causing canonicalization warning;
- very large but bounded table/path behavior if practical.

### Decision/utility preservation audit

Open, code-edit, save, and visually edit unrelated nature nodes in a file containing decision/utility variables. Ensure supported fields/tables survive canonical serialization. Do not normalize utility tables.

### Acceptance criteria

- User is warned before known lossy canonicalization.
- Exact source remains untouched until actual domain serialization.
- Unsupported content never executes.
- Robustness tests pass.
- No new out-of-scope inference features are added.
- Tests/typecheck/lint/build pass.

Mark Session 21 `[x]` and stop.

---

# Session 22 — Full integration/E2E regression suite

## Copy/paste prompt for the coding agent

You are implementing **Session 22 only**.

### Goal

Build a high-value integration and Playwright Electron test suite that proves complete user workflows and catches XMLBIF ordering regressions. Do not redesign features unless a test exposes a real defect.

### Test fixture files

Create small checked-in XMLBIF fixtures under a test fixture directory:

1. root-node network;
2. one-parent network;
3. two-parent, non-binary network with recognizable CPT values;
4. properties/positions;
5. multi-network file;
6. decision/utility preservation file;
7. malformed XML;
8. structurally invalid cycle/reference file;
9. semantically invalid probability file;
10. comment/DOCTYPE fidelity-warning file.

### Mandatory E2E workflows

Automate as many as reliable with Playwright Electron:

#### Workflow A — Open/edit/save/reopen

- open valid fixture;
- verify graph nodes/edge direction;
- rename node;
- edit CPT row;
- drag node;
- save as temp file;
- reopen temp file;
- verify name/CPT/position semantics persisted.

#### Workflow B — Add structure

- new document;
- add 3 nature nodes;
- add two valid arcs;
- attempt cycle and verify rejection;
- edit outcomes;
- save/reopen;
- verify exact topology and valid CPT dimensions.

#### Workflow C — Code↔graph sync

- open valid file;
- edit XML code to add/change node and verify graph updates;
- make XML malformed and verify graph stays last usable + banner;
- verify visual edit disabled;
- fix XML and verify resync;
- visually rename and verify XML regenerated.

#### Workflow D — CPT ordering regression

Using non-binary multi-parent fixture:

- reorder parent outcome;
- reorder child outcome;
- add/remove parent;
- save/reopen;
- compare resulting parsed TABLE against exact expected array.
  This is the most important regression test.

#### Workflow E — Unsaved close

- make edit;
- close/new/open;
- test Cancel, Discard, and Save branches.

#### Workflow F — Multiple networks

- switch active network;
- edit second network;
- verify first unchanged;
- code edit network count and selector update.

### Lower-level integration tests

If some Electron dialogs are hard to automate, use integration tests around store + mocked preload rather than removing coverage.

### CI-friendly behavior

- Tests must create temporary files in test temp directory, never user documents.
- Clean up temp files.
- Avoid timing sleeps; wait for explicit UI state.
- Add stable `data-testid` only where accessibility roles/text are insufficient.
- Do not make production behavior depend on test mode except for safe dialog stubbing through a dedicated test harness.

### Final regression commands

Run:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

Fix all failures. Do not snapshot large XML blindly; use semantic assertions for CPT arrays and topology.

### Acceptance criteria

- Critical open/edit/save/reopen workflow is automated.
- CPT order has exact non-binary regression coverage.
- Invalid code synchronization is automated.
- Cycle rejection and unsaved-close are covered.
- Full suite passes in supported environment.

Mark Session 22 `[x]` and stop.

---

# Session 23 — Packaging, production build, and repository handoff

## Copy/paste prompt for the coding agent

You are implementing **Session 23 only**, the final build session.

### Goal

Make the repository ready for another developer/user to clone, test, build, and package Bayes Engine. Do not add new product features.

### Production packaging

Use the existing Electron build ecosystem. Configure distributable builds for at least:

- Windows
- Linux
- macOS configuration if cross-build is not possible on current host

It is acceptable that actual macOS signing/build requires macOS. Document platform requirements instead of faking success.

Package metadata:

- product name: `Bayes Engine`
- executable/app identifier: sensible unique value such as `com.bayesengine.app`
- version from `package.json`
- placeholder icon allowed if no final brand asset exists, but document replacement path

### Build safety

- preload/main/renderer all bundled correctly;
- production window loads local packaged assets, not dev server;
- source maps policy documented;
- no dev-only IPC/debug endpoint shipped accidentally;
- `nodeIntegration=false`, `contextIsolation=true` still true in production;
- no test fixture path hardcoded into production code.

### README

Create/update root `README.md` with concise sections:

1. What Bayes Engine is.
2. v1 scope and non-goals.
3. Requirements (Node/npm versions if enforced).
4. Install.
5. `npm run dev`.
6. Unit/type/lint tests.
7. E2E tests and OS dependencies.
8. Production build/package commands.
9. Supported file extensions.
10. Important XMLBIF compatibility note: historical 0.3 ordering, `chance` accepted but `nature` serialized.
11. Known limitations: no inference/learning; decision/utility advanced editing only in code; canonical serialization may remove unsupported XML after warning.

### Repository cleanup

- remove dead stubs/debug logs/TODOs that claim implemented work is pending;
- keep meaningful TODOs only with clear reason;
- ensure no generated build artifacts committed unless intentional;
- ensure lockfile is present;
- check license only if project owner has chosen one; do not invent a license.

### Final verification

From clean install if practical:

```bash
rm -rf node_modules <build-output>
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

Then run the packaged app on the current OS and manually smoke-test:

- New
- Open fixture
- Graph visible
- Edit node/CPT
- XML Code sync
- Save As
- Reopen
- Close dirty prompt

### Final acceptance criteria

- Clean install/build works.
- Tests pass.
- Current-OS package launches.
- README commands are accurate.
- Security settings verified in production.
- No known blocking data-corruption bug remains.
- All prior Plan sessions are `[x]`.

Mark Session 23 `[x]`, report final build/package outputs and any platform-specific packaging limitation, then stop.

---

# Completion definition for the whole project

Bayes Engine v1 is complete only when all sessions are checked and a user can:

1. create/open an XMLBIF 0.3 document;
2. see its Bayesian network graph;
3. add/move/delete nature, decision, and utility nodes;
4. create/remove arcs without cycles;
5. edit ordered outcomes safely;
6. edit nature CPTs with Normalize/Complement and decision/utility raw values without probability controls;
7. edit/view raw XML code;
8. recover from invalid code without losing the last usable graph or typed XML;
9. save and reopen with the same supported network semantics and CPT ordering;
10. use multiple NETWORK blocks;
11. receive warnings before known lossy canonicalization;
12. close/new/open without silently losing unsaved work;
13. pass the exact non-binary CPT ordering regression tests.
