## New Design System Styling Guidelines

### CSS Variables & Tailwind Config

The new design uses custom CSS variables defined in `../web-core/src/app/styles/new/index.css` and configured in `tailwind.new.config.js`. All styles are scoped to the `.new-design` class.

### Colors

**Text colors** (use these instead of `text-gray-*`):
- `text-high` - Primary text, highest contrast
- `text-normal` - Standard text
- `text-low` - Muted/secondary text, placeholders

**Background colors**:
- `bg-primary` - Main background
- `bg-secondary` - Slightly darker, used for inputs, cards, sidebars
- `bg-panel` - Panel/elevated surfaces

**Accent colors**:
- `brand` - Orange accent (`hsl(25 82% 54%)`)
- `error` - Error states
- `success` - Success states

### Typography

**Font families**:
- `font-ibm-plex-sans` - Default sans-serif
- `font-ibm-plex-mono` - Monospace/code

**Font sizes** (smaller than typical Tailwind defaults):
- `text-xs` - 8px
- `text-sm` - 10px
- `text-base` - 12px (default)
- `text-lg` - 14px
- `text-xl` - 16px

### Spacing

Custom spacing tokens:
- `p-half` / `m-half` - 6px
- `p-base` / `m-base` - 12px
- `p-double` / `m-double` - 24px

### Border Radius

Uses a small radius by default (`--radius: 0.125rem`):
- `rounded` - Default small radius
- `rounded-sm`, `rounded-md`, `rounded-lg` - Progressively larger

### Focus States

Keyboard focus indication is global: `*:focus-visible:not([tabindex='-1'])`
(plus `html.kbd-nav *:focus` branches) in
`../web-core/src/app/styles/new/index.css` draws a 2px inset `brand` outline
on every focused element. Do NOT add `outline-none`/`focus:outline-none`
or per-component focus rings (`focus:ring-*`, `focus-visible:ring-*`) — the
global rule wins the specificity tie anyway, so a custom ring only renders a
doubled indicator. Programmatic focus targets opt out via `tabindex="-1"`.

Text-entry fields (text `input`, `textarea`, `contenteditable`) are excluded
from the global outline and have their UA outline suppressed — the caret is
the focus indicator, so a border on a field you're typing in is redundant. Do
NOT add focus rings to text fields. Checkbox/radio inputs keep the outline.

Two sanctioned exceptions, both using `KEYBOARD_CURSOR_RING` from
`@vibe/ui/lib/focus-ring` (never hand-written ring classes):
- Virtual cursors (`isFocused`/`isCursor`/`highlightedIndex`/cmdk
  `data-selected`) where real DOM focus sits elsewhere — the global rule
  cannot see them.
- Roving-focus items that keep `tabindex="-1"` while focused (e.g. the
  SettingsDialog section nav) — excluded from the global rule, so they draw
  their own `focus:` ring.

### Example Component Styling

```tsx
// Input field (no focus classes — the global focus-visible outline applies)
className="px-base bg-secondary rounded border text-base text-normal placeholder:text-low"

// Button (icon)
className="flex items-center justify-center bg-secondary rounded border text-low hover:text-normal"

// Sidebar container
className="w-64 bg-secondary shrink-0 p-base"
```

### Architecture Rules

- **View components** (in `views/`) should be stateless - receive all data via props
- **Container components** (in `containers/`) manage state and pass to views
- **UI components** (in `ui-new/`) are reusable primitives
- File names in `ui-new/` must be **PascalCase** (e.g., `Field.tsx`, `Label.tsx`)
