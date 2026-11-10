# Ensemble UI kit

Import shared renderer components from `ui-kit`. Appearance comes from the variables in `tokens.css`, which `styles.css` loads for both light and dark themes.

## SearchPicker

Use `SearchPicker` to filter grouped actions or choose an item inside an existing screen or dialog. Pass localized input, result, and empty-state labels. Section IDs must be unique, and item IDs must be unique across all sections.

The picker matches words against the label, detail, and keywords. Use `initialLimit` to cap suggestions before the user types. Use `overflow` to cap a section after filtering and append an option that can reveal the full group. Handle its ID in `onSelect`. When results come from an async search, pass `query` with `onQueryChange` and mark the remote section `prefiltered` to preserve its search order and matches. Use `filters` when a tab strip between the input and the list controls the result panel.

Arrow keys move the highlight. Enter or a click calls `onSelect` with the item ID. Pass `selectedId` (or `''` before selection) when the caller needs a selection that stays distinct from the highlight. The caller owns confirmation, submission, and dialog closing. Pass `inputRef` to share a dialog's focus target, and `readOnly` to lock changes while keeping the search input focusable.

The results scroll within the picker. Set `--search-picker-results-height` on a surrounding surface to fit its layout.

## Conversation text

Use `FoldableText` for long plain text. It measures the rendered lines and keeps the full text selectable when expanded. Own the expanded state by item ID when the containing list virtualizes rows. Render attachments and actions outside the clipped body.

Use `CodeBlock` with the parsed code text and optional language. It preserves whitespace and provides a scoped copy action. Use `CopyTextButton` for plain text or whole-message copy. Supply localized labels for the action, success, and failure.
