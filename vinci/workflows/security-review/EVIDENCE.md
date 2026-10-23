# Source evidence and limits

Inspected 2026-10-21 19:27–19:28 UTC through the GitHub connector. Read-only source access, no repository checkout or code execution. Latest commit returned by repository commit listing: `ee913a3406459110224b06d84440e57372b06707` (2026-10-17). Relevant files were then refetched at that exact commit; matching blob IDs establish the inspected content, not installed-state freshness.

- Prompt convention: https://github.com/getsimpledirect/vinci-code-cli/blob/ee913a3406459110224b06d84440e57372b06707/packages/coding-agent/docs/prompt-templates.md — blob d8990bea2511b3edad2d8d1d8b3ae044998c2cd9.
- Launcher argument pass-through and provider classes: https://github.com/getsimpledirect/vinci-code-cli/blob/ee913a3406459110224b06d84440e57372b06707/vinci/bin/vinci — blob 5ae8d3bac6f96cdbb330550af1037bfbb13fe021.
- Layer ownership, existing commands and product qualification limits: https://github.com/getsimpledirect/vinci-code-cli/blob/ee913a3406459110224b06d84440e57372b06707/vinci/README.md — blob 3a12ec074ad728c1c013fabdd0485baa19415436.
- Route distinction and transcript/spill/redaction limits: https://github.com/getsimpledirect/vinci-code-cli/blob/ee913a3406459110224b06d84440e57372b06707/vinci/PRIVACY.md — blob 7bd094f850cd4a487efff6ef83d2467c6a3675ca.

Source copies are retained in the separate audit packet, not in this proposed repository addition. No claim that README statements independently establish production security. `/security` command purpose also read in repository root README (blob 24e7d033092b39a2c426938c908dd5fd13ff63d9). Parent handoff identifies existing CLI implementation ownership and separate audits; active owner acceptance remains to be checked before a draft PR. Open-issue search `repo:getsimpledirect/vinci-code-cli is:open security` returned zero; completeness and vacancy are not inferred.
