import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreatePatientPage, PatientProfilePage, PatientRegistryPage } from "./PatientPages";

const patient = {
  id: "20000000-0000-4000-8000-000000000001",
  officialIdentifier: {
    type: "CONFIGURED_OFFICIAL_ID" as const,
    issuingAuthority: "CONFIGURED_ISSUER" as const,
    value: "SYNTHETIC-000001",
  },
  firstName: "Ada",
  lastName: "Lovelace",
  dateOfBirth: "1990-08-22",
  sex: "FEMALE" as const,
  profileAge: 36,
  researchCase: {
    id: "30000000-0000-4000-8000-000000000001",
    startedAt: "2026-08-22T10:00:00.000Z",
    ageAtStart: 36,
  },
  createdAt: "2026-08-22T10:00:00.000Z",
  updatedAt: "2026-08-22T10:00:00.000Z",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("Patient Registry pages", () => {
  it("shows loading then empty registry states", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((done) => (resolve = done))),
    );

    render(<PatientRegistryPage onNavigate={vi.fn()} />);
    expect(screen.getByText("Loading patient registry")).toBeTruthy();

    resolve(json({ schemaVersion: "1", patients: [] }));
    expect(await screen.findByRole("heading", { name: "No patients in registry" })).toBeTruthy();
  });

  it("searches the shared list without putting sensitive values in the URL or logs", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (request: Request) => {
      void request;
      return json({ schemaVersion: "1", patients: [patient] });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/patients");

    render(<PatientRegistryPage onNavigate={vi.fn()} />);
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search patients"), {
      target: { value: "SYNTHETIC-000001" },
    });
    fireEvent.submit(screen.getByRole("search"));

    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(window.location.href).not.toContain("SYNTHETIC-000001");
    expect(fetchMock.mock.calls.map(([request]) => String((request as Request).url))).toEqual([
      `${window.location.origin}/api/v1/patients`,
    ]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("opens the canonical profile after duplicate create without confirmation", async () => {
    const onNavigate = vi.fn();
    let requestBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requestBody = await request.clone().json();
        return json({ schemaVersion: "1", patient });
      }),
    );
    render(<CreatePatientPage csrfToken="csrf" onNavigate={onNavigate} />);
    expect(screen.queryByLabelText(/^Official identifier type/)).toBeNull();
    expect(screen.queryByLabelText(/^Issuing authority/)).toBeNull();

    for (const [label, value] of [
      ["First name", "Ada"],
      ["Last name", "Lovelace"],
      ["Date of birth", "1990-08-22"],
      ["Sex", "FEMALE"],
      ["Official identifier value", "SYNTHETIC-000001"],
    ]) {
      fireEvent.change(screen.getByLabelText(new RegExp(`^${label}`)), { target: { value } });
    }
    fireEvent.submit(
      screen.getByRole("button", { name: "Create or open patient" }).closest("form")!,
    );

    await vi.waitFor(() => expect(onNavigate).toHaveBeenCalledWith(`/patients/${patient.id}`));
    expect(requestBody).toMatchObject({
      officialIdentifier: {
        value: "SYNTHETIC-000001",
      },
    });
    expect(requestBody).not.toHaveProperty("officialIdentifier.type");
    expect(requestBody).not.toHaveProperty("officialIdentifier.issuingAuthority");
    expect(window.location.href).not.toContain("SYNTHETIC-000001");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    [403, "Patient registry access denied"],
    [500, "Patient registry unavailable"],
  ])("renders explicit API error state for status %i", async (status, title) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ schemaVersion: "1", error: {} }, status)),
    );
    render(<PatientRegistryPage onNavigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
  });

  it("renders invalid submission and invalid profile states", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ schemaVersion: "1", error: {} }, 400))
      .mockResolvedValueOnce(json({ schemaVersion: "1", error: {} }, 404));
    vi.stubGlobal("fetch", fetchMock);
    const first = render(<CreatePatientPage csrfToken="csrf" onNavigate={vi.fn()} />);
    fireEvent.submit(
      screen.getByRole("button", { name: "Create or open patient" }).closest("form")!,
    );
    expect(await screen.findByRole("heading", { name: "Patient data is invalid" })).toBeTruthy();

    first.unmount();
    render(<PatientProfilePage patientId={patient.id} csrfToken="csrf" onNavigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Patient profile not found" })).toBeTruthy();
  });

  it("displays current profile age from the server response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) =>
        request.url.includes("/research-case")
          ? json({ schemaVersion: "1", error: {} }, 500)
          : json({ schemaVersion: "1", patient }),
      ),
    );
    render(<PatientProfilePage patientId={patient.id} csrfToken="csrf" onNavigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Ada Lovelace" })).toBeTruthy();
    expect(screen.queryByText("Identifier type")).toBeNull();
    expect(screen.queryByText("Issuing authority")).toBeNull();
    expect(screen.getByText("Current age").nextElementSibling?.textContent).toBe("36");
    expect(screen.getByRole("navigation", { name: "Research Case steps" })).toBeTruthy();
    expect(screen.getByText("DSM-5-TR schizophrenia criteria").getAttribute("aria-current")).toBe(
      "step",
    );
  });
});
