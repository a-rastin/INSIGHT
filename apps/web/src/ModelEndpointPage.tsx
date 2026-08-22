import { type FormEvent, useEffect, useState } from "react";

import {
  Badge,
  Banner,
  Button,
  ErrorState,
  FormField,
  LoadingState,
  TextInput,
} from "./components/primitives";
import { apiClient } from "./generated/api-client";
import type { operations } from "./generated/api-types";

type Configuration = NonNullable<
  operations["getModelEndpointConfiguration"]["responses"][200]["content"]["application/json"]["configuration"]
>;

function message(error: unknown) {
  if (error && typeof error === "object" && "error" in error) {
    const value = error as { error?: { message?: unknown } };
    if (typeof value.error?.message === "string") return value.error.message;
  }
  return "Model endpoint request failed.";
}

export function ModelEndpointPage({ csrfToken }: { csrfToken: string }) {
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    const result = await apiClient.GET("/api/v1/admin/model-endpoint");
    if (result.data) {
      setConfiguration(result.data.configuration);
      setError("");
    } else setError(message(result.error));
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (
      !configuration?.credentialConfigured ||
      !["PENDING", "CHECKING"].includes(configuration.status)
    ) {
      return;
    }
    const timer = window.setTimeout(() => void load(), 1_000);
    return () => window.clearTimeout(timer);
  }, [configuration?.credentialConfigured, configuration?.status]);

  async function replace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = event.currentTarget;
    const data = new FormData(form);
    const result = await apiClient.PUT("/api/v1/admin/model-endpoint", {
      headers: { "x-csrf-token": csrfToken },
      body: {
        baseUrl: String(data.get("baseUrl") ?? ""),
        model: String(data.get("model") ?? ""),
        credential: String(data.get("credential") ?? ""),
      },
    });
    if (result.data?.configuration) {
      setConfiguration(result.data.configuration);
      form.reset();
    } else setError(message(result.error));
    setBusy(false);
  }

  async function check() {
    setBusy(true);
    setError("");
    const result = await apiClient.POST("/api/v1/admin/model-endpoint/check", {
      headers: { "x-csrf-token": csrfToken },
    });
    if (result.data?.configuration) setConfiguration(result.data.configuration);
    else setError(message(result.error));
    setBusy(false);
  }

  async function clear() {
    setBusy(true);
    setError("");
    const result = await apiClient.DELETE("/api/v1/admin/model-endpoint/credential", {
      headers: { "x-csrf-token": csrfToken },
    });
    if (result.data?.configuration) setConfiguration(result.data.configuration);
    else setError(message(result.error));
    setBusy(false);
  }

  if (loading) return <LoadingState label="Loading model endpoint" />;
  if (error && !configuration)
    return (
      <ErrorState
        title="Model endpoint unavailable"
        description={error}
        action={<Button onClick={() => void load()}>Retry</Button>}
      />
    );

  const statusTone =
    configuration?.status === "COMPATIBLE"
      ? "normal"
      : configuration?.status === "INCOMPATIBLE"
        ? "urgent"
        : "warning";
  return (
    <div className="page-stack">
      <Banner title="Accepted hosted-provider risk" tone="warning">
        Provider retention, training, and data-processing agreement terms do not block activation.
        De-identified clinical projections may be retained, analyzed, or used for training under
        provider terms. Direct identifiers remain prohibited.
      </Banner>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="card" aria-labelledby="endpoint-status-title">
        <div className="section-heading">
          <div>
            <p className="kicker">Current configuration</p>
            <h2 id="endpoint-status-title">Compatibility</h2>
          </div>
          <Badge tone={statusTone}>{configuration?.status ?? "PENDING"}</Badge>
        </div>
        {configuration ? (
          <dl className="profile-grid">
            <div>
              <dt>Version</dt>
              <dd>{configuration.version}</dd>
            </div>
            <div>
              <dt>AI eligibility</dt>
              <dd>{configuration.aiEligible ? "Eligible" : "Disabled"}</dd>
            </div>
            <div>
              <dt>Base URL</dt>
              <dd className="mono-value">{configuration.baseUrl}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd className="mono-value">{configuration.model}</dd>
            </div>
            <div>
              <dt>Credential</dt>
              <dd>{configuration.credentialConfigured ? "Configured" : "Not configured"}</dd>
            </div>
            <div>
              <dt>Last checked</dt>
              <dd>
                {configuration.lastCheckedAt
                  ? new Date(configuration.lastCheckedAt).toLocaleString()
                  : "Not checked"}
              </dd>
            </div>
            {configuration.failureCategory ? (
              <div>
                <dt>Safe failure category</dt>
                <dd>{configuration.failureCategory.replaceAll("_", " ")}</dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p>No model endpoint configured.</p>
        )}
        <div className="row-actions model-endpoint-actions">
          <Button
            variant="secondary"
            onClick={() => void check()}
            disabled={busy || !configuration?.credentialConfigured}
          >
            Retry check
          </Button>
          <Button
            variant="danger"
            onClick={() => void clear()}
            disabled={busy || !configuration?.credentialConfigured}
          >
            Clear credential
          </Button>
        </div>
      </section>
      <section className="card" aria-labelledby="replace-endpoint-title">
        <h2 id="replace-endpoint-title">Replace configuration</h2>
        <p>
          Enter API root including provider path such as <span className="mono-value">/v1</span>. Do
          not include final <span className="mono-value">/chat/completions</span>.
        </p>
        <form className="page-stack" onSubmit={replace}>
          <FormField
            label="Base URL"
            hint="Absolute HTTPS URL. Development mode permits loopback HTTP only."
            required
          >
            {(props) => (
              <TextInput
                {...props}
                name="baseUrl"
                type="url"
                defaultValue={configuration?.baseUrl}
                required
                maxLength={2000}
              />
            )}
          </FormField>
          <FormField label="Model" required>
            {(props) => (
              <TextInput
                {...props}
                name="model"
                defaultValue={configuration?.model}
                required
                maxLength={500}
              />
            )}
          </FormField>
          <FormField
            label="API key"
            hint="Write-only. INSIGHT never displays or returns the saved value."
            required
          >
            {(props) => (
              <TextInput
                {...props}
                name="credential"
                type="password"
                required
                maxLength={4096}
                autoComplete="new-password"
              />
            )}
          </FormField>
          <div>
            <Button type="submit" loading={busy}>
              Replace and check
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
