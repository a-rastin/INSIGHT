import { useEffect, useMemo, useState } from "react";
import {
  addOutcome,
  cardinality,
  findDefinition,
  findVariable,
  flatIndexToCoordinates,
  product,
  removeOutcome,
  renameOutcome,
  reorderOutcomes,
  setCptDistribution,
  setRawTableRow,
  type MutationResult,
  type XmlBifNetwork,
} from "@insight/bayes";

import { Button } from "./components/primitives";

type ApplyMutation = (
  operation: (network: XmlBifNetwork, allowDataLoss: boolean) => MutationResult<XmlBifNetwork>,
) => void;

interface TableProjection {
  readonly parentNames: readonly string[];
  readonly parentStates: readonly (readonly string[])[];
  readonly parentIndexes: readonly (readonly number[])[];
  readonly columns: readonly string[];
  readonly values: readonly (readonly number[])[];
}

function projectTable(network: XmlBifNetwork, variableName: string): TableProjection | string {
  const variable = findVariable(network, variableName);
  const definition = findDefinition(network, variableName);
  if (!variable || !definition) return "Table definition is missing.";
  const parents = definition.given.map((name) => findVariable(network, name));
  const parentCardinalities = definition.given.map((name) => cardinality(network, name));
  if (parents.some((parent) => !parent) || parentCardinalities.some((value) => !value))
    return "Table dimensions cannot be resolved.";
  const dimensions = parentCardinalities as number[];
  const columns = variable.type === "utility" ? ["Value"] : variable.outcomes;
  const expected = product(
    variable.type === "utility" ? dimensions : [...dimensions, variable.outcomes.length],
  );
  if (definition.table.length !== expected)
    return `Table has ${definition.table.length} values; expected ${expected}.`;
  const rows = product(dimensions);
  if (rows > 5_000) return "Table exceeds 5,000-row graphical editing limit.";
  const parentIndexes = Array.from({ length: rows }, (_, index) =>
    flatIndexToCoordinates(index, dimensions),
  );
  return {
    parentNames: definition.given,
    parentIndexes,
    parentStates: parentIndexes.map((indexes) =>
      indexes.map((state, parent) => parents[parent]!.outcomes[state]!),
    ),
    columns,
    values: Array.from({ length: rows }, (_, row) =>
      definition.table.slice(row * columns.length, (row + 1) * columns.length),
    ),
  };
}

export function OutcomeEditor({
  network,
  variableName,
  onApply,
}: {
  readonly network: XmlBifNetwork;
  readonly variableName: string;
  readonly onApply: ApplyMutation;
}) {
  const variable = findVariable(network, variableName);
  const [newOutcome, setNewOutcome] = useState("");
  if (!variable || variable.type === "utility") return null;
  return (
    <section className="bn-subeditor" aria-labelledby="bn-outcomes-title">
      <h4 id="bn-outcomes-title">Ordered outcomes</h4>
      <ol className="bn-outcome-list">
        {variable.outcomes.map((outcome, index) => (
          <li key={`${index}:${outcome}`}>
            <input
              aria-label={`Outcome ${index + 1}`}
              className="text-input"
              defaultValue={outcome}
              onBlur={(event) => {
                if (event.target.value !== outcome)
                  onApply((current) =>
                    renameOutcome(current, variableName, index, event.target.value),
                  );
              }}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={index === 0}
              onClick={() => {
                const order = variable.outcomes.map((_, item) => item);
                [order[index - 1], order[index]] = [order[index]!, order[index - 1]!];
                onApply((current) => reorderOutcomes(current, variableName, order));
              }}
            >
              Up
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={index === variable.outcomes.length - 1}
              onClick={() => {
                const order = variable.outcomes.map((_, item) => item);
                [order[index], order[index + 1]] = [order[index + 1]!, order[index]!];
                onApply((current) => reorderOutcomes(current, variableName, order));
              }}
            >
              Down
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() =>
                onApply((current, allowDataLoss) =>
                  removeOutcome(current, variableName, index, { allowDataLoss }),
                )
              }
            >
              Remove
            </Button>
          </li>
        ))}
      </ol>
      <div className="bn-inline-editor">
        <label>
          New outcome
          <input
            className="text-input"
            value={newOutcome}
            onChange={(event) => setNewOutcome(event.target.value)}
          />
        </label>
        <Button
          type="button"
          variant="secondary"
          disabled={!newOutcome.trim()}
          onClick={() => {
            onApply((current) => addOutcome(current, variableName, newOutcome.trim()));
            setNewOutcome("");
          }}
        >
          Add outcome
        </Button>
      </div>
    </section>
  );
}

export function TableEditor({
  network,
  variableName,
  onApply,
}: {
  readonly network: XmlBifNetwork;
  readonly variableName: string;
  readonly onApply: ApplyMutation;
}) {
  const variable = findVariable(network, variableName);
  const projection = useMemo(() => projectTable(network, variableName), [network, variableName]);
  const [drafts, setDrafts] = useState<string[][]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    setDrafts(
      typeof projection === "string" ? [] : projection.values.map((row) => row.map(String)),
    );
    setError("");
  }, [projection]);
  if (!variable) return null;
  if (typeof projection === "string") return <p className="field-error">{projection}</p>;

  const commit = (row: number, normalize = false) => {
    let values = (drafts[row] ?? []).map((value) =>
      value.trim() === "" ? Number.NaN : Number(value),
    );
    if (!values.every(Number.isFinite)) {
      setError(`Row ${row + 1}: Enter finite numeric values.`);
      return;
    }
    if (normalize) {
      if (values.some((value) => value < 0)) {
        setError(`Row ${row + 1}: Probabilities cannot be negative.`);
        return;
      }
      const sum = values.reduce((total, value) => total + value, 0);
      if (sum <= 0) {
        setError(`Row ${row + 1}: Cannot normalize a zero-sum row.`);
        return;
      }
      values = values.map((value) => value / sum);
      setDrafts((current) =>
        current.map((currentRow, index) => (index === row ? values.map(String) : currentRow)),
      );
    }
    setError("");
    onApply((current) =>
      variable.type === "nature"
        ? setCptDistribution(current, variableName, projection.parentIndexes[row]!, values)
        : setRawTableRow(current, variableName, projection.parentIndexes[row]!, values),
    );
  };

  return (
    <section className="bn-subeditor" aria-labelledby="bn-table-title">
      <h4 id="bn-table-title">{variable.type === "nature" ? "CPT" : "Raw table"}</h4>
      <div className="bn-table-scroll">
        <table>
          <thead>
            <tr>
              {projection.parentNames.map((name) => (
                <th key={name} scope="col">
                  {name}
                </th>
              ))}
              {projection.columns.map((column) => (
                <th key={column} scope="col">
                  {variable.type === "nature" ? `P(${column})` : column}
                </th>
              ))}
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {projection.parentIndexes.map((indexes, row) => (
              <tr key={indexes.join(",") || "root"}>
                {projection.parentStates[row]!.map((state, index) => (
                  <th key={`${index}:${state}`} scope="row">
                    {state}
                  </th>
                ))}
                {projection.columns.map((column, columnIndex) => (
                  <td key={column}>
                    <input
                      aria-label={`${projection.parentStates[row]!.join(", ") || "Root"} ${
                        variable.type === "nature" ? `P(${column})` : column
                      }`}
                      inputMode="decimal"
                      value={drafts[row]?.[columnIndex] ?? ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDrafts((current) =>
                          current.map((currentRow, rowIndex) =>
                            rowIndex === row
                              ? currentRow.map((currentValue, index) =>
                                  index === columnIndex ? value : currentValue,
                                )
                              : currentRow,
                          ),
                        );
                      }}
                    />
                  </td>
                ))}
                <td>
                  <Button type="button" variant="secondary" onClick={() => commit(row)}>
                    Apply row
                  </Button>
                  {variable.type === "nature" ? (
                    <Button type="button" variant="secondary" onClick={() => commit(row, true)}>
                      Normalize
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
