# Architecture

## Layers

```text
Electron main
  └─ typed preload bridge: dialogs + filesystem only
Renderer
  ├─ UI: Graph / Inspector+tables / XML Code
  ├─ Document store: path, dirty, sourceText, model, diagnostics, sync state
  └─ Domain
      ├─ model + immutable mutations
      ├─ table tensor/index transforms
      ├─ validator
      └─ xmlbif parser/serializer
```

No UI code in parser/domain; no filesystem access in React components.

## Canonical state

```ts
DocumentState = {
  sourceText: string;          // exact opened/code-edited text
  model: NetworkFile | null;   // last successfully parsed structural model
  diagnostics: Diagnostic[];
  sync: 'synced' | 'code-invalid' | 'dirty-domain';
  path?: string;
  dirty: boolean;
  activeNetworkIndex: number;
}
```

Graph renders `model`. Code renders `sourceText`.

## Sync

- **Open/code edit:** sourceText → secure parse → structural/semantic diagnostics → if structurally usable, replace model; otherwise keep last valid model.
- **Graph/inspector/CPT edit:** domain mutation → validate → serialize deterministic XML → replace sourceText → mark dirty.
- Do not parse/serialize through the UI layer.

## Domain shape

Keep ordered arrays:

- file.networks[]
- network.variables[] / properties[] / definitions[]
- variable.outcomes[] / properties[]
- definition.parents[] / tableValues[] / properties[]
  Never use sets/maps as the persisted ordering source.

## CPT safety

For nature/chance nodes, treat a table as tensor axes `[parent1, parent2, ..., child]`, rightmost fastest (child outcomes contiguous per parent configuration).

- Rename: no numerical change.
- Reorder child outcomes/parents/parent outcomes: permute tensor exactly.
- Add parent: expand dimension; initialize new configurations deterministically (uniform unless an existing distribution can be safely replicated).
- Remove dimension/state: preserve only when transformation is lossless; otherwise initialize affected distributions uniformly and emit a user-visible warning.
- After every transform, validate dimensions and probability normalization for nature/chance nodes.

## Influence diagrams

- Nature and decision table axes are `[parent1, parent2, ..., child]`; utility table axes are parent-only.
- Decision and utility cells accept any finite real value. They are never normalized or range-checked as probabilities.
- Nature and decision nodes may be arc sources. Utility nodes are sinks.
- Decision nodes have ordered outcomes. Utility nodes have no outcomes and one value per parent configuration.
- Lossless parent/state removal collapses identical raw slices. Lossy removal requires UI confirmation, then domain mutation resets every affected raw table to zero and emits warnings.
- Variable type is immutable; no type-conversion mutation exists.

## XML fidelity

Keep exact source text until a domain edit. Serializer is canonical, not formatting-preserving. Preserve supported XMLBIF content and arbitrary PROPERTY text. Comments, DTD formatting, and unknown tags may be lost only after a visual/domain edit; warn before destructive canonicalization when such content is detected.
