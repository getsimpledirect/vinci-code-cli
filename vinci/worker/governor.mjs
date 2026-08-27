// Governor lease management for Stage 2
export async function claimGovernorPaths({ governorUrl, token, paths, taskId, attempt }) {
  if (!governorUrl || !token) return null;

  const url = `${governorUrl}/v1/governor/claim-paths`;
  const idempotencyKey = `${taskId}/${attempt}`;
  const body = { paths };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Session ${token}`,
        "Idempotency-Key": idempotencyKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const responseBody = await response.json();

    if (response.status === 200) {
      return {
        success: true,
        claimed_at: new Date().toISOString(),
        paths: responseBody.paths || paths,
        ttl: responseBody.ttl || 3600,
        budget_usd: responseBody.budget_usd,
        max_runtime_s: responseBody.max_runtime_s,
        deadline: responseBody.deadline,
      };
    }

    // 403, 409, 422, etc
    if (response.status === 403 || response.status === 409 || response.status === 422) {
      return {
        success: false,
        blocked: true,
        reason: responseBody.reason || `Lease refused (${response.status})`,
      };
    }

    // Other errors
    return {
      success: false,
      blocked: false,
      reason: `Governor error: ${response.status} ${responseBody.reason || "unknown"}`,
    };
  } catch (error) {
    return {
      success: false,
      blocked: false,
      reason: `Governor connection failed: ${error.message}`,
    };
  }
}

export function tightenEnvelopeLimits(envelope, governorOrder) {
  if (!governorOrder) return envelope;

  const tightened = { ...envelope };
  
  if (governorOrder.budget_usd && governorOrder.budget_usd < envelope.budget_usd) {
    tightened.budget_usd = governorOrder.budget_usd;
  }
  
  if (governorOrder.max_runtime_s && governorOrder.max_runtime_s < envelope.max_runtime_s) {
    tightened.max_runtime_s = governorOrder.max_runtime_s;
  }
  
  if (governorOrder.deadline) {
    const govDeadline = Date.parse(governorOrder.deadline);
    const envDeadline = envelope.deadline ? Date.parse(envelope.deadline) : Date.now() + 365 * 24 * 60 * 60 * 1000;
    if (govDeadline < envDeadline) {
      tightened.deadline = governorOrder.deadline;
    }
  }
  
  return tightened;
}
