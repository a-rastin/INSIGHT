import type { Diagnostic } from "./diagnostics";
import { MAX_XMLBIF_SOURCE_BYTES, xmlSourceByteLength } from "./inputLimits";
import type {
  SourceVariableType,
  VariableType,
  XmlBifDefinition,
  XmlBifFile,
  XmlBifNetwork,
  XmlBifVariable,
  XmlProperty,
} from "./model";

export interface ParseSuccess {
  ok: true;
  file: XmlBifFile;
  warnings: Diagnostic[];
}

export interface ParseFailure {
  ok: false;
  diagnostics: Diagnostic[];
}

export type ParseResult = ParseSuccess | ParseFailure;

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function directChildren(element: Element, tagName: string): Element[] {
  return Array.from(element.children).filter(
    (child) => child.tagName === tagName,
  );
}

function firstText(element: Element, tagName: string): string {
  return directChildren(element, tagName)[0]?.textContent?.trim() ?? "";
}

function propertiesOf(element: Element): XmlProperty[] {
  return directChildren(element, "PROPERTY").map((property) => ({
    text: property.textContent ?? "",
  }));
}

function parseVariableType(
  element: Element,
  networkIndex: number,
  variableName: string,
  diagnostics: Diagnostic[],
): { type: VariableType; sourceType?: SourceVariableType } | null {
  const sourceType = element.getAttribute("TYPE");
  if (sourceType === null) return { type: "nature" };
  if (sourceType === "chance") return { type: "nature", sourceType };
  if (
    sourceType === "nature" ||
    sourceType === "decision" ||
    sourceType === "utility"
  ) {
    return { type: sourceType };
  }

  diagnostics.push({
    code: "UNSUPPORTED_VARIABLE_TYPE",
    severity: "error",
    category: "compatibility",
    message: `Unsupported variable TYPE: ${sourceType}`,
    networkIndex,
    variableName,
  });
  return null;
}

function parseVariable(
  element: Element,
  networkIndex: number,
  diagnostics: Diagnostic[],
): XmlBifVariable | null {
  const name = firstText(element, "NAME");
  const parsedType = parseVariableType(
    element,
    networkIndex,
    name,
    diagnostics,
  );
  if (!parsedType) return null;

  return {
    name,
    ...parsedType,
    outcomes: directChildren(element, "OUTCOME").map(
      (outcome) => outcome.textContent?.trim() ?? "",
    ),
    properties: propertiesOf(element),
  };
}

function parseTable(
  element: Element | undefined,
  networkIndex: number,
  definitionFor: string,
  diagnostics: Diagnostic[],
): number[] {
  const text = element?.textContent?.trim() ?? "";
  if (!text) return [];

  const table: number[] = [];
  for (const token of text.split(/\s+/)) {
    const value = Number(token);
    if (!NUMBER_PATTERN.test(token) || !Number.isFinite(value)) {
      diagnostics.push({
        code: "INVALID_TABLE_NUMBER",
        severity: "error",
        category: "xml",
        message: `Invalid TABLE number: ${token}`,
        networkIndex,
        definitionFor,
      });
      continue;
    }
    table.push(value);
  }
  return table;
}

function parseDefinition(
  element: Element,
  networkIndex: number,
  diagnostics: Diagnostic[],
): XmlBifDefinition {
  const definitionFor = firstText(element, "FOR");
  const tables = directChildren(element, "TABLE");
  if (tables.length > 1) {
    diagnostics.push({
      code: "MULTIPLE_TABLES",
      severity: "warning",
      category: "compatibility",
      message:
        "DEFINITION has multiple TABLE elements; last TABLE is effective",
      networkIndex,
      definitionFor,
    });
  }

  return {
    for: definitionFor,
    given: directChildren(element, "GIVEN").map(
      (given) => given.textContent?.trim() ?? "",
    ),
    table: parseTable(tables.at(-1), networkIndex, definitionFor, diagnostics),
    properties: propertiesOf(element),
  };
}

function parseNetwork(
  element: Element,
  networkIndex: number,
  diagnostics: Diagnostic[],
): XmlBifNetwork {
  const variables = directChildren(element, "VARIABLE")
    .map((variable) => parseVariable(variable, networkIndex, diagnostics))
    .filter((variable): variable is XmlBifVariable => variable !== null);

  return {
    name: firstText(element, "NAME"),
    properties: propertiesOf(element),
    variables,
    definitions: directChildren(element, "DEFINITION").map((definition) =>
      parseDefinition(definition, networkIndex, diagnostics),
    ),
  };
}

function malformedXml(message: string): ParseFailure {
  const location =
    /(?:^|\n)(\d+):(\d+):/.exec(message) ??
    /line(?: number)?\s+(\d+)[\s\S]*?column\s+(\d+)/i.exec(message);

  return {
    ok: false,
    diagnostics: [
      {
        code: "XML_MALFORMED",
        severity: "error",
        category: "xml",
        message,
        ...(location
          ? { line: Number(location[1]), column: Number(location[2]) }
          : {}),
      },
    ],
  };
}

export function parseXmlBif(source: string): ParseResult {
  if (xmlSourceByteLength(source) > MAX_XMLBIF_SOURCE_BYTES) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "SOURCE_TOO_LARGE",
          severity: "error",
          category: "xml",
          message: `XMLBIF source exceeds the ${MAX_XMLBIF_SOURCE_BYTES / 1024 / 1024} MB safety limit`,
        },
      ],
    };
  }

  let document: Document;
  try {
    document = new DOMParser().parseFromString(source, "application/xml");
  } catch (error) {
    return malformedXml(
      error instanceof Error ? error.message : "XML parsing failed",
    );
  }

  const parserError = document.getElementsByTagName("parsererror")[0];
  if (parserError) {
    return malformedXml(parserError.textContent?.trim() || "Malformed XML");
  }

  const root = document.documentElement;
  if (root.tagName !== "BIF") {
    return {
      ok: false,
      diagnostics: [
        {
          code: "ROOT_NOT_BIF",
          severity: "error",
          category: "xml",
          message: "Root element must be BIF",
        },
      ],
    };
  }

  const diagnostics: Diagnostic[] = [];
  const file: XmlBifFile = {
    version: root.getAttribute("VERSION") ?? "",
    networks: directChildren(root, "NETWORK").map((network, index) =>
      parseNetwork(network, index, diagnostics),
    ),
  };
  const errors = diagnostics.filter(({ severity }) => severity === "error");

  return errors.length > 0
    ? { ok: false, diagnostics }
    : {
        ok: true,
        file,
        warnings: diagnostics,
      };
}
