# Private holdout benchmark

The holdout lane measures generalization on tasks that are absent from the Vinci source archive. Keep the existing repository benchmark frozen as the regression suite.

## Bundle separation

Store two immutable archives in the benchmark S3 bucket:

- `task.tgz` contains `manifest.json` using repository corpus version 2 and a `fixtures/` directory containing its seed patches. It is downloaded before the agent runs and deleted when the agent exits.
- `verifier.tgz` contains a version 1 `manifest.json` and private verifier programs. It is downloaded only after the agent exits, so the hidden checks never share the machine with the model process.

Each verifier scenario has this shape:

```json
{
  "id": "stable-scenario-id",
  "allowedChangedFiles": ["src/owner.js", "test/regression.js"],
  "commands": [
    ["node", "$VERIFIER_ROOT/stable-scenario-id.mjs"],
    ["npm", "test"]
  ],
  "timeoutSeconds": 600
}
```

Fixture paths and credential locations are removed from the agent environment. Each seed patch is deleted immediately after it is applied. Do not include accepted solution patches or upstream fix URLs in the task bundle.

Verifier programs receive the checkout as their working directory and in `VINCI_HOLDOUT_REPOSITORY`. `$VERIFIER_ROOT` is replaced only by the verifier process and is redacted from result metadata. Supported command executables are `node`, `npm`, `pnpm`, `uv`, `go`, `cargo`, and `make`.

## Qualification policy

- Use 5-8 unseen public repositories with one or two bounded tasks each.
- Pin every repository to a full commit SHA.
- Prefer historical defects, but seed the regression so the accepted upstream fix commit is not in the checkout history.
- Include behavioral hidden tests, a broader project check, strict changed-file scope, and a review of the retained patch.
- Run three clean repetitions without changing Vinci or the holdout bundles between repetitions.
- Do not tune orchestration against individual holdout failures. Move any task used for tuning into the frozen regression suite and replace it with a new holdout task.

The workflow configuration requires S3 object keys and SHA-256 digests for both bundles. Digest mismatches and unsafe archive paths fail before execution.
