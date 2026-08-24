/**
 * Whether verification is switched off, and nothing else.
 *
 * This is a LEAF module on purpose (#10). The predicate is consumed by `lib/task-outcome.ts`,
 * `lib/grader.ts`, `vinci-completion-receipt.ts`, and `vinci-verification.ts` — and the first
 * version lived in vinci-verification.ts, which made every one of those importers transitively
 * pull in `@earendil-works/pi-ai` and fail to resolve `partial-json` when loaded standalone.
 * Keep this file free of imports so that can't happen again.
 */

const STATE_KEY = "__vinciVerificationControl" as const;

type VerificationControl = { disabledForSession: boolean };

type VinciGlobal = typeof globalThis & { [STATE_KEY]?: VerificationControl };
const vinciGlobal = globalThis as VinciGlobal;

// Shared across the isolated extension loaders, the same way the verification store is.
const control: VerificationControl = vinciGlobal[STATE_KEY] ?? { disabledForSession: false };
if (!vinciGlobal[STATE_KEY]) {
  Object.defineProperty(vinciGlobal, STATE_KEY, { value: control, writable: false, configurable: false });
}

/** True when verification is off — either from the environment or the session toggle (`/verify off`). */
export function vinciVerificationDisabled(): boolean {
  return process.env.VINCI_NO_VERIFY === "1" || control.disabledForSession;
}

/** True when the environment disabled it, so `/verify on` can say so honestly. */
export function vinciVerificationDisabledByEnv(): boolean {
  return process.env.VINCI_NO_VERIFY === "1";
}

export function setVinciVerificationDisabledForSession(disabled: boolean): void {
  control.disabledForSession = disabled;
}

export function resetVinciVerificationControl(): void {
  control.disabledForSession = false;
}
