import {
  type FormEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";

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
import { Dsm5trAssessment } from "./Dsm5trAssessment";
import { apiClient } from "./generated/api-client";
import type { operations } from "./generated/api-types";

type Patient =
  operations["listPatients"]["responses"][200]["content"]["application/json"]["patients"][number];
type CreatePatientBody =
  operations["createOrOpenPatient"]["requestBody"]["content"]["application/json"];
type LoadError = "unauthorized" | "failure";

function open(
  event: MouseEvent<HTMLAnchorElement>,
  path: string,
  onNavigate: (path: string) => void,
) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  event.preventDefault();
  onNavigate(path);
}

function loadError(status: number): LoadError {
  return status === 401 || status === 403 ? "unauthorized" : "failure";
}

function AccessError({ error, retry }: { error: LoadError; retry: () => void }) {
  return (
    <ErrorState
      title={
        error === "unauthorized" ? "Patient registry access denied" : "Patient registry unavailable"
      }
      description={
        error === "unauthorized"
          ? "Your session is not authorized to access Patient content."
          : "Patient data could not be loaded. Try again."
      }
      action={<Button onClick={retry}>Try again</Button>}
    />
  );
}

export function PatientRegistryPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [patients, setPatients] = useState<Patient[] | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [query, setQuery] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setPatients(null);
    setError(null);
    void apiClient
      .GET("/api/v1/patients")
      .then((result) => {
        if (!active) return;
        if (result.data) setPatients([...result.data.patients]);
        else setError(loadError(result.response.status));
      })
      .catch(() => {
        if (active) setError("failure");
      });
    return () => {
      active = false;
    };
  }, [reload]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("en-US");
    if (!needle) return patients ?? [];
    return (patients ?? []).filter((patient) =>
      [
        patient.firstName,
        patient.lastName,
        `${patient.firstName} ${patient.lastName}`,
        patient.officialIdentifier.value,
        patient.dateOfBirth,
        patient.sex,
      ].some((value) => value.toLocaleLowerCase("en-US").includes(needle)),
    );
  }, [patients, query]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(String(new FormData(event.currentTarget).get("patient-search") ?? ""));
  }

  const columns = [
    { key: "name", header: "Patient" },
    { key: "identifier", header: "Official identifier" },
    { key: "age", header: "Current age" },
    { key: "sex", header: "Sex" },
    { key: "updated", header: "Updated" },
    { key: "action", header: "Action" },
  ];
  const rows: Record<string, ReactNode>[] = filtered.map((patient) => ({
    id: patient.id,
    name: `${patient.firstName} ${patient.lastName}`,
    identifier: patient.officialIdentifier.value,
    age: patient.profileAge,
    sex: patient.sex === "MALE" ? "Male" : "Female",
    updated: new Date(patient.updatedAt).toLocaleDateString(),
    action: (
      <a
        href={`/patients/${patient.id}`}
        onClick={(event) => open(event, `/patients/${patient.id}`, onNavigate)}
      >
        Open profile
      </a>
    ),
  }));

  return (
    <div className="page-stack">
      <section className="card" aria-labelledby="patient-search-title">
        <div className="section-heading">
          <div>
            <p className="kicker">Shared patient registry</p>
            <h2 id="patient-search-title">Find a patient</h2>
          </div>
          <a
            className="button button--primary"
            href="/patients/new"
            onClick={(event) => open(event, "/patients/new", onNavigate)}
          >
            Create patient
          </a>
        </div>
        <form className="inline-form" onSubmit={search} role="search">
          <FormField
            label="Search patients"
            hint="Search by name, official identifier, birth date, or sex."
          >
            {(fieldProps) => <TextInput {...fieldProps} name="patient-search" autoComplete="off" />}
          </FormField>
          <Button type="submit">Search</Button>
        </form>
      </section>
      {!patients && !error ? <LoadingState label="Loading patient registry" /> : null}
      {error ? <AccessError error={error} retry={() => setReload((value) => value + 1)} /> : null}
      {patients && patients.length === 0 ? (
        <EmptyState
          title="No patients in registry"
          description="Create the first Patient record for this research deployment."
          action={<Button onClick={() => onNavigate("/patients/new")}>Create patient</Button>}
        />
      ) : null}
      {patients && patients.length > 0 && filtered.length === 0 ? (
        <EmptyState
          title="No matching patients"
          description="No shared Patient record matches this search."
        />
      ) : null}
      {patients && filtered.length > 0 ? (
        <section className="card" aria-labelledby="registry-list-title">
          <h2 id="registry-list-title">Patients</h2>
          <DataTable
            ariaLabel="Shared patient registry"
            caption={`${filtered.length} Patient record${filtered.length === 1 ? "" : "s"}`}
            columns={columns}
            rows={rows}
            rowKey={(row) => String(row.id)}
          />
        </section>
      ) : null}
    </div>
  );
}

export function CreatePatientPage({
  csrfToken,
  onNavigate,
}: {
  csrfToken: string;
  onNavigate: (path: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<"invalid" | LoadError | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const body: CreatePatientBody = {
      schemaVersion: "1",
      officialIdentifier: {
        type: String(
          data.get("identifier-type"),
        ) as CreatePatientBody["officialIdentifier"]["type"],
        issuingAuthority: String(
          data.get("identifier-issuer"),
        ) as CreatePatientBody["officialIdentifier"]["issuingAuthority"],
        value: String(data.get("identifier-value")),
      },
      firstName: String(data.get("first-name")),
      lastName: String(data.get("last-name")),
      dateOfBirth: String(data.get("date-of-birth")),
      sex: String(data.get("sex")) as CreatePatientBody["sex"],
    };

    try {
      const result = await apiClient.POST("/api/v1/patients", {
        headers: { "x-csrf-token": csrfToken },
        body,
      });
      if (result.data) onNavigate(`/patients/${result.data.patient.id}`);
      else if (result.response.status === 400) setError("invalid");
      else setError(loadError(result.response.status));
    } catch {
      setError("failure");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-stack">
      {error === "invalid" ? (
        <Banner title="Patient data is invalid" tone="urgent">
          Check every field and submit again. Patient age must be between 18 and 99.
        </Banner>
      ) : null}
      {error === "unauthorized" || error === "failure" ? (
        <AccessError error={error} retry={() => setError(null)} />
      ) : null}
      <section className="card" aria-labelledby="create-patient-title">
        <div className="section-heading">
          <div>
            <p className="kicker">Patient identity</p>
            <h2 id="create-patient-title">Create or open patient</h2>
          </div>
        </div>
        <p className="field-hint">
          A matching normalized official identifier updates and opens the existing shared record
          without confirmation.
        </p>
        <form className="patient-form" onSubmit={submit}>
          <FormField label="First name" required>
            {(props) => (
              <TextInput
                {...props}
                name="first-name"
                required
                maxLength={128}
                pattern="[A-Za-z]+(?:(?: |'|-)[A-Za-z]+)*"
                autoComplete="off"
              />
            )}
          </FormField>
          <FormField label="Last name" required>
            {(props) => (
              <TextInput
                {...props}
                name="last-name"
                required
                maxLength={128}
                pattern="[A-Za-z]+(?:(?: |'|-)[A-Za-z]+)*"
                autoComplete="off"
              />
            )}
          </FormField>
          <FormField label="Date of birth" required>
            {(props) => (
              <TextInput {...props} name="date-of-birth" type="date" required autoComplete="off" />
            )}
          </FormField>
          <FormField label="Sex" required>
            {(props) => (
              <select className="text-input" {...props} name="sex" required defaultValue="">
                <option value="" disabled>
                  Select sex
                </option>
                <option value="MALE">Male</option>
                <option value="FEMALE">Female</option>
              </select>
            )}
          </FormField>
          <FormField label="Official identifier type" required>
            {(props) => (
              <TextInput
                {...props}
                name="identifier-type"
                required
                maxLength={128}
                autoComplete="off"
              />
            )}
          </FormField>
          <FormField label="Issuing authority" required>
            {(props) => (
              <TextInput
                {...props}
                name="identifier-issuer"
                required
                maxLength={256}
                autoComplete="off"
              />
            )}
          </FormField>
          <FormField label="Official identifier value" required>
            {(props) => (
              <TextInput
                {...props}
                name="identifier-value"
                required
                maxLength={256}
                autoComplete="off"
              />
            )}
          </FormField>
          <div className="form-actions">
            <Button type="submit" loading={loading}>
              Create or open patient
            </Button>
            <Button type="button" variant="secondary" onClick={() => onNavigate("/patients")}>
              Cancel
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function PatientProfilePage({
  patientId,
  csrfToken,
  onNavigate,
}: {
  patientId: string;
  csrfToken: string;
  onNavigate: (path: string) => void;
}) {
  const [patient, setPatient] = useState<Patient | null>(null);
  const [error, setError] = useState<LoadError | "not-found" | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setPatient(null);
    setError(null);
    void apiClient
      .GET("/api/v1/patients/{patientId}", { params: { path: { patientId } } })
      .then((result) => {
        if (!active) return;
        if (result.data) setPatient(result.data.patient);
        else if (result.response.status === 404) setError("not-found");
        else setError(loadError(result.response.status));
      })
      .catch(() => {
        if (active) setError("failure");
      });
    return () => {
      active = false;
    };
  }, [patientId, reload]);

  if (!patient && !error) return <LoadingState label="Loading patient profile" />;
  if (error === "not-found") {
    return (
      <ErrorState
        title="Patient profile not found"
        description="This Patient record is unavailable or the link is invalid."
        action={<Button onClick={() => onNavigate("/patients")}>Return to registry</Button>}
      />
    );
  }
  if (error) return <AccessError error={error} retry={() => setReload((value) => value + 1)} />;
  if (!patient) return null;

  return (
    <div className="page-stack">
      <section className="card" aria-labelledby="patient-profile-title">
        <div className="section-heading">
          <div>
            <p className="kicker">Patient profile</p>
            <h2 id="patient-profile-title">
              {patient.firstName} {patient.lastName}
            </h2>
          </div>
          <Button variant="secondary" onClick={() => onNavigate("/patients")}>
            Back to registry
          </Button>
        </div>
        <dl className="profile-grid">
          <div>
            <dt>Current age</dt>
            <dd>{patient.profileAge}</dd>
          </div>
          <div>
            <dt>Date of birth</dt>
            <dd>{patient.dateOfBirth}</dd>
          </div>
          <div>
            <dt>Sex</dt>
            <dd>{patient.sex === "MALE" ? "Male" : "Female"}</dd>
          </div>
          <div>
            <dt>Official identifier</dt>
            <dd>{patient.officialIdentifier.value}</dd>
          </div>
          <div>
            <dt>Identifier type</dt>
            <dd>{patient.officialIdentifier.type}</dd>
          </div>
          <div>
            <dt>Issuing authority</dt>
            <dd>{patient.officialIdentifier.issuingAuthority}</dd>
          </div>
          <div>
            <dt>Research Case started</dt>
            <dd>{new Date(patient.researchCase.startedAt).toLocaleDateString()}</dd>
          </div>
          <div>
            <dt>Age at Research Case start</dt>
            <dd>{patient.researchCase.ageAtStart}</dd>
          </div>
        </dl>
      </section>
      <nav className="case-stepper" aria-label="Research Case steps">
        <ol>
          {[
            "Patient demographics",
            "DSM-5-TR schizophrenia criteria",
            "PANSS",
            "C-SSRS suicide-risk screen",
            "Medical history",
            "Medication normalization",
            "AI and Bayesian processing",
            "DDI and Primary Treatment Plan",
            "Psychiatrist review",
            "Final Treatment Plan",
          ].map((label, index) => (
            <li key={label} aria-current={index === 1 ? "step" : undefined}>
              <span>{index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      </nav>
      <Dsm5trAssessment patientId={patientId} csrfToken={csrfToken} />
    </div>
  );
}
