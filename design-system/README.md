# Quantichy Design System

The single source of truth for visual style across the Quantichy landing page,
dashboard, and any future surface. Use these tokens and components instead of
hand-rolling new colors, spacing, or one-off styles.

## Files

| File              | What it is                                                                 |
| ----------------- | -------------------------------------------------------------------------- |
| `tokens.css`      | All design tokens (colors, typography, spacing, radius, shadows, motion)   |
| `components.css`  | Reusable component classes, all prefixed `qds-` (buttons, cards, badges…)  |
| `preview.html`    | Live browseable style guide — open in a browser to see everything rendered |
| `README.md`       | This file                                                                  |

## Quick Start

Add both stylesheets to any new page **before** your page-specific CSS:

```html
<link rel="stylesheet" href="/design-system/tokens.css">
<link rel="stylesheet" href="/design-system/components.css">
```

Then build with tokens and components:

```html
<div class="qds-card qds-card--feature">
  <h3 style="font:var(--fw-semibold) var(--fs-xl)/1.3 var(--font-heading);">
    Bitcoin
  </h3>
  <p style="color:var(--text-secondary); font-size:var(--fs-base);">
    Market overview
  </p>
  <button class="qds-btn qds-btn--primary">View details</button>
</div>
```

## Browsing the System

Open `design-system/preview.html` in a browser. Every token and component is
rendered with its name, value, and example usage. Use the sticky TOC on the
left to jump between sections.

## Token Cheatsheet

### Colors
- **Brand:** `--brand-primary`, `--brand-navy`, `--brand-accent`
- **Neutral scale:** `--neutral-0` … `--neutral-900`
- **Semantic:** `--success*`, `--danger*`, `--warning*`, `--info*` (each has
  base, `-strong`, `-deep`, `-bg`, `-border` variants)
- **Surfaces:** `--surface-page`, `--surface-card`, `--surface-raised`,
  `--surface-sunken`, `--surface-hover`
- **Text:** `--text-primary`, `--text-secondary`, `--text-muted`,
  `--text-inverse`
- **Borders:** `--border-subtle`, `--border-default`, `--border-strong`
- **Data series (charts/ranks):** `--series-1` … `--series-7`

### Typography
- **Families:** `--font-heading`, `--font-body`, `--font-mono`
- **Sizes:** `--fs-2xs` (9px) … `--fs-display` (48px)
- **Weights:** `--fw-regular` (400) … `--fw-black` (900)
- **Tracking:** `--tracking-tight`, `--tracking-tighter`, `--tracking-tightest`,
  `--tracking-wide`, `--tracking-widest`
- **Line height:** `--lh-tight`, `--lh-normal`, `--lh-relaxed`

### Spacing
`--space-0` (0) through `--space-16` (80px). Common defaults:
- Card padding: `--space-8` (16px)
- Content padding: `--space-11` (24px)
- Section padding: `--space-12` (32px)

### Radius
`--radius-xs` (3px) … `--radius-7xl` (24px), plus `--radius-pill` (999px) and
`--radius-full` (50%).

### Shadows
`--shadow-xs` … `--shadow-3xl` for elevation, plus glow rings:
`--shadow-glow-success`, `--shadow-glow-danger`, `--shadow-glow-info`.

### Motion
- **Easings:** `--ease-snap`, `--ease-smooth`, `--ease-spring`
- **Durations:** `--dur-instant` (100ms) … `--dur-slower` (500ms)

## Component Cheatsheet

All classes are prefixed `qds-`. Variants use `--modifier`. State uses `is-*`.

### Cards
```html
<div class="qds-card">…</div>
<div class="qds-card qds-card--feature">…</div>
<div class="qds-card qds-card--interactive">…</div>
```

### Buttons
```html
<button class="qds-btn qds-btn--primary">Primary</button>
<button class="qds-btn qds-btn--accent">Accent</button>
<button class="qds-btn qds-btn--secondary">Secondary</button>
<button class="qds-btn qds-btn--ghost">Ghost</button>
<button class="qds-btn qds-btn--success">Success</button>
<button class="qds-btn qds-btn--danger">Danger</button>

<!-- Sizes -->
<button class="qds-btn qds-btn--primary qds-btn--sm">Small</button>
<button class="qds-btn qds-btn--primary qds-btn--lg">Large</button>
```

### Inputs
```html
<label class="qds-label">Email</label>
<input class="qds-input" type="email" placeholder="you@domain.com">
<input class="qds-input is-error" type="text">
```

### Pills
```html
<div class="qds-pillbar">
  <button class="qds-pill is-active">7D</button>
  <button class="qds-pill">30D</button>
  <button class="qds-pill">90D</button>
</div>
```

### Badges
```html
<span class="qds-badge qds-badge--bull">+2.4%</span>
<span class="qds-badge qds-badge--bear">−1.2%</span>
<span class="qds-badge qds-badge--neutral">Neutral</span>
<span class="qds-badge qds-badge--info">New</span>
<span class="qds-badge qds-badge--warn">Beta</span>
```

### Stats / KPI
```html
<div class="qds-stat">
  <div class="qds-stat__label">Market Cap</div>
  <div class="qds-stat__value">$1.2T</div>
  <div class="qds-stat__delta qds-stat__delta--up">+3.1%</div>
</div>
```

### Info Tooltip
```html
<span class="qds-info">
  <button class="qds-info__btn" aria-label="More info">i</button>
  <span class="qds-info__tip">Short explanation goes here.</span>
</span>
```

### Modals & Toasts
- `.qds-modal` + `.qds-modal__panel` for centered dialogs
- `.qds-sheet` for bottom sheets
- `.qds-toast` for transient notifications

### Layout Utilities
- `.qds-stack` — vertical flex with `--space-6` gap
- `.qds-row` — horizontal flex with `--space-6` gap

## Conventions

1. **Tokens first.** Never hard-code a color, size, radius, or shadow that
   already exists as a token. If you need a new one, add it to `tokens.css`
   rather than inventing it inline.
2. **Use components when possible.** Reach for a `qds-*` class before writing
   bespoke CSS. Extend via additional classes, not by overriding internals.
3. **Naming:** components are `qds-{component}`, variants are
   `qds-{component}--{variant}`, state is `is-{state}` (e.g. `is-active`,
   `is-error`, `is-loading`).
4. **Inline styles are fine** for one-offs as long as they consume tokens
   (`style="color:var(--text-secondary)"`). Avoid raw hex codes or px values.
5. **Light theme only** for now. Avoid baking light-mode-specific colors into
   components — go through tokens so dark mode can be added later by swapping
   `:root` values.

## Adding to the System

When you build a new component that will be reused:

1. Prototype it in the page where it's needed.
2. Once stable, move the styles into `components.css` under a new `qds-*` class.
3. Add an example to `preview.html` so it's discoverable.
4. If it introduces new visual values (a new color, spacing, shadow), define
   them as tokens in `tokens.css` first — components should never hard-code.

## Why a Design System

- **Consistency** between landing, dashboard, and marketing surfaces.
- **Speed** — new pages compose existing pieces instead of restyling.
- **Single point of change** — tweak a token, update everywhere.
- **Easier theming** — dark mode or white-label later requires only token
  swaps, not hunting through markup.
