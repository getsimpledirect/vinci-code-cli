/**
 * Parsing, selection and de-duplication for `<project>/.vinci/memory.md`.
 *
 * The file stays plain markdown a human can open and hand-edit — that is a product requirement, not
 * an implementation detail. So writes go through a DOCUMENT, not a list: every line the parser does
 * not recognise as an entry (a heading, a note to yourself, a blank spacer) is carried through
 * untouched and written back in its original position.
 *
 * That matters because `/memory` tells people the file is theirs to edit. An earlier version parsed
 * to a list of entries and re-serialised from that list, which silently deleted everything else in
 * the file the next time Vinci saved a fact.
 *
 * Pure functions, no I/O, so the behaviour is testable without a session.
 *
 * Line shapes:
 *   - fact                              legacy, undated (real users have these; must keep working)
 *   - (2026-07-29) fact                 saved because the user asked
 *   - (2026-07-29, auto) fact           Vinci decided to save this one on its own
 *   - (2026-07-29, pinned) fact         always injected first, never dropped while it fits
 *   - (2026-07-29, auto, pinned) fact
 */

export interface MemoryEntry {
  /** ISO date the entry was saved. Absent for legacy undated lines. */
  date?: string;
  /** The fact itself, with no markers. */
  text: string;
  /** Injected ahead of everything else. */
  pinned: boolean;
  /** Saved by Vinci on its own initiative rather than at the user's explicit request. */
  autonomous: boolean;
}

const ENTRY_RE = /^-\s+(?:\((\d{4}-\d{2}-\d{2})((?:\s*,\s*[a-z]+)*)\)\s*)?(.*)$/;

export function parseMemoryEntries(content: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const line of content.split("\n")) {
    const match = ENTRY_RE.exec(line.trim());
    if (!match) continue;
    const text = (match[3] ?? "").trim();
    if (!text) continue;
    const flags = (match[2] ?? "")
      .split(",")
      .map((flag) => flag.trim().toLowerCase())
      .filter(Boolean);
    entries.push({
      date: match[1],
      text,
      pinned: flags.includes("pinned"),
      autonomous: flags.includes("auto"),
    });
  }
  return entries;
}

export function formatEntry(entry: MemoryEntry): string {
  if (!entry.date) return `- ${entry.text}`;
  const flags = [entry.autonomous ? "auto" : undefined, entry.pinned ? "pinned" : undefined].filter(Boolean);
  const marker = flags.length > 0 ? `${entry.date}, ${flags.join(", ")}` : entry.date;
  return `- (${marker}) ${entry.text}`;
}

export function serializeEntries(entries: readonly MemoryEntry[]): string {
  return entries.length === 0 ? "" : `${entries.map(formatEntry).join("\n")}\n`;
}

/**
 * A parsed memory file: entry lines resolved, every other line preserved verbatim and in place.
 */
export type MemoryBlock = { kind: "entry"; entry: MemoryEntry } | { kind: "raw"; text: string };
export type MemoryDocument = MemoryBlock[];

export function parseMemoryDocument(content: string): MemoryDocument {
  const blocks: MemoryDocument = [];
  // A trailing newline yields a final empty element; drop it so a round trip does not grow the file.
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const [entry] = parseMemoryEntries(line);
    if (entry) blocks.push({ kind: "entry", entry });
    // Drop a trailing CR so a CRLF file does not come back with mixed endings: entry lines are
    // regenerated with LF, and preserving CR only on the untouched lines would mix the two.
    else blocks.push({ kind: "raw", text: line.replace(/\r$/, "") });
  }
  return blocks;
}

export function documentEntries(doc: readonly MemoryBlock[]): MemoryEntry[] {
  return doc.filter((block): block is { kind: "entry"; entry: MemoryEntry } => block.kind === "entry").map((block) => block.entry);
}

export function serializeDocument(doc: readonly MemoryBlock[]): string {
  if (doc.length === 0) return "";
  return `${doc.map((block) => (block.kind === "entry" ? formatEntry(block.entry) : block.text)).join("\n")}\n`;
}

/**
 * Add an entry to the document, replacing a near-duplicate in place if one exists. A genuinely new
 * entry is appended after the LAST existing entry rather than at the end of the file, so a trailing
 * note ("see the wiki") stays trailing.
 */
export function upsertIntoDocument(doc: readonly MemoryBlock[], entry: MemoryEntry): MemoryDocument {
  const next: MemoryDocument = [...doc];
  const index = next.findIndex((block) => block.kind === "entry" && isNearDuplicate(block.entry.text, entry.text));
  if (index !== -1) {
    const previous = (next[index] as { kind: "entry"; entry: MemoryEntry }).entry;
    next[index] = { kind: "entry", entry: { ...entry, pinned: entry.pinned || previous.pinned } };
    return next;
  }
  let lastEntry = -1;
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i].kind === "entry") {
      lastEntry = i;
      break;
    }
  }
  next.splice(lastEntry + 1, 0, { kind: "entry", entry });
  return next;
}

/** Remove the Nth entry (indexed among entries, not lines), leaving every other line alone. */
export function removeEntryFromDocument(doc: readonly MemoryBlock[], entryIndex: number): MemoryDocument {
  let seen = -1;
  return doc.filter((block) => {
    if (block.kind !== "entry") return true;
    seen += 1;
    return seen !== entryIndex;
  });
}

export function normalizeFact(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string): Set<string> {
  return new Set(normalizeFact(text).split(" ").filter(Boolean));
}

/**
 * Whether two facts are close enough that keeping both would be noise. Catches restatements and
 * most same-subject contradictions ("we deploy on Friday" vs "we deploy on Monday").
 *
 * Deliberately NOT semantic: detecting a contradiction phrased in entirely different words would
 * need a model call, and memory writes stay free and offline. Anything this misses lands as a
 * second line the user can delete with /memory — visible, not silent.
 */
export function isNearDuplicate(a: string, b: string): boolean {
  const na = normalizeFact(a);
  const nb = normalizeFact(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;

  const ta = tokens(a);
  const tb = tokens(b);
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  const union = ta.size + tb.size - shared;
  return union > 0 && shared / union >= 0.6;
}

/**
 * Add an entry, replacing a near-duplicate in place if one exists. Replacing in position (rather
 * than moving the entry to the end) keeps the file stable for anyone reading it by hand; the date
 * is refreshed so the update still counts as recent.
 */
export function upsertEntry(entries: readonly MemoryEntry[], entry: MemoryEntry): MemoryEntry[] {
  const next = [...entries];
  const index = next.findIndex((existing) => isNearDuplicate(existing.text, entry.text));
  if (index === -1) {
    next.push(entry);
    return next;
  }
  const previous = next[index];
  next[index] = { ...entry, pinned: entry.pinned || previous.pinned };
  return next;
}

export interface InjectionSelection {
  /** The chosen entries, rendered in file order so the block reads naturally. */
  text: string;
  shown: number;
  total: number;
  omitted: number;
}

/**
 * Choose the entries to inject within `cap` characters.
 *
 * Pinned first, then most-recent-first — where "recent" means later in the file, since the file is
 * append-ordered and legacy lines carry no date. The previous implementation used
 * `content.slice(-cap)`, which silently dropped the OLDEST entries: exactly the foundational facts
 * ("we use pnpm", "never touch the generated dir") that are most worth keeping. Anything dropped
 * here is reported to the caller so the omission can be stated rather than hidden.
 */
export function selectForInjection(entries: readonly MemoryEntry[], cap: number): InjectionSelection {
  const indexed = entries.map((entry, index) => ({ entry, index }));
  const priority = [
    ...indexed.filter((item) => item.entry.pinned).sort((a, b) => b.index - a.index),
    ...indexed.filter((item) => !item.entry.pinned).sort((a, b) => b.index - a.index),
  ];

  const chosen = new Set<number>();
  let used = 0;
  for (const item of priority) {
    // The rendered block joins with "\n", so a newline is only spent once an entry already exists.
    const cost = formatEntry(item.entry).length + (chosen.size > 0 ? 1 : 0);
    if (used + cost > cap) continue;
    chosen.add(item.index);
    used += cost;
  }

  const text = indexed
    .filter((item) => chosen.has(item.index))
    .map((item) => formatEntry(item.entry))
    .join("\n");

  return { text, shown: chosen.size, total: entries.length, omitted: entries.length - chosen.size };
}
