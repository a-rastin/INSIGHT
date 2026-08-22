# UI Context

## Layout

- Native-feeling desktop shell.
- Top menu/toolbar: New, Open, Save, Select, Add Node, Add Arc, Delete, Fit.
- Main tabs: **Graph** and **XML Code**.
- Right inspector for selected network/node; CPT editor appears for selected nature/chance nodes. Show a network selector only when the file contains multiple networks.
- Bottom status/error area: dirty state, parse/validation result, concise diagnostics.

## Graph behavior

- Nature/chance: rounded node; decision: rectangle; utility: diamond.
- Arrow direction is parent → child.
- Select, box-select, drag, pan, zoom, fit; Delete removes selected elements.
- Add Node then click canvas. Add Arc then connect parent to child.
- Double-click node focuses/opens its inspector.
- New nature node: unique `NodeN`, outcomes `State0`, `State1`, uniform CPT.
- Read/write `PROPERTY` position hints; auto-layout only when missing.

## Inspector

- XMLBIF name/identifier, ordered outcomes, raw properties.
- Outcome reorder uses a real CPT permutation; rename does not.
- Invalid identifier/reference/probability is shown next to the field and in diagnostics.

## CPT editor

- Columns/rows must clearly identify parent configurations and child outcomes.
- Actions: Normalize distribution; Complement selected cell when exactly one missing value can be derived.
- Never hide parent/state order.

## XML Code

- Monospace XML editor with line diagnostics.
- Invalid code remains editable; graph stays on last valid model and shows “Graph not synchronized”.
- Visual edits regenerate deterministic XML and move code status back to synchronized.
