import { SaxesParser, type SaxesTagPlain } from "saxes";
import type { Diagnostic } from "./diagnostics.js";
import {
  MAX_XMLBIF_ELEMENTS,
  MAX_XMLBIF_NESTING_DEPTH,
  MAX_XMLBIF_SOURCE_BYTES,
  xmlSourceByteLength,
} from "./inputLimits.js";
import type {
  SourceVariableType,
  VariableType,
  XmlBifDefinition,
  XmlBifFile,
  XmlBifNetwork,
  XmlBifVariable,
  XmlProperty,
} from "./model.js";

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

interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  content: Array<string | XmlElement>;
  children: XmlElement[];
}

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function failure(code: string, message: string, line?: number, column?: number): ParseFailure {
  return {
    ok: false,
    diagnostics: [
      {
        code,
        severity: "error",
        category: "xml",
        message,
        ...(line === undefined ? {} : { line, column }),
      },
    ],
  };
}

function textContent(element: XmlElement): string {
  return element.content
    .map((part) => (typeof part === "string" ? part : textContent(part)))
    .join("");
}

function directChildren(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

function firstText(element: XmlElement, name: string): string {
  const child = directChildren(element, name)[0];
  return child ? textContent(child).trim() : "";
}

function propertiesOf(element: XmlElement): XmlProperty[] {
  return directChildren(element, "PROPERTY").map((property) => ({ text: textContent(property) }));
}

function parseVariableType(
  element: XmlElement,
  networkIndex: number,
  variableName: string,
  diagnostics: Diagnostic[],
): { type: VariableType; sourceType?: SourceVariableType } | null {
  const sourceType = element.attributes.TYPE;
  if (sourceType === undefined) return { type: "nature" };
  if (sourceType === "chance") return { type: "nature", sourceType };
  if (sourceType === "nature" || sourceType === "decision" || sourceType === "utility") {
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
  element: XmlElement,
  networkIndex: number,
  diagnostics: Diagnostic[],
): XmlBifVariable | null {
  const name = firstText(element, "NAME");
  const parsedType = parseVariableType(element, networkIndex, name, diagnostics);
  if (!parsedType) return null;
  return {
    name,
    ...parsedType,
    outcomes: directChildren(element, "OUTCOME").map((outcome) => textContent(outcome).trim()),
    properties: propertiesOf(element),
  };
}

function parseTable(
  element: XmlElement | undefined,
  networkIndex: number,
  definitionFor: string,
  diagnostics: Diagnostic[],
): number[] {
  const text = element ? textContent(element).trim() : "";
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
    } else table.push(value);
  }
  return table;
}

function parseDefinition(
  element: XmlElement,
  networkIndex: number,
  diagnostics: Diagnostic[],
): XmlBifDefinition {
  const definitionFor = firstText(element, "FOR");
  const tables = directChildren(element, "TABLE");
  if (tables.length > 1)
    diagnostics.push({
      code: "MULTIPLE_TABLES",
      severity: "warning",
      category: "compatibility",
      message: "DEFINITION has multiple TABLE elements; last TABLE is effective",
      networkIndex,
      definitionFor,
    });
  return {
    for: definitionFor,
    given: directChildren(element, "GIVEN").map((given) => textContent(given).trim()),
    table: parseTable(tables.at(-1), networkIndex, definitionFor, diagnostics),
    properties: propertiesOf(element),
  };
}

function parseNetwork(
  element: XmlElement,
  networkIndex: number,
  diagnostics: Diagnostic[],
): XmlBifNetwork {
  return {
    name: firstText(element, "NAME"),
    properties: propertiesOf(element),
    variables: directChildren(element, "VARIABLE")
      .map((variable) => parseVariable(variable, networkIndex, diagnostics))
      .filter((variable): variable is XmlBifVariable => variable !== null),
    definitions: directChildren(element, "DEFINITION").map((definition) =>
      parseDefinition(definition, networkIndex, diagnostics),
    ),
  };
}

export function parseXmlBif(source: string): ParseResult {
  if (xmlSourceByteLength(source) > MAX_XMLBIF_SOURCE_BYTES) {
    return failure(
      "SOURCE_TOO_LARGE",
      `XMLBIF source exceeds the ${MAX_XMLBIF_SOURCE_BYTES / 1024 / 1024} MB safety limit`,
    );
  }

  const parser = new SaxesParser({ xmlns: false });
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let elementCount = 0;
  let parseFailure: ParseFailure | undefined;

  parser.on("error", (error) => {
    if (!parseFailure)
      parseFailure = failure("XML_MALFORMED", error.message, parser.line, parser.column);
  });
  parser.on("opentag", (tag: SaxesTagPlain) => {
    if (parseFailure) return;
    elementCount += 1;
    if (stack.length + 1 > MAX_XMLBIF_NESTING_DEPTH) {
      parseFailure = failure(
        "XML_DEPTH_LIMIT",
        `XML nesting exceeds the ${MAX_XMLBIF_NESTING_DEPTH} element safety limit`,
        parser.line,
        parser.column,
      );
      return;
    }
    if (elementCount > MAX_XMLBIF_ELEMENTS) {
      parseFailure = failure(
        "XML_ELEMENT_LIMIT",
        `XML contains more than ${MAX_XMLBIF_ELEMENTS} elements`,
        parser.line,
        parser.column,
      );
      return;
    }
    const element: XmlElement = {
      name: tag.name,
      attributes: tag.attributes,
      content: [],
      children: [],
    };
    const parent = stack.at(-1);
    if (parent) {
      parent.children.push(element);
      parent.content.push(element);
    } else root = element;
    stack.push(element);
  });
  const appendText = (text: string): void => {
    if (!parseFailure) stack.at(-1)?.content.push(text);
  };
  parser.on("text", appendText);
  parser.on("cdata", appendText);
  parser.on("closetag", () => {
    if (!parseFailure) stack.pop();
  });

  try {
    parser.write(source).close();
  } catch (error) {
    if (!parseFailure) {
      parseFailure = failure(
        "XML_MALFORMED",
        error instanceof Error ? error.message : "XML parsing failed",
        parser.line,
        parser.column,
      );
    }
  }
  if (parseFailure) return parseFailure;
  if (!root || root.name !== "BIF") return failure("ROOT_NOT_BIF", "Root element must be BIF");

  const diagnostics: Diagnostic[] = [];
  const file: XmlBifFile = {
    version: root.attributes.VERSION ?? "",
    networks: directChildren(root, "NETWORK").map((network, index) =>
      parseNetwork(network, index, diagnostics),
    ),
  };
  return diagnostics.some(({ severity }) => severity === "error")
    ? { ok: false, diagnostics }
    : { ok: true, file, warnings: diagnostics };
}
