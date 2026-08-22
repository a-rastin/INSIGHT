import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RawValueEditor } from "../src/components/RawValueEditor";
import type { XmlBifNetwork } from "../src/domain/model";

afterEach(cleanup);

const network: XmlBifNetwork = {
  name: "Raw",
  properties: [],
  variables: [
    {
      name: "Choice",
      type: "decision",
      outcomes: ["go", "stay"],
      properties: [],
    },
  ],
  definitions: [{ for: "Choice", given: [], table: [0, 2], properties: [] }],
};

describe("RawValueEditor", () => {
  it("accepts negative and above-one values without probability controls", () => {
    const onCommitRow = vi.fn(() => ({ ok: true as const }));
    render(
      <RawValueEditor
        network={network}
        variableName="Choice"
        onCommitRow={onCommitRow}
      />,
    );

    fireEvent.change(screen.getByLabelText("Root go"), {
      target: { value: "-3.5" },
    });
    fireEvent.change(screen.getByLabelText("Root stay"), {
      target: { value: "8" },
    });
    fireEvent.blur(screen.getByLabelText("Root stay"));

    expect(onCommitRow).toHaveBeenLastCalledWith([], [-3.5, 8]);
    expect(screen.queryByRole("button", { name: "Normalize" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Complement" })).toBeNull();
  });

  it("rejects non-finite drafts before mutation", () => {
    const onCommitRow = vi.fn(() => ({ ok: true as const }));
    render(
      <RawValueEditor
        network={network}
        variableName="Choice"
        onCommitRow={onCommitRow}
      />,
    );

    fireEvent.change(screen.getByLabelText("Root go"), {
      target: { value: "Infinity" },
    });
    fireEvent.blur(screen.getByLabelText("Root go"));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter finite numeric values.",
    );
    expect(onCommitRow).not.toHaveBeenCalled();
  });
});
