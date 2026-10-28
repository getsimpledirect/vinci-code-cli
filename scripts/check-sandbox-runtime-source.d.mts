export const sandboxSourcePath: string;
export const sandboxVersion: string;
export const sandboxArchivePath: string;
export const sandboxIntegrity: string;
export function checkSandboxSource(root?: string): {
	seal: { version: string };
	files: Map<string, { bytes: Buffer; mode: number }>;
};
export function checkInstalledSandbox(directory: string, root?: string): { version: string };
