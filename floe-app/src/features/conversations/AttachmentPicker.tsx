import React, { useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";
import {
  formatAttachmentBytes,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
} from "../../fs/conversationAttachments.ts";
import { tk } from "../../theme.ts";

export type AttachmentPickerProps = {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
};

function fileIdentity(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function appendAttachmentFiles(existing: File[], incoming: File[]): { files: File[]; error: string | null } {
  const oversized = incoming.find(file => file.size > MAX_ATTACHMENT_BYTES);
  if (oversized) return { files: existing, error: `${oversized.name} exceeds the 20MB attachment limit.` };
  const empty = incoming.find(file => file.size === 0);
  if (empty) return { files: existing, error: `${empty.name} is empty.` };
  const byIdentity = new Map(existing.map(file => [fileIdentity(file), file]));
  incoming.forEach(file => byIdentity.set(fileIdentity(file), file));
  const files = [...byIdentity.values()];
  if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return { files: existing, error: `Attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files at a time.` };
  }
  return { files, error: null };
}

export function AttachmentPicker({ files, onChange, disabled = false }: AttachmentPickerProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  function addFiles(incoming: File[]) {
    const result = appendAttachmentFiles(files, incoming);
    setError(result.error);
    if (!result.error) onChange(result.files);
  }

  return (
    <div style={{ display: "grid", gap: 7 }}>
      <input
        ref={inputRef}
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        style={{ display: "none" }}
        onChange={event => {
          addFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
        <button
          type="button"
          aria-label="Attach files"
          title="Attach files or paste an image"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          style={{
            width: 32, height: 32, display: "inline-flex", alignItems: "center", justifyContent: "center",
            border: `1px solid ${tk.border}`, borderRadius: tk.r2,
            background: "transparent", color: tk.ink3,
            cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1,
          }}
        >
          <Paperclip size={15} aria-hidden="true" />
        </button>
        {files.map(file => (
          <span
            key={fileIdentity(file)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              maxWidth: 260, padding: "5px 7px", borderRadius: tk.r2,
              border: `1px solid ${tk.border}`, background: tk.surfaceSunk,
              color: tk.ink2, fontSize: 11.5,
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</span>
            <span style={{ color: tk.ink4, whiteSpace: "nowrap" }}>{formatAttachmentBytes(file.size)}</span>
            <button
              type="button"
              aria-label={`Remove ${file.name}`}
              onClick={() => onChange(files.filter(candidate => fileIdentity(candidate) !== fileIdentity(file)))}
              style={{ display: "inline-flex", padding: 0, border: "none", background: "transparent", color: tk.ink3, cursor: "pointer" }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      {error && <div role="alert" style={{ color: tk.danger, fontSize: 11.5 }}>{error}</div>}
    </div>
  );
}

export function pastedFiles(event: React.ClipboardEvent<HTMLTextAreaElement>): File[] {
  return Array.from(event.clipboardData.items)
    .filter(item => item.kind === "file")
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null);
}
