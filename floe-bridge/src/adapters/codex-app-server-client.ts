import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { message?: string };
};

export type CodexDynamicToolResult = {
  contentItems: Array<{ type: "inputText"; text: string }>;
  success: boolean;
};

export type CodexDynamicToolHandler = (tool: string, args: any) => Promise<CodexDynamicToolResult>;

export type CodexThreadInput = {
  model?: string;
  cwd?: string;
  baseInstructions: string;
  dynamicTools: unknown[];
  toolHandler: CodexDynamicToolHandler;
};

export interface CodexRuntimeClient {
  startThread(input: CodexThreadInput): Promise<{ threadId: string; model: string }>;
  startTurn(threadId: string, text: string, effort?: string): Promise<{ output: string; turnId: string }>;
  dispose(): Promise<void>;
}

type Pending = { resolve(value: any): void; reject(reason: Error): void };
type ActiveTurn = { output: string; resolve(value: { output: string; turnId: string }): void; reject(reason: Error): void; timer: ReturnType<typeof setTimeout> };

export class CodexAppServerClient implements CodexRuntimeClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly toolHandlers = new Map<string, CodexDynamicToolHandler>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private nextId = 1;
  private initialized: Promise<void>;
  private stderr = "";

  constructor() {
    const configured = process.env.FLOE_CODEX_COMMAND?.trim();
    if (configured) {
      this.child = spawn(configured, ["app-server", "--stdio"], { stdio: "pipe", windowsHide: true });
    } else if (process.platform === "win32") {
      this.child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "codex app-server --stdio"], { stdio: "pipe", windowsHide: true });
    } else {
      this.child = spawn("codex", ["app-server", "--stdio"], { stdio: "pipe" });
    }
    this.child.stderr.on("data", chunk => { this.stderr = `${this.stderr}${String(chunk)}`.slice(-16_000); });
    this.child.on("error", error => this.failAll(error));
    this.child.on("exit", code => this.failAll(new Error(this.stderr.trim() || `Codex app-server exited (${code ?? "unknown"})`)));

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", line => {
      try { void this.handleMessage(JSON.parse(line) as JsonRpcMessage); } catch { /* ignore non-protocol output */ }
    });
    this.initialized = this.initialize();
  }

  async startThread(input: CodexThreadInput): Promise<{ threadId: string; model: string }> {
    await this.initialized;
    const result = await this.request("thread/start", {
      model: input.model || null,
      cwd: input.cwd || null,
      baseInstructions: input.baseInstructions,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      serviceName: "floe",
      dynamicTools: input.dynamicTools,
    });
    const threadId = String(result.thread.id);
    this.toolHandlers.set(threadId, input.toolHandler);
    return { threadId, model: String(result.model) };
  }

  async startTurn(threadId: string, text: string, effort?: string): Promise<{ output: string; turnId: string }> {
    await this.initialized;
    const result = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      effort: normalizeEffort(effort),
    });
    const turnId = String(result.turn.id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activeTurns.delete(turnId);
        reject(new Error("Codex turn timed out"));
      }, 10 * 60_000);
      this.activeTurns.set(turnId, { output: "", resolve, reject, timer });
    });
  }

  async dispose(): Promise<void> {
    this.toolHandlers.clear();
    this.child.stdin.end();
    if (!this.child.killed) this.child.kill();
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "floe", title: "Floe", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private respond(id: number | string, result: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    if (message.id !== undefined && !message.method) {
      const waiter = this.pending.get(String(message.id));
      if (!waiter) return;
      this.pending.delete(String(message.id));
      if (message.error) waiter.reject(new Error(message.error.message || "Codex app-server request failed"));
      else waiter.resolve(message.result);
      return;
    }

    if (message.method === "item/tool/call" && message.id !== undefined) {
      const handler = this.toolHandlers.get(String(message.params?.threadId));
      if (!handler) {
        this.respond(message.id, { contentItems: [{ type: "inputText", text: "Floe tool session is unavailable" }], success: false });
        return;
      }
      try {
        this.respond(message.id, await handler(String(message.params?.tool), message.params?.arguments ?? {}));
      } catch (error) {
        this.respond(message.id, { contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }], success: false });
      }
      return;
    }

    if (message.method?.endsWith("/requestApproval") && message.id !== undefined) {
      this.respond(message.id, { decision: "decline" });
      return;
    }

    const turnId = String(message.params?.turnId ?? message.params?.turn?.id ?? "");
    const active = this.activeTurns.get(turnId);
    if (message.method === "item/agentMessage/delta" && active) {
      active.output += String(message.params?.delta ?? "");
      return;
    }
    if (message.method === "turn/completed" && active) {
      clearTimeout(active.timer);
      this.activeTurns.delete(turnId);
      if (message.params?.turn?.status === "failed") {
        active.reject(new Error(message.params?.turn?.error?.message ?? "Codex turn failed"));
      } else {
        active.resolve({ output: active.output, turnId });
      }
    }
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    for (const active of this.activeTurns.values()) {
      clearTimeout(active.timer);
      active.reject(error);
    }
    this.activeTurns.clear();
  }
}

function normalizeEffort(effort?: string): string | null {
  if (!effort || effort === "off") return null;
  return ["minimal", "low", "medium", "high", "xhigh"].includes(effort) ? effort : null;
}
