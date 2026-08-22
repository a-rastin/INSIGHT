# UI Context

## Product Identity and Branding

The product name is **INSIGHT**.

Use `INSIGHT` for the principal product wordmark. Product-logo treatments should use the uppercase form.

## Current Design Character

INSIGHT is a research project and a desktop-first decision-support workspace for psychiatrists. Its dominant visual language is:

- bright and predominantly light;
- white or near-white clinical surfaces;
- dark neutral text;
- restrained teal for primary actions and selection;
- explicit semantic colors for urgent, warning, normal, follow-up, and informational states;
- compact, information-dense clinical workspaces;
- wider spacing on authentication and initial-entry states;
- clear clinician review, provenance, and safety messaging;
- minimal decorative imagery.

The visual tone should be organized, calm, serious, and modern. Avoid playful illustration, decorative gradients, glassmorphism, excessive blur, neon colors, oversized marketing typography inside clinical workspaces, or consumer-wellness styling.

## Theme

Use color sparingly:

- Teal is reserved for primary actions, active navigation, selected controls, focus indicators, and selected clinical metrics.
- Clinical state colors are restricted to text, icons, badges, borders, and narrow accent stripes. Do not use them as large page or card fills.
- Primary body copy always uses the ink tokens, not teal.
- Clinical dashboards may be information-dense; patient-facing surfaces, if added, must use more whitespace and larger touch targets.

### Theme-mode status

The supplied product prompt requests a dark/light mode toggle, but the archive defines only a light palette and provides no dark tokens, contrast validation, or dark-theme component contract. Therefore:

- The light theme below is the only approved theme in the current context.
- Do not derive dark colors by inversion and do not invent dark tokens.
- Do not expose a functional dark-mode toggle until an approved dark palette and accessibility review are supplied.
- Treat dark mode as an unresolved product/design decision, not as implemented behavior.

## Canonical Color System

The canonical palette is the teal/neutral system used in the shared design references and implemented most directly by Dashboard, Diagnosis, Severity, and Suicide Risk.

Use repository-aligned token names:

```css
:root {
  --primary: #0A9E8F;
  --primary-hover: #088A7D;
  --primary-light: #E6F6F5;
  --on-primary: #FFFFFF;

  --ink: #111827;
  --ink-muted: #6B7280;
  --ink-subtle: #9CA3AF;

  --canvas: #FFFFFF;
  --surface-1: #F9FAFB;
  --surface-2: #F3F4F6;

  --border: #E5E7EB;
  --border-strong: #D1D5DB;

  --urgent: #DC2626;
  --urgent-bg: #FEF2F2;

  --warning: #D97706;
  --warning-bg: #FFFBEB;

  --normal: #059669;
  --normal-bg: #ECFDF5;

  --follow-up: #7C3AED;
  --follow-up-bg: #F5F3FF;

  --info: #0284C7;
  --info-bg: #F0F9FF;
}
```

### Color roles

| Role                                      | Token                            | Use                                                |
| ----------------------------------------- | -------------------------------- | -------------------------------------------------- |
| Main page and card background             | `--canvas`                       | Primary reading surface                            |
| Sidebar, inset region, alternate panel    | `--surface-1`                    | Low-emphasis structure                             |
| Hover, disabled, selected-neutral surface | `--surface-2`                    | Secondary state                                    |
| Main text                                 | `--ink`                          | Body copy, headings, values                        |
| Supporting text                           | `--ink-muted`                    | Instructions, metadata, helper text                |
| Placeholder and low-emphasis text         | `--ink-subtle`                   | Disabled and tertiary information                  |
| Primary action and selected state         | `--primary`                      | CTA, selected navigation, focus, progress          |
| Primary hover                             | `--primary-hover`                | Pointer hover and pressed emphasis                 |
| Soft selected state                       | `--primary-light`                | Selected pills, tags, metric accents               |
| Critical state                            | `--urgent` / `--urgent-bg`       | Urgent finding, destructive action, blocking error |
| Caution state                             | `--warning` / `--warning-bg`     | Review required, stale or incomplete data          |
| Normal state                              | `--normal` / `--normal-bg`       | Complete, available, within range                  |
| Follow-up state                           | `--follow-up` / `--follow-up-bg` | Ongoing care or scheduled follow-up                |
| Informational state                       | `--info` / `--info-bg`           | Neutral guidance and provenance                    |

### Color usage rules

- Use teal for primary actions, active navigation, selected controls, progress, and focus indicators.
- Use `--ink` for normal body text. Do not use teal as general paragraph text.
- Pair every clinical state color with visible text and, where practical, an icon or shape.
- Prefer a state-colored border, icon, badge, or narrow left stripe over a large saturated fill.
- Light semantic background tints are acceptable for banners and safety cards when the state must remain continuously visible.
- Never use red and green as the only distinction between two clinical outcomes.

### Verified contrast constraint

`#0A9E8F` against white is approximately `3.33:1`. It is suitable for non-text UI boundaries and sufficiently large or bold text, but not for ordinary small body text. White on `#0A9E8F` has the same approximate contrast, so primary-button labels must be adequately sized and weighted. For small critical copy, use darker ink-compatible state colors or pair color with another cue.



## Typography

```css
:root {
  --font-sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace;
}
```

### Type roles

| Role                  | Size and weight                               | Use                                                        |
| --------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| Major workspace title | `28–32px`, `600–700`, line-height `1.15–1.25` | Dashboard, risk assessment, major standalone workspace     |
| Module/page title     | `20–26px`, `600–700`                          | Diagnosis, Severity, Treatment Plan sections               |
| Section title         | `16–20px`, `600–700`                          | Cards, form sections, safety panels                        |
| Clinical body         | `14–15px`, `400`, line-height `1.5–1.65`      | Instructions, descriptions, findings                       |
| Label/caption         | `11–13px`, `600–800`                          | Field labels, metadata, table headers, status kickers      |
| Numeric/code data     | `12–15px`, mono                               | Patient identifiers, scores, versions, dosages, timestamps |
| Large score/metric    | `22–32px`, mono, `600–700`                    | PANSS totals, risk score, dashboard metrics                |

Uppercase labels are used for compact metadata and section kickers. Keep tracking restrained; the implemented repository frequently uses uppercase labels without large letter spacing.

## Border Radius

```css
:root {
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-pill: 9999px;
}
```

Implementation guidance:

- Dense buttons and inputs may use `6px` where matching Dashboard, DDI Checker, Medical History, or Suicide Risk.
- Standard controls should normally use `8px`.
- Main clinical cards should use `8px` or `12px`.
- Major overlays may use `10–16px`.
- Status pills, score choices, and compact chips use pill radius.
- Do not introduce highly rounded consumer-app cards or mixed arbitrary radii within one surface.

## Spacing, Elevation, and Motion

### Spacing scale

```css
:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
  --space-16: 64px;
  --space-20: 80px;
  --space-24: 96px;
}
```

Use an 8px base rhythm. Use 4px for internal micro-gaps, not for main page spacing.

Typical repository values:

- page padding: `16–28px` on dense workspaces;
- card padding: `14–24px`;
- primary form/card padding: `24–32px`;
- column gap: `18–24px`;
- mobile page padding: `10–16px`;
- section separation: `16–28px`.

### Shadows

```css
:root {
  --shadow-card: 0 1px 3px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
  --shadow-elevated: 0 4px 12px rgba(0, 0, 0, 0.08);
  --shadow-overlay: 0 20px 60px rgba(0, 0, 0, 0.12);
}
```

Use subtle borders as the primary surface separator. Shadows should remain restrained. Do not use large floating shadows on every card.

### Motion

```css
:root {
  --motion-fast: 100ms;
  --motion-base: 180ms;
  --motion-slow: 300ms;
  --motion-easing: cubic-bezier(0.4, 0, 0.2, 1);
  --motion-decelerate: cubic-bezier(0, 0, 0.2, 1);
}
```

- Use `100ms` for immediate selection feedback.

- Use `180ms` for hover, border, background, and ordinary state changes.

- Use `300ms` only for deliberate progress or expansion.

- Use content-shaped skeletons where the repository already does so.

- Honor `prefers-reduced-motion` by suppressing shimmer and movement.

- Urgent information must not disappear automatically.

- Use semantic HTML as the baseline contract.

- Reuse the module's existing framework rather than introducing a second UI runtime.

- Do not introduce a new cross-project component library as an incidental change.

- Keep browser URLs relative to the gateway.

- In unified deployment, use the gateway-owned application navigation for the `INSIGHT` wordmark, role-appropriate top-level routes, current-route state, authenticated identity, and sign-out. Module-local headers may retain workflow context, but must not reproduce role routing or authentication behavior.

- Scope CSS to the module root when embedding or when selector collision is possible.

- Treat embeddability as module-specific. Diagnosis explicitly supports an embedded root and suppresses standalone chrome; do not assume every module already has the same mount/unmount contract.

# 
