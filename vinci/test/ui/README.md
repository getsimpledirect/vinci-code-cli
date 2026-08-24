# Vinci UI regression tests

The suite boots the production `InteractiveMode` with the repository's faux model and xterm-backed
virtual terminal. It sends real terminal input and compares normalized visible viewports. It never
uses Vinci credentials, network access, tmux, or a real model.

Run it from the repository root:

```bash
node packages/coding-agent/node_modules/vitest/dist/cli.js --run vinci/test/ui/scenarios.test.mjs
```

When an intentional UI change alters a viewport, regenerate snapshots locally and review the diff:

```bash
UPDATE_VINCI_UI_SNAPSHOTS=1 node packages/coding-agent/node_modules/vitest/dist/cli.js --run vinci/test/ui/scenarios.test.mjs
git diff -- vinci/test/ui/snapshots
```

Do not update snapshots merely to make CI pass. Confirm that focus, wording, spacing, wrapping, and
the active decision state are correct. Keep terminal-specific image rendering and subjective motion
review in the release smoke check; deterministic interaction behavior belongs here.

The EC2 lane adds real Linux PTY evidence without replacing this deterministic suite. Its artifact
bundle contains SVG frames, timed asciinema recordings, raw ANSI, and visible-screen text at three
terminal sizes. Operational details live in the internal ops repository.
