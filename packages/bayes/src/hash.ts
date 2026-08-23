import type { XmlBifFile } from "./model.js";
import { serializeXmlBif } from "./serializer.js";

export async function hashXmlBifSemantics(file: XmlBifFile): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serializeXmlBif(file)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
