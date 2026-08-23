export interface XmlFidelityRisk {
  readonly code:
    | "XML_COMMENT"
    | "XML_DOCTYPE"
    | "XML_PROCESSING_INSTRUCTION"
    | "UNKNOWN_XML_ELEMENT"
    | "UNKNOWN_XML_ATTRIBUTE"
    | "IGNORED_XML_TEXT";
  readonly message: string;
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

function addRisk(risks: XmlFidelityRisk[], risk: XmlFidelityRisk): void {
  if (!risks.some(({ code, message }) => code === risk.code && message === risk.message))
    risks.push(risk);
}

function inspectElement(element: Element, risks: XmlFidelityRisk[]): void {
  const allowed = allowedChildren[element.tagName];
  if (!allowed)
    addRisk(risks, {
      code: "UNKNOWN_XML_ELEMENT",
      message: `Unknown XML element <${element.tagName}> is not preserved by graphical editing.`,
    });
  const attributes = allowedAttributes[element.tagName] ?? [];
  for (const attribute of Array.from(element.attributes))
    if (!attributes.includes(attribute.name))
      addRisk(risks, {
        code: "UNKNOWN_XML_ATTRIBUTE",
        message: `Unknown XML attribute ${attribute.name} on <${element.tagName}> is not preserved by graphical editing.`,
      });
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 1) {
      const childElement = child as Element;
      if (allowed && !allowed.includes(childElement.tagName))
        addRisk(risks, {
          code: "UNKNOWN_XML_ELEMENT",
          message: `Unknown XML element <${childElement.tagName}> is not preserved by graphical editing.`,
        });
      inspectElement(childElement, risks);
    } else if (child.nodeType === 7)
      addRisk(risks, {
        code: "XML_PROCESSING_INSTRUCTION",
        message: "XML processing instructions are not preserved by graphical editing.",
      });
    else if (child.nodeType === 8)
      addRisk(risks, {
        code: "XML_COMMENT",
        message: "XML comments are not preserved by graphical editing.",
      });
    else if (child.nodeType === 3 && child.textContent?.trim() && (allowed?.length ?? 0) > 0)
      addRisk(risks, {
        code: "IGNORED_XML_TEXT",
        message: `Text directly inside <${element.tagName}> is not preserved by graphical editing.`,
      });
  }
}

export function detectXmlFidelityRisks(source: string): XmlFidelityRisk[] {
  try {
    const document = new DOMParser().parseFromString(source, "application/xml");
    if (document.getElementsByTagName("parsererror").length > 0) return [];
    const risks: XmlFidelityRisk[] = [];
    if (document.doctype)
      addRisk(risks, {
        code: "XML_DOCTYPE",
        message: "DOCTYPE and DTD content are not preserved by graphical editing.",
      });
    for (const child of Array.from(document.childNodes)) {
      if (child.nodeType === 7)
        addRisk(risks, {
          code: "XML_PROCESSING_INSTRUCTION",
          message: "XML processing instructions are not preserved by graphical editing.",
        });
      else if (child.nodeType === 8)
        addRisk(risks, {
          code: "XML_COMMENT",
          message: "XML comments are not preserved by graphical editing.",
        });
    }
    inspectElement(document.documentElement, risks);
    return risks;
  } catch {
    return [];
  }
}
