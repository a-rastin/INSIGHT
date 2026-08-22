import {
  coordinatesToFlatIndex,
  flatIndexToCoordinates,
  insertAxis,
  insertAxisState,
  permuteAxes,
  permuteAxisStates,
  product,
  removeAxisIfLossless,
  removeAxisState,
} from "./cptTensor";
import type { Diagnostic } from "./diagnostics";
import {
  cardinality,
  findVariable,
  formatPositionProperty,
  parsePositionProperty,
  tableAxisCardinalities,
  type Position,
  type VariableType,
  type XmlBifNetwork,
  type XmlProperty,
} from "./model";
import {
  EDITOR_IDENTIFIER_PATTERN,
  PROBABILITY_TOLERANCE,
  validateFile,
} from "./validator";

export interface MutationSuccess<T> {
  ok: true;
  value: T;
  warnings: Diagnostic[];
}

export interface MutationFailure {
  ok: false;
  diagnostics: Diagnostic[];
}

export type MutationResult<T> = MutationSuccess<T> | MutationFailure;

export interface DestructiveMutationOptions {
  allowDataLoss?: boolean;
}

function diagnostic(
  code: string,
  message: string,
  category: Diagnostic["category"] = "structure",
): Diagnostic {
  return { code, severity: "error", category, message };
}

function validateMutation(
  network: XmlBifNetwork,
  warnings: Diagnostic[] = [],
): MutationResult<XmlBifNetwork> {
  const diagnostics = validateFile({ version: "0.3", networks: [network] });
  const errors = diagnostics.filter(({ severity }) => severity === "error");

  return errors.length > 0
    ? { ok: false, diagnostics: errors }
    : {
        ok: true,
        value: network,
        warnings: [
          ...warnings,
          ...diagnostics.filter(({ severity }) => severity === "warning"),
        ],
      };
}

function variableNotFound(name: string): MutationFailure {
  return {
    ok: false,
    diagnostics: [
      diagnostic(
        "VARIABLE_NOT_FOUND",
        `Variable does not exist: ${name}`,
        "reference",
      ),
    ],
  };
}

function validateNewVariableName(
  network: XmlBifNetwork,
  name: string,
  currentName?: string,
): MutationFailure | null {
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
  if (
    name !== currentName &&
    network.variables.some((variable) => variable.name === name)
  ) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "DUPLICATE_VARIABLE_NAME",
          `Duplicate variable name: ${name}`,
        ),
      ],
    };
  }
  return null;
}

export function renameNetwork(
  network: XmlBifNetwork,
  name: string,
): MutationResult<XmlBifNetwork> {
  return validateMutation({ ...network, name });
}

export function renameVariable(
  network: XmlBifNetwork,
  oldName: string,
  newName: string,
): MutationResult<XmlBifNetwork> {
  if (!findVariable(network, oldName)) return variableNotFound(oldName);
  const invalidName = validateNewVariableName(network, newName, oldName);
  if (invalidName) return invalidName;

  return validateMutation({
    ...network,
    variables: network.variables.map((variable) =>
      variable.name === oldName ? { ...variable, name: newName } : variable,
    ),
    definitions: network.definitions.map((definition) => ({
      ...definition,
      for: definition.for === oldName ? newName : definition.for,
      given: definition.given.map((parent) =>
        parent === oldName ? newName : parent,
      ),
    })),
  });
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
  if (
    !Number.isInteger(outcomeIndex) ||
    outcomeIndex < 0 ||
    outcomeIndex >= variable.outcomes.length
  ) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "OUTCOME_INDEX_OUT_OF_BOUNDS",
          `Outcome index is out of bounds: ${outcomeIndex}`,
        ),
      ],
    };
  }

  return validateMutation({
    ...network,
    variables: network.variables.map((current) =>
      current.name === variableName
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
          diagnostic(
            "OUTCOME_INDEX_OUT_OF_BOUNDS",
            `Outcome index is out of bounds: ${index}`,
          ),
        ],
      };
}

function validInput(network: XmlBifNetwork): MutationFailure | null {
  const diagnostics = validateFile({ version: "0.3", networks: [network] });
  const errors = diagnostics.filter(({ severity }) => severity === "error");
  return errors.length > 0 ? { ok: false, diagnostics: errors } : null;
}

function outcomeEditFailure(
  network: XmlBifNetwork,
  variableName: string,
): MutationFailure | null {
  const variable = findVariable(network, variableName);
  if (variable?.type !== "utility") return null;

  return {
    ok: false,
    diagnostics: [
      diagnostic(
        "UNSUPPORTED_OUTCOME_EDIT",
        `Utility variable cannot have outcomes: ${variableName}`,
        "compatibility",
      ),
    ],
  };
}

function definitionCardinalities(
  network: XmlBifNetwork,
  definition: XmlBifNetwork["definitions"][number],
): number[] {
  return tableAxisCardinalities(network, definition) as number[];
}

function outcomeWarning(
  code: string,
  message: string,
  variableName: string,
): Diagnostic {
  return {
    code,
    severity: "warning",
    category: "probability",
    message,
    variableName,
    definitionFor: variableName,
  };
}

function rawTableResetWarning(
  definitionFor: string,
  reason: string,
): Diagnostic {
  return {
    code: "RAW_TABLE_RESET",
    severity: "warning",
    category: "value",
    message: `Raw table for ${definitionFor} was reset to zero ${reason}`,
    variableName: definitionFor,
    definitionFor,
  };
}

function confirmationRequired(definitions: readonly string[]): MutationFailure {
  return {
    ok: false,
    diagnostics: [
      {
        code: "RAW_TABLE_RESET_CONFIRMATION_REQUIRED",
        severity: "warning",
        category: "value",
        message: `This change will reset raw table values to zero: ${definitions.join(", ")}`,
      },
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
      value !== 0 &&
      flatIndexToCoordinates(flatIndex, cardinalities)[axisIndex] ===
        stateIndex,
  );
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
      (index) =>
        !Number.isInteger(index) ||
        index < 0 ||
        index >= variable.outcomes.length,
    ) ||
    new Set(newOrder).size !== variable.outcomes.length
  ) {
    return {
      ok: false,
      diagnostics: [
        diagnostic("INVALID_OUTCOME_ORDER", "Invalid outcome order"),
      ],
    };
  }

  return validateMutation({
    ...network,
    variables: network.variables.map((current) =>
      current.name === variableName
        ? {
            ...current,
            outcomes: newOrder.map((index) => current.outcomes[index]),
          }
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
  const indexFailure = outcomeIndexFailure(
    index,
    true,
    variable.outcomes.length,
  );
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
    const childCardinality = child.outcomes.length;
    if (!ownDefinition) {
      if (child.type === "nature") {
        warnings.push(
          outcomeWarning(
            "CPT_INITIALIZED_NEW_PARENT_STATE",
            `CPT for ${definition.for} received a uniform slice for new ${variableName} outcome`,
            definition.for,
          ),
        );
      }
    }
    return {
      ...definition,
      table: insertAxisState(
        definition.table,
        definitionCardinalities(network, definition),
        axisIndex,
        index,
        () =>
          ownDefinition || child.type !== "nature" ? 0 : 1 / childCardinality,
      ),
    };
  });

  return validateMutation(
    {
      ...network,
      variables: network.variables.map((current) =>
        current.name === variableName
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
  const indexFailure = outcomeIndexFailure(
    outcomeIndex,
    false,
    variable.outcomes.length,
  );
  if (indexFailure) return indexFailure;
  if (variable.outcomes.length === 1) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          variable.type === "decision"
            ? "DECISION_OUTCOME_REQUIRED"
            : "NATURE_OUTCOME_REQUIRED",
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
    return confirmationRequired(
      [...rawTablesToReset].map(({ for: definitionFor }) => definitionFor),
    );
  }

  const warnings: Diagnostic[] = [];
  const definitions = network.definitions.map((definition) => {
    const ownDefinition = definition.for === variableName;
    const axisIndex = ownDefinition
      ? definition.given.length
      : definition.given.indexOf(variableName);
    if (axisIndex < 0) return definition;

    const cardinalities = definitionCardinalities(network, definition);
    let table = removeAxisState(
      definition.table,
      cardinalities,
      axisIndex,
      outcomeIndex,
    );
    if (rawTablesToReset.has(definition)) {
      table = table.map(() => 0);
      warnings.push(
        rawTableResetWarning(
          definition.for,
          `after removing outcome ${variable.outcomes[outcomeIndex]} from ${variableName}`,
        ),
      );
    } else if (ownDefinition && variable.type === "nature") {
      const removedHasProbability = definition.table.some(
        (value, flatIndex) => {
          const coordinates = flatIndexToCoordinates(flatIndex, cardinalities);
          return (
            coordinates[axisIndex] === outcomeIndex &&
            value > PROBABILITY_TOLERANCE
          );
        },
      );
      if (removedHasProbability) {
        table = table.map(() => 1 / (variable.outcomes.length - 1));
        warnings.push(
          outcomeWarning(
            "CPT_RESET_CHILD_OUTCOME_REMOVAL",
            `CPT for ${variableName} was reset after removing a nonzero outcome`,
            variableName,
          ),
        );
      }
    }
    return { ...definition, table };
  });

  return validateMutation(
    {
      ...network,
      variables: network.variables.map((current) =>
        current.name === variableName
          ? {
              ...current,
              outcomes: current.outcomes.filter(
                (_, index) => index !== outcomeIndex,
              ),
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
  if (child.type !== "nature") {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "UNSUPPORTED_CPT_EDIT",
          `Cannot edit decision/utility table for ${childName}`,
          "compatibility",
        ),
      ],
    };
  }

  const definition = network.definitions.find(
    ({ for: name }) => name === childName,
  );
  if (!definition) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "CPT_DEFINITION_MISSING",
          `CPT definition is missing for ${childName}`,
        ),
      ],
    };
  }
  const cardinalities = definitionCardinalities(network, definition);
  if (definition.table.length !== product(cardinalities)) {
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
  if (
    parentStateIndexes.length !== definition.given.length ||
    parentStateIndexes.some(
      (state, axis) =>
        !Number.isInteger(state) || state < 0 || state >= cardinalities[axis],
    )
  ) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "CPT_PARENT_CONFIGURATION_INVALID",
          "Parent state configuration is invalid",
          "probability",
        ),
      ],
    };
  }
  if (
    values.length !== child.outcomes.length ||
    values.some(
      (value) =>
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1 + PROBABILITY_TOLERANCE,
    )
  ) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "CPT_ROW_VALUES_INVALID",
          "CPT row must contain finite probabilities between 0 and 1",
          "probability",
        ),
      ],
    };
  }
  const sum = values.reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > PROBABILITY_TOLERANCE) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "CPT_DISTRIBUTION_NOT_NORMALIZED",
          `CPT row sums to ${sum}, not 1`,
          "probability",
        ),
      ],
    };
  }

  const table = [...definition.table];
  values.forEach((value, childStateIndex) => {
    table[
      coordinatesToFlatIndex(
        [...parentStateIndexes, childStateIndex],
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

export function setRawTableRow(
  network: XmlBifNetwork,
  variableName: string,
  parentStateIndexes: readonly number[],
  values: readonly number[],
): MutationResult<XmlBifNetwork> {
  const variable = findVariable(network, variableName);
  if (!variable) return variableNotFound(variableName);
  if (variable.type === "nature") {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "UNSUPPORTED_RAW_TABLE_EDIT",
          `Nature table must use probability editing: ${variableName}`,
          "compatibility",
        ),
      ],
    };
  }

  const definition = network.definitions.find(
    ({ for: name }) => name === variableName,
  );
  if (!definition) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "RAW_TABLE_DEFINITION_MISSING",
          `Raw table definition is missing for ${variableName}`,
          "value",
        ),
      ],
    };
  }

  const cardinalities = definitionCardinalities(network, definition);
  const parentCardinalities = cardinalities.slice(0, definition.given.length);
  const valueCount =
    variable.type === "decision" ? variable.outcomes.length : 1;
  if (definition.table.length !== product(cardinalities)) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "RAW_TABLE_LENGTH",
          `Raw table dimensions are invalid for ${variableName}`,
          "value",
        ),
      ],
    };
  }
  if (
    parentStateIndexes.length !== parentCardinalities.length ||
    parentStateIndexes.some(
      (state, axis) =>
        !Number.isInteger(state) ||
        state < 0 ||
        state >= parentCardinalities[axis],
    )
  ) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "RAW_TABLE_PARENT_CONFIGURATION_INVALID",
          "Parent state configuration is invalid",
          "value",
        ),
      ],
    };
  }
  if (
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
        variable.type === "decision"
          ? [...parentStateIndexes, columnIndex]
          : parentStateIndexes,
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

export function setVariableProperties(
  network: XmlBifNetwork,
  variableName: string,
  properties: readonly XmlProperty[],
): MutationResult<XmlBifNetwork> {
  if (!findVariable(network, variableName))
    return variableNotFound(variableName);

  return validateMutation({
    ...network,
    variables: network.variables.map((variable) =>
      variable.name === variableName
        ? {
            ...variable,
            properties: properties.map((property) => ({ ...property })),
          }
        : variable,
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
    return {
      ok: false,
      diagnostics: [diagnostic("INVALID_POSITION", "Position must be finite")],
    };
  }

  const properties = variable.properties.map((property) => ({ ...property }));
  const positionIndex = properties.findIndex(
    ({ text }) => parsePositionProperty(text) !== null,
  );
  const property = { text: formatPositionProperty(position) };
  if (positionIndex < 0) properties.push(property);
  else properties[positionIndex] = property;

  return setVariableProperties(network, variableName, properties);
}

function nextNodeName(network: XmlBifNetwork): string {
  const names = new Set(network.variables.map(({ name }) => name));
  for (let index = 1; ; index += 1) {
    const name = `Node${index}`;
    if (!names.has(name)) return name;
  }
}

export function addVariable(
  network: XmlBifNetwork,
  type: VariableType,
  requestedName?: string,
  position?: Position,
): MutationResult<XmlBifNetwork> {
  const name = requestedName ?? nextNodeName(network);
  const invalidName = validateNewVariableName(network, name);
  if (invalidName) return invalidName;
  if (
    position &&
    (!Number.isFinite(position.x) || !Number.isFinite(position.y))
  ) {
    return {
      ok: false,
      diagnostics: [diagnostic("INVALID_POSITION", "Position must be finite")],
    };
  }

  return validateMutation({
    ...network,
    variables: [
      ...network.variables,
      {
        name,
        type,
        outcomes: type === "utility" ? [] : ["State0", "State1"],
        properties: position
          ? [{ text: formatPositionProperty(position) }]
          : [],
      },
    ],
    definitions: [
      ...network.definitions,
      {
        for: name,
        given: [],
        table:
          type === "nature" ? [0.5, 0.5] : type === "decision" ? [0, 0] : [0],
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

function parentEditFailure(
  network: XmlBifNetwork,
  childName: string,
  parentName: string,
): MutationFailure | null {
  const child = findVariable(network, childName);
  if (!child) return variableNotFound(childName);
  const parent = findVariable(network, parentName);
  if (!parent) return variableNotFound(parentName);
  if (parent.type !== "utility") return null;

  return {
    ok: false,
    diagnostics: [
      diagnostic(
        "UTILITY_CANNOT_BE_PARENT",
        `Utility variable cannot be a parent: ${parentName}`,
      ),
    ],
  };
}

export function addParent(
  network: XmlBifNetwork,
  childName: string,
  parentName: string,
  insertIndex?: number,
): MutationResult<XmlBifNetwork> {
  const inputFailure = validInput(network);
  if (inputFailure) return inputFailure;
  const unsupported = parentEditFailure(network, childName, parentName);
  if (unsupported) return unsupported;
  if (childName === parentName) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "SELF_PARENT",
          `Variable cannot parent itself: ${childName}`,
        ),
      ],
    };
  }

  const definition = network.definitions.find(
    ({ for: name }) => name === childName,
  );
  if (definition?.given.includes(parentName)) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "DUPLICATE_GIVEN",
          `${parentName} is already a parent of ${childName}`,
        ),
      ],
    };
  }
  const parentCount = definition?.given.length ?? 0;
  const index = insertIndex ?? parentCount;
  if (!Number.isInteger(index) || index < 0 || index > parentCount) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "PARENT_INDEX_OUT_OF_BOUNDS",
          `Parent index is out of bounds: ${index}`,
        ),
      ],
    };
  }

  const child = findVariable(network, childName)!;
  const oldGiven = definition?.given ?? [];
  const given = [
    ...oldGiven.slice(0, index),
    parentName,
    ...oldGiven.slice(index),
  ];
  const newCardinalities = definitionCardinalities(network, {
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
            cardinality(network, parentName) as number,
          )
        : Array.from({ length: product(newCardinalities) }, () => 0),
    properties: definition?.properties ?? [],
  };
  return validateMutation({
    ...network,
    definitions: definition
      ? network.definitions.map((current) =>
          current === definition ? nextDefinition : current,
        )
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
  const unsupported = parentEditFailure(network, childName, parentName);
  if (unsupported) return unsupported;
  const definition = network.definitions.find(
    ({ for: name }) => name === childName,
  );
  const axisIndex = definition?.given.indexOf(parentName) ?? -1;
  if (axisIndex < 0) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "PARENT_NOT_FOUND",
          `${parentName} is not a parent of ${childName}`,
        ),
      ],
    };
  }

  const child = findVariable(network, childName)!;
  const cardinalities = definitionCardinalities(network, definition!);
  const collapsed = removeAxisIfLossless(
    definition!.table,
    cardinalities,
    axisIndex,
  );
  if (!collapsed && child.type !== "nature" && !options.allowDataLoss) {
    return confirmationRequired([childName]);
  }

  const given = definition!.given.filter((_, index) => index !== axisIndex);
  const warnings: Diagnostic[] = [];
  let table = collapsed;
  if (!table) {
    const nextLength = product(cardinalities) / cardinalities[axisIndex];
    if (child.type === "nature") {
      table = Array.from(
        { length: nextLength },
        () => 1 / child.outcomes.length,
      );
      warnings.push(
        outcomeWarning(
          "CPT_RESET_PARENT_REMOVAL",
          `CPT for ${childName} was reset after removing parent ${parentName}`,
          childName,
        ),
      );
    } else {
      table = Array.from({ length: nextLength }, () => 0);
      warnings.push(
        rawTableResetWarning(childName, `after removing parent ${parentName}`),
      );
    }
  }

  return validateMutation(
    {
      ...network,
      definitions: network.definitions.map((current) =>
        current === definition! ? { ...current, given, table } : current,
      ),
    },
    warnings,
  );
}

export function reorderParents(
  network: XmlBifNetwork,
  childName: string,
  newOrder: readonly number[],
): MutationResult<XmlBifNetwork> {
  const inputFailure = validInput(network);
  if (inputFailure) return inputFailure;
  const child = findVariable(network, childName);
  if (!child) return variableNotFound(childName);
  const definition = network.definitions.find(
    ({ for: name }) => name === childName,
  );
  const parentCount = definition?.given.length ?? 0;
  if (
    newOrder.length !== parentCount ||
    newOrder.some(
      (index) => !Number.isInteger(index) || index < 0 || index >= parentCount,
    ) ||
    new Set(newOrder).size !== parentCount
  ) {
    return {
      ok: false,
      diagnostics: [diagnostic("INVALID_PARENT_ORDER", "Invalid parent order")],
    };
  }

  return validateMutation({
    ...network,
    definitions: network.definitions.map((current) =>
      current === definition!
        ? {
            ...current,
            given: newOrder.map((index) => current.given[index]),
            table: permuteAxes(
              current.table,
              definitionCardinalities(network, current),
              child.type === "utility"
                ? [...newOrder]
                : [...newOrder, parentCount],
            ),
          }
        : current,
    ),
  });
}

export function deleteVariable(
  network: XmlBifNetwork,
  variableName: string,
  options: DestructiveMutationOptions = {},
): MutationResult<XmlBifNetwork> {
  if (!findVariable(network, variableName))
    return variableNotFound(variableName);
  const inputErrors = validateFile({
    version: "0.3",
    networks: [network],
  }).filter(({ severity }) => severity === "error");
  if (inputErrors.length > 0) return { ok: false, diagnostics: inputErrors };

  const rawTablesToReset = new Set(
    network.definitions.filter((definition) => {
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
    }),
  );
  if (rawTablesToReset.size > 0 && !options.allowDataLoss) {
    return confirmationRequired(
      [...rawTablesToReset].map(({ for: definitionFor }) => definitionFor),
    );
  }

  const warnings: Diagnostic[] = [];
  const definitions = network.definitions.flatMap((definition) => {
    if (definition.for === variableName) return [];
    const axisIndex = definition.given.indexOf(variableName);
    if (axisIndex < 0) return [definition];

    const child = findVariable(network, definition.for)!;
    const cardinalities = definitionCardinalities(network, definition);

    const table = removeAxisIfLossless(
      definition.table,
      cardinalities,
      axisIndex,
    );
    const given = definition.given.filter((parent) => parent !== variableName);
    if (table) return [{ ...definition, given, table }];

    const nextLength = product(cardinalities) / cardinalities[axisIndex];
    if (rawTablesToReset.has(definition)) {
      warnings.push(
        rawTableResetWarning(
          definition.for,
          `after deleting parent variable ${variableName}`,
        ),
      );
      return [
        {
          ...definition,
          given,
          table: Array.from({ length: nextLength }, () => 0),
        },
      ];
    }

    warnings.push(
      outcomeWarning(
        "CPT_RESET_PARENT_REMOVAL",
        `CPT for ${definition.for} was reset after removing parent ${variableName}`,
        definition.for,
      ),
    );
    return [
      {
        ...definition,
        given,
        table: Array.from(
          { length: nextLength },
          () => 1 / child.outcomes.length,
        ),
      },
    ];
  });

  return validateMutation(
    {
      ...network,
      variables: network.variables.filter(
        (variable) => variable.name !== variableName,
      ),
      definitions,
    },
    warnings,
  );
}
