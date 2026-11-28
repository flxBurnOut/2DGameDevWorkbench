export const MAX_GODOT_BYTES: number;
export function digest(bytes: Uint8Array): Promise<string>;
export function safePackagePath(name: string): string;
export function readGodotZip(
  bytes: Uint8Array,
): Promise<Map<string, Uint8Array>>;
export type GodotPackageManifest = {
  format: 'forge-godot-export';
  version: 1;
  packageId: string;
  kind: string;
  engine: string;
  entryScenes: string[];
  spriteFrames: string[];
  runtime: string | null;
  details: Record<string, unknown>;
  files: { path: string; sha256: string; bytes: number }[];
};
export function prepareGodotPackage(
  bytes: Uint8Array,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; manifest: GodotPackageManifest }>;
