// Local consumer projections validated by runtime.mjs; not a canonical schema or published package.
export type RuntimeRecord = Readonly<Record<string, unknown>>;
export interface RuntimeRequestOptions { readonly signal?: AbortSignal; readonly timeoutMs?: number }
export interface RuntimeEventOptions extends RuntimeRequestOptions { readonly after?: number }
export interface RuntimeWatchOptions { readonly after?: number; readonly timeoutMs: number; readonly signal?: AbortSignal }
export interface RuntimeTextAttachment { readonly name: string; readonly mediaType: "text/plain" | "text/markdown"; readonly content: string; readonly digest: string }
export interface RuntimeCreateSpec { readonly saved: true; readonly input: string; readonly commandId: string; readonly attachments?: readonly RuntimeTextAttachment[] }
export interface RuntimeAnswerSpec { readonly questionId: string; readonly answer: string; readonly expectedRevision: number; readonly humanSeconds: number }
export interface RuntimeApproveSpec { readonly approvalId: string; readonly actionDigest: string; readonly commandId: string; readonly humanSeconds: number }
export interface RuntimeCorrectSpec { readonly approvalId: string; readonly actionDigest: string; readonly text: string; readonly target: string; readonly commandId: string; readonly expectedRevision: number }
export interface RuntimeEvent extends RuntimeRecord { readonly schemaVersion: 4; readonly runId: string; readonly eventId: string; readonly idempotencyKey: string; readonly sequence: number; readonly type: string; readonly occurredAt: string; readonly payload: RuntimeRecord }
export interface RuntimeRun extends RuntimeRecord { readonly schemaVersion: 1; readonly runId: string; readonly attemptId: string; readonly state: "CREATED" | "RUNNING" | "PAUSED" | "BLOCKED" | "STALLED" | "TERMINAL" }
export interface RuntimeSnapshot extends RuntimeRecord { readonly revision: number; readonly run: RuntimeRun; readonly pendingQuestionId: string | null; readonly pendingApprovalId: string | null }
export interface RuntimeTaskView extends RuntimeRecord { readonly snapshot: RuntimeSnapshot; readonly events: readonly RuntimeEvent[]; readonly cancellationRequested: boolean }
export interface RuntimeTaskResponse extends RuntimeRecord { readonly view: RuntimeTaskView; readonly input: string }
export interface RuntimeCreatedResponse extends RuntimeRecord { readonly runId: string; readonly view: RuntimeTaskView; readonly retention: string }
export interface RuntimeEventPage extends RuntimeRecord { readonly revision: number; readonly events: readonly RuntimeEvent[] }
export type RuntimeQuestionResponse = RuntimeRecord & ({ readonly questionId: null; readonly question: null } | { readonly questionId: string; readonly question: string });
export interface RuntimeApproval extends RuntimeRecord {
  readonly approvalId: string; readonly actionDigest: string; readonly pending: boolean; readonly effective: boolean; readonly stale: boolean;
  readonly binding: RuntimeRecord & { readonly runId: string; readonly ownerId: string; readonly workspaceId: string; readonly organizationId: null; readonly target: string; readonly contentRevision: number; readonly contentDigest: string; readonly expiresAt: number };
  readonly draft: RuntimeRecord & { readonly version: number; readonly digest: string; readonly content: string };
}
export interface RuntimeApprovalResponse extends RuntimeRecord { readonly approval: RuntimeApproval | null }
export interface RuntimeReceipt extends RuntimeRecord {
  readonly receiptVersion: 3; readonly runId: string; readonly finalState: "DONE" | "DONE_UNVERIFIED";
  readonly verdict: "VERIFIED_PASS" | "BLOCKED" | "CONDITIONAL"; readonly digest: string; readonly objective: string;
  readonly workspace: RuntimeRecord & { readonly kind: "personal"; readonly ownerId: string; readonly workspaceId: string };
  readonly requester: RuntimeRecord & { readonly kind: "user"; readonly userId: string };
}
export interface RuntimeReceiptResponse extends RuntimeRecord { readonly receipt: RuntimeReceipt | null }
export interface RuntimeArtifactResponse extends RuntimeRecord { readonly artifactId: string; readonly version: number; readonly digest: string; readonly content: string }
export interface RuntimeReport {
  readonly reportVersion: 1; readonly runId: string; readonly revision: number;
  readonly basis: { readonly source: string; readonly eventSchemaVersion: 4; readonly replay: "complete_contiguous"; readonly eventCount: number };
  readonly execution: { readonly state: RuntimeRun["state"]; readonly terminalState: "DONE" | "DONE_UNVERIFIED" | "FAILED" | "CANCELLED" | null; readonly outcome: "SUCCEEDED" | "DO_NOT_START" | "DUPLICATE" | "NO_LONGER_VALUABLE" | "SUPERSEDED" | "CLOSE_WITH_NEGATIVE_RESULT" | null; readonly basis: string };
  readonly assessment: { readonly verdict: RuntimeReceipt["verdict"] | null; readonly receiptDigest: string | null; readonly artifactsReported: number | null; readonly unresolvedConditionsReported: number | null; readonly basis: string };
  readonly publication: { readonly tierReported: "NONE" | "MERGED" | "DEPLOYED" | "OBSERVED" | null; readonly basis: string; readonly independentlyConfirmed: null };
  readonly reportedUsage: { readonly basis: string; readonly startedTurns: number; readonly finishedTurns: number; readonly unfinishedTurns: number; readonly inputTokens: number | null; readonly outputTokens: number | null; readonly costMicrousd: number | null; readonly distinctModelsRecorded: number; readonly eventCostMicrousd: number | null; readonly eventCostBasis: string; readonly activeDurationMs: number | null; readonly activeDurationBasis: string; readonly authoritativeForBilling: false };
  readonly recordedAttention: { readonly seconds: number; readonly decisions: number; readonly interruptions: number; readonly basis: string; readonly otherSupervisionSeconds: null };
  readonly unknown: { readonly totalIncurredCost: null; readonly providerQuota: null; readonly accountDebit: null; readonly managedCredits: null; readonly nativeAttribution: null; readonly byoAttribution: null };
}
export interface RuntimeFacade {
  create(spec: RuntimeCreateSpec | string, options?: RuntimeRequestOptions): Promise<RuntimeCreatedResponse>;
  inspect(runId: string, options?: RuntimeRequestOptions): Promise<RuntimeTaskResponse>;
  events(runId: string, options?: RuntimeEventOptions): Promise<RuntimeEventPage>;
  questions(runId: string, options?: RuntimeRequestOptions): Promise<RuntimeQuestionResponse>;
  approvals(runId: string, options?: RuntimeRequestOptions): Promise<RuntimeApprovalResponse>;
  answer(runId: string, spec: RuntimeAnswerSpec | string, options?: RuntimeRequestOptions): Promise<RuntimeTaskView>;
  approve(runId: string, spec: RuntimeApproveSpec | string, options?: RuntimeRequestOptions): Promise<RuntimeRecord & { readonly approvalId: string; readonly effective: true }>;
  correct(runId: string, spec: RuntimeCorrectSpec | string, options?: RuntimeRequestOptions): Promise<RuntimeRecord & { readonly revision: number }>;
  cancel(runId: string, options?: RuntimeRequestOptions): Promise<RuntimeRecord & { readonly view: RuntimeTaskView; readonly acknowledged: boolean }>;
  receipt(runId: string, options?: RuntimeRequestOptions): Promise<RuntimeReceiptResponse>;
  artifact(runId: string, artifactId: string, version: number, options?: RuntimeRequestOptions): Promise<RuntimeArtifactResponse>;
  report(runId: string, options?: RuntimeRequestOptions): Promise<RuntimeReport>;
  watch(runId: string, options: RuntimeWatchOptions, onEvent: (event: RuntimeEvent) => void): Promise<{ readonly revision: number; readonly terminalObserved: true }>;
}
export class RuntimeError extends Error {
  readonly code: string; readonly exitCode: number; readonly mutationUnconfirmed: boolean;
  constructor(code: string, exitCode?: number, mutationUnconfirmed?: boolean);
}
export function createRuntime(configPath: string): Promise<RuntimeFacade>;
// Existing low-level CLI transport export retained; the facade exposes only the operations above.
export function runtimeClient(configPath: string): Promise<(method: string, route: string, raw?: string, timeoutMs?: number, options?: { readonly signal?: AbortSignal }) => Promise<RuntimeRecord>>;
export function runRuntime(args: readonly string[], configPath?: string, write?: (value: string) => void): Promise<void>;
