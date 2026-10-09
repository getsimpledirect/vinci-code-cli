export function parseLauncher(source) {
	return source.matchAll(/--extension "\$\{VINCI_EXTENSIONS\}\/([^".]+)\.\$\{VINCI_EXTENSION_SUFFIX\}"/g);
}
