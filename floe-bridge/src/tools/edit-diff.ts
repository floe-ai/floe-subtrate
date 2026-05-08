/**
 * Edit diff utilities — fuzzy matching and diff generation for the edit tool.
 *
 * Ported from pi-coding-agent edit-diff.ts, stripped of TUI/rendering dependencies.
 * Provides:
 * - Line ending detection and normalization
 * - Unicode/smart-quote fuzzy matching
 * - Multi-edit application with overlap detection
 * - Unified diff generation
 */

import * as Diff from "diff";

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
  );
}

export interface FuzzyMatchResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
  contentForReplacement: string;
}

export interface Edit {
  oldText: string;
  newText: string;
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

export interface AppliedEditsResult {
  baseContent: string;
  newContent: string;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent,
  };
}

/** Strip UTF-8 BOM if present */
export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 * All edits are matched against the original content. Replacements are
 * applied in reverse order so offsets remain stable.
 */
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: Edit[],
  path: string,
): AppliedEditsResult {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      throw new Error(
        normalizedEdits.length === 1
          ? `oldText must not be empty in ${path}.`
          : `edits[${i}].oldText must not be empty in ${path}.`,
      );
    }
  }

  const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
  const baseContent = initialMatches.some((match) => match.usedFuzzyMatch)
    ? normalizeForFuzzyMatch(normalizedContent)
    : normalizedContent;

  const matchedEdits: MatchedEdit[] = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i];
    const matchResult = fuzzyFindText(baseContent, edit.oldText);
    if (!matchResult.found) {
      const label = normalizedEdits.length === 1
        ? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
        : `Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`;
      throw new Error(label);
    }

    const occurrences = countOccurrences(baseContent, edit.oldText);
    if (occurrences > 1) {
      const label = normalizedEdits.length === 1
        ? `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
        : `Found ${occurrences} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`;
      throw new Error(label);
    }

    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText,
    });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1];
    const current = matchedEdits[i];
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  let newContent = baseContent;
  for (let i = matchedEdits.length - 1; i >= 0; i--) {
    const edit = matchedEdits[i];
    newContent =
      newContent.substring(0, edit.matchIndex) +
      edit.newText +
      newContent.substring(edit.matchIndex + edit.matchLength);
  }

  if (baseContent === newContent) {
    const label = normalizedEdits.length === 1
      ? `No changes made to ${path}. The replacement produced identical content.`
      : `No changes made to ${path}. The replacements produced identical content.`;
    throw new Error(label);
  }

  return { baseContent, newContent };
}

/**
 * Generate a unified diff string with line numbers and context.
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) firstChangedLine = newLineNum;
      for (const line of raw) {
        if (part.added) {
          output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
          newLineNum++;
        } else {
          output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
      if (lastWasChange && nextPartIsChange) {
        if (raw.length <= contextLines * 2) {
          for (const line of raw) {
            output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        } else {
          for (const line of raw.slice(0, contextLines)) {
            output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          const skipped = raw.length - contextLines * 2;
          oldLineNum += skipped;
          newLineNum += skipped;
          for (const line of raw.slice(raw.length - contextLines)) {
            output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        }
      } else if (lastWasChange) {
        const shownLines = raw.slice(0, contextLines);
        for (const line of shownLines) {
          output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
        if (raw.length > contextLines) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += raw.length - contextLines;
          newLineNum += raw.length - contextLines;
        }
      } else if (nextPartIsChange) {
        const skipped = Math.max(0, raw.length - contextLines);
        if (skipped > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skipped;
          newLineNum += skipped;
        }
        for (const line of raw.slice(skipped)) {
          output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
      } else {
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }
      lastWasChange = false;
    }
  }

  return { diff: output.join("\n"), firstChangedLine };
}
