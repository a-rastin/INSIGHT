export const MAX_XMLBIF_SOURCE_BYTES = 20 * 1024 * 1024;

export function xmlSourceByteLength(source: string): number {
  return new TextEncoder().encode(source).byteLength;
}
