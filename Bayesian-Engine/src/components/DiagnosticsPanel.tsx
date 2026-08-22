import type { Diagnostic } from "../domain/diagnostics";

interface DiagnosticsPanelProps {
  diagnostics: readonly Diagnostic[];
  onSelectLocation?: (line: number, column: number) => void;
}

export function DiagnosticsPanel({
  diagnostics,
  onSelectLocation,
}: DiagnosticsPanelProps): JSX.Element {
  const errors = diagnostics.filter(({ severity }) => severity === "error");
  const warnings = diagnostics.length - errors.length;

  return (
    <section
      className="diagnostics-panel"
      aria-label="Diagnostics"
      role="status"
    >
      <strong>
        {errors.length} error{errors.length === 1 ? "" : "s"}, {warnings}{" "}
        warning
        {warnings === 1 ? "" : "s"}
      </strong>
      {diagnostics.length === 0 ? (
        <span>No diagnostics</span>
      ) : (
        <ul>
          {diagnostics.map((diagnostic, index) => {
            const key = `${diagnostic.code}:${diagnostic.message}:${index}`;
            const label = `${diagnostic.severity}: ${diagnostic.message}`;
            const { line, column } = diagnostic;
            return (
              <li key={key} className={`diagnostic-${diagnostic.severity}`}>
                {line !== undefined &&
                column !== undefined &&
                onSelectLocation ? (
                  <button
                    type="button"
                    onClick={() => onSelectLocation(line, column)}
                  >
                    {label} (line {line}, column {column})
                  </button>
                ) : (
                  <span>{label}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
