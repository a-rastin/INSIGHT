export type VariableType = "nature" | "decision" | "utility";
export type SourceVariableType = VariableType | "chance";

export interface XmlProperty {
  text: string;
}
export interface XmlBifVariable {
  name: string;
  type: VariableType;
  sourceType?: SourceVariableType;
  outcomes: string[];
  properties: XmlProperty[];
}
export interface XmlBifDefinition {
  for: string;
  given: string[];
  table: number[];
  properties: XmlProperty[];
}
export interface XmlBifNetwork {
  name: string;
  properties: XmlProperty[];
  variables: XmlBifVariable[];
  definitions: XmlBifDefinition[];
}
export interface XmlBifFile {
  version: string;
  networks: XmlBifNetwork[];
}
export interface NetworkEdge {
  source: string;
  target: string;
}
export interface Position {
  x: number;
  y: number;
}

const NUMBER_PATTERN = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
const POSITION_PATTERN = new RegExp(
  `^\\s*position\\s*=\\s*\\(\\s*(${NUMBER_PATTERN})\\s*,\\s*(${NUMBER_PATTERN})\\s*\\)\\s*$`,
);

export function findVariable(network: XmlBifNetwork, name: string): XmlBifVariable | undefined {
  return network.variables.find((variable) => variable.name === name);
}

export function findDefinition(
  network: XmlBifNetwork,
  childName: string,
): XmlBifDefinition | undefined {
  return network.definitions.find((definition) => definition.for === childName);
}

export function parentsOf(network: XmlBifNetwork, childName: string): string[] {
  return findDefinition(network, childName)?.given ?? [];
}

export function edgesOf(network: XmlBifNetwork): NetworkEdge[] {
  return network.definitions.flatMap((definition) =>
    definition.given.map((parent) => ({ source: parent, target: definition.for })),
  );
}

export function cardinality(network: XmlBifNetwork, variableName: string): number | undefined {
  return findVariable(network, variableName)?.outcomes.length;
}

export function parentConfigurationCount(
  network: XmlBifNetwork,
  definition: XmlBifDefinition,
): number | undefined {
  let count = 1;
  for (const parentName of definition.given) {
    const value = cardinality(network, parentName);
    if (value === undefined) return undefined;
    count *= value;
  }
  return count;
}

export function tableAxisNames(
  network: XmlBifNetwork,
  definition: XmlBifDefinition,
): string[] | undefined {
  const child = findVariable(network, definition.for);
  if (!child) return undefined;
  return child.type === "utility" ? [...definition.given] : [...definition.given, definition.for];
}

export function tableAxisCardinalities(
  network: XmlBifNetwork,
  definition: XmlBifDefinition,
): number[] | undefined {
  const names = tableAxisNames(network, definition);
  if (!names) return undefined;
  const values: number[] = [];
  for (const name of names) {
    const value = cardinality(network, name);
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values;
}

export function expectedTableLength(
  network: XmlBifNetwork,
  definition: XmlBifDefinition,
): number | undefined {
  return tableAxisCardinalities(network, definition)?.reduce((length, value) => length * value, 1);
}

export function parsePositionProperty(text: string): Position | null {
  const match = POSITION_PATTERN.exec(text);
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

export function formatPositionProperty(position: Position): string {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new RangeError("Position coordinates must be finite numbers");
  }
  return `position = (${String(position.x)}, ${String(position.y)})`;
}
