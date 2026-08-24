# Vinci Code

**A coding companion for people who are not professional programmers.** Vinci narrates every
step in plain language, keeps the screen calm, defends itself against loops, and finishes what
it starts — running on SimpleDirect's own models and infrastructure.

> Made, not generated.

## Install (beta)

One command — no clone, no build (needs Node v22.19+):

```sh
curl -fsSL https://vinci.getsimpledirect.com/install | sh
```

Then run `vinci` and type `/login` — it pairs in the browser, no API key to paste. Updater-enabled
releases install signed updates automatically before the next task, with atomic rollback.
`vinci --version` reports what you are running — no version is pinned in docs, because a
hardcoded one goes stale the moment anything ships.

Prefer your own provider key? Just `/login` and pick a provider — no Vinci account is needed
at all, and nothing to configure first.

## Build from source (contributors)

```sh
git clone https://github.com/getsimpledirect/vinci-code-cli && cd vinci-code-cli
npm install && bash vinci/build.sh     # network-free build (skips Pi's catalog re-fetch)
vinci/bin/vinci                        # launch branded; /login vinci to connect
bash vinci/test/run.sh                 # units + visual + smoke — run before merging anything
```

## Where everything lives

This repo is a **thin fork of [Pi](https://github.com/badlogic/pi-mono)** (`badlogic/pi-mono`,
MIT). Almost everything Vinci is additive in one directory — start there:

| | |
|---|---|
| [`vinci/README.md`](../vinci/README.md) | **The Vinci layer** — full layout, features, release + sync process |
| [`vinci/PATCHES.md`](../vinci/PATCHES.md) | Every env-gated core patch, inventoried (the sync contract) |
| [`vinci/UPSTREAM.md`](../vinci/UPSTREAM.md) | Branch model: `main` mirrors Pi, `vinci` is the trunk |

The root `README.md` is upstream Pi's, untouched by design — the `main` branch is a pristine
mirror so Pi updates fast-forward cleanly, and all Vinci work lives on the **`vinci`** branch
(this page is `.github/README.md`, which GitHub shows instead of the root file).
