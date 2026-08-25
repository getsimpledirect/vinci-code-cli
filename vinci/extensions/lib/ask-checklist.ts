/**
 * The checklist body for a multi-answer `ask_user`.
 *
 * `ctx.ui.select` is single-choice by construction (SelectList tracks one `selectedIndex`), so a
 * question where several answers can be true at once — "which of these should I include?" — had no
 * honest surface: the model either asked several questions in a row or silently picked one. This
 * renders a togglable checklist instead, drawn through `ctx.ui.custom` so it stays an extension and
 * needs no core patch.
 *
 * Pure rendering + state lives here so the behaviour is testable without a terminal; the extension
 * owns the `ctx.ui.custom` wiring and the key events.
 */

export interface AskOption {
  label: string;
  description?: string;
  recommended: boolean;
}

export interface ChecklistState {
  /** Index of the row the cursor is on. */
  cursor: number;
  /** Indices the user has ticked. */
  chosen: Set<number>;
}

export function createChecklistState(options: readonly AskOption[]): ChecklistState {
  // Pre-tick the recommended option so Enter alone is a sensible answer rather than an empty one.
  const chosen = new Set<number>();
  const recommended = options.findIndex((option) => option.recommended);
  if (recommended !== -1) chosen.add(recommended);
  return { cursor: 0, chosen };
}

export function moveCursor(state: ChecklistState, delta: number, count: number): void {
  if (count <= 0) return;
  state.cursor = (state.cursor + delta + count) % count;
}

export function toggleCurrent(state: ChecklistState): void {
  if (state.chosen.has(state.cursor)) state.chosen.delete(state.cursor);
  else state.chosen.add(state.cursor);
}

export function chosenLabels(state: ChecklistState, options: readonly AskOption[]): string[] {
  return [...state.chosen]
    .sort((a, b) => a - b)
    .map((index) => options[index]?.label)
    .filter((label): label is string => typeof label === "string");
}

/** Minimal theme surface, so tests can pass an identity theme. */
export interface ChecklistTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/**
 * Rows are returned untruncated: they carry ANSI colour from `theme.fg`, so measuring them by
 * `String.length` would count escape bytes as visible columns. The caller clips with the TUI's
 * width-aware helper.
 */
export function renderAskChecklist(
  question: string,
  options: readonly AskOption[],
  state: ChecklistState,
  theme: ChecklistTheme,
): string[] {
  const lines: string[] = ["", theme.fg("accent", theme.bold(`  ${question}`)), ""];
  options.forEach((option, index) => {
    const box = state.chosen.has(index) ? "[✓]" : "[ ]";
    const pointer = index === state.cursor ? "›" : " ";
    const label = `${option.label}${option.recommended ? " (Recommended)" : ""}`;
    const row = ` ${pointer} ${index + 1}. ${box} ${label}`;
    lines.push(index === state.cursor ? theme.fg("accent", row) : row);
    if (option.description) lines.push(theme.fg("muted", `        ${option.description}`));
  });
  lines.push("");
  lines.push(theme.fg("dim", "  space to tick · ↑↓ to move · enter when done · esc to cancel"));
  return lines;
}
