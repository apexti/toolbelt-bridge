/**
 * Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0), written
 * against Deno.Command so the compiled binary has no npm dependencies.
 * Supports initialize, tools/list, tools/call, arbitrary passthrough requests,
 * and notifications/tools/list_changed.
 */
import type { ToolDefinition } from "../protocol.ts";
import { resolveCommand } from "./prereqs.ts";

export interface StdioServerOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string | null;
  clientInfo?: { name: string; version: string };
  onLog?: (stream: "stdout" | "stderr", line: string) => void;
  onExit?: (code: number | null, signal: string | null) => void;
  onToolsChanged?: () => void;
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class McpRpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export class StdioMcpServer {
  #options: StdioServerOptions;
  #process: Deno.ChildProcess | null = null;
  #stdin: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;
  #exited: Promise<void> | null = null;
  serverInfo: { name?: string; version?: string } | null = null;
  capabilities: Record<string, unknown> = {};
  pid: number | null = null;

  constructor(options: StdioServerOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#process !== null && !this.#closed;
  }

  async start(): Promise<void> {
    const { command, args = [], env = {}, cwd } = this.#options;
    const resolved = await resolveCommand(command);
    if (!resolved) throw new Error(`Command not found: ${command}`);
    const fullArgs = /(^|[\\/])npx(\.cmd|\.exe)?$/i.test(resolved) && !args.includes("-y")
      ? ["-y", ...args]
      : args;
    const cmd = new Deno.Command(resolved, {
      args: fullArgs,
      env: { ...env },
      cwd: cwd || undefined,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    this.#process = cmd.spawn();
    this.pid = this.#process.pid;
    this.#stdin = this.#process.stdin.getWriter();
    this.#readLines(this.#process.stdout, (line) => this.#handleLine(line));
    this.#readLines(
      this.#process.stderr,
      (line) => this.#options.onLog?.("stderr", line),
    );
    this.#exited = this.#process.status.then((status) => {
      this.#closed = true;
      this.#rejectAll(new Error(`MCP server exited (code ${status.code})`));
      this.#options.onExit?.(status.code, status.signal ?? null);
    });

    const result = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: this.#options.clientInfo || { name: "toolbelt-bridge", version: "2" },
    }) as {
      serverInfo?: { name?: string; version?: string };
      capabilities?: Record<string, unknown>;
    };
    this.serverInfo = result?.serverInfo || null;
    this.capabilities = result?.capabilities || {};
    await this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {}) as {
        tools?: ToolDefinition[];
        nextCursor?: string;
      };
      for (const tool of result?.tools || []) {
        if (tool && typeof tool.name === "string") {
          tools.push({
            name: tool.name,
            description: typeof tool.description === "string" ? tool.description : "",
            inputSchema: tool.inputSchema && typeof tool.inputSchema === "object"
              ? tool.inputSchema
              : { type: "object", properties: {} },
          });
        }
      }
      cursor = result?.nextCursor;
    } while (cursor);
    return tools;
  }

  callTool(name: string, args: unknown): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args ?? {} });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.#stdin || this.#closed) {
      return Promise.reject(new Error("MCP server is not running"));
    }
    const id = this.#nextId++;
    const timeoutMs = this.#options.requestTimeoutMs ?? 120_000;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    this.#write({ jsonrpc: "2.0", id, method, params: params ?? {} }).catch((error) => {
      const pending = this.#pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(error);
      }
    });
    return promise;
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.#write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  async stop(graceMs = 2000): Promise<void> {
    if (!this.#process) return;
    this.#closed = true;
    try {
      await this.#stdin?.close();
    } catch {
      /* already closed */
    }
    const proc = this.#process;
    const exited = this.#exited || Promise.resolve();
    let finished = false;
    exited.then(() => (finished = true));
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, graceMs))]);
    if (!finished) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      await exited.catch(() => {});
    }
    this.#process = null;
    this.#stdin = null;
    this.#rejectAll(new Error("MCP server stopped"));
  }

  async #write(message: unknown): Promise<void> {
    if (!this.#stdin) throw new Error("MCP server is not running");
    await this.#stdin.write(new TextEncoder().encode(JSON.stringify(message) + "\n"));
  }

  #handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.#options.onLog?.("stdout", line);
      return;
    }
    if (
      message.id !== undefined &&
      (message.result !== undefined || message.error !== undefined)
    ) {
      const pending = this.#pending.get(Number(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(Number(message.id));
      if (message.error) {
        const err = message.error as { code?: number; message?: string; data?: unknown };
        pending.reject(
          new McpRpcError(err.code ?? -32000, err.message || "MCP error", err.data),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      if (message.method === "notifications/tools/list_changed") {
        this.#options.onToolsChanged?.();
      } else if (message.method === "ping" && message.id !== undefined) {
        this.#write({ jsonrpc: "2.0", id: message.id, result: {} }).catch(() => {});
      }
    }
  }

  #rejectAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
  }

  async #readLines(
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => void,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          onLine(buffer.slice(0, idx).replace(/\r$/, ""));
          buffer = buffer.slice(idx + 1);
        }
      }
      if (buffer.trim()) onLine(buffer);
    } catch {
      /* stream closed */
    }
  }
}
