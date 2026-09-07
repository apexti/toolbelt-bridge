/**
 * Lifecycle of the local MCP servers from config.mcpServers: start/stop,
 * crash restarts, tool snapshots, and per-org exposure.
 */
import type { ConfigStore, McpServerConfig } from "../config.ts";
import { isValidServerKey, normalizeServerConfig } from "../config.ts";
import type { Logger } from "../log.ts";
import type { ServerPayload, ServerStatus, ToolDefinition } from "../protocol.ts";
import { McpRpcError, StdioMcpServer } from "./stdio-server.ts";
import { VERSION } from "../version.ts";

export interface ManagedServerState {
  key: string;
  config: McpServerConfig;
  status: ServerStatus;
  lastError: string | null;
  tools: ToolDefinition[];
  pid: number | null;
  startedAt: string | null;
  restarts: number;
  serverInfo: { name?: string; version?: string } | null;
}

interface Managed {
  key: string;
  client: StdioMcpServer | null;
  status: ServerStatus;
  lastError: string | null;
  tools: ToolDefinition[];
  startedAt: string | null;
  restartTimes: number[];
  manualStop: boolean;
  restartTimer: ReturnType<typeof setTimeout> | null;
  serverInfo: { name?: string; version?: string } | null;
}

export type McpChange = { key: string; kind: "status" | "tools" | "config" | "removed" };

const RESTART_WINDOW_MS = 10 * 60 * 1000;
const MAX_RESTARTS_PER_WINDOW = 5;

export class McpManager {
  #store: ConfigStore;
  #log: Logger;
  #servers = new Map<string, Managed>();
  #listeners = new Set<(change: McpChange) => void>();

  constructor(store: ConfigStore, log: Logger) {
    this.#store = store;
    this.#log = log;
  }

  onChange(listener: (change: McpChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(change: McpChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (error) {
        this.#log.warn("mcp", `listener failed: ${(error as Error).message}`);
      }
    }
  }

  #managed(key: string): Managed {
    let managed = this.#servers.get(key);
    if (!managed) {
      managed = {
        key,
        client: null,
        status: "stopped",
        lastError: null,
        tools: [],
        startedAt: null,
        restartTimes: [],
        manualStop: false,
        restartTimer: null,
        serverInfo: null,
      };
      this.#servers.set(key, managed);
    }
    return managed;
  }

  list(): ManagedServerState[] {
    return Object.keys(this.#store.config.mcpServers).sort().map((key) => this.get(key)!);
  }

  get(key: string): ManagedServerState | null {
    const config = this.#store.config.mcpServers[key];
    if (!config) return null;
    const managed = this.#managed(key);
    return {
      key,
      config,
      status: managed.status,
      lastError: managed.lastError,
      tools: managed.tools,
      pid: managed.client?.pid ?? null,
      startedAt: managed.startedAt,
      restarts: managed.restartTimes.length,
      serverInfo: managed.serverInfo,
    };
  }

  async startAll(): Promise<void> {
    for (const [key, config] of Object.entries(this.#store.config.mcpServers)) {
      if (!config.autoStart) continue;
      try {
        await this.start(key);
      } catch (error) {
        this.#log.error(key, `failed to start: ${(error as Error).message}`);
      }
    }
  }

  async start(key: string): Promise<ManagedServerState> {
    const config = this.#store.config.mcpServers[key];
    if (!config) throw new Error(`Unknown server "${key}"`);
    const managed = this.#managed(key);
    if (managed.client?.running) return this.get(key)!;
    if (managed.restartTimer !== null) {
      clearTimeout(managed.restartTimer);
      managed.restartTimer = null;
    }
    managed.manualStop = false;
    managed.lastError = null;
    this.#log.info(key, `starting: ${config.command} ${config.args.join(" ")}`);

    const client = new StdioMcpServer({
      command: config.command,
      args: config.args,
      env: { ...Deno.env.toObject(), ...config.env },
      cwd: config.cwd,
      clientInfo: { name: "toolbelt-bridge", version: VERSION },
      onLog: (stream, line) => this.#log.child(key, stream, line),
      onExit: (code) => this.#handleExit(key, client, code),
      onToolsChanged: () => {
        this.refreshTools(key).catch((error) =>
          this.#log.warn(key, `tools refresh failed: ${(error as Error).message}`)
        );
      },
    });
    managed.client = client;
    try {
      await client.start();
      managed.serverInfo = client.serverInfo;
      managed.tools = await client.listTools();
      managed.status = "running";
      managed.startedAt = new Date().toISOString();
      this.#log.info(key, `running (${managed.tools.length} tools)`);
    } catch (error) {
      managed.status = "error";
      managed.lastError = (error as Error).message;
      managed.client = null;
      await client.stop(500).catch(() => {});
      this.#emit({ key, kind: "status" });
      throw error;
    }
    this.#emit({ key, kind: "status" });
    return this.get(key)!;
  }

  async stop(key: string): Promise<ManagedServerState | null> {
    const managed = this.#servers.get(key);
    if (!managed) return this.get(key);
    managed.manualStop = true;
    if (managed.restartTimer !== null) {
      clearTimeout(managed.restartTimer);
      managed.restartTimer = null;
    }
    if (managed.client) {
      this.#log.info(key, "stopping");
      const client = managed.client;
      managed.client = null;
      await client.stop();
    }
    managed.status = "stopped";
    managed.startedAt = null;
    this.#emit({ key, kind: "status" });
    return this.get(key);
  }

  async restart(key: string): Promise<ManagedServerState> {
    await this.stop(key);
    return this.start(key);
  }

  async refreshTools(key: string): Promise<ToolDefinition[]> {
    const managed = this.#servers.get(key);
    if (!managed?.client?.running) return [];
    managed.tools = await managed.client.listTools();
    this.#emit({ key, kind: "tools" });
    return managed.tools;
  }

  async upsert(
    key: string,
    input: Partial<McpServerConfig> & { command?: string },
  ): Promise<ManagedServerState> {
    if (!isValidServerKey(key)) {
      throw new Error("Server key must be 1-64 letters, digits, '.', '_' or '-'");
    }
    const config = normalizeServerConfig(input);
    if (!config.command) throw new Error("A command is required");
    const existed = Boolean(this.#store.config.mcpServers[key]);
    await this.#store.update((cfg) => {
      cfg.mcpServers[key] = config;
    });
    this.#emit({ key, kind: "config" });
    const managed = this.#managed(key);
    if (existed && managed.client?.running) await this.restart(key);
    else if (config.autoStart && !managed.client?.running) {
      await this.start(key).catch((error) =>
        this.#log.error(key, `failed to start: ${(error as Error).message}`)
      );
    }
    return this.get(key)!;
  }

  async setExposure(key: string, orgs: string[]): Promise<ManagedServerState> {
    if (!this.#store.config.mcpServers[key]) throw new Error(`Unknown server "${key}"`);
    await this.#store.update((cfg) => {
      cfg.mcpServers[key].orgs = [...new Set(orgs.map(String))];
    });
    this.#emit({ key, kind: "config" });
    return this.get(key)!;
  }

  async remove(key: string): Promise<void> {
    await this.stop(key);
    await this.#store.update((cfg) => {
      delete cfg.mcpServers[key];
    });
    this.#servers.delete(key);
    this.#emit({ key, kind: "removed" });
  }

  async stopAll(): Promise<void> {
    for (const key of [...this.#servers.keys()]) {
      await this.stop(key).catch(() => {});
    }
  }

  /** Servers exposed to one org, in protocol form. */
  snapshotFor(orgId: string): ServerPayload[] {
    return this.list()
      .filter((s) => s.config.orgs.includes(orgId))
      .map((s) => this.toPayload(s));
  }

  toPayload(state: ManagedServerState): ServerPayload {
    return {
      serverKey: state.key,
      name: state.key,
      description: state.config.description || state.serverInfo?.name || null,
      icon: state.config.icon || null,
      authType: "none",
      status: state.status,
      lastError: state.lastError,
      tools: state.tools,
    };
  }

  /** Forward an MCP JSON-RPC request from Toolbelt to a server. */
  async request(
    key: string,
    request: { method: string; params?: unknown },
  ): Promise<unknown> {
    const managed = this.#servers.get(key);
    if (!managed?.client?.running) throw new Error(`Server "${key}" is not running`);
    const client = managed.client;
    switch (request.method) {
      case "initialize":
        return {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: managed.serverInfo?.name || key,
            version: managed.serverInfo?.version || "1.0.0",
          },
        };
      case "tools/list":
        return { tools: await client.listTools() };
      case "tools/call": {
        const params = (request.params || {}) as { name?: string; arguments?: unknown };
        if (!params.name) throw new Error("tools/call requires a tool name");
        return client.callTool(params.name, params.arguments);
      }
      default:
        return client.request(request.method, request.params);
    }
  }

  #handleExit(key: string, client: StdioMcpServer, code: number | null): void {
    const managed = this.#servers.get(key);
    if (!managed || managed.client !== client) return; // replaced or stopped on purpose
    managed.client = null;
    managed.startedAt = null;
    if (managed.manualStop) {
      managed.status = "stopped";
      this.#emit({ key, kind: "status" });
      return;
    }
    managed.status = "error";
    managed.lastError = `exited unexpectedly (code ${code ?? "?"})`;
    this.#log.warn(key, managed.lastError);
    const now = Date.now();
    managed.restartTimes = managed.restartTimes.filter((t) =>
      now - t < RESTART_WINDOW_MS
    );
    if (managed.restartTimes.length >= MAX_RESTARTS_PER_WINDOW) {
      managed.lastError += "; giving up after repeated crashes";
      this.#log.error(key, "too many restarts; not restarting automatically");
      this.#emit({ key, kind: "status" });
      return;
    }
    managed.restartTimes.push(now);
    const delay = Math.min(30_000, 1000 * 2 ** (managed.restartTimes.length - 1));
    this.#log.info(key, `restarting in ${delay}ms`);
    this.#emit({ key, kind: "status" });
    managed.restartTimer = setTimeout(() => {
      managed.restartTimer = null;
      this.start(key).catch((error) =>
        this.#log.error(key, `restart failed: ${(error as Error).message}`)
      );
    }, delay);
  }
}

export function errorForMcpResponse(error: unknown): { message: string; code?: string } {
  if (error instanceof McpRpcError) {
    return { message: error.message, code: String(error.code) };
  }
  return { message: (error as Error)?.message || String(error) };
}
