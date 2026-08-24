import {
  coordinatesToFlatIndex,
  flatIndexToCoordinates,
  insertAxis,
  insertAxisState,
  permuteAxisStates,
  product,
  removeAxisIfLossless,
  removeAxisState,
} from "./cptTensor.js";
import type { Diagnostic } from "./diagnostics.js";
import {
  cardinality,
  findVariable,
  formatPositionProperty,
  parsePositionProperty,
  tableAxisCardinalities,
  type Position,
  type VariableType,
  type XmlBifNetwork,
} from "./model.js";
import { EDITOR_IDENTIFIER_PATTERN, PROBABILITY_TOLERANCE, validateFile } from "./validator.js";

export interface MutationSuccess<T> {
  readonly ok: true;
  readonly value: T;
  readonly warnings: readonly Diagnostic[];
}

export interface MutationFailure {
  readonly ok: false;
  readonly diagnostics: readonly Diagnostic[];
}

export type MutationResult<T> = MutationSuccess<T> | MutationFailure;

export interface DestructiveMutationOptions {
  readonly allowDataLoss?: boolean;
}

function diagnostic(
  code: string,
  message: string,
  category: Diagnostic["category"] = "structure",
  severity: Diagnostic["severity"] = "error",
): Diagnostic {
  return { code, severity, category, message };
}

function validateMutation(
  network: XmlBifNetwork,
  warnings: readonly Diagnostic[] = [],
): MutationResult<XmlBifNetwork> {
  const diagnostics = validateFile({ version: "0.3", networks: [network] });
  const errors = diagnostics.filter(({ severity }) => severity === "error");
  return errors.length
    ? { ok: false, diagnostics: errors }
    : {
        ok: true,
        value: network,
        warnings: [...warnings, ...diagnostics.filter(({ severity }) => severity === "warning")],
      };
}

function variableNotFound(name: string): MutationFailure {
  return {
    ok: false,
    diagnostics: [
      diagnostic("VARIABLE_NOT_FOUND", `Variable does not exist: ${name}`, "reference"),
    ],
  };
}

function validInput(network: XmlBifNetwork): MutationFailure | null {
  const diagnostics = validateFile({ version: "0.3", networks: [network] }).filter(
    ({ severity }) => severity === "error",
  );
  return diagnostics.length ? { ok: false, diagnostics } : null;
}

function validateNewName(network: XmlBifNetwork, name: string): MutationFailure | null {
  if (!EDITOR_IDENTIFIER_PATTERN.test(name)) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "INVALID_VARIABLE_IDENTIFIER",
          `Variable name is not a valid editor identifier: ${name}`,
        ),
      ],
    };
  }
  if (network.variables.some((variable) => variable.name === name)) {
    return {
      ok: false,
      diagnostics: [diagnostic("DUPLICATE_VARIABLE_NAME", `Duplicate variable name: ${name}`)],
    };
  }
  return null;
}

function definitionCardinalities(
  network: XmlBifNetwork,
  definition: XmlBifNetwork["definitions"][number],
): number[] {
  return tableAxisCardinalities(network, definition) as number[];
}

function outcomeEditFailure(network: XmlBifNetwork, variableName: string): MutationFailure | null {
  return findVariable(network, variableName)?.type === "utility"
    ? {
        ok: false,
        diagnostics: [
          diagnostic(
            "UNSUPPORTED_OUTCOME_EDIT",
            `Utility variable cannot have outcomes: ${variableName}`,
            "compatibility",
          ),
        ],
      }
    : null;
}

function outcomeIndexFailure(
  index: number,
  allowEnd: boolean,
  outcomeCount: number,
): MutationFailure | null {
  const upperBound = allowEnd ? outcomeCount : outcomeCount - 1;
  return Number.isInteger(index) && index >= 0 && index <= upperBound
    ? null
    : {
        ok: false,
        diagnostics: [
          diagnostic("OUTCOME_INDEX_OUT_OF_BOUNDS", `Outcome index is out of bounds: ${index}`),
        ],
      };
}

function hasNonzeroAxisState(
  values: readonly number[],
  cardinalities: readonly number[],
  axisIndex: number,
  stateIndex: number,
): boolean {
  return values.some(
    (value, flatIndex) =>
      value !== 0 && flatIndexToCoordinates(flatIndex, cardinalities)[axisIndex] === stateIndex,
  );
}

function nextNodeName(network: XmlBifNetwork): string {
  const names = new Set(network.variables.map(({ name }) => name));
  for (let index = 1; ; index += 1) {
    const name = `Node${index}`;
    if (!names.has(name)) return name;
  }
}

function resetWarning(definitionFor: string, message: string, raw: boolean): Diagnostic {
  return {
    code: raw ? "RAW_TABLE_RESET" : "CPT_RESET_PARENT_REMOVAL",
    severity: "warning",
    category: raw ? "value" : "probability",
    message,
    variableName: definitionFor,
    definitionFor,
  };
}

function confirmationRequired(definitions: readonly string[]): MutationFailure {
  return {
    ok: false,
    diagnostics: [
      diagnostic(
        "RAW_TABLE_RESET_CONFIRMATION_REQUIRED",
        `This change will reset raw table values to zero: ${definitions.join(", ")}`,
        "value",
        "warning",
      ),
    ],
  };
}

export function addVariable(
  network: XmlBifNetwork,
  type: VariableType,
  requestedName?: string,
  position?: Position,
): MutationResult<XmlBifNetwork> {
  const inputFailure = validInput(network);
  if (inputFailure) return inputFailure;
  const name = requestedName ?? nextNodeName(network);
  const nameFailure = validateNewName(network, name);
  if (nameFailure) return nameFailure;
  if (position && (!Number.isFinite(position.x) || !Number.isFinite(position.y))) {
    return { ok: false, diagnostics: [diagnostic("INVALID_POSITION", "Position must be finite")] };
  }
  return validateMutation({
    ...network,
    variables: [
      ...network.variables,
      {
        name,
        type,
        outcomes: type === "utility" ? [] : ["State0", "State1"],
        properties: position ? [{ text: formatPositionProperty(position) }] : [],
      },
    ],
    definitions: [
      ...network.definitions,
      {
        for: name,
        given: [],
        table: type === "nature" ? [0.5, 0.5] : type === "decision" ? [0, 0] : [0],
        properties: [],
      },
    ],
  });
}

export function addNatureVariable(
  network: XmlBifNetwork,
  requestedName?: string,
  position?: Position,
): MutationResult<XmlBifNetwork> {
  return addVariable(network, "nature", requestedName, position);
}

export function renameOutcome(
  network: XmlBifNetwork,
  variableName: string,
  outcomeIndex: number,
  name: string,
): MutationResult<XmlBifNetwork> {
  const variable = findVariable(network, variableName);
  if (!variable) return variableNotFound(variableName);
  const editFailure = outcomeEditFailure(network, variableName);
  if (editFailure) return editFailure;
  const indexFailure = outcomeIndexFailure(outcomeIndex, false, variable.outcomes.length);
  if (indexFailure) return indexFailure;
  return validateMutation({
    ...network,
    variables: network.variables.map((current) =>
      current === variable
        ? {
            ...current,
            outcomes: current.outcomes.map((outcome, index) =>
              index === outcomeIndex ? name : outcome,
            ),
          }
        : current,
    ),
  });
}

export function reorderOutcomes(
  network: XmlBifNetwork,
  variableName: string,
  newOrder: readonly number[],
): MutationResult<XmlBifNetwork> {
  const variable = findVariable(network, variableName);
  if (!variable) return variableNotFound(variableName);
  const editFailure = outcomeEditFailure(network, variableName);
  if (editFailure) return editFailure;
  const inputFailure = validInput(network);
  if (inputFailure) return inputFailure;
  if (
    newOrder.length !== variable.outcomes.length ||
    newOrder.some(
      (index) => !Number.isInteger(index) || index < 0 || index >= variable.outcomes.length,
    ) ||
    new Set(newOrder).size !== variable.outcomes.length
  ) {
    return {
      ok: false,
      diagnostics: [diagnostic("INVALID_OUTCOME_ORDER", "Invalid outcome order")],
    };
  }
  return validateMutation({
    ...network,
    variables: network.variables.map((current) =>
      current === variable
        ? { ...current, outcomes: newOrder.map((index) => current.outcomes[index]!) }
        : current,
    ),
    definitions: network.definitions.map((definition) => {
      const axisIndex =
        definition.for === variableName
          ? definition.given.length
          : definition.given.indexOf(variableName);
      return axisIndex < 0
        ? definition
        : {
            ...definition,
            table: permuteAxisStates(
              definition.table,
              definitionCardinalities(network, definition),
              axisIndex,
              newOrder,
            ),
          };
    }),
  });
}

export function addOutcome(
  network: XmlBifNetwork,
  variableName: string,
  outcomeName: string,
  insertIndex?: number,
): MutationResult<XmlBifNetwork> {
  const variable = findVariable(network, variableName);
  if (!variable) return variableNotFound(variableName);
  const editFailure = outcomeEditFailure(network, variableName);
  if (editFailure) return editFailure;
  const index = insertIndex ?? variable.outcomes.length;
  const indexFailure = outcomeIndexFailure(index, true, variable.outcomes.length);
  if (indexFailure) return indexFailure;
  const inputFailure = validInput(network);
  if (inputFailure) return inputFailure;
  const warnings: Diagnostic[] = [];
  const definitions = network.definitions.map((definition) => {
    const ownDefinition = definition.for === variableName;
    const axisIndex = ownDefinition
      ? definition.given.length
      : definition.given.indexOf(variableName);
    if (axisIndex < 0) return definition;
    const child = findVariable(network, definition.for)!;
    if (!ownDefinition && child.type === "nature") {
      warnings.push({
        code: "CPT_INITIALIZED_NEW_PARENT_STATE",
        severity: "warning",
        category: "probability",
        message: `CPT for ${definition.for} received a uniform slice for new ${variableName} outcome`,
        variableName: definition.for,
        definitionFor: definition.for,
      });
    }
    return {
      ...definition,
      table: insertAxisState(
        definition.table,
        definitionCardinalities(network, definition),
        axisIndex,
        index,
        () => (ownDefinition || child.type !== "nature" ? 0 : 1 / child.outcomes.length),
      ),
    };
  });
  return validateMutation(
    {
      ...network,
      variables: network.variables.map((current) =>
        current === variable
          ? {
              ...current,
              outcomes: [
                ...current.outcomes.slice(0, index),
                outcomeName,
                ...current.outcomes.slice(index),
              ],
            }
          : current,
      ),
      definitions,
    },
    warnings,
  );
}

export function removeOutcome(
  network: XmlBifNetwork,
  variableName: string,
  outcomeIndex: number,
  options: DestructiveMutationOptions = {},
): MutationResult<XmlBifNetwork> {
  const variable = findVariable(network, variableName);
  if (!variable) return variableNotFound(variableName);
  const editFailure = outcomeEditFailure(network, variableName);
  if (editFailure) return editFailure;
  const indexFailure = outcomeIndexFailure(outcomeIndex, false, variable.outcomes.length);
  if (indexFailure) return indexFailure;
  if (variable.outcomes.length === 1) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          variable.type === "decision" ? "DECISION_OUTCOME_REQUIRED" : "NATURE_OUTCOME_REQUIRED",
          `${variable.type === "decision" ? "Decision" : "Nature"} variable must keep at least one outcome: ${variableName}`,
        ),
      ],
    };
  }
  const inputFailure = validInput(network);
  if (inputFailure) return inputFailure;
  const rawTablesToReset = new Set(
    network.definitions.filter((definition) => {
      const child = findVariable(network, definition.for);
      if (!child || child.type === "nature") return false;
      const axisIndex =
        definition.for === variableName
          ? definition.given.length
          : definition.given.indexOf(variableName);
      return (
        axisIndex >= 0 &&
        hasNonzeroAxisState(
          definition.table,
          definitionCardinalities(network, definition),
          axisIndex,
          outcomeIndex,
        )
      );
    }),
  );
  if (rawTablesToReset.size > 0 && !options.allowDataLoss) {
    return confirmationRequired([...rawTablesToReset].map(({ for: name }) => name));
  }
  const warnings: Diagnostic[] = [];
  const definitions = network.definitions.map((definition) => {
    const ownDefinition = definition.for === variableName;
    const axisIndex = ownDefinition
      ? definition.given.length
      : definition.given.indexOf(variableName);
    if (axisIndex < 0) return definition;
    const cardinalities = definitionCardinalities(network, definition);
    let table = removeAxisState(definition.table, cardinalities, axisIndex, outcomeIndex);
    if (rawTablesToReset.has(definition)) {
      table = table.map(() => 0);
      warnings.push(
        resetWarning(
          definition.for,
          `Raw table for ${definition.for} was reset to zero after removing outcome ${variable.outcomes[outcomeIndex]} from ${variableName}`,
          true,
        ),
      );
    } else if (ownDefinition && variable.type === "nature") {
      const removedHasProbability = definition.table.some((value, flatIndex) => {
        const coordinates = flatIndexToCoordinates(flatIndex, cardinalities);
        return coordinates[axisIndex] === outcomeIndex && value > PROBABILITY_TOLERANCE;
      });
      if (removedHasProbability) {
        table = table.map(() => 1 / (variable.outcomes.length - 1));
        warnings.push({
          code: "CPT_RESET_CHILD_OUTCOME_REMOVAL",
          severity: "warning",
          category: "probability",
          message: `CPT for ${variableName} was reset after removing a nonzero outcome`,
          variableName,
          definitionFor: variableName,
        });
      }
    }
    return { ...definition, table };
  });
  return validateMutation(
    {
      ...network,
      variables: network.variables.map((current) =>
        current === variable
          ? {
              ...current,
              outcomes: current.outcomes.filter((_, index) => index !== outcomeIndex),
            }
          : current,
      ),
      definitions,
    },
    warnings,
  );
}

export function setCptDistribution(
  network: XmlBifNetwork,
  childName: string,
  parentStateIndexes: readonly number[],
  values: readonly number[],
): MutationResult<XmlBifNetwork> {
  const child = findVariable(network, childName);
  if (!child) return variableNotFound(childName);
  const definition = network.definitions.find(({ for: name }) => name === childName);
  if (child.type !== "nature" || !definition) {
    return {
      ok: false,
      diagnostics: [
        diagnostic("UNSUPPORTED_CPT_EDIT", `Cannot edit CPT for ${childName}`, "compatibility"),
      ],
    };
  }
  const cardinalities = definitionCardinalities(network, definition);
  if (
    definition.table.length !== product(cardinalities) ||
    parentStateIndexes.length !== definition.given.length ||
    parentStateIndexes.some(
      (state, axis) => !Number.isInteger(state) || state < 0 || state >= cardinalities[axis]!,
    )
  ) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "CPT_TABLE_LENGTH",
          `CPT dimensions are invalid for ${childName}`,
          "probability",
        ),
      ],
    };
  }
  const sum = values.reduce((total, value) => total + value, 0);
  if (
    values.length !== child.outcomes.length ||
    values.some(
      (value) => !Number.isFinite(value) || value < 0 || value > 1 + PROBABILITY_TOLERANCE,
    ) ||
    Math.abs(sum - 1) > PROBABILITY_TOLERANCE
  ) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "CPT_ROW_VALUES_INVALID",
          "CPT row must contain finite probabilities between 0 and 1 that sum to 1",
          "probability",
        ),
      ],
    };
  }
  const table = [...definition.table];
  values.forEach((value, childStateIndex) => {
    table[coordinatesToFlatIndex([...parentStateIndexes, childStateIndex], cardinalities)] = value;
  });
  return validateMutation({
    ...network,
    definitions: network.definitions.map((current) =>
      current === definition ? { ...current, table } : current,
    ),
  });
}

export function setRawTableRow(
  network: XmlBifNetwork,
  variableName: string,
  parentStateIndexes: readonly number[],
  values: readonly number[],
): MutationResult<XmlBifNetwork> {
  const variable = findVariable(network, variableName);
  if (!variable) return variableNotFound(variableName);
  const definition = network.definitions.find(({ for: name }) => name === variableName);
  if (variable.type === "nature" || !definition) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "UNSUPPORTED_RAW_TABLE_EDIT",
          `Cannot edit raw table for ${variableName}`,
          "compatibility",
        ),
      ],
    };
  }
  const cardinalities = definitionCardinalities(network, definition);
  const parentCardinalities = cardinalities.slice(0, definition.given.length);
  const valueCount = variable.type === "decision" ? variable.outcomes.length : 1;
  if (
    definition.table.length !== product(cardinalities) ||
    parentStateIndexes.length !== parentCardinalities.length ||
    parentStateIndexes.some(
      (state, axis) => !Number.isInteger(state) || state < 0 || state >= parentCardinalities[axis]!,
    ) ||
    values.length !== valueCount ||
    values.some((value) => !Number.isFinite(value))
  ) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "RAW_TABLE_ROW_VALUES_INVALID",
          `Raw table row must contain ${valueCount} finite numeric value${valueCount === 1 ? "" : "s"}`,
          "value",
        ),
      ],
    };
  }
  const table = [...definition.table];
  values.forEach((value, columnIndex) => {
    table[
      coordinatesToFlatIndex(
        variable.type === "decision" ? [...parentStateIndexes, columnIndex] : parentStateIndexes,
        cardinalities,
      )
    ] = value;
  });
  return validateMutation({
    ...network,
    definitions: network.definitions.map((current) =>
      current === definition ? { ...current, table } : current,
    ),
  });
}

export function setVariablePosition(
  network: XmlBifNetwork,
  variableName: string,
  position: Position,
): MutationResult<XmlBifNetwork> {
  const variable = findVariable(network, variableName);
  if (!variable) return variableNotFound(variableName);
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    return { ok: false, diagnostics: [diagnostic("INVALID_POSITION", "Position must be finite")] };
  }
  const properties = variable.properties.map((property) => ({ ...property }));
  const positionIndex = properties.findIndex(({ text }) => parsePositionProperty(text) !== null);
  const property = { text: formatPositionProperty(position) };
  if (positionIndex < 0) properties.push(property);
  else properties[positionIndex] = property;
  return validateMutation({
    ...network,
    variables: network.variables.map((current) =>
      current === variable ? { ...current, properties } : current,
    ),
  });
}

function parentEditFailure(
  network: XmlBifNetwork,
  childName: string,
  parentName: string,
): MutationFailure | null {
  if (!findVariable(network, childName)) return variableNotFound(childName);
  const parent = findVariable(network, parentName);
  if (!parent) return variableNotFound(parentName);
  return parent.type === "utility"
    ? {
        ok: false,
        diagnostics: [
          diagnostic(
            "UTILITY_CANNOT_BE_PARENT",
            `Utility variable cannot be a parent: ${parentName}`,
          ),
        ],
      }
    : null;
}

export function addParent(
  network: XmlBifNetwork,
  childName: string,
  parentName: string,
  insertIndex?: number,
): MutationResult<XmlBifNetwork> {
  const inputFailure = validInput(network);
  if (inputFailure) return inputFailure;
  const editFailure = parentEditFailure(network, childName, parentName);
  if (editFailure) return editFailure;
  if (childName === parentName) {
    return {
      ok: false,
      diagnostics: [diagnostic("SELF_PARENT", `Variable cannot parent itself: ${childName}`)],
    };
  }
  const definition = network.definitions.find(({ for: name }) => name === childName);
  if (definition?.given.includes(parentName)) {
    return {
      ok: false,
      diagnostics: [
        diagnostic("DUPLICATE_GIVEN", `${parentName} is already a parent of ${childName}`),
      ],
    };
  }
  const parentCount = definition?.given.length ?? 0;
  const index = insertIndex ?? parentCount;
  if (!Number.isInteger(index) || index < 0 || index > parentCount) {
    return {
      ok: false,
      diagnostics: [
        diagnostic("PARENT_INDEX_OUT_OF_BOUNDS", `Parent index is out of bounds: ${index}`),
      ],
    };
  }
  const child = findVariable(network, childName)!;
  const given = [
    ...(definition?.given.slice(0, index) ?? []),
    parentName,
    ...(definition?.given.slice(index) ?? []),
  ];
  const shape = definitionCardinalities(network, {
    for: childName,
    given,
    table: [],
    properties: [],
  });
  const nextDefinition = {
    for: childName,
    given,
    table:
      child.type === "nature"
        ? insertAxis(
            definition!.table,
            definitionCardinalities(network, definition!),
            index,
            cardinality(network, parentName)!,
          )
        : Array.from({ length: product(shape) }, () => 0),
    properties: definition?.properties ?? [],
  };
  return validateMutation({
    ...network,
    definitions: definition
      ? network.definitions.map((current) => (current === definition ? nextDefinition : current))
      : [...network.definitions, nextDefinition],
  });
}

export function removeParent(
  network: XmlBifNetwork,
  childName: string,
  parentName: string,
  options: DestructiveMutationOptions = {},
): MutationResult<XmlBifNetwork> {
  const inputFailure = validInput(network);
  if (inputFailure) return inputFailure;
  const editFailure = parentEditFailure(network, childName, parentName);
  if (editFailure) return editFailure;
  const definition = network.definitions.find(({ for: name }) => name === childName);
  const axisIndex = definition?.given.indexOf(parentName) ?? -1;
  if (axisIndex < 0) {
    return {
      ok: false,
      diagnostics: [
        diagnostic("PARENT_NOT_FOUND", `${parentName} is not a parent of ${childName}`),
      ],
    };
  }
  const child = findVariable(network, childName)!;
  const cardinalities = definitionCardinalities(network, definition!);
  const collapsed = removeAxisIfLossless(definition!.table, cardinalities, axisIndex);
  if (!collapsed && child.type !== "nature" && !options.allowDataLoss) {
    return confirmationRequired([childName]);
  }
  const warnings: Diagnostic[] = [];
  let table = collapsed;
  if (!table) {
    const length = product(cardinalities) / cardinalities[axisIndex]!;
    table = Array.from({ length }, () => (child.type === "nature" ? 1 / child.outcomes.length : 0));
    warnings.push(
      resetWarning(
        childName,
        child.type === "nature"
          ? `CPT for ${childName} was reset after removing parent ${parentName}`
          : `Raw table for ${childName} was reset to zero after removing parent ${parentName}`,
        child.type !== "nature",
      ),
    );
  }
  return validateMutation(
    {
      ...network,
      definitions: network.definitions.map((current) =>
        current === definition
          ? {
              ...current,
              given: current.given.filter((_, index) => index !== axisIndex),
              table,
            }
          : current,
      ),
    },
    warnings,
  );
}

export function deleteVariable(
  network: XmlBifNetwork,
  variableName: string,
  options: DestructiveMutationOptions = {},
): MutationResult<XmlBifNetwork> {
  if (!findVariable(network, variableName)) return variableNotFound(variableName);
  const inputFailure = validInput(network);
  if (inputFailure) return inputFailure;
  const rawTablesToReset = network.definitions.filter((definition) => {
    const child = findVariable(network, definition.for);
    const axisIndex = definition.given.indexOf(variableName);
    return (
      child?.type !== "nature" &&
      axisIndex >= 0 &&
      removeAxisIfLossless(
        definition.table,
        definitionCardinalities(network, definition),
        axisIndex,
      ) === null
    );
  });
  if (rawTablesToReset.length && !options.allowDataLoss) {
    return confirmationRequired(rawTablesToReset.map(({ for: name }) => name));
  }
  const warnings: Diagnostic[] = [];
  const definitions = network.definitions.flatMap((definition) => {
    if (definition.for === variableName) return [];
    const axisIndex = definition.given.indexOf(variableName);
    if (axisIndex < 0) return [definition];
    const child = findVariable(network, definition.for)!;
    const cardinalities = definitionCardinalities(network, definition);
    const collapsed = removeAxisIfLossless(definition.table, cardinalities, axisIndex);
    const given = definition.given.filter((parent) => parent !== variableName);
    if (collapsed) return [{ ...definition, given, table: collapsed }];
    const raw = child.type !== "nature";
    const length = product(cardinalities) / cardinalities[axisIndex]!;
    warnings.push(
      resetWarning(
        definition.for,
        raw
          ? `Raw table for ${definition.for} was reset to zero after deleting parent variable ${variableName}`
          : `CPT for ${definition.for} was reset after removing parent ${variableName}`,
        raw,
      ),
    );
    return [
      {
        ...definition,
        given,
        table: Array.from({ length }, () => (raw ? 0 : 1 / child.outcomes.length)),
      },
    ];
  });
  return validateMutation(
    {
      ...network,
      variables: network.variables.filter(({ name }) => name !== variableName),
      definitions,
    },
    warnings,
  );
}
