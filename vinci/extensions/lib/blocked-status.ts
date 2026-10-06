/** Read an explicit blocked-status line without treating quoted examples as the task's status. */
export function vinciBlockedStatusLine(text: string): string | undefined {
  const prose = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, "");
  // Only paired emphasis around status labels is normalized; leave explanations/error codes intact.
  const normalized = prose.replace(
    /(\*\*|__|\*|_)(Blocked|Verification(?:[ \t]*:[ \t]*Blocked|[ \t]+blocked)?)([:—]?)\1/gi,
    "$2$3",
  );
  const line = normalized.match(
    /^[ \t]{0,3}(?:Blocked|Verification[ \t]+blocked|Verification[ \t]*:[ \t]*Blocked)[ \t]*(?::|—|\()[ \t]*(\S[^\r\n]*)/im,
  );
  return line ? `Blocked: ${line[1].trim()}` : undefined;
}
