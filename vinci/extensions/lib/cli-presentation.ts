/** Presentation settings shared by startup and the Vinci extensions. */
export function vinciPlainPresentation(): boolean {
  return process.env.TERM === "dumb" || process.env.VINCI_PLAIN === "1" || process.env.VINCI_SCREEN_READER === "1";
}

export function vinciNoColor(): boolean {
  return process.env.NO_COLOR !== undefined;
}

export function vinciAscii(): boolean {
  const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "";
  return vinciPlainPresentation() || process.env.VINCI_ASCII === "1" ||
    process.env.TERM === "linux" || !/utf-?8/i.test(locale);
}

export function vinciReducedMotion(): boolean {
  return vinciPlainPresentation() || !process.stdin.isTTY || !process.stdout.isTTY ||
    process.env.VINCI_REDUCED_MOTION === "1" ||
    !["", "0", "false", "no", "off"].includes(process.env.CI?.trim().toLowerCase() ?? "");
}

/** Remove foreground, background and underline colours while keeping styles and terminal control. */
export function stripVinciColor(text: string): string {
  return text.replace(/\x1b\[([0-9:;]*)m/g, (sequence, parameters: string) => {
    if (!parameters) return sequence;
    const params = parameters.split(";");
    const kept: string[] = [];
    for (let i = 0; i < params.length; i++) {
      const field = params[i];
      const code = Number(field.split(":", 1)[0]);
      if (code === 38 || code === 48 || code === 58) {
        if (!field.includes(":")) {
          const mode = params[i + 1];
          if (mode === "5") i += 2;
          if (mode === "2") i += 4;
        }
      } else if (!((code >= 30 && code <= 49) || (code >= 90 && code <= 107) || code === 59)) {
        kept.push(field);
      }
    }
    return kept.length ? `\x1b[${kept.join(";")}m` : "";
  });
}
