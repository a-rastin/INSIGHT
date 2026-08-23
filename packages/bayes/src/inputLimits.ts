export const MAX_XMLBIF_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_XMLBIF_NESTING_DEPTH = 64;
export const MAX_XMLBIF_ELEMENTS = 100_000;

export function xmlSourceByteLength(source: string): number {
  return new TextEncoder().encode(source).byteLength;
}
