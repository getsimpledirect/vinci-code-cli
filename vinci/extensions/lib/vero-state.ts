import "./control.ts";
import "./task-outcome.ts";

export { vinciPlainPresentation, vinciReducedMotion } from "./cli-presentation.ts";
export { getVeroPresentation } from "./vero-presentation.ts";

export type VeroPose = "pixel" | "rich" | "working" | "review" | "blocked" | "done";
