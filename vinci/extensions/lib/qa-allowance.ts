/** No provider calls: close the top-level QA authorization once the task reports completion. */
export function closeCompletedQaAllowance(state: string, helper = process.env.VINCI_CREW_HELPER): void {
  if (helper === "1" || (state !== "DONE" && state !== "DONE_UNVERIFIED")) return;
  const bridge = (globalThis as typeof globalThis & {
    __vinciQaRequestGuard?: { close(reason: "completed"): void };
  }).__vinciQaRequestGuard;
  bridge?.close("completed");
}
