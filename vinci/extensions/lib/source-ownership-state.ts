/** Shared dependency-ownership state across isolated Vinci extension loaders. */

type SourceOwnershipStore = {
  candidates: Set<string>;
  inspected: Set<string>;
  successfulFileInspections: string[];
  successfulShellInspectionPaths: string[];
};

const STORE_KEY = "__vinciSourceOwnershipStateStore" as const;
type VinciGlobal = typeof globalThis & { [STORE_KEY]?: SourceOwnershipStore };
const vinciGlobal = globalThis as VinciGlobal;
const store = vinciGlobal[STORE_KEY] ?? {
  candidates: new Set<string>(),
  inspected: new Set<string>(),
  successfulFileInspections: [],
  successfulShellInspectionPaths: [],
};
vinciGlobal[STORE_KEY] = store;

function cleanPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").trim();
}

function inputPath(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const value = input as { path?: unknown; file_path?: unknown };
  return cleanPath(String(value.path ?? value.file_path ?? ""));
}

function shellCommand(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  return String((input as { command?: unknown }).command ?? "").replaceAll("\\", "/");
}

function pathMatches(candidate: string, inspected: string): boolean {
  return inspected === candidate || inspected.endsWith(`/${candidate}`);
}

function completeShellInspectionPaths(command: string): string[] {
  const paths: string[] = [];
  for (const segment of command.replaceAll("\\", "/").split(/&&|\|\||[;\n]/)) {
    if (/[|<>]/.test(segment)) continue;
    const match = segment.match(/(?:^|\s)cat\s+(?:--\s+)?([^\s]+)/);
    if (!match) continue;
    const path = cleanPath(match[1].replace(/^(['"])(.*)\1$/, "$2"));
    if (path) paths.push(path);
  }
  return paths;
}

export function resetVinciSourceOwnership(): void {
  store.candidates.clear();
  store.inspected.clear();
  store.successfulFileInspections.length = 0;
  store.successfulShellInspectionPaths.length = 0;
}

export function addVinciSourceOwnershipCandidates(paths: readonly string[]): void {
  for (const rawPath of paths) {
    const path = cleanPath(rawPath);
    if (!path) continue;
    store.candidates.add(path);
    if (
      store.successfulFileInspections.some((inspected) => pathMatches(path, inspected)) ||
      store.successfulShellInspectionPaths.some((inspected) => pathMatches(path, inspected))
    ) {
      store.inspected.add(path);
    }
  }
}

export function recordVinciSourceInspection(path: string): void {
  const inspected = cleanPath(path);
  if (!inspected) return;
  store.successfulFileInspections.push(inspected);
  if (store.successfulFileInspections.length > 24) store.successfulFileInspections.shift();
  for (const candidate of store.candidates) {
    if (pathMatches(candidate, inspected)) store.inspected.add(candidate);
  }
}

export function recordVinciSourceShellInspection(command: string): void {
  for (const inspected of completeShellInspectionPaths(command)) {
    store.successfulShellInspectionPaths.push(inspected);
    if (store.successfulShellInspectionPaths.length > 24) store.successfulShellInspectionPaths.shift();
    for (const candidate of store.candidates) {
      if (pathMatches(candidate, inspected)) store.inspected.add(candidate);
    }
  }
}

export function pendingVinciSourceOwnershipPaths(): string[] {
  return Array.from(store.candidates).filter((path) => !store.inspected.has(path));
}

/** True only for a read that satisfies a currently pending dependency-ownership checkpoint. */
export function isPendingVinciSourceOwnershipInspection(toolName: string, input: unknown): boolean {
  const pending = pendingVinciSourceOwnershipPaths();
  if (toolName === "read") {
    const path = inputPath(input);
    return pending.some((candidate) => pathMatches(candidate, path));
  }
  if (toolName === "bash") {
    const paths = completeShellInspectionPaths(shellCommand(input));
    return pending.some((candidate) => paths.some((path) => pathMatches(candidate, path)));
  }
  return false;
}
