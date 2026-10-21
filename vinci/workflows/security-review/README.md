# Security review with Vinci Code

Reviewable, unpublished workflow prototype, 2026-10-21. This adds a security-review use case to existing Vinci Code and its existing approved model route. It is not a separate product, penetration-testing service or security certification.

## What is ready

- A reusable prompt following the existing Pi/Vinci prompt-template convention.
- Scope, route, finding, remediation and retest JSON templates.
- A strict standard-library declaration validator with positive and negative synthetic controls.
- An intentionally incomplete tenant-authorization snippet, not a real discovered vulnerability.
- Source-backed proposed integration and owner acceptance gates.

The JSON examples contain synthetic approval references and placeholder hashes. They are never real authorization. Blank templates intentionally fail validation until completed. No private source has been sent to an inference provider.

## Run offline checks

Use a known-clean Python 3.10+ environment. Do not start Python in a suspected compromised environment merely to run this pack. These commands install nothing, make no network calls, load no project code and use isolated Python without site initialization:

```sh
python3 -I -S -m unittest discover -s tests -v
python3 -I -S tools/validate_review.py examples/synthetic-review.json --at 2026-10-21T19:30:00Z
python3 -I -S tools/validate_review.py examples/reject-unknown-route.json --at 2026-10-21T19:30:00Z
python3 -I -S tools/validate_review.py examples/reject-false-remediation.json --at 2026-10-21T19:30:00Z
```

Expected exits: tests 0; positive declaration 0; each negative 2. `--at` is historical fixture replay, never permission to bypass a current expiry. Omit it for current declaration-time checks. Exit 0 says VALID_DECLARATION_ONLY, not authorized to run. The check reads exactly the supplied JSON, not its referenced repo/files/endpoints. Hash syntax is checked; file authenticity, human identities, approval validity and actual route are not attested.

## Operator flow

1. Establish scope and current owner consent outside the model. Choose an isolated sanitized copy and explicit file allowlist. Keep live secrets/customer records out.
2. Verify the inference route before starting any model-assisted private-source review. Select the existing approved route, not a new service. Record exact resolution and retention/region evidence. The pack itself works offline, but Vinci Code inference is not made offline by this prompt.
3. Complete scope/route templates, load the prompt only in a qualified client and run a read-only review. No automated tool execution is authorized by this prototype.
4. Produce evidence records and proposed patch artifacts. A qualified human confirms reachability/impact and reviews the patch.
5. Separately authorize isolated regression testing if needed. Record exact patch/source hashes, actual outcomes, NOT_RUN and unresolved coverage. Only the owner can accept remediation.

## NOT_RUN

No Vinci executable launch; prompt loading/expansion not runtime-tested; no model/API calls; no scan; no source-code behavioral test; no customer data; no CI or packaged-client qualification; no accuracy/recall measurement; no active exploit validation; no production security assessment; no patch applied; no PR, merge, release, deployment or service activation by this pack builder.

Passing synthetic declaration tests validates only these contract checks. Prompt compliance and runtime authorization enforcement require independent integration tests before distribution. Read INTEGRATION.md and CONTRACT.md before use.
