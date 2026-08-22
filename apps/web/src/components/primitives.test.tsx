import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Banner,
  Button,
  DataTable,
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
});
