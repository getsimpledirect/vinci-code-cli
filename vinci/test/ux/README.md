# Vinci Code — felt-experience tooling

The benchmark measures *whether* a task gets done correctly. These tools measure how it **feels** —
snappiness and cadence — the part a non-programmer notices first. They hit the real provider and need
your `VINCI_API_KEY`, so they are **manual tools, not part of the offline harness or CI**.

## 1. TTFT probe — "how long until it starts talking?"

```
VINCI_API_KEY=vinci_live_… node vinci/test/ux/ttft-probe.mjs
VINCI_API_KEY=vinci_live_… node vinci/test/ux/ttft-probe.mjs --runs 5 --prompt "fix the failing test" --cwd ../some-repo
```

Runs the real `vinci -p` and reports **time-to-first-token** (launch → first streamed byte), total time,
and the largest mid-stream gap (a big gap = a visible stall mid-answer). TTFT is dominated by the
provider round-trip, so it's the cleanest read on the felt cost of the #23 serving dependency —
separate from total task time, which the corpus benchmark already covers.

Per-run timelines land in `vinci/test/ux/.ttft-runs/` (gitignored) for cadence analysis.

## 2. Experiencing it as a user — the CLI has no "simulator", the terminal *is* the runtime

Unlike an iOS/Android app (where you need Xcode's simulator / the Android emulator to stand in for a
device), a CLI runs the same code in your terminal that a user runs in theirs. So "experience what the
user experiences" has three tiers, cheapest first:

- **Live (most authentic):** just run it interactively.
  ```
  VINCI_API_KEY=vinci_live_… vinci
  ```
  Inside Claude Code you can do this in-session with `! vinci` and watch it stream in real time.

- **Recorded replay (the shareable "simulator"):** capture a real session as a timed cast that plays
  back at true speed — the closest analogue to a simulator recording, good for UX review or sharing.
  ```
  asciinema rec vinci-session.cast -c "VINCI_API_KEY=vinci_live_… vinci"
  asciinema play vinci-session.cast     # replays at the exact original cadence
  ```

- **Cadence data (numbers, not feel):** the TTFT probe's per-run timelines above.

The point of all three: the honesty/closure work only pays off if a real person, watching it stream,
trusts what they see. These let us watch that directly instead of inferring it from pass/fail.

## Relationship to `vinci-qa`

The sibling repo **`vinci-qa`** is the persona-driven synthetic-user harness: a `claude -p` agent *uses
the product like a real person* and writes a UX report with defects and friction notes. Today it covers
**Vinci Chat (web)** via Playwright MCP and **Vinci Mobile** via the iOS Simulator / Android — the
"experience it as a user" machinery, one persona = one markdown prompt.

It does **not** yet have a **Vinci Code (CLI)** lane. The two layers are complementary:

- This probe = the **numbers** (first-token latency, cadence) — the felt cost of the provider round-trip.
- A vinci-qa CLI lane = the **experience** (a persona drives the real `vinci` terminal session and reports
  what it felt like) — the CLI analogue of `run-web.sh` / `run-mobile.sh`.

If/when the CLI lane is added to vinci-qa, it should reuse vinci-qa's `base-*.md` + Universal Invariants
+ report format, and can shell out to this probe for the snappiness numbers.
