# The `DESIGN.md` format — compact reference

**This is the offline fallback, not the source of truth.** `"${CLAUDE_SKILL_DIR}/scripts/designmd.sh" spec`
prints the real specification; cross-check against it whenever it is reachable. This file exists
because `spec` needs the CLI too, and the moment the schema is most needed — writing the three
candidates, before any lint call — is exactly the moment it may be unavailable.

A `DESIGN.md` is optional YAML frontmatter (machine-readable tokens) plus a markdown body (the
rationale). **The tokens are normative; the prose is context.** Prose may use evocative names
("Midnight Forest Green") as long as they map onto the systematic token names.

## Frontmatter

```yaml
---
version: alpha            # optional
name: <string>            # required in practice — the identity's name
description: <string>     # optional
omitted: <string[] | {section, reason}[]>
colors:
  <token>: <CSS colour>
typography:
  <token>: {fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, fontFeature, fontVariation}
rounded:
  <scale>: <Dimension>
spacing:
  <scale>: <Dimension | number>
components:
  <component>:
    <property>: <value | "{path.to.token}">
---
```

- **Colour** — any valid CSS colour: `#RGB`, `#RRGGBB`, `#RRGGBBAA`, named, `rgb()`, `hsl()`,
  `hwb()`, `oklch()`, `lab()`, `color-mix()`. **Hex is the recommended default.** All values are
  converted to sRGB for contrast checking.
- **Dimension** — a string with a unit: `px`, `em`, `rem` only. `lineHeight` also takes a bare
  number, which is a multiplier of `fontSize` and is the recommended form.
- **`spacing`** additionally takes a bare number for counts and ratios — which is what a terminal's
  cell units are.
- **Token references** — `"{colors.primary}"`, in braces, an object path. Must resolve to a
  primitive, except inside `components`, where a composite (`"{typography.label-md}"`) is allowed.
- **Custom top-level keys are allowed.** The `unknown-key` rule only warns when a key is within
  edit distance 2 of a schema key — i.e. when it looks like a typo of one. Unrelated extension keys
  are silent.

## Section order — fixed, all `##`

1. **Overview** (or "Brand & Style") — brand personality, audience, the feeling. The foundation the
   agent reasons from when no token covers a case.
2. **Colors** — at minimum a `primary` palette. Convention: `primary`, `secondary`, `tertiary`,
   `neutral`, plus `surface` / `on-surface` / `error` pairs.
3. **Typography** — most systems have 9–15 levels. Convention: `headline-*`, `body-*`, `label-*`.
4. **Layout** (or "Layout & Spacing") — the grid or spacing model.
5. **Elevation & Depth** — shadows, or for a flat system, what conveys hierarchy instead.
6. **Shapes** — the shape language; `rounded` tokens.
7. **Components** — buttons, chips, lists, inputs, and their state variants
   (`button-primary`, `button-primary-hover`).
8. **Do's and Don'ts** — the guardrails, as short imperative bullets.

An optional `#` title may precede them. A section that does not apply goes in `omitted:` rather than
being silently dropped.

## What the linter checks

`contrast-ratio` (WCAG) · `missing-primary` · `missing-sections` · `section-order` · `broken-ref`
· `orphaned-tokens` · `unknown-key` · `omitted` · `token-like-ignored`.

`lint --format json` returns `{"findings": [...], "summary": {"errors", "warnings", "infos"}}`.
The CLI exits `1` when `errors` is non-zero and `2` when the file cannot be read; a **warning does
not change the exit code**, so read `summary`, never the code alone.

## Unknown content

| case | behaviour |
|---|---|
| unknown `##` heading | preserved, no error |
| unknown colour / typography token name | accepted if the value is valid |
| unknown spacing value | accepted, stored as a string if not a valid Dimension |
| unknown component property | accepted with a warning |
| **duplicate section heading** | **the file is rejected** |

## Export targets

`css-vars` (what `build-compare.py` consumes) · `css-tailwind` (v4 `@theme`) · `json-tailwind`
(v3 `theme.extend`) · `tailwind` (alias) · `dtcg` (W3C Design Tokens).
