import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentPicker, pastedFiles } from "./AttachmentPicker.tsx";

afterEach(() => cleanup());

function Harness(): React.ReactElement {
  const [files, setFiles] = useState<File[]>([]);
  return <AttachmentPicker files={files} onChange={setFiles} />;
}

describe("conversation attachment picker", () => {
  it("adds and removes a deliberately selected file", () => {
    render(<Harness />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });

    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.getByText("notes.txt")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
    expect(screen.queryByText("notes.txt")).toBeNull();
  });

  it("extracts pasted image files without treating clipboard text as a host path", () => {
    const image = new File(["image"], "pasted.png", { type: "image/png" });
    const event = {
      clipboardData: {
        items: [
          { kind: "string", getAsFile: () => null },
          { kind: "file", getAsFile: () => image },
        ],
      },
    } as unknown as React.ClipboardEvent<HTMLTextAreaElement>;

    expect(pastedFiles(event)).toEqual([image]);
  });
});
