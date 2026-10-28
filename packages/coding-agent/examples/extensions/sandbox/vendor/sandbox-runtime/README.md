# Reviewed sandbox-runtime consumer fork

This local package retains the upstream release pinned in source-seal.json and binds its existing configuration
schema to Zod 4.6.6. It addresses GHSA-mrhx-c7xc-m3w5 without upgrading the sandbox
implementation or changing permissions, policy, defaults, OS adapters or binaries.
All 75 upstream package files remain present. Runtime JavaScript is byte-identical.
Only package.json and three schema declaration/map files change. The archive also
includes reconstructed schema source and a sealed inventory. All six public
configuration type aliases are regenerated with TypeScript 5.9.3.

Zod error objects and concrete schema classes change across majors. Configuration
acceptance and parsed output are checked by a fixed corpus; this does not promise
identical diagnostics or universal resource bounds for unconstrained inputs.

The public upstream archive URL and SHA512, per-file upstream hashes/modes, and
final hashes/modes are recorded in source-seal.json. The checker additionally pins
the final archive SHA512 and seal SHA256. Installed checks allow npm's normal
executable-bit normalization for the declared CLI bin. No lifecycle scripts are included.

To reproduce from the integrity-pinned public upstream archive, after installing
the repository's pinned dependencies with lifecycle scripts disabled:

```sh
python3 scripts/vendor-sandbox-runtime.py --archive /path/to/upstream-sandbox-runtime.tgz --check
node scripts/check-sandbox-runtime-source.mjs
```

The generator performs no downloads and retains temporary compiler inputs under
TMPDIR. Use `--output /new/review/directory` instead of `--check` when reviewing a
new artifact; existing outputs are never overwritten. `schema.ts.txt` is the
exact upstream runtime schema plus its original six type aliases, used as a
compiler input rather than an additional application source module.

Remove this fork only after a published parent release uses a patched Zod major
and passes the same consumer, type, inventory and platform gates. Do not replace
Zod 3 with the Zod 4 package's `/v3` compatibility entry: that retains the affected
implementation. Upstream Apache-2.0 LICENSE and notices remain inside the archive.
