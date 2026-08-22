import { useEffect, useMemo, useState } from "react";
import type { XmlBifNetwork } from "../domain/model";
import type { DocumentActionResult } from "../store/documentStore";
import { projectRawTable } from "./rawTableProjection";

export interface RawValueEditorProps {
  network: XmlBifNetwork;
  variableName: string;
  onCommitRow: (
    parentStateIndexes: readonly number[],
    values: readonly number[],
  ) => DocumentActionResult;
}

function resultMessage(result: DocumentActionResult): string | undefined {
  return result.ok
    ? undefined
    : result.diagnostics.map(({ message }) => message).join("\n");
}

export function RawValueEditor({
  network,
  variableName,
  onCommitRow,
}: RawValueEditorProps): JSX.Element {
  const projection = useMemo(
    () => projectRawTable(network, variableName),
    [network, variableName],
  );
  const [drafts, setDrafts] = useState<string[][]>([]);
  const [errors, setErrors] = useState<Record<number, string>>({});

  useEffect(() => {
    setDrafts(
      projection.ok ? projection.rows.map((row) => row.values.map(String)) : [],
    );
    setErrors({});
  }, [projection]);

  if (!projection.ok)
    return <p className="inspector-hint">{projection.reason}</p>;

  const setRowError = (row: number, message?: string) =>
    setErrors((current) => {
      const next = { ...current };
      if (message) next[row] = message;
      else delete next[row];
      return next;
    });

  const commitRow = (rowIndex: number) => {
    const values = (drafts[rowIndex] ?? []).map((text) =>
      text.trim() === "" ? NaN : Number(text),
    );
    if (!values.every(Number.isFinite)) {
      setRowError(rowIndex, "Enter finite numeric values.");
      return;
    }

    const result = onCommitRow(
      projection.rows[rowIndex].parentStateIndexes,
      values,
    );
    setRowError(rowIndex, resultMessage(result));
  };

  return (
    <div className="cpt-editor raw-value-editor">
      <div className="cpt-table-scroll">
        <table>
          <thead>
            <tr>
              {projection.parentNames.map((name) => (
                <th key={name} scope="col">
                  {name}
                </th>
              ))}
              {projection.columnLabels.map((label) => (
                <th key={label} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {projection.rows.map((row, rowIndex) => (
              <tr key={row.parentStateIndexes.join(",") || "root"}>
                {row.parentStates.map((state, parentIndex) => (
                  <th key={parentIndex} scope="row">
                    {state}
                  </th>
                ))}
                {projection.columnLabels.map((label, columnIndex) => (
                  <td key={label}>
                    <input
                      aria-label={`${row.parentStates.join(", ") || "Root"} ${label}`}
                      inputMode="decimal"
                      value={drafts[rowIndex]?.[columnIndex] ?? ""}
                      onChange={(event) => {
                        const text = event.target.value;
                        setDrafts((current) =>
                          current.map((draftRow, index) =>
                            index === rowIndex
                              ? draftRow.map((value, column) =>
                                  column === columnIndex ? text : value,
                                )
                              : draftRow,
                          ),
                        );
                        setRowError(rowIndex);
                      }}
                      onBlur={() => commitRow(rowIndex)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {Object.entries(errors).map(([row, message]) => (
        <p className="field-error" role="alert" key={row}>
          Row {Number(row) + 1}: {message}
        </p>
      ))}
    </div>
  );
}
