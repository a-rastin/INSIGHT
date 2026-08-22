import {
  coordinatesToFlatIndex,
  flatIndexToCoordinates,
  product,
} from "../domain/cptTensor";
import {
  cardinality,
  findDefinition,
  type XmlBifNetwork,
} from "../domain/model";

export interface CptTableRow {
  parentStateIndexes: number[];
  parentStates: string[];
  tableIndexes: number[];
  values: number[];
}

export const MAX_CPT_EDITOR_ROWS = 5000;

export type CptTableProjection =
  | {
      ok: true;
      parentNames: string[];
      childOutcomes: string[];
      rows: CptTableRow[];
    }
  | { ok: false; reason: string };

export function projectCptTable(
  network: XmlBifNetwork,
  childName: string,
): CptTableProjection {
  const child = network.variables.find(({ name }) => name === childName);
  if (!child) return { ok: false, reason: "Selected variable does not exist." };
  if (child.type !== "nature") {
    return {
      ok: false,
      reason: "Decision and utility tables are editable only in XML Code view.",
    };
  }

  const definition = findDefinition(network, childName);
  if (!definition) return { ok: false, reason: "CPT definition is missing." };
  const parents = definition.given.map((name) =>
    network.variables.find((variable) => variable.name === name),
  );
  const cardinalities = definition.given.map((name) =>
    cardinality(network, name),
  );
  if (
    child.outcomes.length === 0 ||
    parents.some((parent) => !parent) ||
    cardinalities.some((value) => value === undefined || value <= 0)
  ) {
    return { ok: false, reason: "CPT dimensions cannot be resolved." };
  }

  const parentCardinalities = cardinalities as number[];
  const allCardinalities = [...parentCardinalities, child.outcomes.length];
  const expectedLength = product(allCardinalities);
  if (definition.table.length !== expectedLength) {
    return {
      ok: false,
      reason: `CPT has ${definition.table.length} values; expected ${expectedLength}. Fix TABLE dimensions in XML Code view.`,
    };
  }

  const rowCount = product(parentCardinalities);
  if (rowCount > MAX_CPT_EDITOR_ROWS) {
    return {
      ok: false,
      reason: `CPT has ${rowCount} rows, above the ${MAX_CPT_EDITOR_ROWS}-row graphical editing limit. Edit this TABLE in XML Code view.`,
    };
  }

  return {
    ok: true,
    parentNames: [...definition.given],
    childOutcomes: [...child.outcomes],
    rows: Array.from({ length: rowCount }, (_, rowIndex) => {
      const parentStateIndexes = flatIndexToCoordinates(
        rowIndex,
        parentCardinalities,
      );
      const tableIndexes = child.outcomes.map((_, childStateIndex) =>
        coordinatesToFlatIndex(
          [...parentStateIndexes, childStateIndex],
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
