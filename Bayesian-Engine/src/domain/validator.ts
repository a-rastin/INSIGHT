import type { Diagnostic } from "./diagnostics";
import {
  cardinality,
  expectedTableLength,
  parentConfigurationCount,
  type XmlBifDefinition,
  type XmlBifFile,
  type XmlBifNetwork,
} from "./model";

export const EDITOR_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const PROBABILITY_TOLERANCE = 1e-9;

export type DistributionVisitor = (
  values: readonly number[],
  parentStateIndexes: readonly number[],
  parentConfigurationIndex: number,
) => void;

function parentStateIndexesFor(
  configurationIndex: number,
  parentCardinalities: readonly number[],
): number[] {
  const indexes = new Array<number>(parentCardinalities.length);
  let remainder = configurationIndex;

  for (let index = parentCardinalities.length - 1; index >= 0; index -= 1) {
    const parentCardinality = parentCardinalities[index];
    indexes[index] = remainder % parentCardinality;
    remainder = Math.floor(remainder / parentCardinality);
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
  const parentCardinalities = definition.given.map((parent) =>
    cardinality(network, parent),
  );

  if (
    childCardinality === undefined ||
    childCardinality === 0 ||
    configurationCount === undefined ||
    expectedLength === undefined ||
    parentCardinalities.some(
      (parentCardinality) =>
        parentCardinality === undefined || parentCardinality === 0,
    )
  ) {
    throw new RangeError("CPT dimensions cannot be resolved");
  }
  if (definition.table.length !== expectedLength) {
    throw new RangeError(
      `CPT has ${definition.table.length} values; expected ${expectedLength}`,
    );
  }

  for (
    let configurationIndex = 0;
    configurationIndex < configurationCount;
    configurationIndex += 1
  ) {
    const start = configurationIndex * childCardinality;
    visit(
      definition.table.slice(start, start + childCardinality),
      parentStateIndexesFor(
        configurationIndex,
        parentCardinalities as number[],
      ),
      configurationIndex,
    );
  }
}

function hasCycle(network: XmlBifNetwork, variableNames: Set<string>): boolean {
  const children = new Map<string, Set<string>>();
  const indegree = new Map([...variableNames].map((name) => [name, 0]));

  for (const definition of network.definitions) {
    if (!variableNames.has(definition.for)) continue;

    for (const parent of definition.given) {
      if (!variableNames.has(parent) || parent === definition.for) continue;
      const targets = children.get(parent) ?? new Set<string>();
      if (targets.has(definition.for)) continue;
      targets.add(definition.for);
      children.set(parent, targets);
      indegree.set(definition.for, (indegree.get(definition.for) ?? 0) + 1);
    }
  }

  const queue = [...indegree]
    .filter(([, count]) => count === 0)
    .map(([name]) => name);
  let visited = 0;

  for (let index = 0; index < queue.length; index += 1) {
    const name = queue[index];
    visited += 1;
    for (const child of children.get(name) ?? []) {
      const remaining = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, remaining);
      if (remaining === 0) queue.push(child);
    }
  }

  return visited !== variableNames.size;
}

function validateNetwork(
  network: XmlBifNetwork,
  networkIndex: number,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const variableNames = new Set<string>();
  const definitionCounts = new Map<string, number>();
  const seenEdges = new Set<string>();

  if (network.name.trim() === "") {
    diagnostics.push({
      code: "BLANK_NETWORK_NAME",
      severity: "error",
      category: "structure",
      message: "Network name must not be blank",
      networkIndex,
    });
  }

  for (const variable of network.variables) {
    if (variable.name.trim() === "") {
      diagnostics.push({
        code: "BLANK_VARIABLE_NAME",
        severity: "error",
        category: "structure",
        message: "Variable name must not be blank",
        networkIndex,
        variableName: variable.name,
      });
    } else if (!EDITOR_IDENTIFIER_PATTERN.test(variable.name)) {
      diagnostics.push({
        code: "LEGACY_IDENTIFIER",
        severity: "warning",
        category: "compatibility",
        message: `Variable name is not a valid editor identifier: ${variable.name}`,
        networkIndex,
        variableName: variable.name,
      });
    }

    if (variableNames.has(variable.name)) {
      diagnostics.push({
        code: "DUPLICATE_VARIABLE_NAME",
        severity: "error",
        category: "structure",
        message: `Duplicate variable name: ${variable.name}`,
        networkIndex,
        variableName: variable.name,
      });
    }
    variableNames.add(variable.name);

    if (variable.type === "nature" && variable.outcomes.length === 0) {
      diagnostics.push({
        code: "NATURE_WITHOUT_OUTCOMES",
        severity: "error",
        category: "structure",
        message: `Nature variable has no outcomes: ${variable.name}`,
        networkIndex,
        variableName: variable.name,
      });
    }
    if (variable.type === "decision" && variable.outcomes.length === 0) {
      diagnostics.push({
        code: "DECISION_WITHOUT_OUTCOMES",
        severity: "error",
        category: "structure",
        message: `Decision variable has no outcomes: ${variable.name}`,
        networkIndex,
        variableName: variable.name,
      });
    }
    if (variable.type === "utility" && variable.outcomes.length > 0) {
      diagnostics.push({
        code: "UTILITY_WITH_OUTCOMES",
        severity: "error",
        category: "structure",
        message: `Utility variable must not have outcomes: ${variable.name}`,
        networkIndex,
        variableName: variable.name,
      });
    }

    const outcomes = new Set<string>();
    for (const outcome of variable.outcomes) {
      if (outcomes.has(outcome)) {
        diagnostics.push({
          code: "DUPLICATE_OUTCOME",
          severity: "warning",
          category: "compatibility",
          message: `Variable has duplicate outcome label: ${outcome}`,
          networkIndex,
          variableName: variable.name,
        });
      }
      outcomes.add(outcome);
    }
  }

  for (const definition of network.definitions) {
    const count = (definitionCounts.get(definition.for) ?? 0) + 1;
    definitionCounts.set(definition.for, count);
    if (count > 1) {
      diagnostics.push({
        code: "DUPLICATE_DEFINITION",
        severity: "error",
        category: "structure",
        message: `Multiple definitions target variable: ${definition.for}`,
        networkIndex,
        definitionFor: definition.for,
      });
    }

    if (!variableNames.has(definition.for)) {
      diagnostics.push({
        code: "UNKNOWN_DEFINITION_TARGET",
        severity: "error",
        category: "reference",
        message: `Definition target does not reference a variable: ${definition.for}`,
        networkIndex,
        definitionFor: definition.for,
      });
    }

    const parents = new Set<string>();
    for (const parent of definition.given) {
      if (!variableNames.has(parent)) {
        diagnostics.push({
          code: "UNKNOWN_PARENT",
          severity: "error",
          category: "reference",
          message: `Parent does not reference a variable: ${parent}`,
          networkIndex,
          definitionFor: definition.for,
        });
      }
      if (
        network.variables.some(
          (variable) => variable.name === parent && variable.type === "utility",
        )
      ) {
        diagnostics.push({
          code: "UTILITY_CANNOT_BE_PARENT",
          severity: "error",
          category: "structure",
          message: `Utility variable cannot be a parent: ${parent}`,
          networkIndex,
          variableName: parent,
          definitionFor: definition.for,
        });
      }
      if (parents.has(parent)) {
        diagnostics.push({
          code: "DUPLICATE_PARENT",
          severity: "error",
          category: "structure",
          message: `Definition repeats parent: ${parent}`,
          networkIndex,
          definitionFor: definition.for,
        });
      }
      parents.add(parent);

      if (parent === definition.for) {
        diagnostics.push({
          code: "SELF_PARENT",
          severity: "error",
          category: "structure",
          message: `Variable cannot be its own parent: ${definition.for}`,
          networkIndex,
          definitionFor: definition.for,
        });
      }

      const edgeKey = JSON.stringify([parent, definition.for]);
      if (seenEdges.has(edgeKey)) {
        diagnostics.push({
          code: "DUPLICATE_EDGE",
          severity: "error",
          category: "structure",
          message: `Duplicate edge: ${parent} -> ${definition.for}`,
          networkIndex,
          definitionFor: definition.for,
        });
      }
      seenEdges.add(edgeKey);
    }
  }

  for (const variable of network.variables) {
    if (
      variable.type === "nature" &&
      (definitionCounts.get(variable.name) ?? 0) === 0
    ) {
      diagnostics.push({
        code: "MISSING_NATURE_DEFINITION",
        severity: "error",
        category: "structure",
        message: `Nature variable has no definition: ${variable.name}`,
        networkIndex,
        variableName: variable.name,
      });
    }
  }

  if (hasCycle(network, variableNames)) {
    diagnostics.push({
      code: "GRAPH_CYCLE",
      severity: "error",
      category: "structure",
      message: "Network graph contains a cycle",
      networkIndex,
    });
  }

  return diagnostics;
}

function validateNetworkRawTables(
  network: XmlBifNetwork,
  networkIndex: number,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const variable of network.variables) {
    if (variable.type === "nature") continue;
    if (
      network.variables.filter(({ name }) => name === variable.name).length !==
      1
    ) {
      continue;
    }

    const definitions = network.definitions.filter(
      (definition) => definition.for === variable.name,
    );
    if (definitions.length !== 1) continue;

    const definition = definitions[0];
    const parents = new Set(definition.given);
    const dimensionsResolvable =
      parents.size === definition.given.length &&
      !parents.has(variable.name) &&
      definition.given.every(
        (parent) =>
          network.variables.filter(({ name }) => name === parent).length ===
            1 && (cardinality(network, parent) ?? 0) > 0,
      );
    if (!dimensionsResolvable) continue;

    const expectedLength = expectedTableLength(network, definition);
    if (expectedLength === undefined) continue;

    const definitionIndex = network.definitions.indexOf(definition);
    const path = `networks[${networkIndex}].definitions[${definitionIndex}].table`;
    const common = {
      severity: "error" as const,
      category: "value" as const,
      networkIndex,
      variableName: variable.name,
      definitionFor: definition.for,
    };

    if (definition.table.length !== expectedLength) {
      diagnostics.push({
        ...common,
        code:
          variable.type === "decision"
            ? "DECISION_TABLE_LENGTH"
            : "UTILITY_TABLE_LENGTH",
        message: `${variable.type === "decision" ? "Decision" : "Utility"} table for ${definition.for} has ${definition.table.length} values; expected ${expectedLength}`,
        path,
      });
      continue;
    }

    definition.table.forEach((value, tableIndex) => {
      if (Number.isFinite(value)) return;
      diagnostics.push({
        ...common,
        code: "TABLE_VALUE_NON_FINITE",
        message: `Table for ${definition.for} contains a non-finite value`,
        tableIndex,
        path: `${path}[${tableIndex}]`,
      });
    });
  }

  return diagnostics;
}

export function validateStructure(file: XmlBifFile): Diagnostic[] {
  return file.networks.flatMap(validateNetwork);
}

export function validateRawTables(file: XmlBifFile): Diagnostic[] {
  return file.networks.flatMap(validateNetworkRawTables);
}

function validateNetworkProbabilities(
  network: XmlBifNetwork,
  networkIndex: number,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const variable of network.variables) {
    if (variable.type !== "nature" || variable.outcomes.length === 0) continue;
    if (
      network.variables.filter(({ name }) => name === variable.name).length !==
      1
    ) {
      continue;
    }

    const definitions = network.definitions.filter(
      (definition) => definition.for === variable.name,
    );
    if (definitions.length !== 1) continue;

    const definition = definitions[0];
    const parents = new Set(definition.given);
    const dimensionsResolvable =
      parents.size === definition.given.length &&
      !parents.has(variable.name) &&
      definition.given.every(
        (parent) =>
          network.variables.filter(({ name }) => name === parent).length ===
            1 && (cardinality(network, parent) ?? 0) > 0,
      );
    if (!dimensionsResolvable) continue;

    const expectedLength = expectedTableLength(network, definition);
    const definitionIndex = network.definitions.indexOf(definition);
    const path = `networks[${networkIndex}].definitions[${definitionIndex}].table`;
    const common = {
      severity: "error" as const,
      category: "probability" as const,
      networkIndex,
      variableName: variable.name,
      definitionFor: definition.for,
    };

    if (expectedLength === undefined) continue;
    if (definition.table.length === 0 && expectedLength > 0) {
      diagnostics.push({
        ...common,
        code: "CPT_TABLE_EMPTY",
        message: `CPT for ${definition.for} is empty; expected ${expectedLength} values`,
        path,
      });
      continue;
    }
    if (definition.table.length !== expectedLength) {
      diagnostics.push({
        ...common,
        code: "CPT_TABLE_LENGTH",
        message: `CPT for ${definition.for} has ${definition.table.length} values; expected ${expectedLength}`,
        path,
      });
      continue;
    }

    forEachDistribution(
      network,
      definition,
      (values, _parentStateIndexes, parentConfigurationIndex) => {
        let sum = 0;
        let allFinite = true;

        values.forEach((value, childStateIndex) => {
          const tableIndex =
            parentConfigurationIndex * variable.outcomes.length +
            childStateIndex;
          const valuePath = `${path}[${tableIndex}]`;

          if (!Number.isFinite(value)) {
            allFinite = false;
            diagnostics.push({
              ...common,
              code: "CPT_VALUE_NON_FINITE",
              message: `CPT for ${definition.for} contains a non-finite value`,
              parentConfigurationIndex,
              tableIndex,
              path: valuePath,
            });
            return;
          }

          sum += value;
          if (value < 0) {
            diagnostics.push({
              ...common,
              code: "CPT_VALUE_NEGATIVE",
              message: `CPT for ${definition.for} contains a negative value: ${value}`,
              parentConfigurationIndex,
              tableIndex,
              path: valuePath,
            });
          }
          if (value > 1 + PROBABILITY_TOLERANCE) {
            diagnostics.push({
              ...common,
              code: "CPT_VALUE_ABOVE_ONE",
              message: `CPT for ${definition.for} contains a value above 1: ${value}`,
              parentConfigurationIndex,
              tableIndex,
              path: valuePath,
            });
          }
        });

        if (allFinite && Math.abs(sum - 1) > PROBABILITY_TOLERANCE) {
          diagnostics.push({
            ...common,
            code: "CPT_DISTRIBUTION_NOT_NORMALIZED",
            message: `CPT distribution for ${definition.for} sums to ${sum}, not 1`,
            parentConfigurationIndex,
            path,
          });
        }
      },
    );
  }

  return diagnostics;
}

export function validateProbabilities(file: XmlBifFile): Diagnostic[] {
  return file.networks.flatMap(validateNetworkProbabilities);
}

export function validateFile(file: XmlBifFile): Diagnostic[] {
  return [
    ...validateStructure(file),
    ...validateProbabilities(file),
    ...validateRawTables(file),
  ];
}

export function hasBlockingStructuralErrors(
  diagnostics: Diagnostic[],
): boolean {
  return diagnostics.some(
    ({ severity, category }) =>
      severity === "error" &&
      (category === "structure" || category === "reference"),
  );
}
