import type { Diagnostic } from "./diagnostics.js";
import {
  cardinality,
  expectedTableLength,
  parentConfigurationCount,
  type XmlBifDefinition,
  type XmlBifFile,
  type XmlBifNetwork,
  type XmlBifVariable,
} from "./model.js";

export const EDITOR_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const PROBABILITY_TOLERANCE = 1e-9;
export type DistributionVisitor = (
  values: readonly number[],
  parentStateIndexes: readonly number[],
  parentConfigurationIndex: number,
) => void;

function parentStateIndexesFor(index: number, cardinalities: readonly number[]): number[] {
  const indexes = new Array<number>(cardinalities.length);
  let remainder = index;
  for (let axis = cardinalities.length - 1; axis >= 0; axis -= 1) {
    indexes[axis] = remainder % cardinalities[axis];
    remainder = Math.floor(remainder / cardinalities[axis]);
  }
  return indexes;
}

export function forEachDistribution(
  network: XmlBifNetwork,
  definition: XmlBifDefinition,
  visit: DistributionVisitor,
): void {
  const childCardinality = cardinality(network, definition.for);
  const configurationCount = parentConfigurationCount(network, definition);
  const expectedLength = expectedTableLength(network, definition);
  const parentCardinalities = definition.given.map((parent) => cardinality(network, parent));
  if (
    !childCardinality ||
    configurationCount === undefined ||
    expectedLength === undefined ||
    parentCardinalities.some((value) => !value)
  )
    throw new RangeError("CPT dimensions cannot be resolved");
  if (definition.table.length !== expectedLength) {
    throw new RangeError(`CPT has ${definition.table.length} values; expected ${expectedLength}`);
  }
  for (let index = 0; index < configurationCount; index += 1) {
    const start = index * childCardinality;
    visit(
      definition.table.slice(start, start + childCardinality),
      parentStateIndexesFor(index, parentCardinalities as number[]),
      index,
    );
  }
}

function diagnostic(
  code: string,
  category: Diagnostic["category"],
  message: string,
  networkIndex: number,
  fields: Partial<Diagnostic> = {},
  severity: Diagnostic["severity"] = "error",
): Diagnostic {
  return { code, severity, category, message, networkIndex, ...fields };
}

function hasCycle(network: XmlBifNetwork, names: Set<string>): boolean {
  const children = new Map<string, Set<string>>();
  const indegree = new Map([...names].map((name) => [name, 0]));
  for (const definition of network.definitions) {
    if (!names.has(definition.for)) continue;
    for (const parent of definition.given) {
      if (!names.has(parent) || parent === definition.for) continue;
      const targets = children.get(parent) ?? new Set<string>();
      if (targets.has(definition.for)) continue;
      targets.add(definition.for);
      children.set(parent, targets);
      indegree.set(definition.for, (indegree.get(definition.for) ?? 0) + 1);
    }
  }
  const queue = [...indegree].filter(([, count]) => count === 0).map(([name]) => name);
  let visited = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const name = queue[index];
    visited += 1;
    for (const child of children.get(name) ?? []) {
      const count = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, count);
      if (count === 0) queue.push(child);
    }
  }
  return visited !== names.size;
}

function validateNetwork(network: XmlBifNetwork, networkIndex: number): Diagnostic[] {
  const result: Diagnostic[] = [];
  const names = new Set<string>();
  const definitionCounts = new Map<string, number>();
  const seenEdges = new Set<string>();
  if (!network.name.trim()) {
    result.push(
      diagnostic("BLANK_NETWORK_NAME", "structure", "Network name must not be blank", networkIndex),
    );
  }
  for (const variable of network.variables) {
    const field = { variableName: variable.name };
    if (!variable.name.trim()) {
      result.push(
        diagnostic(
          "BLANK_VARIABLE_NAME",
          "structure",
          "Variable name must not be blank",
          networkIndex,
          field,
        ),
      );
    } else if (!EDITOR_IDENTIFIER_PATTERN.test(variable.name)) {
      result.push(
        diagnostic(
          "LEGACY_IDENTIFIER",
          "compatibility",
          `Variable name is not a valid editor identifier: ${variable.name}`,
          networkIndex,
          field,
          "warning",
        ),
      );
    }
    if (names.has(variable.name)) {
      result.push(
        diagnostic(
          "DUPLICATE_VARIABLE_NAME",
          "structure",
          `Duplicate variable name: ${variable.name}`,
          networkIndex,
          field,
        ),
      );
    }
    names.add(variable.name);
    if (variable.type === "nature" && variable.outcomes.length === 0) {
      result.push(
        diagnostic(
          "NATURE_WITHOUT_OUTCOMES",
          "structure",
          `Nature variable has no outcomes: ${variable.name}`,
          networkIndex,
          field,
        ),
      );
    }
    if (variable.type === "decision" && variable.outcomes.length === 0) {
      result.push(
        diagnostic(
          "DECISION_WITHOUT_OUTCOMES",
          "structure",
          `Decision variable has no outcomes: ${variable.name}`,
          networkIndex,
          field,
        ),
      );
    }
    if (variable.type === "utility" && variable.outcomes.length > 0) {
      result.push(
        diagnostic(
          "UTILITY_WITH_OUTCOMES",
          "structure",
          `Utility variable must not have outcomes: ${variable.name}`,
          networkIndex,
          field,
        ),
      );
    }
    const outcomes = new Set<string>();
    for (const outcome of variable.outcomes) {
      if (outcomes.has(outcome)) {
        result.push(
          diagnostic(
            "DUPLICATE_OUTCOME",
            "compatibility",
            `Variable has duplicate outcome label: ${outcome}`,
            networkIndex,
            field,
            "warning",
          ),
        );
      }
      outcomes.add(outcome);
    }
  }
  for (const definition of network.definitions) {
    const field = { definitionFor: definition.for };
    const count = (definitionCounts.get(definition.for) ?? 0) + 1;
    definitionCounts.set(definition.for, count);
    if (count > 1)
      result.push(
        diagnostic(
          "DUPLICATE_DEFINITION",
          "structure",
          `Multiple definitions target variable: ${definition.for}`,
          networkIndex,
          field,
        ),
      );
    if (!names.has(definition.for))
      result.push(
        diagnostic(
          "UNKNOWN_DEFINITION_TARGET",
          "reference",
          `Definition target does not reference a variable: ${definition.for}`,
          networkIndex,
          field,
        ),
      );
    const parents = new Set<string>();
    for (const parent of definition.given) {
      if (!names.has(parent))
        result.push(
          diagnostic(
            "UNKNOWN_PARENT",
            "reference",
            `Parent does not reference a variable: ${parent}`,
            networkIndex,
            field,
          ),
        );
      if (
        network.variables.some(
          (variable) => variable.name === parent && variable.type === "utility",
        )
      ) {
        result.push(
          diagnostic(
            "UTILITY_CANNOT_BE_PARENT",
            "structure",
            `Utility variable cannot be a parent: ${parent}`,
            networkIndex,
            { ...field, variableName: parent },
          ),
        );
      }
      if (parents.has(parent))
        result.push(
          diagnostic(
            "DUPLICATE_PARENT",
            "structure",
            `Definition repeats parent: ${parent}`,
            networkIndex,
            field,
          ),
        );
      parents.add(parent);
      if (parent === definition.for)
        result.push(
          diagnostic(
            "SELF_PARENT",
            "structure",
            `Variable cannot be its own parent: ${definition.for}`,
            networkIndex,
            field,
          ),
        );
      const edge = JSON.stringify([parent, definition.for]);
      if (seenEdges.has(edge))
        result.push(
          diagnostic(
            "DUPLICATE_EDGE",
            "structure",
            `Duplicate edge: ${parent} -> ${definition.for}`,
            networkIndex,
            field,
          ),
        );
      seenEdges.add(edge);
    }
  }
  for (const variable of network.variables) {
    if (variable.type === "nature" && (definitionCounts.get(variable.name) ?? 0) === 0) {
      result.push(
        diagnostic(
          "MISSING_NATURE_DEFINITION",
          "structure",
          `Nature variable has no definition: ${variable.name}`,
          networkIndex,
          { variableName: variable.name },
        ),
      );
    }
  }
  if (hasCycle(network, names))
    result.push(
      diagnostic("GRAPH_CYCLE", "structure", "Network graph contains a cycle", networkIndex),
    );
  return result;
}

function uniqueVariable(network: XmlBifNetwork, name: string): XmlBifVariable | undefined {
  const matches = network.variables.filter((variable) => variable.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function resolvableDefinition(
  network: XmlBifNetwork,
  variable: XmlBifVariable,
): XmlBifDefinition | undefined {
  const definitions = network.definitions.filter((definition) => definition.for === variable.name);
  if (uniqueVariable(network, variable.name) !== variable || definitions.length !== 1)
    return undefined;
  const definition = definitions[0];
  const parents = new Set(definition.given);
  if (
    parents.size !== definition.given.length ||
    parents.has(variable.name) ||
    definition.given.some(
      (parent) => !uniqueVariable(network, parent) || !cardinality(network, parent),
    )
  )
    return undefined;
  return definition;
}

export function validateStructure(file: XmlBifFile): Diagnostic[] {
  return file.networks.flatMap(validateNetwork);
}

export function validateRawTables(file: XmlBifFile): Diagnostic[] {
  return file.networks.flatMap((network, networkIndex) =>
    network.variables.flatMap((variable) => {
      if (variable.type === "nature") return [];
      const definition = resolvableDefinition(network, variable);
      if (!definition) return [];
      const expected = expectedTableLength(network, definition);
      if (expected === undefined) return [];
      const definitionIndex = network.definitions.indexOf(definition);
      const path = `networks[${networkIndex}].definitions[${definitionIndex}].table`;
      const fields = { variableName: variable.name, definitionFor: definition.for, path };
      if (definition.table.length !== expected)
        return [
          diagnostic(
            variable.type === "decision" ? "DECISION_TABLE_LENGTH" : "UTILITY_TABLE_LENGTH",
            "value",
            `${variable.type === "decision" ? "Decision" : "Utility"} table for ${definition.for} has ${definition.table.length} values; expected ${expected}`,
            networkIndex,
            fields,
          ),
        ];
      return definition.table.flatMap((value, tableIndex) =>
        Number.isFinite(value)
          ? []
          : [
              diagnostic(
                "TABLE_VALUE_NON_FINITE",
                "value",
                `Table for ${definition.for} contains a non-finite value`,
                networkIndex,
                { ...fields, tableIndex, path: `${path}[${tableIndex}]` },
              ),
            ],
      );
    }),
  );
}

export function validateProbabilities(file: XmlBifFile): Diagnostic[] {
  return file.networks.flatMap((network, networkIndex) =>
    network.variables.flatMap((variable) => {
      if (variable.type !== "nature" || variable.outcomes.length === 0) return [];
      const definition = resolvableDefinition(network, variable);
      if (!definition) return [];
      const expected = expectedTableLength(network, definition);
      if (expected === undefined) return [];
      const definitionIndex = network.definitions.indexOf(definition);
      const path = `networks[${networkIndex}].definitions[${definitionIndex}].table`;
      const fields = { variableName: variable.name, definitionFor: definition.for, path };
      if (definition.table.length === 0 && expected > 0)
        return [
          diagnostic(
            "CPT_TABLE_EMPTY",
            "probability",
            `CPT for ${definition.for} is empty; expected ${expected} values`,
            networkIndex,
            fields,
          ),
        ];
      if (definition.table.length !== expected)
        return [
          diagnostic(
            "CPT_TABLE_LENGTH",
            "probability",
            `CPT for ${definition.for} has ${definition.table.length} values; expected ${expected}`,
            networkIndex,
            fields,
          ),
        ];
      const result: Diagnostic[] = [];
      forEachDistribution(network, definition, (values, _parents, parentConfigurationIndex) => {
        let sum = 0;
        let allFinite = true;
        values.forEach((value, childStateIndex) => {
          const tableIndex = parentConfigurationIndex * variable.outcomes.length + childStateIndex;
          const valueFields = {
            ...fields,
            parentConfigurationIndex,
            tableIndex,
            path: `${path}[${tableIndex}]`,
          };
          if (!Number.isFinite(value)) {
            allFinite = false;
            result.push(
              diagnostic(
                "CPT_VALUE_NON_FINITE",
                "probability",
                `CPT for ${definition.for} contains a non-finite value`,
                networkIndex,
                valueFields,
              ),
            );
            return;
          }
          sum += value;
          if (value < 0)
            result.push(
              diagnostic(
                "CPT_VALUE_NEGATIVE",
                "probability",
                `CPT for ${definition.for} contains a negative value: ${value}`,
                networkIndex,
                valueFields,
              ),
            );
          if (value > 1 + PROBABILITY_TOLERANCE)
            result.push(
              diagnostic(
                "CPT_VALUE_ABOVE_ONE",
                "probability",
                `CPT for ${definition.for} contains a value above 1: ${value}`,
                networkIndex,
                valueFields,
              ),
            );
        });
        if (allFinite && Math.abs(sum - 1) > PROBABILITY_TOLERANCE) {
          result.push(
            diagnostic(
              "CPT_DISTRIBUTION_NOT_NORMALIZED",
              "probability",
              `CPT distribution for ${definition.for} sums to ${sum}, not 1`,
              networkIndex,
              { ...fields, parentConfigurationIndex },
            ),
          );
        }
      });
      return result;
    }),
  );
}

export function validateFile(file: XmlBifFile): Diagnostic[] {
  return [...validateStructure(file), ...validateProbabilities(file), ...validateRawTables(file)];
}

export function hasBlockingStructuralErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some(
    ({ severity, category }) =>
      severity === "error" && (category === "structure" || category === "reference"),
  );
}
