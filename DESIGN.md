# DESIGN

Documents the console design system as implemented in `ui/src/styles.css`. Light,
editorial-humanist, restrained orange accent. Theme is light by deliberate choice (a tool used in
normal ambient light on a wide monitor, matching the documentation site), not by default.

## Color

Tinted-neutral light surface; one warm accent under ~10% coverage (Restrained strategy). Never
pure `#000`/`#fff`; neutrals are tinted toward the warm hue.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#faf9f7` | app background |
| `--panel` | `#ffffff` | panels, tables, cards |
| `--ink` | `#1c1a17` | primary text, primary button |
| `--ink-soft` | `#6b6660` | secondary text |
| `--ink-faint` | `#9b958d` | labels, meta, captions |
| `--line` | `#e7e3dd` | borders, rules |
| `--accent` | `#e05d24` | emphasis, active state, focus ring |
| `--accent-soft` | `#fdeee6` | accent backgrounds |
| `--ok / --err / --warn` | green / red / amber | semantic badges and alerts (+ `*-soft` tints) |

Brand mark gradient: `#D7613A → #DC8946 → #F9C078` (orange to amber). Reserved for the logo mark
and favicon, not for UI fills.

**Retire:** the hardcoded blue `#5b8def` that leaked into chat bubbles, the catalog explorer
active item, coverage bars, markdown links, and segmented controls. It is the one off-brand color
in the system. Replace with `--accent` (or `--ink` for high-contrast selected states).

## Typography

- **Display / headings:** Georgia serif (`--serif`), weight 500. `h1` 26px, `h2` 18px. Italic
  serif in `--ink-soft` is the accepted emphasis device (the "nav*flow*" wordmark, `h1 em`).
- **Body / UI:** system sans (`-apple-system, …`), 14px / 1.5.
- **Data / identifiers / code:** SF Mono (`--mono`), 12.5px. All keys, values, URLs, payloads.
- **Eyebrows / labels:** mono, ~11px, uppercase, `0.06–0.08em` tracking, `--ink-faint`.
- Page pattern: `h1` + `.subtitle` (one line, `--ink-soft`), then `h2` section heads.

## Shape, line, elevation

- Radii: 6px (controls, chips), 8px (panels, cards, tables, code blocks). 99px for badges.
- Borders: 1px `--line`. Elevation is borders and background tint, not shadow. No glassmorphism.
- Spacing rhythm: page padding `28px 36px`, panel padding `18px 20px`, max content width 1600px.

## Components

- **Shell:** 208px sticky sidebar (mark + serif wordmark + `console` eyebrow), nav links with a
  soft active fill, footer meta. Main column flush, max-width 1600.
- **Tables** are the primary data surface: uppercase mono `thead`, 1px row rules, `tr.clickable`
  hover tint. Prefer tables over card grids for lists.
- **Badges** (status pills with a leading dot): `ok / error / paused / push / starting`.
- **Chips** (mono tags) for labels and field names.
- **Panels** for grouped detail; **cards** only for genuine metric tiles, never nested.
- **Tabs:** underline-on-active in `--accent`.
- **Buttons:** default outline; `.primary` is solid `--ink`; `.danger` red outline. Verbs are
  technical and plain.
- **Forms:** block labels with mono help text; accent focus border.
- **Empty states:** dashed-border, centered, one faint line in the product voice.

## Motion

Minimal. Ease-out only; never animate layout properties. Hover and focus transitions on color and
border are enough.

## Copy

Technical reference voice. No marketing, no exclamation, no em dashes (use commas, colons,
parentheses). Buttons name the action plainly ("Add source", "Discover", "Save").
