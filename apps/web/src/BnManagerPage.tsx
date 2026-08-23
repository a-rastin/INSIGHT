import { type FormEvent, useEffect, useState } from "react";

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

type Model =
  operations["getBnModelHistory"]["responses"][200]["content"]["application/json"]["models"][number];
type Network = Model["networks"][number];
type GraphNode = Network["nodes"][number];
type Point = { x: number; y: number };

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
}: {
  network: Network;
  selectedNode?: string;
  onSelectNode: (node: string) => void;
}) {
  const positions = layoutNetwork(network);
  const width = Math.max(700, ...[...positions.values()].map(({ x }) => x + 130));
  const height = Math.max(300, ...[...positions.values()].map(({ y }) => y + 80));
  return (
    <div
      className="bn-graph-region"
      role="region"
      aria-label="Read-only network graph"
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
  const network = selected?.networks[networkIndex];
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

              {selected.networks.length > 0 ? (
                <section className="card" aria-labelledby="bn-graph-title">
                  <div className="section-heading">
                    <div>
                      <p className="kicker">Read only</p>
                      <h2 id="bn-graph-title">Model graph</h2>
                    </div>
                    {selected.networks.length > 1 ? (
                      <label className="bn-network-select">
                        Network
                        <select
                          value={networkIndex}
                          onChange={(event) => {
                            setNetworkIndex(Number(event.target.value));
                            setSelectedNode(undefined);
                          }}
                        >
                          {selected.networks.map((item, index) => (
                            <option key={`${item.name}:${index}`} value={index}>
                              {item.name || `Network ${index + 1}`}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </div>
                  {network ? (
                    <div className="bn-graph-layout">
                      <NetworkGraph
                        network={network}
                        selectedNode={selectedNode}
                        onSelectNode={setSelectedNode}
                      />
                      <NodeInspector node={node} />
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
