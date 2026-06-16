/**
 * RecordList — generic read table for substrate rows.
 *
 * Props:
 *   title   — heading shown above the table
 *   load    — async function returning rows
 *   columns — optional explicit column list; auto-derived from keys if absent
 *
 * Shows loading / empty / error states throughout.
 */
import React, { useEffect, useState } from "react";
import { colors, space, font } from "../theme.ts";

export type RecordListProps = {
  title: string;
  load: () => Promise<Record<string, unknown>[]>;
  columns?: string[];
};

export function RecordList({ title, load, columns }: RecordListProps): React.ReactElement {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    load()
      .then((data) => {
        if (cancelled) return;
        setRows(data);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load");
        setLoading(false);
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  // Derive columns from first row if not provided
  const cols: string[] =
    columns ??
    (rows.length > 0 ? Object.keys(rows[0]!) : []);

  const cellStyle: React.CSSProperties = {
    padding: `${space.sm}px ${space.lg}px`,
    borderBottom: `1px solid ${colors.border}`,
    fontSize: 13,
    color: colors.text,
    maxWidth: 280,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    verticalAlign: "top",
  };

  const headerCellStyle: React.CSSProperties = {
    ...cellStyle,
    fontSize: font.meta,
    fontWeight: font.h,
    color: colors.muted,
    background: colors.surface,
    position: "sticky",
    top: 0,
    zIndex: 1,
  };

  return (
    <div
      data-testid={`record-list-${title.toLowerCase().replace(/\s+/g, "-")}`}
      style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}
    >
      {/* Title bar */}
      <div
        style={{
          padding: `${space.md}px ${space.lg}px`,
          borderBottom: `1px solid ${colors.border}`,
          background: colors.surface,
          fontWeight: font.h,
          fontSize: 15,
          color: colors.text,
        }}
      >
        {title}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {loading && (
          <div
            role="status"
            aria-live="polite"
            style={{ padding: space.xl, color: colors.muted, font: font.body }}
          >
            Loading…
          </div>
        )}

        {!loading && error && (
          <div
            role="alert"
            style={{ padding: space.xl, color: colors.danger, font: font.body }}
          >
            Error: {error}
          </div>
        )}

        {!loading && !error && rows.length === 0 && (
          <div
            role="status"
            style={{ padding: space.xl, color: colors.muted, fontStyle: "italic", font: font.body }}
          >
            No records.
          </div>
        )}

        {!loading && !error && rows.length > 0 && (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              tableLayout: "auto",
            }}
            aria-label={title}
          >
            <thead>
              <tr>
                {cols.map((col) => (
                  <th key={col} scope="col" style={headerCellStyle}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={i}
                  style={{
                    background: i % 2 === 0 ? colors.surface : colors.canvas,
                  }}
                >
                  {cols.map((col) => {
                    const val = row[col];
                    const display =
                      val === null || val === undefined
                        ? ""
                        : typeof val === "object"
                        ? JSON.stringify(val)
                        : String(val);
                    return (
                      <td key={col} style={cellStyle} title={display}>
                        {display}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
