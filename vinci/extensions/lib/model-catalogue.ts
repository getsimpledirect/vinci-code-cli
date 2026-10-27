import { VINCI_PLATFORM_BASE_URL } from "../vinci-links.ts";

// Only these managed classes are selectable. Server additions require a client decision.
export const VINCI_MODEL_NAMES: Readonly<Record<string, string>> = {
  auto: "Vinci Auto",
  mezzo: "Vinci Mezzo",
  forte: "Vinci Forte",
};

export interface VinciModelDetail {
  label: string;
  occupant: string;
}

export type VinciModelCatalogue = ReadonlyMap<string, VinciModelDetail> | undefined;

/** Stable grouping also applies after scoped ordering and fuzzy matching. */
export function groupVinciModels<T extends { provider: string; id: string }>(models: readonly T[]): T[] {
  const order = Object.keys(VINCI_MODEL_NAMES);
  return [...models].sort((a, b) => {
    const group = Number(b.provider === "vinci") - Number(a.provider === "vinci");
    if (group !== 0) return group;
    if (a.provider === "vinci" && b.provider === "vinci") {
      const aRank = order.indexOf(a.id);
      const bRank = order.indexOf(b.id);
      return (aRank < 0 ? order.length : aRank) - (bRank < 0 ? order.length : bRank);
    }
    return 0;
  });
}

/** Each loader attempts once, including failures. Injection gives offline tests independent loaders. */
export function createVinciModelCatalogue(fetcher?: typeof fetch): () => Promise<VinciModelCatalogue> {
  let cached: Promise<VinciModelCatalogue> | undefined;
  return () => {
    cached ??= (async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, 1500);
      });
      try {
        const request = (async () => {
          const url = new URL(`${VINCI_PLATFORM_BASE_URL.replace(/\/$/, "")}/api/models`);
          // Catalogue discovery is public and must never forward account credentials.
          if (url.username || url.password) return undefined;
          const response = await (fetcher ?? fetch)(url.toString(), {
            method: "GET", credentials: "omit", redirect: "error", signal: controller.signal,
          });
          if (!response.ok) return undefined;
          const payload: unknown = await response.json();
          if (typeof payload !== "object" || payload === null || !("models" in payload) || !Array.isArray(payload.models)) {
            return undefined;
          }
          const details = new Map<string, VinciModelDetail>();
          for (const entry of payload.models) {
            if (typeof entry !== "object" || entry === null || typeof entry.id !== "string") continue;
            if (entry.id === "auto" || !Object.hasOwn(VINCI_MODEL_NAMES, entry.id)) continue;
            if (details.has(entry.id)) return undefined;
            if (typeof entry.label !== "string" || typeof entry.occupant !== "string") return undefined;
            const label = entry.label.trim();
            const occupant = entry.occupant.trim();
            if (!label || !occupant || /[\x00-\x1f\x7f]/.test(label + occupant)) return undefined;
            details.set(entry.id, { label, occupant });
          }
          if (!details.has("mezzo") || !details.has("forte")) return undefined;
          return details;
        })();
        return await Promise.race([request, timeout]);
      } catch {
        return undefined;
      } finally {
        clearTimeout(timer);
      }
    })();
    return cached;
  };
}

// The product uses one process-wide loader, fetched lazily by /model, never on startup.
export const loadVinciModelCatalogue = createVinciModelCatalogue();
