// The ONE parser for the launcher's extension registration lines. Three tests previously kept
// diverging copies of this regex; a launcher-form change must break exactly one place.
export function parseLauncherExtensions(launcherSource) {
  return Array.from(
    launcherSource.matchAll(/--extension "\$\{VINCI_EXTENSIONS\}\/([^".]+)\.\$\{VINCI_EXTENSION_SUFFIX\}"/g),
    (match) => `${match[1]}.ts`,
  );
}
