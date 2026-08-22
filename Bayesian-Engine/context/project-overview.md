# Project Overview

## Product

**Bayes Engine** is a local desktop editor for XMLBIF Bayesian-network and influence-diagram files. Users can create/open/save a model, draw its DAG, edit node states and tables, and edit/view the underlying XML.

## v1 scope

- XMLBIF 0.3 discrete networks.
- Full visual authoring for discrete `nature`, `decision`, and `utility` nodes; parse compatibility alias `chance`.
- Decision and utility tables are editable raw finite values. Policy optimization and influence-diagram inference remain out of scope.
- Ordered outcomes/parents, arbitrary `PROPERTY` strings, and node positions.
- XML code view with validation and two-way synchronization.
- No inference, learning, evidence propagation, DBNs, or GeNIe-specific XDSL features.

## XMLBIF rules

- Root: `<BIF VERSION="0.3">`; each `<NETWORK>` has a `<NAME>`.
- Variable: `<VARIABLE TYPE="nature|decision|utility">`, `<NAME>`, ordered `<OUTCOME>`s, optional `<PROPERTY>`s.
- Definition: `<FOR>child</FOR>`, ordered zero-or-more `<GIVEN>parent</GIVEN>`, `<TABLE>...</TABLE>`, optional properties.
- Each `GIVEN P` defines edge `P -> FOR`; there is no separate XML edge list.
- `OUTCOME` and `GIVEN` order are semantic.
- For nature/chance nodes, expected table length: `product(|parents|) × |child|`.
- Decision tables use axes `[parent1, parent2, ..., decision]` and accept any finite real values without normalization.
- Utility tables use parent-only axes `[parent1, parent2, ...]`, with one finite real value per parent configuration. Utility nodes have no outcomes.
- Historical XMLBIF 0.3 serialization order is axes `[parent1, parent2, ..., child]`; the rightmost axis changes fastest, so child outcomes are contiguous for each parent configuration.
- For probabilistic nodes, each fixed parent configuration must form a finite, non-negative distribution summing to 1 within tolerance (`1e-9`).
- Graph must be acyclic; names/references must resolve.
- Nature and decision nodes may parent nature, decision, or utility nodes. Utility nodes are sinks and cannot parent another node.
- Removing raw-table dimensions preserves identical slices losslessly. If values would be discarded, visual editing requires confirmation and resets each affected decision/utility table to zero.
- `PROPERTY` text is application-specific; preserve unknown values. Recognize `position = (x, y)` only as a UI hint.
- Original 0.3 material uses `TYPE="nature"`; some ecosystem material uses `chance`. Parse both; serialize new probability nodes as `nature`.
- For newly created/renamed identifiers use `^[A-Za-z_][A-Za-z0-9_]*$`; preserve loadable legacy names and warn when they fall outside it.
- If the two provided XMLBIF guides disagree on wire semantics, follow `The Interchange Format for Bayesian Networks.md` (the historical 0.3 specification).

## Source-derived UX baseline

Use GeNIe only as interaction inspiration: graph canvas, node/arc tools, double-click node properties, move/select/delete, save/open, and direct probability editing with normalize/complement behavior. Do not clone its full feature set or branding.

## Success

A file can be opened, visually edited, code-edited, validated, saved, reopened, and retain the same network semantics and table ordering.
