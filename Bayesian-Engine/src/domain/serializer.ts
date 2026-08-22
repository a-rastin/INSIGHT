import type { XmlBifFile } from "./model";

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function element(indent: string, name: string, text: string): string {
  return `${indent}<${name}>${escapeXml(text)}</${name}>`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError("TABLE values must be finite numbers");
  }

  return Object.is(value, -0) ? "-0" : String(value);
}

export function serializeXmlBif(file: XmlBifFile): string {
  if (file.version !== "0.3") {
    throw new RangeError(`Unsupported XMLBIF version: ${file.version}`);
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<BIF VERSION="0.3">',
  ];

  for (const network of file.networks) {
    lines.push("  <NETWORK>", element("    ", "NAME", network.name));
    for (const property of network.properties) {
      lines.push(element("    ", "PROPERTY", property.text));
    }

    for (const variable of network.variables) {
      lines.push(
        `    <VARIABLE TYPE="${variable.type}">`,
        element("      ", "NAME", variable.name),
      );
      for (const outcome of variable.outcomes) {
        lines.push(element("      ", "OUTCOME", outcome));
      }
      for (const property of variable.properties) {
        lines.push(element("      ", "PROPERTY", property.text));
      }
      lines.push("    </VARIABLE>");
    }

    for (const definition of network.definitions) {
      lines.push("    <DEFINITION>", element("      ", "FOR", definition.for));
      for (const parent of definition.given) {
        lines.push(element("      ", "GIVEN", parent));
      }
      lines.push(
        element(
          "      ",
          "TABLE",
          definition.table.map(formatNumber).join(" "),
        ),
      );
      for (const property of definition.properties) {
        lines.push(element("      ", "PROPERTY", property.text));
      }
      lines.push("    </DEFINITION>");
    }

    lines.push("  </NETWORK>");
  }

  lines.push("</BIF>");
  return `${lines.join("\n")}\n`;
}
