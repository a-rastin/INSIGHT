import axe from "axe-core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Banner,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  FormField,
  LoadingState,
  TextInput,
} from "./primitives";

describe("shared primitives", () => {
  it("connects field labels, help, required, and error states", () => {
    render(
      <FormField label="Patient identifier" hint="Ten digits" error="Required" required>
        {(props) => <TextInput {...props} />}
      </FormField>,
    );

    const input = screen.getByRole("textbox", { name: /patient identifier/i });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain("hint");
    expect(input.getAttribute("aria-describedby")).toContain("error");
  });

  it("exposes loading and error states to assistive technology", () => {
    render(
      <>
        <Button loading>Save</Button>
        <LoadingState label="Loading records" />
        <ErrorState title="Could not load" description="Try again later." />
      </>,
    );

    expect(screen.getByRole("button", { name: /loading: save/i }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("status").textContent).toContain("Loading records");
    expect(screen.getByRole("alert", { name: "Could not load" })).toBeTruthy();
  });

  it("renders labelled banners and semantic table headers", () => {
    render(
      <>
        <Banner title="Review required" tone="warning">
          Confirm current data.
        </Banner>
        <DataTable
          ariaLabel="Record summary"
          caption="Current records"
          columns={[{ key: "name", header: "Name" }]}
          rows={[{ id: "1", name: "Example" }]}
          rowKey={(row) => row.id}
        />
      </>,
    );

    expect(screen.getByRole("status", { name: "Review required" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Record summary" }).getAttribute("tabindex")).toBe(
      "0",
    );
  });

  it("has no serious accessibility violations across universal page states", async () => {
    const { container } = render(
      <main>
        <h1>State inventory</h1>
        <LoadingState label="Loading records" />
        <EmptyState title="No records" description="No records match this view." />
        <Banner title="Validation required" tone="urgent">
          Correct labelled fields before continuing.
        </Banner>
        <Banner title="Workflow queued" tone="info">
          Work is waiting to start.
        </Banner>
        <Banner title="Workflow running" tone="info">
          Work is in progress.
        </Banner>
        <Banner title="Input is stale" tone="warning">
          Refresh before continuing.
        </Banner>
        <ErrorState title="Access denied" description="Your account cannot access this data." />
        <ErrorState
          title="Dependency unavailable"
          description="Required service could not be reached."
        />
        <ErrorState title="Workflow failed" description="Work did not complete." />
        <Banner title="Workflow succeeded" tone="info">
          Result and provenance are available.
        </Banner>
      </main>,
    );

    const results = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.filter(({ impact }) => impact === "serious")).toEqual([]);
  });
});
