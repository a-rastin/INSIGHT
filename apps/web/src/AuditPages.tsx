import { type FormEvent, type ReactNode, useEffect, useState } from "react";

import {
  Banner,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  FormField,
  LoadingState,
  TextInput,
} from "./components/primitives";
import { apiClient } from "./generated/api-client";
import type { operations } from "./generated/api-types";

type OperationalResponse =
  operations["listOperationalAudit"]["responses"][200]["content"]["application/json"];
type ClinicalResponse =
  operations["listClinicalAudit"]["responses"][200]["content"]["application/json"];

const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function formatTimestamp(value: string, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "long",
    timeZone,
  }).format(new Date(value));
}

function isoDateTime(value: string) {
  return value ? new Date(value).toISOString() : undefined;
}

function JsonValue({ value }: { value: unknown }) {
  return value === null ? (
    <span>None</span>
  ) : (
    <pre className="audit-json">{JSON.stringify(value, null, 2)}</pre>
  );
}

function PageControls({
  page,
  onPage,
}: {
  page: { offset: number; limit: number; total: number };
  onPage: (offset: number) => void;
}) {
  const first = page.total === 0 ? 0 : page.offset + 1;
  const last = Math.min(page.offset + page.limit, page.total);
  return (
    <nav className="audit-pagination" aria-label="Audit pages">
      <span>
        Showing {first}-{last} of {page.total}
      </span>
      <Button
        variant="secondary"
        disabled={page.offset === 0}
        onClick={() => onPage(Math.max(0, page.offset - page.limit))}
      >
        Previous
      </Button>
      <Button
        variant="secondary"
        disabled={page.offset + page.limit >= page.total}
        onClick={() => onPage(page.offset + page.limit)}
      >
        Next
      </Button>
    </nav>
  );
}

function TimeZoneField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <FormField label="Display timezone">
      {(props) => (
        <select
          {...props}
          className="text-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value={localTimeZone}>Local ({localTimeZone})</option>
          {localTimeZone === "UTC" ? null : <option value="UTC">UTC</option>}
        </select>
      )}
    </FormField>
  );
}

export function OperationalAuditPage() {
  const [response, setResponse] = useState<OperationalResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [eventType, setEventType] = useState("");
  const [targetType, setTargetType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [limit, setLimit] = useState(25);
  const [timeZone, setTimeZone] = useState(localTimeZone);

  async function load(offset = 0) {
    setLoading(true);
    setError(false);
    try {
      const result = await apiClient.GET("/api/v1/admin/operational-audit", {
        params: {
          query: {
            offset,
            limit,
            ...(eventType ? { eventType } : {}),
            ...(targetType
              ? {
                  targetType: targetType as "USER" | "DEPLOYMENT_EVIDENCE" | "MODEL_ENDPOINT",
                }
              : {}),
            ...(from ? { from: isoDateTime(from) } : {}),
            ...(to ? { to: isoDateTime(to) } : {}),
          },
        },
      });
      if (!result.data) throw new Error("Audit response unavailable");
      setResponse(result.data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function filter(event: FormEvent) {
    event.preventDefault();
    void load();
  }

  const rows: Record<string, ReactNode>[] = (response?.events ?? []).map((event) => ({
    id: event.id,
    occurredAt: formatTimestamp(event.occurredAt, timeZone),
    eventType: event.eventType,
    actor: event.actorUserId ?? "System",
    target: event.target ? `${event.target.type} ${event.target.id}` : "None",
    metadata: (
      <details>
        <summary>Sanitized metadata</summary>
        <JsonValue value={{ before: event.beforeMetadata, after: event.afterMetadata }} />
      </details>
    ),
  }));

  return (
    <div className="page-stack">
      <Banner title="Operational metadata only" tone="info">
        Patient UUIDs, names, identifiers, free text, clinical values, and plans are excluded by the
        server query and response contract.
      </Banner>
      <Banner title="Ordinary audit-table limitation" tone="warning">
        These PostgreSQL rows are not hash chained, digitally signed, or tamper-evident. This view
        is read-only and provides no edit or delete action.
      </Banner>
      <form className="card audit-filters" onSubmit={filter}>
        <FormField label="Event type">
          {(props) => (
            <TextInput
              {...props}
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Target type">
          {(props) => (
            <select
              {...props}
              className="text-input"
              value={targetType}
              onChange={(e) => setTargetType(e.target.value)}
            >
              <option value="">All targets</option>
              <option value="USER">User</option>
              <option value="DEPLOYMENT_EVIDENCE">Deployment evidence</option>
              <option value="MODEL_ENDPOINT">Model endpoint</option>
            </select>
          )}
        </FormField>
        <FormField label="From">
          {(props) => (
            <TextInput
              {...props}
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          )}
        </FormField>
        <FormField label="To">
          {(props) => (
            <TextInput
              {...props}
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Rows per page">
          {(props) => (
            <select
              {...props}
              className="text-input"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            >
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
            </select>
          )}
        </FormField>
        <TimeZoneField value={timeZone} onChange={setTimeZone} />
        <Button type="submit">Apply filters</Button>
      </form>
      {loading ? <LoadingState label="Loading operational audit" /> : null}
      {error ? (
        <ErrorState
          title="Operational audit unavailable"
          description="Audit records could not be loaded."
        />
      ) : null}
      {!loading && !error && rows.length === 0 ? (
        <EmptyState title="No operational events" description="No events match current filters." />
      ) : null}
      {!loading && !error && rows.length > 0 ? (
        <section className="card" aria-labelledby="operational-events-title">
          <h2 id="operational-events-title">Operational events</h2>
          <DataTable
            ariaLabel="Operational audit events"
            caption={`Times displayed in ${timeZone}`}
            columns={[
              { key: "occurredAt", header: "Time" },
              { key: "eventType", header: "Event" },
              { key: "actor", header: "Actor" },
              { key: "target", header: "Target" },
              { key: "metadata", header: "Metadata" },
            ]}
            rows={rows}
            rowKey={(row) => String(row.id)}
          />
          {response ? (
            <PageControls page={response.page} onPage={(offset) => void load(offset)} />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

export function ClinicalAuditPage() {
  const [response, setResponse] = useState<ClinicalResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [patientId, setPatientId] = useState("");
  const [eventType, setEventType] = useState("");
  const [kind, setKind] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [limit, setLimit] = useState(25);
  const [timeZone, setTimeZone] = useState(localTimeZone);

  async function load(offset = 0) {
    setLoading(true);
    setError(false);
    try {
      const result = await apiClient.GET("/api/v1/clinical-audit", {
        params: {
          query: {
            patientId,
            offset,
            limit,
            ...(eventType ? { eventType } : {}),
            ...(kind ? { kind: kind as "PATIENT" | "WORKFLOW" } : {}),
            ...(from ? { from: isoDateTime(from) } : {}),
            ...(to ? { to: isoDateTime(to) } : {}),
          },
        },
      });
      if (!result.data) throw new Error("Audit response unavailable");
      setResponse(result.data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  function filter(event: FormEvent) {
    event.preventDefault();
    void load();
  }

  const rows: Record<string, ReactNode>[] = (response?.events ?? []).map((event) => ({
    id: event.id,
    occurredAt: formatTimestamp(event.occurredAt, timeZone),
    eventType: event.eventType,
    actor: event.actorUserId ?? "System",
    version: event.targetVersion,
    change: (
      <details>
        <summary>Before and after</summary>
        <h3>Before</h3>
        <JsonValue value={event.before} />
        <h3>After</h3>
        <JsonValue value={event.after} />
      </details>
    ),
    provenance: (
      <details>
        <summary>References</summary>
        <JsonValue value={event.provenance} />
      </details>
    ),
  }));

  return (
    <div className="page-stack">
      <Banner title="Authorized clinical audit path" tone="info">
        Patient and Research Case references remain searchable here after Patient deletion. Deleted
        Patients remain unavailable through registry and workflow routes.
      </Banner>
      <Banner title="Ordinary audit-table limitation" tone="warning">
        Retained history is sensitive, not anonymized, and not tamper-evident. This view is
        read-only and provides no edit or delete action.
      </Banner>
      <form className="card audit-filters" onSubmit={filter}>
        <FormField label="Patient UUID" required>
          {(props) => (
            <TextInput
              {...props}
              required
              pattern="[0-9a-fA-F-]{36}"
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Event type">
          {(props) => (
            <TextInput
              {...props}
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Event kind">
          {(props) => (
            <select
              {...props}
              className="text-input"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="">All events</option>
              <option value="PATIENT">Patient changes</option>
              <option value="WORKFLOW">Workflow transitions</option>
            </select>
          )}
        </FormField>
        <FormField label="From">
          {(props) => (
            <TextInput
              {...props}
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          )}
        </FormField>
        <FormField label="To">
          {(props) => (
            <TextInput
              {...props}
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Rows per page">
          {(props) => (
            <select
              {...props}
              className="text-input"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            >
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
            </select>
          )}
        </FormField>
        <TimeZoneField value={timeZone} onChange={setTimeZone} />
        <Button type="submit">Inspect history</Button>
      </form>
      {loading ? <LoadingState label="Loading clinical audit" /> : null}
      {error ? (
        <ErrorState
          title="Clinical audit unavailable"
          description="Authorized history could not be loaded."
        />
      ) : null}
      {!loading && !error && response && rows.length === 0 ? (
        <EmptyState
          title="No clinical events"
          description="No retained events match current filters."
        />
      ) : null}
      {!loading && !error && rows.length > 0 ? (
        <section className="card" aria-labelledby="clinical-events-title">
          <h2 id="clinical-events-title">Attributable clinical history</h2>
          <p>
            Patient <code>{response?.events[0]?.patientLink.patientId}</code>, Research Case{" "}
            <code>{response?.events[0]?.patientLink.researchCaseId}</code>
          </p>
          <DataTable
            ariaLabel="Clinical audit events"
            caption={`Times displayed in ${timeZone}`}
            columns={[
              { key: "occurredAt", header: "Time" },
              { key: "eventType", header: "Event" },
              { key: "actor", header: "Actor" },
              { key: "version", header: "Version" },
              { key: "change", header: "Attributable change" },
              { key: "provenance", header: "Provenance" },
            ]}
            rows={rows}
            rowKey={(row) => String(row.id)}
          />
          {response ? (
            <PageControls page={response.page} onPage={(offset) => void load(offset)} />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
