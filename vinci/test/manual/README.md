# Manual diagnostic tests

Human-run diagnostics that need live credentials or paid calls — deliberately NOT part of the
offline `vinci/test/run.sh` harness.

## space-drop: gateway SSE vs direct DeepInfra

Confirms whether inter-word space drops (`orcode`, `andpush`) come from the model/serving or from
the vinci-chat gateway's SSE re-streaming. Details on the test are documented in the internal ops repository.

**How it works.** Streams the same long plain-prose prompts N times through each lane — direct to
DeepInfra (`zai-org/GLM-5.2`) and through the gateway (`forte`) — saving each call's reassembled
text and its raw `data:` SSE frames. `space-drop-analyze.py` reassembles `content +
reasoning_content` from the raw frames and flags joined words with an inflection-aware dictionary
check (irregular verbs + suffix stripping remove the false positives a naive check produces).

**Run.** Recreate the streamer (reads `DEEPINFRA_API_KEY` from `~/projects/vinci-cft/.env` and the
paired token from `~/.pi/agent/auth.json`; never prints either), point it at a results dir, then:

```sh
python3 vinci/test/manual/space-drop-analyze.py   # from the results dir
```

**2026-07-15 baseline (before any gateway fix):** direct 0 genuine drops / 20 calls; gateway drops
present at frame seams (`[', no lists or', 'code.']`). A fixed gateway should bring gateway drops to
zero. Genuine drops are cross-token (the leading space of a token beginning a new SSE frame);
single-token oddities like `thisCulture` are upstream and out of scope for the gateway fix.
