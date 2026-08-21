import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { message?: string };
};

type CodexModel = {
  id: string;
  name: string;
  description: string;
  is_default: boolean;
  reasoning_efforts: string[];
};

type ProviderStatus = {
  type: "provider_status";
  provider: "openai-codex-app-server";
  available: boolean;
  connected: boolean;
  account_type: string | null;
  plan_type: string | null;
  models: CodexModel[];
  error?: string;
};

class CodexAppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(reason: Error): void }>();
  private readonly notifications = new Set<(message: JsonRpcMessage) => void>();
  private nextId = 1;
  private startupError = "";

  constructor() {
    const configured = process.env.FLOE_CODEX_COMMAND?.trim();
    if (configured) {
      this.child = spawn(configured, ["app-server", "--stdio"], { stdio: "pipe", windowsHide: true });
    } else if (process.platform === "win32") {
      this.child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "codex app-server --stdio"], {
        stdio: "pipe",
        windowsHide: true,
      });
    } else {
      this.child = spawn("codex", ["app-server", "--stdio"], { stdio: "pipe" });
    }

    this.child.stderr.on("data", chunk => { this.startupError += String(chunk); });
    this.child.on("error", error => this.rejectAll(error));
    this.child.on("exit", code => {
      if (this.pending.size > 0) {
        const detail = this.startupError.trim();
        this.rejectAll(new Error(detail || `Codex app-server exited before replying (${code ?? "unknown"})`));
      }
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", line => {
      let message: JsonRpcMessage;
      try { message = JSON.parse(line) as JsonRpcMessage; } catch { return; }
      if (message.id !== undefined && typeof message.id === "number") {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message || "Codex app-server request failed"));
        else waiter.resolve(message.result);
        return;
      }
      if (message.method) {
        for (const listener of this.notifications) listener(message);
      }
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "floe", title: "Floe", version: "0.1.0" },
      capabilities: {},
    });
    this.notify("initialized", {});
  }

  request(method: string, params: unknown = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method: string, params: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  waitFor(method: string, predicate: (params: any) => boolean, timeoutMs = 10 * 60_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.notifications.delete(listener);
        reject(new Error("Timed out waiting for ChatGPT sign-in"));
      }, timeoutMs);
      const listener = (message: JsonRpcMessage) => {
        if (message.method !== method || !predicate(message.params)) return;
        clearTimeout(timer);
        this.notifications.delete(listener);
        resolve(message.params);
      };
      this.notifications.add(listener);
    });
  }

  close(): void {
    this.child.stdin.end();
    if (!this.child.killed) this.child.kill();
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}

async function readStatus(server: CodexAppServer): Promise<ProviderStatus> {
  const account = await server.request("account/read", { refreshToken: false });
  const models: CodexModel[] = [];
  let cursor: string | null = null;
  do {
    const page = await server.request("model/list", { cursor, limit: 100 });
    for (const model of page.data ?? []) {
      if (model.hidden) continue;
      models.push({
        id: String(model.id),
        name: String(model.displayName ?? model.id),
        description: String(model.description ?? ""),
        is_default: model.isDefault === true,
        reasoning_efforts: Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts.map((item: any) => String(item.reasoningEffort ?? item.effort ?? item))
          : [],
      });
    }
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
  } while (cursor);

  return {
    type: "provider_status",
    provider: "openai-codex-app-server",
    available: true,
    connected: account.account != null,
    account_type: account.account?.type ?? null,
    plan_type: account.account?.type === "chatgpt" ? account.account.planType ?? null : null,
    models,
  };
}

async function withServer<T>(fn: (server: CodexAppServer) => Promise<T>): Promise<T> {
  const server = new CodexAppServer();
  try {
    await server.initialize();
    return await fn(server);
  } finally {
    server.close();
  }
}

async function status(): Promise<ProviderStatus> {
  try {
    return await withServer(readStatus);
  } catch (error) {
    return {
      type: "provider_status",
      provider: "openai-codex-app-server",
      available: false,
      connected: false,
      account_type: null,
      plan_type: null,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function login(): Promise<ProviderStatus> {
  return withServer(async server => {
    const current = await server.request("account/read", { refreshToken: true });
    if (current.account == null) {
      const started = await server.request("account/login/start", {
        type: "chatgpt",
        useHostedLoginSuccessPage: true,
        appBrand: "chatgpt",
      });
      if (started.type !== "chatgpt" || !started.loginId || !started.authUrl) {
        throw new Error("Codex did not start a ChatGPT browser login");
      }
      const completion = server.waitFor("account/login/completed", params => params?.loginId === started.loginId);
      await openLoginUrl(started.authUrl);
      const result = await completion;
      if (!result.success) throw new Error(result.error || "ChatGPT sign-in did not complete");
    }
    return readStatus(server);
  });
}

async function openLoginUrl(url: string): Promise<void> {
  let command: string;
  let args: string[];
  if (process.platform === "win32") {
    command = "powershell.exe";
    const script = `Start-Process -FilePath '${url.replaceAll("'", "''")}'`;
    args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  const result = command === "status"
    ? await status()
    : command === "login"
      ? await login()
      : null;
  if (!result) throw new Error("Usage: floe-auth <status|login>");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
