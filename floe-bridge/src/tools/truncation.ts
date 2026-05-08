/**
 * Output truncation — bounds tool output to prevent unbounded content
 * in work logs, telemetry, and agent context.
 *
 * Limits: 2000 lines / 50KB, configurable.
 * Default strategy: tail-truncated (keeps the latest output).
 */

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

export type TruncationResult = {
  text: string;
  truncated: boolean;
  original_lines: number;
  original_bytes: number;
};

/**
 * Truncate output text by line count and byte size.
 *
 * Strategy:
 * - If output exceeds maxLines, keep the last maxLines lines (tail).
 * - If output exceeds maxBytes, keep the last maxBytes bytes (tail).
 * - Prepends a truncation notice when content is trimmed.
 */
export function truncateOutput(
  text: string,
  options?: {
    maxLines?: number;
    maxBytes?: number;
    strategy?: "tail" | "head";
  }
): TruncationResult {
  const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const strategy = options?.strategy ?? "tail";

  const originalBytes = Buffer.byteLength(text, "utf-8");
  const lines = text.split("\n");
  const originalLines = lines.length;

  let truncated = false;
  let result = text;

  // Truncate by lines
  if (lines.length > maxLines) {
    truncated = true;
    if (strategy === "tail") {
      const kept = lines.slice(-maxLines);
      result = kept.join("\n");
    } else {
      const kept = lines.slice(0, maxLines);
      result = kept.join("\n");
    }
  }

  // Truncate by bytes
  if (Buffer.byteLength(result, "utf-8") > maxBytes) {
    truncated = true;
    if (strategy === "tail") {
      // Take from the end
      const buf = Buffer.from(result, "utf-8");
      result = buf.slice(-maxBytes).toString("utf-8");
      // Clean up potentially broken first character
      const firstValid = result.indexOf("\n");
      if (firstValid > 0 && firstValid < 100) {
        result = result.slice(firstValid + 1);
      }
    } else {
      const buf = Buffer.from(result, "utf-8");
      result = buf.slice(0, maxBytes).toString("utf-8");
      // Clean up potentially broken last character
      const lastNewline = result.lastIndexOf("\n");
      if (lastNewline > result.length - 100) {
        result = result.slice(0, lastNewline);
      }
    }
  }

  if (truncated) {
    const notice = `[truncated: showing ${strategy === "tail" ? "last" : "first"} portion of ${originalLines} lines / ${originalBytes} bytes]\n`;
    result = strategy === "tail" ? notice + result : result + "\n" + notice;
  }

  return {
    text: result,
    truncated,
    original_lines: originalLines,
    original_bytes: originalBytes
  };
}
