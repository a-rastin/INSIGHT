import axe from "axe-core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BnManagerPage } from "./BnManagerPage";

const model = {
  id: "20000000-0000-4000-8000-000000000001",
  pathwayIdentity: "PHARMACOTHERAPY",
  version: 2,
  lifecycle: "REJECTED",
  quarantineReason: null,
  source: {
    fileName: "pharmacotherapy-invalid.xml",
    mediaType: "application/xml",
    byteLength: 412,
    contentSha256: "a".repeat(64),
    semanticSha256: null,
    topologySha256: null,
    importerVersion: "1.0.0",
    importedByUserId: "10000000-0000-4000-8000-000000000001",
    importedAt: "2026-08-23T12:00:00.000Z",
  },
  validation: {
    softwareCompatible: false,
    clinicalValidity: "NOT_ESTABLISHED",
    checks: [
      { code: "SECURE_PARSE", passed: true, detail: "XML parsed within configured limits." },
      {
        code: "MODEL_VALIDATION",
        passed: false,
        detail: "Structure or tables fail software validation.",
      },
    ],
    diagnostics: [
      {
        code: "CPT_DISTRIBUTION_NOT_NORMALIZED",
        severity: "error",
        category: "probability",
        message: "CPT distribution for Choice sums to 0.4, not 1",
        variableName: "Choice",
      },
    ],
  },
  evidence: { status: "UNREVIEWED", reference: "NO-EVIDENCE-REVIEW" },
  calibration: { status: "UNCALIBRATED", reference: "NO-CALIBRATION-REPORT" },
  clinicalReview: { status: "UNREVIEWED", reference: "NO-CLINICAL-REVIEW" },
  networks: [
    {
      name: "MedicationChoice",
      nodes: [
        {
          id: "Input",
          type: "nature",
          outcomes: ["yes", "no"],
          parents: [],
          properties: [],
          tableValueCount: 2,
          position: null,
        },
        {
          id: "Choice",
          type: "nature",
          outcomes: ["first", "second"],
          parents: ["Input"],
          properties: [],
          tableValueCount: 4,
          position: null,
        },
      ],
      edges: [{ source: "Input", target: "Choice" }],
    },
  ],
} as const;

const sourceXml = `<BIF VERSION="0.3"><NETWORK><NAME>MedicationChoice</NAME>
  <VARIABLE TYPE="nature"><NAME>Input</NAME><OUTCOME>yes</OUTCOME><OUTCOME>no</OUTCOME></VARIABLE>
  <VARIABLE TYPE="nature"><NAME>Choice</NAME><OUTCOME>first</OUTCOME><OUTCOME>second</OUTCOME></VARIABLE>
  <DEFINITION><FOR>Input</FOR><TABLE>0.5 0.5</TABLE></DEFINITION>
  <DEFINITION><FOR>Choice</FOR><GIVEN>Input</GIVEN><TABLE>0.1 0.9 0.8 0.2</TABLE></DEFINITION>
</NETWORK></BIF>`;

const rawSourceXml = sourceXml.replace(
  "</NETWORK>",
  `<VARIABLE TYPE="decision"><NAME>Decision</NAME><OUTCOME>go</OUTCOME><OUTCOME>stay</OUTCOME></VARIABLE>
  <VARIABLE TYPE="utility"><NAME>Utility</NAME></VARIABLE>
  <DEFINITION><FOR>Decision</FOR><TABLE>-1 2</TABLE></DEFINITION>
  <DEFINITION><FOR>Utility</FOR><TABLE>4</TABLE></DEFINITION></NETWORK>`,
);

const activeModel = {
  ...model,
  lifecycle: "ACTIVE",
  validation: { ...model.validation, softwareCompatible: true, diagnostics: [] },
  source: {
    ...model.source,
    semanticSha256: "b".repeat(64),
    topologySha256: "c".repeat(64),
  },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ schemaVersion: "1", models: [model] })),
  );
});

describe("BN Manager", () => {
  it("keeps software diagnostics separate from evidence and inspects graph nodes", async () => {
    render(<BnManagerPage csrfToken="csrf-token" />);

    expect(await screen.findByText(/CPT_DISTRIBUTION_NOT_NORMALIZED/)).toBeTruthy();
    expect(screen.getByText("Software invalid")).toBeTruthy();
    expect(screen.getByText("Clinical validity NOT ESTABLISHED")).toBeTruthy();
    expect(screen.getByText("UNCALIBRATED")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Choice nature/ }));
    expect(screen.getByRole("complementary", { name: "Node inspector" }).textContent).toContain(
      "Input",
    );
    expect(screen.getByRole("complementary", { name: "Node inspector" }).textContent).toContain(
      "first, second",
    );
  });

  it("has no detectable WCAG A or AA violations", async () => {
    const { container } = render(<BnManagerPage csrfToken="csrf-token" />);
    await screen.findByRole("heading", { name: "Immutable versions" });
    const results = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it("edits through domain mutations, diagnoses invalid arcs, and cancels atomically", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push(url);
        if (url.includes("/source")) {
          return json({ schemaVersion: "1", modelId: activeModel.id, sourceXml });
        }
        return json({ schemaVersion: "1", models: [activeModel] });
      }),
    );
    render(<BnManagerPage csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit structure" }));
    expect(await screen.findByRole("region", { name: "Editable network graph" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Parent"), { target: { value: "Choice" } });
    fireEvent.change(screen.getByLabelText("Child"), { target: { value: "Input" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect nodes" }));
    expect(screen.getByText("GRAPH_CYCLE")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Input nature/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete node" }));
    expect(screen.getByRole("button", { name: /Input nature/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
    expect(screen.getByRole("region", { name: "Read-only network graph" })).toBeTruthy();
    expect(requests.filter((url) => url.includes("/candidates"))).toEqual([]);
  });

  it("saves a changed graph as a new candidate hash and version", async () => {
    let savedSource = "";
    const candidate = {
      ...activeModel,
      id: "20000000-0000-4000-8000-000000000002",
      version: 3,
      lifecycle: "ACTIVE",
      source: { ...activeModel.source, contentSha256: "d".repeat(64) },
    };
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/source")) {
          return json({ schemaVersion: "1", modelId: activeModel.id, sourceXml });
        }
        if (url.includes("/candidates")) {
          const body =
            input instanceof Request ? await input.clone().json() : JSON.parse(String(init?.body));
          savedSource = body.sourceXml;
          return json({ schemaVersion: "1", model: candidate }, 201);
        }
        return json({ schemaVersion: "1", models: [activeModel] });
      }),
    );
    render(<BnManagerPage csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit structure" }));
    await screen.findByRole("region", { name: "Editable network graph" });
    fireEvent.change(screen.getByLabelText("Node type"), { target: { value: "utility" } });
    fireEvent.change(screen.getByLabelText("Node ID (optional)"), {
      target: { value: "ExpectedUtility" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add node" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and activate new version" }));
    expect(await screen.findByText("Version 3")).toBeTruthy();
    expect(savedSource).toContain("<NAME>ExpectedUtility</NAME>");
    expect(candidate.source.contentSha256).not.toBe(activeModel.source.contentSha256);
  });

  it("edits outcomes, CPTs, and finite raw values through synchronized projections", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        return url.includes("/source")
          ? json({ schemaVersion: "1", modelId: activeModel.id, sourceXml: rawSourceXml })
          : json({ schemaVersion: "1", models: [activeModel] });
      }),
    );
    render(<BnManagerPage csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit structure" }));
    await screen.findByText("Synchronized");

    fireEvent.click(screen.getByRole("button", { name: /Choice nature/ }));
    fireEvent.change(screen.getByLabelText("yes P(first)"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("yes P(second)"), { target: { value: "80" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Normalize" })[0]!);
    expect((screen.getByLabelText("yes P(first)") as HTMLInputElement).value).toBe("0.2");
    expect((screen.getByLabelText("yes P(second)") as HTMLInputElement).value).toBe("0.8");

    fireEvent.click(screen.getByRole("button", { name: /Input nature/ }));
    fireEvent.change(screen.getByLabelText("Outcome 1"), { target: { value: "present" } });
    fireEvent.blur(screen.getByLabelText("Outcome 1"));
    expect((screen.getByLabelText("XMLBIF source") as HTMLTextAreaElement).value).toContain(
      "<OUTCOME>present</OUTCOME>",
    );

    fireEvent.click(screen.getByRole("button", { name: /Decision decision/ }));
    fireEvent.change(screen.getByLabelText("Root go"), { target: { value: "Infinity" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply row" }));
    expect(screen.getByRole("alert").textContent).toContain("finite numeric values");
    fireEvent.change(screen.getByLabelText("Root go"), { target: { value: "-3.5" } });
    fireEvent.change(screen.getByLabelText("Root stay"), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply row" }));
    expect((screen.getByLabelText("XMLBIF source") as HTMLTextAreaElement).value).toContain(
      "<TABLE>-3.5 8</TABLE>",
    );
  });

  it("keeps last valid graph while XML draft is malformed and serializes valid recovery", async () => {
    let savedSource = "";
    const candidate = {
      ...activeModel,
      id: "20000000-0000-4000-8000-000000000004",
      version: 3,
      lifecycle: "ACTIVE",
    };
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/source"))
          return json({ schemaVersion: "1", modelId: activeModel.id, sourceXml });
        if (url.includes("/candidates")) {
          const body =
            input instanceof Request ? await input.clone().json() : JSON.parse(String(init?.body));
          savedSource = body.sourceXml;
          return json({ schemaVersion: "1", model: candidate }, 201);
        }
        return json({ schemaVersion: "1", models: [activeModel] });
      }),
    );
    render(<BnManagerPage csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit structure" }));
    const xml = await screen.findByLabelText("XMLBIF source");
    fireEvent.change(xml, { target: { value: "<BIF><NETWORK>" } });
    expect(screen.getByText("Draft invalid")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Choice nature/ })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save and activate new version" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Node ID (optional)"), {
      target: { value: "MustNotReplaceDraft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add node" }));
    expect((xml as HTMLTextAreaElement).value).toBe("<BIF><NETWORK>");
    expect(screen.queryByRole("button", { name: /MustNotReplaceDraft/ })).toBeNull();

    fireEvent.change(xml, {
      target: { value: sourceXml.replace("0.1 0.9 0.8 0.2", "0.2 0.8 0.8 0.2") },
    });
    expect(screen.getByText("Synchronized")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save and activate new version" }));
    await screen.findByText("Version 3");
    expect(savedSource).toContain("<TABLE>0.2 0.8 0.8 0.2</TABLE>");
    expect(savedSource.endsWith("</BIF>\n")).toBe(true);
  });

  it("requires confirmation before graphical edits discard XML fidelity content", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        return url.includes("/source")
          ? json({
              schemaVersion: "1",
              modelId: activeModel.id,
              sourceXml: sourceXml.replace("<NETWORK>", "<!-- retained -->\n<NETWORK>"),
            })
          : json({ schemaVersion: "1", models: [activeModel] });
      }),
    );
    render(<BnManagerPage csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit structure" }));
    fireEvent.change(await screen.findByLabelText("Node type"), { target: { value: "utility" } });
    fireEvent.change(screen.getByLabelText("Node ID (optional)"), {
      target: { value: "BlockedUtility" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add node" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("XML comments"));
    expect(screen.queryByRole("button", { name: /BlockedUtility utility/ })).toBeNull();
    expect((screen.getByLabelText("XMLBIF source") as HTMLTextAreaElement).value).toContain(
      "<!-- retained -->",
    );
  });
});
