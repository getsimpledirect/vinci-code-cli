# Release activation and recovery

Activation stages `install-<version>.sh` write-once and downloads it to check its SHA-256 against the reviewed candidate record before the conditional manifest write. The versioned archive is already staged and SHA-256 checked by activation validation. After the manifest write, public `vinci-code.tgz` and `install.sh` are copied from those verified versioned objects. This is option (a): it reuses the existing bucket, role, protected environment and approval structure without rebuilding or signing again.

The manifest remains the activation point; the following writes are not a transaction. A failed completion step, including continued public-notes failure or receipt upload failure, makes the job fail with a `vinci-rollback.yml` recovery message. A lost manifest-write response is unresolved and must be reconciled before any further write.

| Partial state after the manifest write | What clients see | Recovery |
| --- | --- | --- |
| Live-byte verification fails or its result is unknown | Manifest clients may already see the candidate; public installer and compatibility archive still have their previous bytes. | Reconcile the signed live manifest with the reviewed bytes, then use the rollback route below if the candidate must be withdrawn. |
| Compatibility archive copy fails or its response is lost | Manifest clients use the versioned candidate archive; direct compatibility downloads may have either old or new bytes. Installer bytes have not been copied yet. | Inspect both objects before action; roll back the manifest if withdrawing, then reconcile the public entry points separately. |
| Installer copy fails or its response is lost | The compatibility archive has been copied; the installer may still have old bytes. The installer selects the archive from the signed manifest, so the signed manifest controls the installed version. | Roll back if withdrawing; check the installer against the retained reviewed bytes before any separately authorized repair. |
| Main GitHub Release creation fails, possibly after partial asset upload | Manifest and installer clients can use the candidate, while release-page clients may see no release or incomplete assets. | Inspect the exact tag's existing release and assets; do not rerun activation to repair release metadata. Roll back to a prior complete published release if withdrawing. |
| Public release notes fail or readback fails | Product entry points and the main release are published; public notes may be absent or already present despite the failed response. | Inspect the public tag before a separately authorized notes repair; use rollback only if withdrawing the product candidate. |
| Receipt retention fails | Product state is determined by earlier steps; the durable activation receipt may be missing. | Preserve available run evidence, reconcile live bytes and entry points, and use rollback if withdrawing. A green earlier step is not evidence of receipt retention. |

To withdraw an activated candidate, an authorized release operator dispatches `.github/workflows/vinci-rollback.yml` in `getsimpledirect/vinci-code-cli` with `version` set to the prior **already published** `X.Y.Z` and `reason` describing the failed activation and run. Obtain the existing `vinci-release` protected approval. The target must have its versioned S3 archive and the `vinci-vX.Y.Z` GitHub Release's checksum and signed-manifest assets. The workflow verifies that binding, signs a higher-sequence manifest naming that prior archive, performs one conditional manifest write, then verifies live bytes and retains a receipt. Check its `LIVE_BYTES_VERIFIED` receipt and the actual signed live manifest before declaring recovery.

Rollback changes only `manifest-beta.json`; it does not repair `install.sh`, `vinci-code.tgz`, GitHub Releases or notes. Reconcile those separately against retained reviewed bytes under the existing release authority. Never overwrite an immutable versioned key, refresh the ETag to force activation, or rerun the whole activation job after a partial activation: its original baseline is no longer valid. If a pre-manifest installer upload succeeded before a later refusal, its versioned key remains spent; use a new candidate version rather than overwriting it.

## Ops policy template

Replace the hostname placeholder with exact hosts measured and reviewed outside candidate preparation, or omit that field and use reviewed host templates. The combined number of exact hosts and templates must be one to eight. Either field may be absent or an empty array if the other supplies entries; a present field must be an array, never `null`. Both fields are validated even when the other would match. Duplicate exact hosts and duplicate templates are refused. Exact hosts keep their existing restrictions (lowercase hostnames; no wildcard, URL, IP, local host or `api.github.com`). Replace both timestamp placeholders and confirm each prerequisite only after its review. This unfilled template deliberately fails preflight. The exact policy bytes are SHA-256 bound into the candidate record, so a policy edit requires a new staged candidate and review. The stage summary prints both candidate and policy expiry; activation also bounds authorization by the QA lifetime.

```json
{
  "schemaVersion": 1,
  "owner": "thegeorgepu",
  "environment": "vinci-release",
  "protectedApprovalReviewed": false,
  "tagOidcTrustReviewed": false,
  "stagingExposureAndCostsApproved": false,
  "retentionApproved": false,
  "confirmedAt": "<REVIEWED_ISO_TIMESTAMP>",
  "expiresAt": "<APPROVED_ISO_DEADLINE>",
  "maxCandidateHours": 168,
  "maxQaHours": 24,
  "candidateRetentionDays": 14,
  "receiptRetentionDays": 90,
  "artifactDownloadHosts": ["<MEASURED_EXACT_HOSTNAME>"],
  "artifactDownloadHostPatterns": ["productionresultssa{digits}.blob.core.windows.net"]
}
```

Templates contain lowercase literal `[a-z0-9.-]` characters and exactly one `{digits}` placeholder for one to three ASCII digits, including leading zeros. They require a nonempty literal prefix and at least two dots after the placeholder; the literal text must not end in a dot or hyphen. Every possible expansion must pass the same exact-host validator, including the 253-character bound and local/IP exclusions. Literals are escaped and matching is anchored to the entire hostname. Raw regexes, wildcards, extra placeholders and four-digit expansions are refused. Staging validates both fields before signing; activation repeats the same checks. No additional review flag is required: the reviewed policy SHA binds the pattern list.

Redirects retain the existing URL rules: HTTPS with its default port or explicit `:443` is accepted; other ports, nonempty userinfo or fragments, raw control characters and backslashes are refused. Redirect validation explicitly rejects IP literals and the existing host exclusions before matching the canonical hostname against an exact entry or a complete template. Transfers still use manual redirects, omit credentials on the storage request, and require exactly one authenticated API redirect followed by a 200 response. A template match does not establish that GitHub owns the storage account; choosing the reviewed policy remains the release owner's decision. The example is a template, not a live host measurement or policy approval.

## QA receipt bytes

After completing the three checks, serialize the sanitized results once:

```sh
node vinci/scripts/make-qa-receipt.mjs \
  --candidate-receipt-sha256 "$RECEIPT_SHA256" \
  --manifest-sha256 "$MANIFEST_SHA256" --archive-sha256 "$ARCHIVE_SHA256" \
  --source "$SOURCE_SHA" --artifact-id "$ARTIFACT_ID" \
  --completed-at "$COMPLETED_AT" \
  --clean-install PASS --upgrade PASS --rollback PASS --output qa-receipt.json
```

The helper creates the file exclusively, prints `sha256=...` and one `base64=...` line from the same UTF-8 JSON bytes, including the final newline. Use those values for `qa_receipt_sha256` and `qa_receipt_base64`; do not reformat the file afterward. Record `FAIL` for a failed check; the helper preserves it and activation refuses it. The helper records the existing owner and no-model-calls declaration; it does not perform QA or authorize activation.
