# Review contract 1.0

The executable schema is `tools/validate_review.py`; exact field sets reject unknown keys. `templates/review.json` is the full record skeleton. Separate templates expose reusable scope, route, finding, remediation and retest objects. This is a small custom JSON contract, not a claim to implement all JSON Schema standards.

## Scope

Named repository; 40-lowercase-hex commit; exact nonempty canonical relative file allowlist; owner; approval evidence reference; timezone-bearing issued/expiry times; offline_sanitized_copy environment; synthetic/public/sanitized_private data class. Allowed actions are read_source and optionally propose_patch. Execution, hosting, scanning, credentials and publication require separate workflows and are rejected here.

An approver string cannot prove identity. A malicious record can lie. Independent operator verification of approval, identity, current scope and expiry is mandatory. This parser is not a capability/token issuer or a security boundary.

## Route

offline_only has no provider, endpoint, model, class, approval, verification, region or retention assertions and no exported data classes. hosted requires all those fields, a credential-free HTTPS endpoint and an explicitly covered data class. Unknown/pending/TBD placeholders fail. Actual gateway/provider resolution, redirects, authentication, geographic processing, terms and consent must be independently verified before export. An approved gateway URL alone does not identify its downstream provider. No actual endpoint is contacted by validation.

## Finding/evidence

Unique ID, title, hypothesis/confirmed/dismissed/remediated status, severity (unknown allowed only before confirmation), confidence, canonical allowed path, positive integer line range, SHA256, observation, preconditions, reachability and limitations. The example source hash is real for its synthetic fixture; the validator does not open referenced files to recompute hashes. A hypothesis stays a hypothesis until human acceptance. A dismissed finding requires a human dismissal reference. Keep non-findings/counterevidence in the written review too.

## Remediation/retest

not_proposed has null patch fields; proposed/applied requires a patch SHA256, proposal reference, owner and rationale. Applied is a report about separately authorized work, not authorization to apply. NOT_RUN has null test identity fields and explicit limitations. Pass/fail/inconclusive requires evidence, reviewer, tested commit and exact matching patch hash. Remediated requires human acceptance plus applied patch and passing retest. Neither a test receipt nor this schema proves runtime exploitation cannot occur. Reviewer identity and evidence authenticity remain independent human checks; `model` is explicitly rejected as independent acceptance.

## Coverage/conclusion

reviewed_paths plus not_reviewed must account for the exact allowlist. At least one limitation is mandatory. Conclusions are review_incomplete or review_complete_with_limitations. Completion requires complete declared coverage and human disposition of all findings, not a claim that no vulnerabilities exist. Unknown is not zero, pass or permission. Model evaluation is a separate process.

## Minimum later qualification dataset

Use licensed synthetic tasks covering correct code, missing auth, mitigated findings, instruction injection inside comments, secret-like dummy tokens, route drift and incomplete evidence. Compare model hypotheses with independent human labels and executable isolated checks. Track precision, missed seeded defects, unsupported claims, out-of-scope actions and secret leakage separately. No model performance threshold is claimed or measured here. Choose release thresholds before measuring, and preserve hard negatives.
