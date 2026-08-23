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
        version: valid ? 1 : 2,
        valid,
        fileName: body.fileName,
      });
      models.unshift(uploaded);
      return route.fulfill({ status: 201, json: { schemaVersion: "1", model: uploaded } });
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
