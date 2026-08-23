import { type FormEvent, useEffect, useState } from "react";
import {
  addParent,
  addVariable,
  deleteVariable,
  parsePositionProperty,
  parseXmlBif,
  removeParent,
  serializeXmlBif,
  setVariablePosition,
  validateFile,
  type Diagnostic,
  type MutationResult,
  type VariableType,
  type XmlBifFile,
  type XmlBifNetwork,
} from "@insight/bayes";

import { OutcomeEditor, TableEditor } from "./BnModelEditors";
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  ErrorState,
  FormField,
  LoadingState,
  TextInput,
} from "./components/primitives";
import { apiClient } from "./generated/api-client";
import type { operations } from "./generated/api-types";
import { detectXmlFidelityRisks } from "./xmlFidelity";

type Model =
  operations["getBnModelHistory"]["responses"][200]["content"]["application/json"]["models"][number];
type Network = Model["networks"][number];
type GraphNode = Network["nodes"][number];
type Point = { x: number; y: number };

function projectNetwork(network: XmlBifNetwork): Network {
  return {
    name: network.name,
    nodes: network.variables.map((variable) => {
      const definition = network.definitions.find(({ for: name }) => name === variable.name);
      return {
        id: variable.name,
        type: variable.type,
        outcomes: variable.outcomes,
        parents: definition?.given ?? [],
        properties: variable.properties.map(({ text }) => text),
        tableValueCount: definition?.table.length ?? 0,
        position:
          variable.properties
            .map(({ text }) => parsePositionProperty(text))
            .find((position) => position !== null) ?? null,
      };
    }),
    edges: network.definitions.flatMap((definition) =>
      definition.given.map((source) => ({ source, target: definition.for })),
    ),
  };
}

function requestMessage(error: unknown) {
  if (error && typeof error === "object" && "error" in error) {
    const value = error as { error?: { message?: unknown } };
    if (typeof value.error?.message === "string") return value.error.message;
  }
  return "BN Manager request failed.";
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("File could not be read."));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}

export function layoutNetwork(network: Network): Map<string, Point> {
  const explicit = network.nodes.every(({ position }) => position !== null);
  if (explicit) {
    const minX = Math.min(...network.nodes.map(({ position }) => position!.x));
    const minY = Math.min(...network.nodes.map(({ position }) => position!.y));
    return new Map(
      network.nodes.map(({ id, position }) => [
        id,
        {
          x: Math.min(position!.x - minX, 4_000) + 80,
          y: Math.min(position!.y - minY, 4_000) + 60,
        },
      ]),
    );
  }

  const names = new Set(network.nodes.map(({ id }) => id));
  const depth = new Map(network.nodes.map(({ id }) => [id, 0]));
  const incoming = new Map(network.nodes.map(({ id }) => [id, 0]));
  const children = new Map(network.nodes.map(({ id }) => [id, [] as string[]]));
  for (const { source, target } of network.edges) {
    if (!names.has(source) || !names.has(target)) continue;
    incoming.set(target, (incoming.get(target) ?? 0) + 1);
    children.get(source)!.push(target);
  }
  const queue = network.nodes.map(({ id }) => id).filter((id) => incoming.get(id) === 0);
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index]!;
    for (const child of children.get(parent) ?? []) {
      depth.set(child, Math.max(depth.get(child) ?? 0, (depth.get(parent) ?? 0) + 1));
      const remaining = (incoming.get(child) ?? 0) - 1;
      incoming.set(child, remaining);
      if (remaining === 0) queue.push(child);
    }
  }
  const rows = new Map<number, number>();
  return new Map(
    network.nodes.map(({ id }) => {
      const column = depth.get(id) ?? 0;
      const row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      return [id, { x: 90 + column * 230, y: 70 + row * 120 }];
    }),
  );
}

function NetworkGraph({
  network,
  selectedNode,
  onSelectNode,
  editable = false,
}: {
  network: Network;
  selectedNode?: string;
  onSelectNode: (node: string) => void;
  editable?: boolean;
}) {
  const positions = layoutNetwork(network);
  const width = Math.max(700, ...[...positions.values()].map(({ x }) => x + 130));
  const height = Math.max(300, ...[...positions.values()].map(({ y }) => y + 80));
  return (
    <div
      className="bn-graph-region"
      role="region"
      aria-label={editable ? "Editable network graph" : "Read-only network graph"}
      tabIndex={0}
    >
      <div className="bn-graph" style={{ width, height }}>
        <svg aria-hidden="true" width={width} height={height}>
          <defs>
            <marker
              id="bn-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
          </defs>
          {network.edges.map(({ source, target }, index) => {
            const from = positions.get(source);
            const to = positions.get(target);
            return from && to ? (
              <line
                key={`${source}:${target}:${index}`}
                x1={from.x + 55}
                y1={from.y + 20}
                x2={to.x - 55}
                y2={to.y + 20}
                markerEnd="url(#bn-arrow)"
              />
            ) : null;
          })}
        </svg>
        {network.nodes.map((node) => {
          const point = positions.get(node.id)!;
          return (
            <button
              key={node.id}
              type="button"
              className={`bn-node bn-node--${node.type}`}
              style={{ left: point.x, top: point.y }}
              aria-pressed={selectedNode === node.id}
              onClick={() => onSelectNode(node.id)}
            >
              <strong>{node.id}</strong>
              <span>{node.type}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GovernanceStatus({ label, value }: { label: string; value: Model["evidence"] }) {
  return (
    <div className="bn-governance-item">
      <dt>{label}</dt>
      <dd>
        <strong>{value.status.replaceAll("_", " ")}</strong>
        <span>{value.reference}</span>
        {value.notes ? <span>{value.notes}</span> : null}
      </dd>
    </div>
  );
}

function NodeInspector({ node }: { node?: GraphNode }) {
  return (
    <aside className="bn-inspector" aria-label="Node inspector">
      <h3>Node inspector</h3>
      {!node ? (
        <p>Select a graph node to inspect it.</p>
      ) : (
        <dl className="bn-inspector-list">
          <div>
            <dt>Name</dt>
            <dd className="mono-value">{node.id}</dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>{node.type}</dd>
          </div>
          <div>
            <dt>Parents</dt>
            <dd>{node.parents.join(", ") || "None"}</dd>
          </div>
          <div>
            <dt>Outcomes</dt>
            <dd>{node.outcomes.join(", ") || "None"}</dd>
          </div>
          <div>
            <dt>Table values</dt>
            <dd>{node.tableValueCount}</dd>
          </div>
          <div>
            <dt>Properties</dt>
            <dd>{node.properties.join("; ") || "None"}</dd>
          </div>
        </dl>
      )}
    </aside>
  );
}

export function BnManagerPage({ csrfToken }: { csrfToken: string }) {
  const [models, setModels] = useState<Model[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [networkIndex, setNetworkIndex] = useState(0);
  const [selectedNode, setSelectedNode] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<XmlBifFile>();
  const [sourceDraft, setSourceDraft] = useState("");
  const [xmlValid, setXmlValid] = useState(false);
  const [fidelityRisks, setFidelityRisks] = useState<
    ReturnType<typeof detectXmlFidelityRisks>
  >([]);
  const [fidelityAccepted, setFidelityAccepted] = useState(false);
  const [editDiagnostics, setEditDiagnostics] = useState<readonly Diagnostic[]>([]);
  const [newNodeType, setNewNodeType] = useState<VariableType>("nature");
  const [newNodeName, setNewNodeName] = useState("");
  const [arcParent, setArcParent] = useState("");
  const [arcChild, setArcChild] = useState("");

  async function load() {
    const result = await apiClient.GET("/api/v1/admin/bn-models");
    if (result.data) {
      setModels(result.data.models);
      setSelectedId((current) => current ?? result.data!.models[0]?.id);
      setError("");
    } else setError(requestMessage(result.error));
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("artifact");
    if (!(file instanceof File) || file.size === 0) {
      setError("Select a non-empty XMLBIF file.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await apiClient.POST("/api/v1/admin/bn-models/import", {
        headers: { "x-csrf-token": csrfToken },
        body: {
          schemaVersion: "1",
          pathwayIdentity: String(data.get("pathwayIdentity") ?? "")
            .trim()
            .toUpperCase(),
          fileName: file.name,
          artifactBase64: await fileBase64(file),
        },
      });
      if (result.data) {
        setModels((current) => [
          result.data!.model,
          ...current.filter(({ id }) => id !== result.data!.model.id),
        ]);
        setSelectedId(result.data.model.id);
        setNetworkIndex(0);
        setSelectedNode(undefined);
        form.reset();
      } else setError(requestMessage(result.error));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "File could not be uploaded.");
    } finally {
      setBusy(false);
    }
  }

  async function startEdit(model: Model) {
    setBusy(true);
    setError("");
    const result = await apiClient.GET("/api/v1/admin/bn-models/{modelId}/source", {
      params: { path: { modelId: model.id } },
    });
    if (result.data) {
      const parsed = parseXmlBif(result.data.sourceXml);
      if (parsed.ok) {
        const diagnostics = [...parsed.warnings, ...validateFile(parsed.file)];
        if (diagnostics.some(({ severity }) => severity === "error")) {
          setEditDiagnostics(diagnostics);
        } else {
          setDraft(parsed.file);
          setSourceDraft(result.data.sourceXml);
          setXmlValid(true);
          setFidelityRisks(detectXmlFidelityRisks(result.data.sourceXml));
          setFidelityAccepted(false);
          setNetworkIndex(0);
          setSelectedNode(undefined);
          setEditDiagnostics(diagnostics);
        }
      } else setEditDiagnostics(parsed.diagnostics);
    } else setError(requestMessage(result.error));
    setBusy(false);
  }

  function mutate(
    operation: (network: XmlBifNetwork, allowDataLoss: boolean) => MutationResult<XmlBifNetwork>,
  ) {
    const network = draft?.networks[networkIndex];
    if (!draft || !network) return;
    if (!xmlValid) return;
    if (
      fidelityRisks.length > 0 &&
      !fidelityAccepted &&
      !window.confirm(
        `Canonical XML will not preserve:\n${fidelityRisks
          .map(({ message }) => message)
          .join("\n")}\n\nContinue?`,
      )
    )
      return;
    if (fidelityRisks.length > 0) setFidelityAccepted(true);
    let result = operation(network, false);
    let dataLossConfirmed = false;
    if (
      !result.ok &&
      result.diagnostics.some(({ code }) => code === "RAW_TABLE_RESET_CONFIRMATION_REQUIRED")
    ) {
      if (!window.confirm(result.diagnostics.map(({ message }) => message).join("\n"))) return;
      dataLossConfirmed = true;
      result = operation(network, true);
    }
    if (!result.ok) {
      setEditDiagnostics(result.diagnostics);
      return;
    }
    if (
      result.warnings.length > 0 &&
      !dataLossConfirmed &&
      !window.confirm(
        `This edit changes table dimensions and may discard values:\n${result.warnings
          .map(({ message }) => message)
          .join("\n")}\n\nContinue?`,
      )
    )
      return;
    const nextDraft = {
      ...draft,
      networks: draft.networks.map((current, index) =>
        index === networkIndex ? result.value : current,
      ),
    };
    setDraft(nextDraft);
    setSourceDraft(serializeXmlBif(nextDraft));
    setXmlValid(true);
    setFidelityRisks([]);
    setEditDiagnostics(result.warnings);
  }

  function editXml(source: string) {
    setSourceDraft(source);
    setFidelityRisks(detectXmlFidelityRisks(source));
    setFidelityAccepted(false);
    const parsed = parseXmlBif(source);
    if (!parsed.ok) {
      setXmlValid(false);
      setEditDiagnostics(parsed.diagnostics);
      return;
    }
    const diagnostics = [...parsed.warnings, ...validateFile(parsed.file)];
    setEditDiagnostics(diagnostics);
    if (diagnostics.some(({ severity }) => severity === "error")) {
      setXmlValid(false);
      return;
    }
    setDraft(parsed.file);
    setXmlValid(true);
    if (!parsed.file.networks[networkIndex]) {
      setNetworkIndex(0);
      setSelectedNode(undefined);
    } else if (
      selectedNode &&
      !parsed.file.networks[networkIndex].variables.some(({ name }) => name === selectedNode)
    )
      setSelectedNode(undefined);
  }

  function addNode() {
    const network = draft?.networks[networkIndex];
    if (!network) return;
    const index = network.variables.length;
    mutate((current) =>
      addVariable(current, newNodeType, newNodeName.trim() || undefined, {
        x: 90 + (index % 4) * 230,
        y: 70 + Math.floor(index / 4) * 120,
      }),
    );
    setNewNodeName("");
  }

  function moveSelected(dx: number, dy: number) {
    const network = draft?.networks[networkIndex];
    if (!network || !selectedNode) return;
    const variable = network.variables.find(({ name }) => name === selectedNode);
    const point =
      variable?.properties
        .map(({ text }) => parsePositionProperty(text))
        .find((position) => position !== null) ??
      layoutNetwork(projectNetwork(network)).get(selectedNode);
    if (point)
      mutate((current) =>
        setVariablePosition(current, selectedNode, {
          x: point.x + dx,
          y: point.y + dy,
        }),
      );
  }

  async function saveCandidate() {
    if (!draft || !selected || !xmlValid) return;
    if (
      fidelityRisks.length > 0 &&
      !fidelityAccepted &&
      !window.confirm(
        `Saving deterministic XML will not preserve:\n${fidelityRisks
          .map(({ message }) => message)
          .join("\n")}\n\nContinue?`,
      )
    )
      return;
    setBusy(true);
    setError("");
    const result = await apiClient.POST("/api/v1/admin/bn-models/{modelId}/candidates", {
      params: { path: { modelId: selected.id } },
      headers: { "x-csrf-token": csrfToken },
      body: { schemaVersion: "1", sourceXml: serializeXmlBif(draft) },
    });
    if (result.data) {
      setModels((current) => [result.data!.model, ...current]);
      setSelectedId(result.data.model.id);
      setDraft(undefined);
      setSourceDraft("");
      setXmlValid(false);
      setFidelityRisks([]);
      setEditDiagnostics([]);
      setNetworkIndex(0);
      setSelectedNode(undefined);
    } else setError(requestMessage(result.error));
    setBusy(false);
  }

  if (loading) return <LoadingState label="Loading Bayesian model versions" />;
  if (error && models.length === 0)
    return (
      <ErrorState
        title="BN Manager unavailable"
        description={error}
        action={<Button onClick={() => void load()}>Retry</Button>}
      />
    );

  const selected = models.find(({ id }) => id === selectedId) ?? models[0];
  const draftNetwork = draft?.networks[networkIndex];
  const network = draftNetwork ? projectNetwork(draftNetwork) : selected?.networks[networkIndex];
  const node = network?.nodes.find(({ id }) => id === selectedNode);
  return (
    <div className="page-stack bn-manager">
      <Banner title="Software validity is not clinical validity" tone="warning">
        Passing XMLBIF checks allows software use. It does not establish evidence quality,
        calibration, clinical validity, safety, or effectiveness.
      </Banner>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="card" aria-labelledby="bn-upload-title">
        <div className="section-heading">
          <div>
            <p className="kicker">Artifact API</p>
            <h2 id="bn-upload-title">Upload immutable model version</h2>
          </div>
        </div>
        <form className="bn-upload-form" onSubmit={upload}>
          <FormField
            label="Pathway identity"
            required
            hint="Uppercase governed ID, for example PHARMACOTHERAPY."
          >
            {(props) => (
              <TextInput
                {...props}
                name="pathwayIdentity"
                pattern="[A-Za-z][A-Za-z0-9_]*"
                maxLength={128}
                required
              />
            )}
          </FormField>
          <FormField label="XMLBIF file" required>
            {(props) => (
              <input
                {...props}
                className="text-input"
                name="artifact"
                type="file"
                accept=".xml,application/xml,text/xml"
                required
              />
            )}
          </FormField>
          <Button type="submit" loading={busy}>
            Upload and validate
          </Button>
        </form>
      </section>

      {models.length === 0 ? (
        <EmptyState
          title="No Bayesian model versions"
          description="Upload an XMLBIF artifact to create first immutable version."
        />
      ) : (
        <div className="bn-workspace">
          <section className="card bn-version-panel" aria-labelledby="bn-versions-title">
            <h2 id="bn-versions-title">Immutable versions</h2>
            <ul className="bn-version-list">
              {models.map((model) => (
                <li key={model.id}>
                  <button
                    type="button"
                    aria-pressed={model.id === selected?.id}
                    disabled={Boolean(draft && model.id !== selected?.id)}
                    onClick={() => {
                      setSelectedId(model.id);
                      setNetworkIndex(0);
                      setSelectedNode(undefined);
                    }}
                  >
                    <span>
                      <strong>{model.pathwayIdentity}</strong>
                      <small>Version {model.version}</small>
                    </span>
                    <Badge tone={model.validation.softwareCompatible ? "normal" : "urgent"}>
                      {model.lifecycle}
                    </Badge>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {selected ? (
            <div className="page-stack bn-detail">
              <section className="card" aria-labelledby="bn-validity-title">
                <div className="section-heading">
                  <div>
                    <p className="kicker">Software diagnostics</p>
                    <h2 id="bn-validity-title">
                      {selected.pathwayIdentity} version {selected.version}
                    </h2>
                  </div>
                  <Badge tone={selected.validation.softwareCompatible ? "normal" : "urgent"}>
                    {selected.validation.softwareCompatible ? "Software valid" : "Software invalid"}
                  </Badge>
                </div>
                <dl className="bn-check-list">
                  {selected.validation.checks.map((check) => (
                    <div key={check.code}>
                      <dt>{check.code.replaceAll("_", " ")}</dt>
                      <dd>
                        <Badge tone={check.passed ? "normal" : "urgent"}>
                          {check.passed ? "Passed" : "Failed"}
                        </Badge>
                        <span>{check.detail}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
                <div className="bn-diagnostics" role="status" aria-label="Diagnostics">
                  <strong>
                    {
                      selected.validation.diagnostics.filter(({ severity }) => severity === "error")
                        .length
                    }{" "}
                    errors,{" "}
                    {
                      selected.validation.diagnostics.filter(
                        ({ severity }) => severity === "warning",
                      ).length
                    }{" "}
                    warnings
                  </strong>
                  {selected.validation.diagnostics.length === 0 ? (
                    <p>No diagnostics.</p>
                  ) : (
                    <ul>
                      {selected.validation.diagnostics.map((diagnostic, index) => (
                        <li
                          key={`${diagnostic.code}:${index}`}
                          className={`bn-diagnostic--${diagnostic.severity}`}
                        >
                          <strong>
                            {diagnostic.severity}: {diagnostic.code}
                          </strong>
                          <span>{diagnostic.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>

              <section className="card" aria-labelledby="bn-governance-title">
                <div className="section-heading">
                  <div>
                    <p className="kicker">Independent governance status</p>
                    <h2 id="bn-governance-title">Evidence and calibration</h2>
                  </div>
                  <Badge tone="warning">
                    Clinical validity {selected.validation.clinicalValidity.replaceAll("_", " ")}
                  </Badge>
                </div>
                <dl className="bn-governance-grid">
                  <GovernanceStatus label="Evidence" value={selected.evidence} />
                  <GovernanceStatus label="Calibration" value={selected.calibration} />
                  <GovernanceStatus label="Clinical review" value={selected.clinicalReview} />
                </dl>
              </section>

              <section className="card" aria-labelledby="bn-source-title">
                <h2 id="bn-source-title">Source metadata</h2>
                <dl className="profile-grid">
                  <div>
                    <dt>File</dt>
                    <dd>{selected.source.fileName}</dd>
                  </div>
                  <div>
                    <dt>Imported</dt>
                    <dd>{new Date(selected.source.importedAt).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Size</dt>
                    <dd>{selected.source.byteLength.toLocaleString()} bytes</dd>
                  </div>
                  <div>
                    <dt>Importer</dt>
                    <dd>{selected.source.importerVersion}</dd>
                  </div>
                  <div>
                    <dt>Content SHA-256</dt>
                    <dd className="mono-value">{selected.source.contentSha256}</dd>
                  </div>
                  <div>
                    <dt>Semantic SHA-256</dt>
                    <dd className="mono-value">
                      {selected.source.semanticSha256 ?? "Unavailable"}
                    </dd>
                  </div>
                  <div>
                    <dt>Topology SHA-256</dt>
                    <dd className="mono-value">
                      {selected.source.topologySha256 ?? "Unavailable"}
                    </dd>
                  </div>
                </dl>
              </section>

              {(draft?.networks.length ?? selected.networks.length) > 0 ? (
                <section className="card" aria-labelledby="bn-graph-title">
                  <div className="section-heading">
                    <div>
                      <p className="kicker">{draft ? "Candidate draft" : "Read only"}</p>
                      <h2 id="bn-graph-title">Model graph</h2>
                    </div>
                    <div className="bn-graph-actions">
                      {!draft ? (
                        <Button
                          type="button"
                          variant="secondary"
                          loading={busy}
                          disabled={!selected.validation.softwareCompatible}
                          onClick={() => void startEdit(selected)}
                        >
                          Edit structure
                        </Button>
                      ) : (
                        <>
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => {
                              setDraft(undefined);
                              setSourceDraft("");
                              setXmlValid(false);
                              setFidelityRisks([]);
                              setEditDiagnostics([]);
                              setSelectedNode(undefined);
                            }}
                          >
                            Cancel edit
                          </Button>
                          <Button
                            type="button"
                            loading={busy}
                            disabled={!xmlValid}
                            onClick={() => void saveCandidate()}
                          >
                            Save as candidate version
                          </Button>
                        </>
                      )}
                    </div>
                    {(draft?.networks.length ?? selected.networks.length) > 1 ? (
                      <label className="bn-network-select">
                        Network
                        <select
                          value={networkIndex}
                          onChange={(event) => {
                            setNetworkIndex(Number(event.target.value));
                            setSelectedNode(undefined);
                          }}
                        >
                          {(draft?.networks ?? selected.networks).map((item, index) => (
                            <option key={`${item.name}:${index}`} value={index}>
                              {item.name || `Network ${index + 1}`}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </div>
                  {draftNetwork && network ? (
                    <div className="bn-edit-panel" aria-label="Graph structure editor">
                      <div className="bn-edit-group">
                        <label>
                          Node type
                          <select
                            value={newNodeType}
                            onChange={(event) => setNewNodeType(event.target.value as VariableType)}
                          >
                            <option value="nature">Nature</option>
                            <option value="decision">Decision</option>
                            <option value="utility">Utility</option>
                          </select>
                        </label>
                        <label>
                          Node ID (optional)
                          <input
                            className="text-input"
                            value={newNodeName}
                            pattern="[A-Za-z_][A-Za-z0-9_]*"
                            onChange={(event) => setNewNodeName(event.target.value)}
                          />
                        </label>
                        <Button type="button" variant="secondary" onClick={addNode}>
                          Add node
                        </Button>
                      </div>
                      <div className="bn-edit-group">
                        <label>
                          Parent
                          <select
                            value={arcParent}
                            onChange={(event) => setArcParent(event.target.value)}
                          >
                            <option value="">Select</option>
                            {network.nodes.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.id}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Child
                          <select
                            value={arcChild}
                            onChange={(event) => setArcChild(event.target.value)}
                          >
                            <option value="">Select</option>
                            {network.nodes.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.id}
                              </option>
                            ))}
                          </select>
                        </label>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={!arcParent || !arcChild}
                          onClick={() =>
                            mutate((current) => addParent(current, arcChild, arcParent))
                          }
                        >
                          Connect nodes
                        </Button>
                      </div>
                      {editDiagnostics.length ? (
                        <ul className="bn-edit-diagnostics" aria-label="Edit diagnostics">
                          {editDiagnostics.map((item, index) => (
                            <li key={`${item.code}:${index}`}>
                              <strong>{item.code}</strong>: {item.message}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <section className="bn-xml-editor" aria-labelledby="bn-xml-editor-title">
                        <div className="section-heading">
                          <h3 id="bn-xml-editor-title">XML source</h3>
                          <Badge tone={xmlValid ? "normal" : "urgent"}>
                            {xmlValid ? "Synchronized" : "Draft invalid"}
                          </Badge>
                        </div>
                        <label>
                          XMLBIF source
                          <textarea
                            className="text-input mono-value"
                            rows={16}
                            value={sourceDraft}
                            onChange={(event) => editXml(event.target.value)}
                          />
                        </label>
                        {!xmlValid ? (
                          <p className="field-error" role="alert">
                            Graph and table editors still show last valid model. Fix XML before saving.
                          </p>
                        ) : null}
                      </section>
                    </div>
                  ) : null}
                  {network ? (
                    <div className="bn-graph-layout">
                      <NetworkGraph
                        network={network}
                        selectedNode={selectedNode}
                        onSelectNode={setSelectedNode}
                        editable={Boolean(draft)}
                      />
                      <div className="page-stack">
                        <NodeInspector node={node} />
                        {draftNetwork && node ? (
                          <div className="bn-node-actions" aria-label="Selected node actions">
                            <OutcomeEditor
                              network={draftNetwork}
                              variableName={node.id}
                              onApply={mutate}
                            />
                            <TableEditor
                              network={draftNetwork}
                              variableName={node.id}
                              onApply={mutate}
                            />
                            <strong>Move node</strong>
                            <div>
                              <Button
                                type="button"
                                variant="secondary"
                                onClick={() => moveSelected(-40, 0)}
                              >
                                Left
                              </Button>
                              <Button
                                type="button"
                                variant="secondary"
                                onClick={() => moveSelected(40, 0)}
                              >
                                Right
                              </Button>
                              <Button
                                type="button"
                                variant="secondary"
                                onClick={() => moveSelected(0, -40)}
                              >
                                Up
                              </Button>
                              <Button
                                type="button"
                                variant="secondary"
                                onClick={() => moveSelected(0, 40)}
                              >
                                Down
                              </Button>
                            </div>
                            <Button
                              type="button"
                              variant="danger"
                              onClick={() =>
                                mutate((current, allowDataLoss) =>
                                  deleteVariable(current, node.id, { allowDataLoss }),
                                )
                              }
                            >
                              Delete node
                            </Button>
                            {node.parents.map((parent) => (
                              <Button
                                key={parent}
                                type="button"
                                variant="secondary"
                                onClick={() =>
                                  mutate((current, allowDataLoss) =>
                                    removeParent(current, node.id, parent, { allowDataLoss }),
                                  )
                                }
                              >
                                Remove arc {parent} to {node.id}
                              </Button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </section>
              ) : (
                <Banner title="Graph unavailable" tone="urgent">
                  XML could not be parsed into a graph. Review software diagnostics.
                </Banner>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
