# Ensemble UI kit

Import shared renderer components from `ui-kit`. Appearance comes from the variables in `tokens.css`, which `styles.css` loads for both light and dark themes.

## SearchPicker

Use `SearchPicker` to filter grouped actions or choose an item inside an existing screen or dialog. Pass localized input, result, and empty-state labels. Section IDs must be unique, and item IDs must be unique across all sections.

The picker matches words against the label, detail, and keywords. Use `initialLimit` to cap suggestions before the user types. When results come from an async search, pass `query` with `onQueryChange` and mark the remote section `prefiltered` to preserve its search order and matches.

Arrow keys move the highlight. Enter or a click calls `onSelect` with the item ID. Pass `selectedId` (or `''` before selection) when the caller needs a selection that stays distinct from the highlight. The caller owns confirmation, submission, and dialog closing. Pass `inputRef` to share a dialog's focus target, and `readOnly` to lock changes while keeping the search input focusable.

The results scroll within the picker. Set `--search-picker-results-height` on a surrounding surface to fit its layout.
