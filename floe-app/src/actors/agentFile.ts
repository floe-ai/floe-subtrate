/**
 * agentFile — frontmatter + body (de)serialization for `.floe/agents/*.md`
 * actor definition files.
 *
 * Mirrors floe-bridge/src/project.ts exactly:
 *  - `parseAgentFile` (~line 244): splits a leading `---`…`\n---` block via
 *    the `yaml` package; the remainder (with one leading newline stripped)
 *    is the body.
 *  - Serialization (~line 233):
 *    `` `---\n${YAML.stringify(frontmatter).trim()}\n---\n${body}\n` ``
 *
 * floe-app writes these files directly via the Tauri FS commands — the
 * bridge's disk-drift sync (reconcileFromBus, every 30s) picks up new/edited
 * files and registers/updates the corresponding endpoint. This module does
 * NOT call registerEndpoint; it only produces/parses file contents.
 */
import YAML from "yaml";

export const AGENT_SCHEMA = "floe.agent.v1" as const;
export const DEFAULT_ENGINE = "pi" as const;

export type AgentFrontmatter = {
  schema: string;
  agent_id: string;
  // Optional: some legacy/applied-from files use `label` instead of `name`
  // (e.g. the substrate's own .floe/agents/floe.md). The bridge's loadProject
  // reads `frontmatter.name` for display, falling back to a titleCased
  // agent_id when absent — it does NOT read `label`. We must not synthesize
  // an empty `name` for a file that doesn't have one, or saving would clobber
  // a `label`-based file's display semantics.
  name?: string;
  runtime: { engine: string };
  scope?: { paths: string[] };
  pulse?: { inherit: boolean };
  skills?: string[];
  extensions?: string[];
  mcp?: string[];
  [key: string]: unknown;
};

export type ParsedAgentFile = {
  frontmatter: AgentFrontmatter;
  body: string;
};

/**
 * Parse a `.floe/agents/<id>.md` file's contents into frontmatter + body.
 * Mirrors floe-bridge's parseAgentFile exactly (same split rule), so a file
 * we write here round-trips losslessly through the bridge's actual parser.
 */
export function parseAgentFile(content: string): ParsedAgentFile {
  if (!content.startsWith("---")) {
    return { frontmatter: emptyFrontmatter(), body: content };
  }
  const marker = "\n---";
  const end = content.indexOf(marker, 3);
  if (end < 0) {
    return { frontmatter: emptyFrontmatter(), body: content };
  }
  const raw = content.slice(3, end).trim();
  const body = content.slice(end + marker.length).replace(/^\r?\n/, "");
  const parsed = (YAML.parse(raw) ?? {}) as Record<string, unknown>;
  return {
    frontmatter: normalizeFrontmatter(parsed),
    body,
  };
}

function emptyFrontmatter(): AgentFrontmatter {
  return { schema: AGENT_SCHEMA, agent_id: "", runtime: { engine: DEFAULT_ENGINE } };
}

function normalizeFrontmatter(raw: Record<string, unknown>): AgentFrontmatter {
  const runtime = (raw.runtime ?? {}) as Record<string, unknown>;
  const result: AgentFrontmatter = {
    ...raw,
    schema: typeof raw.schema === "string" ? raw.schema : AGENT_SCHEMA,
    agent_id: typeof raw.agent_id === "string" ? raw.agent_id : "",
    runtime: { engine: typeof runtime.engine === "string" ? runtime.engine : DEFAULT_ENGINE },
  };
  // Only set `name` if the file actually has one — see the AgentFrontmatter
  // comment on `name` for why we must not synthesize an empty string here.
  if (typeof raw.name === "string") result.name = raw.name;
  else delete result.name;
  return result;
}

/**
 * Serialize frontmatter + body back into `.floe/agents/<id>.md` file
 * contents. Matches floe-bridge's exact template so the result round-trips
 * through its parseAgentFile:
 *   `---\n${YAML.stringify(frontmatter).trim()}\n---\n${body}\n`
 *
 * The template always appends exactly one trailing `\n` after the body. If
 * `body` itself already ends in a newline (the common case — a textarea's
 * value, or a body just round-tripped through parseAgentFile), appending
 * unconditionally would grow the trailing blank line by one on every
 * load/edit/save cycle. We trim trailing newlines from `body` first so the
 * single `\n` the template adds is the only one — making save idempotent.
 */
export function serializeAgentFile(frontmatter: AgentFrontmatter, body: string): string {
  const trimmedBody = body.replace(/\n+$/, "");
  return `---\n${YAML.stringify(frontmatter).trim()}\n---\n${trimmedBody}\n`;
}

/** Build a fresh frontmatter object for a new actor, omitting empty optional fields. */
export function buildFrontmatter(input: {
  agentId: string;
  name: string;
  engine: string;
  scopePaths: string[];
  pulseInherit: boolean | null;
  skills: string[];
  extensions: string[];
  mcp: string[];
}): AgentFrontmatter {
  const fm: AgentFrontmatter = {
    schema: AGENT_SCHEMA,
    agent_id: input.agentId,
    name: input.name,
    runtime: { engine: input.engine || DEFAULT_ENGINE },
  };
  if (input.scopePaths.length > 0) fm.scope = { paths: input.scopePaths };
  if (input.pulseInherit !== null) fm.pulse = { inherit: input.pulseInherit };
  if (input.skills.length > 0) fm.skills = input.skills;
  if (input.extensions.length > 0) fm.extensions = input.extensions;
  if (input.mcp.length > 0) fm.mcp = input.mcp;
  return fm;
}

/** Parse a comma/newline-separated list field into a trimmed, non-empty string array. */
export function parseListField(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
