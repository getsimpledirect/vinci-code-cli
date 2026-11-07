/** Read an explicit blocked-status line without treating quoted examples as the task's status. */
export function vinciBlockedStatusLine(text: string): string | undefined {
  let fence: { marker: string; length: number } | undefined;
  const prose = text
    .split(/\r?\n/)
    .filter((line) => {
      const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (
          delimiter &&
          delimiter[1][0] === fence.marker &&
          delimiter[1].length >= fence.length &&
          /^[ \t]*$/.test(delimiter[2])
        ) fence = undefined;
        return false;
      }
      if (delimiter) {
        fence = { marker: delimiter[1][0], length: delimiter[1].length };
        return false;
      }
      return true;
    })
    .join("\n");
  // Only paired emphasis around status labels is normalized; leave explanations/error codes intact.
  const normalized = prose.replace(
    /(\*\*|__|\*|_)(Status|Blocked|Verification(?:[ \t]*:[ \t]*Blocked|[ \t]+blocked)?)([:—]?)\1/gi,
    "$2$3",
  );
  for (const proseLine of normalized.split("\n")) {
    const line = proseLine.match(
      /^ {0,3}(?:Blocked|Verification[ \t]+blocked|Verification[ \t]*:[ \t]*Blocked)[ \t]*(?::|—|\()[ \t]*(\S.*)/i,
    );
    if (line) return `Blocked: ${line[1].trim()}`;
    const heading = proseLine.match(
      /^ {0,3}#{1,6}[ \t]+Status[ \t]*:[ \t]*Blocked\b[ \t]*(?::|—|\()?[ \t]*(\S.*)/i,
    );
    const reason = heading?.[1].replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim();
    if (reason) return `Blocked: ${reason}`;
  }
  return undefined;
}
