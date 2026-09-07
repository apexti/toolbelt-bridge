/**
 * Keeps one OrgConnection per paired org in config, forwards registry
 * changes to every connection, and implements pair / unpair.
 */
import type { ConfigStore } from "../config.ts";
import type { Logger } from "../log.ts";
import type { McpManager } from "../mcp/manager.ts";
import type { LlmRegistry } from "../llm/runtimes.ts";
import type { LlmProxy } from "../llm/proxy.ts";
import type { BridgeInfo, RemoteServerConfig } from "../protocol.ts";
import { claimPairing, orgConfigFromClaim, parsePairInput } from "../pairing.ts";
import { OrgConnection, type OrgConnectionStatus } from "./org-connection.ts";
import { VERSION } from "../version.ts";

export function currentBridgeInfo(store: ConfigStore): BridgeInfo {
  const archMap: Record<string, string> = { x86_64: "x64", aarch64: "arm64" };
  let hostname = "unknown";
  try {
    hostname = Deno.hostname();
  } catch {
    /* permission */
  }
  return {
    name: store.config.name,
    version: VERSION,
    platform: Deno.build.os,
    arch: archMap[Deno.build.arch] || Deno.build.arch,
    hostname,
  };
}

export class ConnectionManager {
  #store: ConfigStore;
  #log: Logger;
  #mcp: McpManager;
  #llm: LlmRegistry;
  #proxy: LlmProxy;
  #connections = new Map<string, OrgConnection>();
  #listeners = new Set<() => void>();
  #wsFactory?: (url: string) => WebSocket;
  #unsubscribe: Array<() => void> = [];

  constructor(
    store: ConfigStore,
    log: Logger,
    mcp: McpManager,
    llm: LlmRegistry,
    proxy: LlmProxy,
    { wsFactory }: { wsFactory?: (url: string) => WebSocket } = {},
  ) {
    this.#store = store;
    this.#log = log;
    this.#mcp = mcp;
    this.#llm = llm;
    this.#proxy = proxy;
    this.#wsFactory = wsFactory;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }

  start(): void {
    this.#unsubscribe.push(
      this.#mcp.onChange(() => {
        for (const conn of this.#connections.values()) conn.syncServers();
        this.#emit();
      }),
      this.#llm.onChange(() => {
        for (const conn of this.#connections.values()) conn.syncModels();
        this.#emit();
      }),
    );
    this.syncFromConfig();
  }

  stop(): void {
    for (const off of this.#unsubscribe.splice(0)) off();
    for (const conn of this.#connections.values()) conn.close();
    this.#connections.clear();
  }

  syncFromConfig(): void {
    const wanted = new Set(this.#store.config.orgs.map((o) => o.id));
    for (const [orgId, conn] of this.#connections) {
      if (!wanted.has(orgId)) {
        conn.close();
        this.#connections.delete(orgId);
      }
    }
    for (const org of this.#store.config.orgs) {
      if (this.#connections.has(org.id)) continue;
      const conn = new OrgConnection(org, {
        mcp: this.#mcp,
        llm: this.#llm,
        proxy: this.#proxy,
        log: this.#log,
        bridgeInfo: () => currentBridgeInfo(this.#store),
        allowRemoteServerCreate: () => this.#store.config.allowRemoteServerCreate,
        createServer: (config: RemoteServerConfig) => this.#createFromRemote(config),
        onState: () => this.#emit(),
        wsFactory: this.#wsFactory,
      });
      conn.setInstallId(this.#store.config.installId);
      this.#connections.set(org.id, conn);
      conn.connect();
    }
    this.#emit();
  }

  list(): OrgConnectionStatus[] {
    return [...this.#connections.values()].map((c) => c.status());
  }

  get(orgId: string): OrgConnection | null {
    return this.#connections.get(orgId) || null;
  }

  async #createFromRemote(config: RemoteServerConfig): Promise<void> {
    // Servers created from Toolbelt belong to the org that asked for them;
    // the org id is resolved from the connection that received the command.
    const orgs = config.orgId ? [config.orgId] : [];
    await this.#mcp.upsert(config.serverKey, {
      command: config.command,
      args: config.args || [],
      env: config.env || {},
      cwd: config.cwd || null,
      description: config.description || null,
      icon: config.icon || null,
      autoStart: config.autoStart !== false,
      orgs: orgs.length > 0
        ? orgs
        : this.#store.config.mcpServers[config.serverKey]?.orgs || [],
    });
  }

  /** Pair with an org from a code or pair URL; connects immediately. */
  async pair(input: string, serverUrl?: string | null): Promise<OrgConnectionStatus> {
    const target = parsePairInput(input, serverUrl);
    const claim = await claimPairing(
      target,
      this.#store.config.installId,
      currentBridgeInfo(this.#store),
    );
    const orgCfg = orgConfigFromClaim(claim, target.serverUrl);
    await this.#store.update((cfg) => {
      cfg.orgs = cfg.orgs.filter((o) => o.id !== orgCfg.id);
      cfg.orgs.push(orgCfg);
    });
    const existing = this.#connections.get(orgCfg.id);
    if (existing) {
      existing.close();
      this.#connections.delete(orgCfg.id);
    }
    this.#log.info("pair", `paired with ${orgCfg.name} at ${orgCfg.serverUrl}`);
    this.syncFromConfig();
    return this.#connections.get(orgCfg.id)!.status();
  }

  /** Forget an org locally (the bridge row in Toolbelt is removed from its Bridges page). */
  async unpair(orgId: string): Promise<void> {
    this.#connections.get(orgId)?.close();
    this.#connections.delete(orgId);
    await this.#store.update((cfg) => {
      cfg.orgs = cfg.orgs.filter((o) => o.id !== orgId);
      for (const server of Object.values(cfg.mcpServers)) {
        server.orgs = server.orgs.filter((id) => id !== orgId);
      }
      for (const [key, model] of Object.entries(cfg.llm.models)) {
        model.orgs = model.orgs.filter((id) => id !== orgId);
        if (model.orgs.length === 0) delete cfg.llm.models[key];
      }
    });
    this.#emit();
  }

  reconnect(orgId: string): void {
    const conn = this.#connections.get(orgId);
    if (!conn) return;
    conn.close();
    this.#connections.delete(orgId);
    this.syncFromConfig();
  }
}
