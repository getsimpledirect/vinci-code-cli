/**
 * Building the prefilled "new issue" URL for `/issue`.
 *
 * Vinci never POSTs the issue. It composes the text, opens GitHub's issue form with the fields
 * already filled, and the person reads it rendered and presses Submit themselves. That is the whole
 * point: an issue is PUBLIC, and nothing should become public that the author has not seen first.
 * It also means no GitHub token, no login inside the CLI, and no way for a transcript to escape by
 * accident — the payload is only ever a URL the user can walk away from.
 *
 * Pure string work, so the truncation and redaction rules are testable without a browser.
 */

/** GitHub rejects very long URLs; stay well under the ~8KB practical ceiling. */
export const ISSUE_URL_LIMIT = 6000;
/**
 * An issue title is one line. Capping it is what keeps the URL budget solvable: only the body is
 * trimmed to fit, so an unbounded title could push the URL over the limit no matter how far the
 * body shrank — and the over-long URL was returned anyway, so the browser opened onto a form
 * GitHub would reject.
 */
export const ISSUE_TITLE_LIMIT = 120;
const BODY_TRUNCATION_MARKER = "\n\n[trimmed — add the rest in the browser before submitting]";

export type IssueKind = "bug" | "feature";

export interface IssueFields {
  kind: IssueKind;
  title: string;
  /** The user's own account of the problem, already redacted. */
  body: string;
  version: string;
  os: string;
}

/** GitHub's issue-form dropdown values in `.github/ISSUE_TEMPLATE/bug.yml`. */
export function osLabel(platform: string): string {
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  if (platform === "win32") return "Windows (WSL)";
  return "Other";
}

/**
 * Field ids come from the issue templates: bug.yml uses what-happened/steps/version/os, feature.yml
 * uses problem/version. A field id that stops matching simply arrives blank in the form — the user
 * can still type it — so this degrades into a mild annoyance rather than a broken command.
 */
function fieldsFor(fields: IssueFields): Array<[string, string]> {
  if (fields.kind === "bug") {
    return [
      ["template", "bug.yml"],
      ["title", fields.title],
      ["what-happened", fields.body],
      ["version", fields.version],
      ["os", fields.os],
    ];
  }
  return [
    ["template", "feature.yml"],
    ["title", fields.title],
    ["problem", fields.body],
    ["version", fields.version],
  ];
}

/**
 * Compose the URL, trimming the body until the whole thing fits. The body is trimmed rather than
 * any other field because it is the only one that is long and the only one the user can finish
 * typing in the browser.
 */
export function buildIssueUrl(repoUrl: string, fields: IssueFields): string {
  const base = `${repoUrl.replace(/\/+$/, "")}/issues/new`;
  // Slice by code point, not by UTF-16 unit: cutting "🎉" in half leaves a lone surrogate that
  // renders as a replacement character in the issue title.
  const titleChars = [...fields.title];
  const title =
    titleChars.length > ISSUE_TITLE_LIMIT ? `${titleChars.slice(0, ISSUE_TITLE_LIMIT - 1).join("")}…` : fields.title;
  const bodyChars = [...fields.body];
  const render = (body: string) => {
    const params = new URLSearchParams();
    for (const [key, value] of fieldsFor({ ...fields, title, body })) {
      if (value) params.set(key, value);
    }
    return `${base}?${params.toString()}`;
  };

  let url = render(fields.body);
  if (url.length <= ISSUE_URL_LIMIT) return url;

  // Binary-search the longest body that still fits, so a long report loses as little as possible.
  // Counted in code points for the same surrogate-pair reason as the title.
  let low = 0;
  let high = bodyChars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (render(`${bodyChars.slice(0, mid).join("")}${BODY_TRUNCATION_MARKER}`).length <= ISSUE_URL_LIMIT) low = mid;
    else high = mid - 1;
  }
  url = render(`${bodyChars.slice(0, low).join("")}${BODY_TRUNCATION_MARKER}`);
  return url;
}

/** What the user is shown before the browser opens — the issue as text, not as a URL. */
export function issuePreview(fields: IssueFields): string {
  return [
    `Title: ${fields.title}`,
    "",
    fields.body,
    "",
    `Vinci Code ${fields.version} · ${fields.os}`,
  ].join("\n");
}
