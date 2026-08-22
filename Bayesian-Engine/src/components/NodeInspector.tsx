import { useEffect, useState } from "react";
import type {
  XmlBifNetwork,
  XmlBifVariable,
  XmlProperty,
} from "../domain/model";
import type { DocumentActionResult } from "../store/documentStore";
import { CptEditor } from "./CptEditor";
import { RawValueEditor } from "./RawValueEditor";

export interface NodeInspectorProps {
  network: XmlBifNetwork | null;
  variable: XmlBifVariable | null;
  onRename: (name: string) => DocumentActionResult;
  onRenameOutcome: (index: number, name: string) => DocumentActionResult;
  onAddOutcome: (name: string) => DocumentActionResult;
  onRemoveOutcome: (index: number) => DocumentActionResult;
  onReorderOutcomes: (newOrder: number[]) => DocumentActionResult;
  onSetProperties: (properties: XmlProperty[]) => DocumentActionResult;
  onSetCptDistribution: (
    parentStateIndexes: readonly number[],
    values: readonly number[],
  ) => DocumentActionResult;
  onSetRawTableRow: (
    parentStateIndexes: readonly number[],
    values: readonly number[],
  ) => DocumentActionResult;
}

function messages(result: DocumentActionResult): string | undefined {
  return result.ok
    ? undefined
    : result.diagnostics.map(({ message }) => message).join("\n");
}

export function NodeInspector({
  network,
  variable,
  onRename,
  onRenameOutcome,
  onAddOutcome,
  onRemoveOutcome,
  onReorderOutcomes,
  onSetProperties,
  onSetCptDistribution,
  onSetRawTableRow,
}: NodeInspectorProps): JSX.Element {
  const [name, setName] = useState("");
  const [outcomes, setOutcomes] = useState<string[]>([]);
  const [properties, setProperties] = useState<XmlProperty[]>([]);
  const [nameError, setNameError] = useState<string>();
  const [outcomeError, setOutcomeError] = useState<string>();
  const [propertyError, setPropertyError] = useState<string>();
  const [selectedOutcome, setSelectedOutcome] = useState<number>();

  useEffect(() => {
    setName(variable?.name ?? "");
    setOutcomes(variable?.outcomes ?? []);
    setProperties(
      variable?.properties.map((property) => ({ ...property })) ?? [],
    );
    setNameError(undefined);
    setOutcomeError(undefined);
    setPropertyError(undefined);
    setSelectedOutcome(undefined);
  }, [variable]);

  if (!variable) {
    return (
      <aside className="node-inspector" aria-label="Node inspector">
        <h2>Node Inspector</h2>
        <p className="inspector-hint">Select a node to inspect it.</p>
      </aside>
    );
  }

  const commitName = () => {
    if (name === variable.name) return;
    const result = onRename(name);
    setNameError(messages(result));
    if (!result.ok) setName(variable.name);
  };

  const commitOutcome = (index: number) => {
    if (outcomes[index] === variable.outcomes[index]) return;
    const result = onRenameOutcome(index, outcomes[index]);
    setOutcomeError(messages(result));
    if (!result.ok) setOutcomes(variable.outcomes);
  };

  const commitProperties = (next: XmlProperty[]) => {
    const result = onSetProperties(next);
    setPropertyError(messages(result));
    if (!result.ok) setProperties(variable.properties);
  };

  return (
    <aside className="node-inspector" aria-label="Node inspector">
      <h2>Node Inspector</h2>

      <label>
        Type
        <input value={variable.type} readOnly />
      </label>

      <label>
        Name / identifier
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitName();
            if (event.key === "Escape") {
              setName(variable.name);
              setNameError(undefined);
            }
          }}
          aria-invalid={nameError ? "true" : undefined}
        />
      </label>
      {nameError && <p className="field-error">{nameError}</p>}

      {variable.type !== "utility" && (
        <section>
          <div className="inspector-section-heading">
            <h3>Outcomes</h3>
            <button
              type="button"
              onClick={() => {
                const names = new Set(variable.outcomes);
                let index = 0;
                while (names.has(`State${index}`)) index += 1;
                setOutcomeError(messages(onAddOutcome(`State${index}`)));
              }}
            >
              Add outcome
            </button>
          </div>
          <ol className="outcome-list">
            {outcomes.map((outcome, index) => (
              <li key={index}>
                <button
                  type="button"
                  className="outcome-index"
                  aria-label={`Select outcome ${index}`}
                  aria-pressed={selectedOutcome === index}
                  onClick={() => setSelectedOutcome(index)}
                >
                  {index}
                </button>
                <input
                  aria-label={`Outcome ${index}`}
                  value={outcome}
                  onChange={(event) =>
                    setOutcomes((current) =>
                      current.map((value, currentIndex) =>
                        currentIndex === index ? event.target.value : value,
                      ),
                    )
                  }
                  onBlur={() => commitOutcome(index)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitOutcome(index);
                    if (event.key === "Escape") {
                      setOutcomes(variable.outcomes);
                      setOutcomeError(undefined);
                    }
                  }}
                />
              </li>
            ))}
          </ol>
          <div className="outcome-actions">
            <button
              type="button"
              disabled={selectedOutcome === undefined || selectedOutcome === 0}
              onClick={() => {
                if (selectedOutcome === undefined || selectedOutcome === 0)
                  return;
                const order = variable.outcomes.map((_, index) => index);
                [order[selectedOutcome - 1], order[selectedOutcome]] = [
                  order[selectedOutcome],
                  order[selectedOutcome - 1],
                ];
                const result = onReorderOutcomes(order);
                setOutcomeError(messages(result));
                if (result.ok) setSelectedOutcome(selectedOutcome - 1);
              }}
            >
              Move up
            </button>
            <button
              type="button"
              disabled={
                selectedOutcome === undefined ||
                selectedOutcome === variable.outcomes.length - 1
              }
              onClick={() => {
                if (
                  selectedOutcome === undefined ||
                  selectedOutcome === variable.outcomes.length - 1
                )
                  return;
                const order = variable.outcomes.map((_, index) => index);
                [order[selectedOutcome], order[selectedOutcome + 1]] = [
                  order[selectedOutcome + 1],
                  order[selectedOutcome],
                ];
                const result = onReorderOutcomes(order);
                setOutcomeError(messages(result));
                if (result.ok) setSelectedOutcome(selectedOutcome + 1);
              }}
            >
              Move down
            </button>
            <button
              type="button"
              disabled={selectedOutcome === undefined}
              onClick={() => {
                if (selectedOutcome === undefined) return;
                const result = onRemoveOutcome(selectedOutcome);
                setOutcomeError(messages(result));
                if (result.ok) setSelectedOutcome(undefined);
              }}
            >
              Remove selected outcome
            </button>
          </div>
          {outcomeError && <p className="field-error">{outcomeError}</p>}
        </section>
      )}

      <section>
        <div className="inspector-section-heading">
          <h3>Raw properties</h3>
          <button
            type="button"
            onClick={() => {
              const next = [...properties, { text: "" }];
              setProperties(next);
              commitProperties(next);
            }}
          >
            Add Property
          </button>
        </div>
        <ol className="property-list">
          {properties.map((property, index) => (
            <li key={index}>
              <textarea
                aria-label={`Property ${index}`}
                value={property.text}
                onChange={(event) =>
                  setProperties((current) =>
                    current.map((value, currentIndex) =>
                      currentIndex === index
                        ? { text: event.target.value }
                        : value,
                    ),
                  )
                }
                onBlur={() => commitProperties(properties)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setProperties(
                      variable.properties.map((value) => ({ ...value })),
                    );
                    setPropertyError(undefined);
                  }
                }}
              />
              <button
                type="button"
                aria-label={`Remove property ${index}`}
                onClick={() => {
                  const next = properties.filter(
                    (_, currentIndex) => currentIndex !== index,
                  );
                  setProperties(next);
                  commitProperties(next);
                }}
              >
                Remove Property
              </button>
            </li>
          ))}
        </ol>
        {propertyError && <p className="field-error">{propertyError}</p>}
      </section>

      <section>
        <h3>
          {variable.type === "nature"
            ? "CPT"
            : variable.type === "decision"
              ? "Decision values"
              : "Utility values"}
        </h3>
        {network && variable.type === "nature" ? (
          <CptEditor
            network={network}
            childName={variable.name}
            onCommitRow={onSetCptDistribution}
          />
        ) : network ? (
          <RawValueEditor
            network={network}
            variableName={variable.name}
            onCommitRow={onSetRawTableRow}
          />
        ) : null}
      </section>
    </aside>
  );
}
