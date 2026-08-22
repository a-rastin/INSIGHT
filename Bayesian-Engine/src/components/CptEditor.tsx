import { useEffect, useMemo, useState } from "react";
import type { XmlBifNetwork } from "../domain/model";
import { PROBABILITY_TOLERANCE } from "../domain/validator";
import type { DocumentActionResult } from "../store/documentStore";
import { projectCptTable } from "./cptTableProjection";

export interface CptEditorProps {
  network: XmlBifNetwork;
  childName: string;
  onCommitRow: (
    parentStateIndexes: readonly number[],
    values: readonly number[],
  ) => DocumentActionResult;
}

function parseRow(draft: readonly string[]): number[] | null {
  const values = draft.map((text) => (text.trim() === "" ? NaN : Number(text)));
  return values.every((value) => Number.isFinite(value)) ? values : null;
}

function resultMessage(result: DocumentActionResult): string | undefined {
  return result.ok
    ? undefined
    : result.diagnostics.map(({ message }) => message).join("\n");
}

export function CptEditor({
  network,
  childName,
  onCommitRow,
}: CptEditorProps): JSX.Element {
  const projection = useMemo(
    () => projectCptTable(network, childName),
    [network, childName],
  );
  const [drafts, setDrafts] = useState<string[][]>([]);
  const [selectedCell, setSelectedCell] = useState<{
    row: number;
    column: number;
  }>();
  const [errors, setErrors] = useState<Record<number, string>>({});

  useEffect(() => {
    setDrafts(
      projection.ok
        ? projection.rows.map((row) => row.values.map((value) => String(value)))
        : [],
    );
    setSelectedCell(undefined);
    setErrors({});
  }, [projection]);

  if (!projection.ok)
    return <p className="inspector-hint">{projection.reason}</p>;

  const setRowError = (row: number, error?: string) =>
    setErrors((current) => {
      const next = { ...current };
      if (error) next[row] = error;
      else delete next[row];
      return next;
    });

  const commit = (rowIndex: number, values: number[]) => {
    const result = onCommitRow(
      projection.rows[rowIndex].parentStateIndexes,
      values,
    );
    setRowError(rowIndex, resultMessage(result));
    if (result.ok) {
      setDrafts((current) =>
        current.map((row, index) =>
          index === rowIndex ? values.map(String) : row,
        ),
      );
    }
    return result.ok;
  };

  const rowValues = (
    rowIndex: number,
    allowAboveOne = false,
  ): number[] | null => {
    const values = parseRow(drafts[rowIndex] ?? []);
    if (!values) {
      setRowError(rowIndex, "Enter finite numeric values.");
      return null;
    }
    if (
      values.some(
        (value) =>
          value < 0 || (!allowAboveOne && value > 1 + PROBABILITY_TOLERANCE),
      )
    ) {
      setRowError(
        rowIndex,
        "Probabilities must be non-negative and at most 1.",
      );
      return null;
    }
    return values;
  };

  return (
    <div className="cpt-editor">
      <div className="cpt-table-scroll">
        <table>
          <thead>
            <tr>
              {projection.parentNames.map((name) => (
                <th key={name} scope="col">
                  {name}
                </th>
              ))}
              {projection.childOutcomes.map((outcome) => (
                <th key={outcome} scope="col">
                  P({outcome})
                </th>
              ))}
              <th scope="col">Sum</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {projection.rows.map((row, rowIndex) => {
              const values = parseRow(drafts[rowIndex] ?? []);
              const sum = values?.reduce((total, value) => total + value, 0);
              return (
                <tr key={row.parentStateIndexes.join(",") || "root"}>
                  {row.parentStates.map((state, parentIndex) => (
                    <th key={parentIndex} scope="row">
                      {state}
                    </th>
                  ))}
                  {projection.childOutcomes.map((outcome, columnIndex) => (
                    <td key={outcome}>
                      <input
                        aria-label={`${row.parentStates.join(", ") || "Root"} P(${outcome})`}
                        inputMode="decimal"
                        value={drafts[rowIndex]?.[columnIndex] ?? ""}
                        onFocus={() =>
                          setSelectedCell({
                            row: rowIndex,
                            column: columnIndex,
                          })
                        }
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
                        onBlur={() => {
                          const next = rowValues(rowIndex);
                          if (
                            next &&
                            Math.abs(
                              next.reduce((total, value) => total + value, 0) -
                                1,
                            ) <= PROBABILITY_TOLERANCE
                          )
                            commit(rowIndex, next);
                        }}
                      />
                    </td>
                  ))}
                  <td className="cpt-sum">
                    {sum === undefined ? "—" : String(sum)}
                  </td>
                  <td className="cpt-actions">
                    <button
                      type="button"
                      onClick={() => {
                        const next = rowValues(rowIndex, true);
                        if (!next) return;
                        const total = next.reduce(
                          (sumValue, value) => sumValue + value,
                          0,
                        );
                        if (total <= 0) {
                          setRowError(
                            rowIndex,
                            "Cannot normalize a zero-sum row.",
                          );
                          return;
                        }
                        commit(
                          rowIndex,
                          next.map((value) => value / total),
                        );
                      }}
                    >
                      Normalize
                    </button>
                    <button
                      type="button"
                      disabled={selectedCell?.row !== rowIndex}
                      onClick={() => {
                        if (selectedCell?.row !== rowIndex) return;
                        const next = (drafts[rowIndex] ?? []).map(
                          (text, index) =>
                            index === selectedCell.column
                              ? 0
                              : text.trim() === ""
                                ? NaN
                                : Number(text),
                        );
                        if (
                          next.some(
                            (value, index) =>
                              index !== selectedCell.column &&
                              (!Number.isFinite(value) ||
                                value < 0 ||
                                value > 1 + PROBABILITY_TOLERANCE),
                          )
                        ) {
                          setRowError(
                            rowIndex,
                            "Other probabilities must be finite values between 0 and 1.",
                          );
                          return;
                        }
                        const otherSum = next.reduce(
                          (sumValue, value) => sumValue + value,
                          0,
                        );
                        const complement = 1 - otherSum;
                        if (
                          complement < -PROBABILITY_TOLERANCE ||
                          complement > 1 + PROBABILITY_TOLERANCE
                        ) {
                          setRowError(
                            rowIndex,
                            "Complement is outside 0 to 1.",
                          );
                          return;
                        }
                        next[selectedCell.column] = Math.min(
                          1,
                          Math.max(0, complement),
                        );
                        commit(rowIndex, next);
                      }}
                    >
                      Complement
                    </button>
                  </td>
                </tr>
              );
            })}
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
