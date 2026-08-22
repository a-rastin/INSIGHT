export type XmlFidelityRiskCode =
  | "XML_COMMENT"
  | "XML_DOCTYPE"
  | "XML_PROCESSING_INSTRUCTION"
  | "UNKNOWN_XML_ELEMENT"
  | "UNKNOWN_XML_ATTRIBUTE"
  | "IGNORED_XML_TEXT";

export interface XmlFidelityRisk {
  code: XmlFidelityRiskCode;
  message: string;
}

const allowedChildren: Readonly<Record<string, readonly string[]>> = {
  BIF: ["NETWORK"],
  NETWORK: ["NAME", "PROPERTY", "VARIABLE", "DEFINITION"],
  VARIABLE: ["NAME", "OUTCOME", "PROPERTY"],
  DEFINITION: ["FOR", "GIVEN", "TABLE", "PROPERTY"],
  NAME: [],
  OUTCOME: [],
  PROPERTY: [],
  FOR: [],
  GIVEN: [],
  TABLE: [],
};

const allowedAttributes: Readonly<Record<string, readonly string[]>> = {
  BIF: ["VERSION"],
  VARIABLE: ["TYPE"],
};

function addRisk(
  risks: XmlFidelityRisk[],
  code: XmlFidelityRiskCode,
  message: string,
): void {
  if (!risks.some((risk) => risk.code === code && risk.message === message)) {
    risks.push({ code, message });
  }
}

function inspectElement(element: Element, risks: XmlFidelityRisk[]): void {
  const allowed = allowedChildren[element.tagName];
  if (!allowed) {
    addRisk(
      risks,
      "UNKNOWN_XML_ELEMENT",
      `Unknown XML element <${element.tagName}> is not preserved by graphical editing.`,
    );
  }

  const attributes = allowedAttributes[element.tagName] ?? [];
  for (const attribute of Array.from(element.attributes)) {
    if (!attributes.includes(attribute.name)) {
      addRisk(
        risks,
        "UNKNOWN_XML_ATTRIBUTE",
        `Unknown XML attribute ${attribute.name} on <${element.tagName}> is not preserved by graphical editing.`,
      );
    }
  }

  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 1) {
      const childElement = child as Element;
      if (allowed && !allowed.includes(childElement.tagName)) {
        addRisk(
          risks,
          "UNKNOWN_XML_ELEMENT",
          `Unknown XML element <${childElement.tagName}> is not preserved by graphical editing.`,
        );
      }
      inspectElement(childElement, risks);
    } else if (child.nodeType === 7) {
      addRisk(
        risks,
        "XML_PROCESSING_INSTRUCTION",
        "XML processing instructions are not preserved by graphical editing.",
      );
    } else if (child.nodeType === 8) {
      addRisk(
        risks,
        "XML_COMMENT",
        "XML comments are not preserved by graphical editing.",
      );
    } else if (
      child.nodeType === 3 &&
      child.textContent?.trim() &&
      (allowed?.length ?? 0) > 0
    ) {
      addRisk(
        risks,
        "IGNORED_XML_TEXT",
        `Text directly inside <${element.tagName}> is not preserved by graphical editing.`,
      );
    }
  }
}

/** Analyze well-formed XML after parsing. Never resolves or executes XML content. */
export function detectXmlFidelityRisks(source: string): XmlFidelityRisk[] {
  try {
    const document = new DOMParser().parseFromString(source, "application/xml");
    if (document.getElementsByTagName("parsererror").length > 0) return [];

    const risks: XmlFidelityRisk[] = [];
    if (document.doctype) {
      addRisk(
        risks,
        "XML_DOCTYPE",
        "DOCTYPE and DTD content are not preserved by graphical editing.",
      );
    }
    for (const child of Array.from(document.childNodes)) {
      if (child.nodeType === 7) {
        addRisk(
          risks,
          "XML_PROCESSING_INSTRUCTION",
          "XML processing instructions are not preserved by graphical editing.",
        );
      } else if (child.nodeType === 8) {
        addRisk(
          risks,
          "XML_COMMENT",
          "XML comments are not preserved by graphical editing.",
        );
      }
    }
    inspectElement(document.documentElement, risks);
    return risks;
  } catch {
    return [];
  }
}
