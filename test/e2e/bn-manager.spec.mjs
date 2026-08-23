import { expect, test } from "@playwright/test";

const session = {
  schemaVersion: "1",
  user: {
    id: "10000000-0000-4000-8000-000000000001",
    username: "admin",
    role: "ADMINISTRATOR",
    status: "ENABLED",
  },
  csrfToken: "csrf-token",
  expiresAt: "2026-08-24T12:00:00.000Z",
};

const editableSource = `<BIF VERSION="0.3"><NETWORK><NAME>MedicationChoice</NAME>
  <VARIABLE TYPE="nature"><NAME>Input</NAME><OUTCOME>yes</OUTCOME><OUTCOME>no</OUTCOME></VARIABLE>
  <VARIABLE TYPE="nature"><NAME>Choice</NAME><OUTCOME>first</OUTCOME><OUTCOME>second</OUTCOME></VARIABLE>
  <DEFINITION><FOR>Input</FOR><TABLE>0.5 0.5</TABLE></DEFINITION>
  <DEFINITION><FOR>Choice</FOR><GIVEN>Input</GIVEN><TABLE>0.1 0.9 0.8 0.2</TABLE></DEFINITION>
</NETWORK></BIF>`;

function model({ id, version, valid, fileName }) {
  return {
    id,
    pathwayIdentity: "PHARMACOTHERAPY",
    version,
    lifecycle: valid ? "ACTIVE" : "REJECTED",
    quarantineReason: null,
    source: {
      fileName,
      mediaType: "application/xml",
      byteLength: 420,
      contentSha256: (valid ? "a" : "b").repeat(64),
      semanticSha256: valid ? "c".repeat(64) : null,
      topologySha256: valid ? "d".repeat(64) : null,
      importerVersion: "1.0.0",
      importedByUserId: session.user.id,
      importedAt: "2026-08-23T12:00:00.000Z",
    },
    validation: {
      softwareCompatible: valid,
      clinicalValidity: "NOT_ESTABLISHED",
      checks: [
        { code: "SECURE_PARSE", passed: true, detail: "XML parsed within configured limits." },
        {
          code: "MODEL_VALIDATION",
          passed: valid,
          detail: valid
            ? "Structure and tables pass software validation."
            : "Structure or tables fail software validation.",
        },
      ],
      diagnostics: valid
        ? []
        : [
            {
              code: "CPT_DISTRIBUTION_NOT_NORMALIZED",
              severity: "error",
              category: "probability",
              message: "CPT distribution for Choice sums to 0.4, not 1",
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
  };
}

test("Administrator uploads immutable models and inspects invalid diagnostics at narrow width", async ({
  page,
}) => {
  const models = [];
  const requestedPaths = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requestedPaths.push(path);
    if (path === "/api/v1/session") return route.fulfill({ json: session });
    if (path === "/api/v1/admin/bn-models" && request.method() === "GET") {
      return route.fulfill({ json: { schemaVersion: "1", models } });
    }
    if (path === "/api/v1/admin/bn-models/import") {
      const body = request.postDataJSON();
      expect(body.pathwayIdentity).toBe("PHARMACOTHERAPY");
      expect(body.artifactBase64).toBeTruthy();
      const valid = body.fileName === "valid.xml";
      const uploaded = model({
        id: `20000000-0000-4000-8000-00000000000${valid ? "1" : "2"}`,
        version: valid ? 1 : 3,
        valid,
        fileName: body.fileName,
      });
      models.unshift(uploaded);
      return route.fulfill({ status: 201, json: { schemaVersion: "1", model: uploaded } });
    }
    if (path.endsWith("/source")) {
      return route.fulfill({
        json: { schemaVersion: "1", modelId: models[0].id, sourceXml: editableSource },
      });
    }
    if (path.endsWith("/candidates")) {
      const body = request.postDataJSON();
      expect(body.sourceXml).toContain("<NAME>ExpectedUtility</NAME>");
      const candidate = {
        ...model({
          id: "20000000-0000-4000-8000-000000000003",
          version: 2,
          valid: true,
          fileName: "pharmacotherapy-edit-v1.xml",
        }),
        lifecycle: "IMPORTED",
        source: {
          ...model({ id: "x", version: 2, valid: true, fileName: "edit.xml" }).source,
          contentSha256: "e".repeat(64),
        },
      };
      models.unshift(candidate);
      return route.fulfill({ status: 201, json: { schemaVersion: "1", model: candidate } });
    }
    return route.fulfill({ status: 404 });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/administration/bn-manager");
  await expect(page.getByRole("heading", { name: "Upload immutable model version" })).toBeVisible();

  async function upload(fileName, contents) {
    await page.getByLabel(/Pathway identity/).fill("pharmacotherapy");
    await page.getByLabel(/XMLBIF file/).setInputFiles({
      name: fileName,
      mimeType: "application/xml",
      buffer: Buffer.from(contents),
    });
    await page.getByRole("button", { name: "Upload and validate" }).click();
  }
  await upload("valid.xml", '<BIF VERSION="0.3" />');
  await expect(page.getByText("Software valid", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit structure" }).click();
  await expect(page.getByRole("region", { name: "Editable network graph" })).toBeVisible();
  await page.getByRole("button", { name: /Choice nature/ }).click();
  await page.getByLabel("yes P(first)").fill("0.3");
  await page.getByLabel("yes P(second)").fill("0.7");
  await page.getByRole("button", { name: "Apply row" }).first().click();
  await expect(page.getByLabel("XMLBIF source")).toHaveValue(
    /<TABLE>0\.3 0\.7 0\.8 0\.2<\/TABLE>/,
  );
  await page.getByLabel("XMLBIF source").fill("<BIF><NETWORK>");
  await expect(page.getByText("Draft invalid")).toBeVisible();
  await expect(page.getByRole("button", { name: /Choice nature/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save as candidate version" })).toBeDisabled();
  await page
    .getByLabel("XMLBIF source")
    .fill(editableSource.replace("0.1 0.9 0.8 0.2", "0.3 0.7 0.8 0.2"));
  await expect(page.getByText("Synchronized")).toBeVisible();
  await page.getByLabel("Node type").selectOption("utility");
  await page.getByLabel("Node ID (optional)").fill("ExpectedUtility");
  await page.getByRole("button", { name: "Add node" }).click();
  await page.getByRole("button", { name: "Save as candidate version" }).click();
  await expect(
    page.getByRole("button", { name: /PHARMACOTHERAPY Version 2 IMPORTED/ }),
  ).toBeVisible();
  await upload("invalid.xml", '<BIF VERSION="0.3">invalid</BIF>');

  await expect(page.getByText("CPT_DISTRIBUTION_NOT_NORMALIZED")).toBeVisible();
  await expect(page.getByText("Software invalid", { exact: true })).toBeVisible();
  await expect(page.getByText("UNCALIBRATED")).toBeVisible();
  await expect(page.getByText("Clinical validity NOT ESTABLISHED")).toBeVisible();
  await page.getByRole("button", { name: /Choice nature/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: "Node inspector" })).toContainText(
    "first, second",
  );
  await expect(page.getByRole("region", { name: "Read-only network graph" })).toBeVisible();
  expect(requestedPaths.some((path) => path.startsWith("/api/v1/patients"))).toBe(false);
  await expect(page.getByRole("link", { name: "Patient Registry" })).toHaveCount(0);
});
