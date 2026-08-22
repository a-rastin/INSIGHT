import {
  coordinatesToFlatIndex,
  flatIndexToCoordinates,
  product,
} from "../domain/cptTensor";
import {
  cardinality,
  findDefinition,
  findVariable,
  expectedTableLength,
  type XmlBifNetwork,
} from "../domain/model";
import { MAX_CPT_EDITOR_ROWS } from "./cptTableProjection";

export interface RawTableRow {
  parentStateIndexes: number[];
  parentStates: string[];
  tableIndexes: number[];
  values: number[];
}

export type RawTableProjection =
  | {
      ok: true;
      variableType: "decision" | "utility";
      parentNames: string[];
      columnLabels: string[];
      rows: RawTableRow[];
    }
  | { ok: false; reason: string };

export function projectRawTable(
  network: XmlBifNetwork,
  variableName: string,
): RawTableProjection {
  const variable = findVariable(network, variableName);
  if (!variable)
    return { ok: false, reason: "Selected variable does not exist." };
  if (variable.type === "nature") {
    return { ok: false, reason: "Nature tables use the probability editor." };
  }
  if (variable.type === "utility" && variable.outcomes.length > 0) {
    return {
      ok: false,
      reason:
        "Utility variables cannot have outcomes. Remove OUTCOME elements in XML Code view.",
    };
  }
  if (variable.type === "decision" && variable.outcomes.length === 0) {
    return {
      ok: false,
      reason:
        "Decision has no outcomes. Fix OUTCOME elements in XML Code view.",
    };
  }

  const definition = findDefinition(network, variableName);
  if (!definition) {
    return {
      ok: false,
      reason:
        "Raw value definition is missing. Add a DEFINITION in XML Code view.",
    };
  }
  const parents = definition.given.map((name) => findVariable(network, name));
  const parentCardinalities = definition.given.map((name) =>
    cardinality(network, name),
  );
  if (
    parents.some((parent) => !parent) ||
    parentCardinalities.some((value) => value === undefined || value <= 0)
  ) {
    return {
      ok: false,
      reason:
        "Raw table dimensions cannot be resolved. Fix parent outcomes in XML Code view.",
    };
  }

  const expectedLength = expectedTableLength(network, definition);
  if (
    expectedLength === undefined ||
    definition.table.length !== expectedLength
  ) {
    return {
      ok: false,
      reason: `Raw table has ${definition.table.length} values; expected ${String(expectedLength ?? "resolvable dimensions")}. Fix TABLE dimensions in XML Code view.`,
    };
  }

  const cardinalities = parentCardinalities as number[];
  const rowCount = product(cardinalities);
  if (rowCount > MAX_CPT_EDITOR_ROWS) {
    return {
      ok: false,
      reason: `Raw table has ${rowCount} rows, above the ${MAX_CPT_EDITOR_ROWS}-row graphical editing limit. Edit this TABLE in XML Code view.`,
    };
  }

  const columnLabels =
    variable.type === "decision" ? [...variable.outcomes] : ["Value"];
  const allCardinalities =
    variable.type === "decision"
      ? [...cardinalities, variable.outcomes.length]
      : cardinalities;

  return {
    ok: true,
    variableType: variable.type,
    parentNames: [...definition.given],
    columnLabels,
    rows: Array.from({ length: rowCount }, (_, rowIndex) => {
      const parentStateIndexes = flatIndexToCoordinates(
        rowIndex,
        cardinalities,
      );
      const tableIndexes = columnLabels.map((_, columnIndex) =>
        coordinatesToFlatIndex(
          variable.type === "decision"
            ? [...parentStateIndexes, columnIndex]
            : parentStateIndexes,
          allCardinalities,
        ),
      );
      return {
        parentStateIndexes,
        parentStates: parentStateIndexes.map(
          (stateIndex, parentIndex) =>
            parents[parentIndex]!.outcomes[stateIndex],
        ),
        tableIndexes,
        values: tableIndexes.map((index) => definition.table[index]),
      };
    }),
  };
}
