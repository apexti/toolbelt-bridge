/**
 * One WebSocket to Toolbelt per paired organization: hello/welcome, keepalive,
 * reconnect with backoff, registry sync (servers/models), and dispatch of
 * mcp.request / service.* / llm.* frames to the local subsystems.
 */
import type { OrgConnectionConfig } from "../config.ts";
import type { Logger } from "../log.ts";
import {
  type BridgeInfo,
  CLOSE_CODES,
  type InboundMessage,
  type LlmRequestMessage,
  type McpRequestMessage,
  type ModelPayload,
  type OutboundMessage,
  PROTOCOL_VERSION,
  type RemoteServerConfig,
  type ServerPayload,
  type ServiceCommandMessage,
  type WelcomeMessage,
} from "../protocol.ts";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "revoked";

export interface McpLike {
  snapshotFor(orgId: string): ServerPayload[];
  request(key: string, request: { method: string; params?: unknown }): Promise<unknown>;
  start(key: string): Promise<unknown>;
  stop(key: string): Promise<unknown>;
}
export interface LlmLike {
  modelsFor(orgId: string): ModelPayload[];
  discover(): Promise<void>;
}
export interface ProxyLike {
  handle(
    orgId: string,
    msg: LlmRequestMessage,
    send: (m: OutboundMessage) => void,
  ): Promise<void>;
  abort(requestId: string): void;
}

export interface OrgConnectionDeps {
  mcp: McpLike;
  llm: LlmLike;
  proxy: ProxyLike;
  log: Logger;
  bridgeInfo: () => BridgeInfo;
  allowRemoteServerCreate: () => boolean;
  createServer: (config: RemoteServerConfig) => Promise<void>;
  onState?: (conn: OrgConnection) => void;
  wsFactory?: (url: string) => WebSocket;
  pingIntervalMs?: number;
  staleAfterMs?: number;
}

export interface OrgConnectionStatus {
  orgId: string;
  orgName: string;
  serverUrl: string;
  bridgeId: string;
  bridgeName: string | null;
  isPersonal: boolean;
  state: ConnectionState;
  lastError: string | null;
  connectedAt: string | null;
  attempt: number;
  serversExposed: number;
  modelsExposed: number;
}

function errorToPayload(error: unknown): { message: string; code?: string } {
  const message = (error as Error)?.message || String(error);
  const code = (error as { code?: unknown })?.code;
  return code !== undefined ? { message, code: String(code) } : { message };
}

export class OrgConnection {
  cfg: OrgConnectionConfig;
  state: ConnectionState = "idle";
  lastError: string | null = null;
  connectedAt: string | null = null;
  welcome: WelcomeMessage | null = null;
  #deps: OrgConnectionDeps;
  #ws: WebSocket | null = null;
  #attempt = 0;
  #stopped = false;
  #pingTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #lastMessageAt = 0;
  #announcedServers = new Map<string, string>(); // serverKey -> JSON snapshot
  #announcedModels = new Map<string, string>();

  constructor(cfg: OrgConnectionConfig, deps: OrgConnectionDeps) {
    this.cfg = cfg;
    this.#deps = deps;
  }

  get orgId(): string {
    return this.cfg.id;
  }

  get connected(): boolean {
    return this.state === "connected" && this.#ws?.readyState === WebSocket.OPEN;
  }

  status(): OrgConnectionStatus {
    return {
      orgId: this.cfg.id,
      orgName: this.cfg.name,
      serverUrl: this.cfg.serverUrl,
      bridgeId: this.cfg.bridgeId,
      bridgeName: this.welcome?.bridgeName || this.cfg.bridgeName || null,
      isPersonal: this.cfg.isPersonal === true,
      state: this.state,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
      attempt: this.#attempt,
      serversExposed: this.#deps.mcp.snapshotFor(this.cfg.id).length,
      modelsExposed: this.#deps.llm.modelsFor(this.cfg.id).length,
    };
  }

  #setState(state: ConnectionState, error: string | null = null): void {
    this.state = state;
    this.lastError = error;
    this.#deps.onState?.(this);
  }

  connect(): void {
    if (this.#stopped) return;
    if (
      this.#ws &&
      (this.#ws.readyState === WebSocket.OPEN ||
        this.#ws.readyState === WebSocket.CONNECTING)
    ) return;
    this.#setState(this.#attempt > 0 ? "reconnecting" : "connecting", this.lastError);
    let ws: WebSocket;
    try {
      ws = this.#deps.wsFactory
        ? this.#deps.wsFactory(this.cfg.wsUrl)
        : new WebSocket(this.cfg.wsUrl);
    } catch (error) {
      this.#scheduleReconnect(`cannot open socket: ${(error as Error).message}`);
      return;
    }
    this.#ws = ws;
    ws.onopen = () => {
      this.#lastMessageAt = Date.now();
      this.send({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        token: this.cfg.token,
        installId: this.#installId(),
        bridgeId: this.cfg.bridgeId,
        bridgeInfo: this.#deps.bridgeInfo(),
      });
    };
    ws.onmessage = (event) => {
      this.#lastMessageAt = Date.now();
      let message: InboundMessage;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.#handle(message).catch((error) =>
        this.#deps.log.error(this.#tag(), `handler failed: ${(error as Error).message}`)
      );
    };
    ws.onerror = () => {
      /* onclose follows with the reason */
    };
    ws.onclose = (event) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#stopPing();
      this.welcome = null;
      this.connectedAt = null;
      this.#announcedServers.clear();
      this.#announcedModels.clear();
      this.#handleClose(event.code, event.reason);
    };
  }

  #installIdValue = "";
  setInstallId(installId: string): void {
    this.#installIdValue = installId;
  }
  #installId(): string {
    return this.#installIdValue;
  }

  #tag(): string {
    return `org:${this.cfg.name}`;
  }

  #handleClose(code: number, reason: string): void {
    const log = this.#deps.log;
    switch (code) {
      case CLOSE_CODES.REVOKED:
        log.warn(
          this.#tag(),
          "bridge token was revoked or the bridge was deleted in Toolbelt; pair again",
        );
        this.#stopped = true;
        this.#setState("revoked", "Revoked in Toolbelt — pair again to reconnect");
        return;
      case CLOSE_CODES.AUTH_FAILED:
        log.error(
          this.#tag(),
          `authentication failed (${reason || "no reason"}); pair again`,
        );
        this.#stopped = true;
        this.#setState("error", "Toolbelt rejected the bridge token — pair again");
        return;
      case CLOSE_CODES.UNSUPPORTED_PROTOCOL:
        log.error(
          this.#tag(),
          "Toolbelt does not accept this bridge version; update the bridge",
        );
        this.#stopped = true;
        this.#setState("error", "Protocol mismatch — update the bridge");
        return;
      case CLOSE_CODES.SUPERSEDED:
        log.warn(
          this.#tag(),
          "another bridge instance connected with this token; this one is standing down",
        );
        this.#stopped = true;
        this.#setState("error", "Superseded by another running bridge instance");
        return;
      default:
        this.#scheduleReconnect(
          `connection closed (${code}${reason ? ` ${reason}` : ""})`,
        );
    }
  }

  #scheduleReconnect(reason: string): void {
    if (this.#stopped) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.#attempt, 5)) +
      Math.floor(Math.random() * 500);
    this.#attempt += 1;
    this.#deps.log.warn(
      this.#tag(),
      `${reason}; reconnecting in ${Math.round(delay / 1000)}s`,
    );
    this.#setState("reconnecting", reason);
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, delay);
  }

  close(): void {
    this.#stopped = true;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#stopPing();
    const ws = this.#ws;
    this.#ws = null;
    try {
      ws?.close(1000, "bridge stopping");
    } catch {
      /* already closed */
    }
    this.#setState("idle");
  }

  send(message: OutboundMessage): boolean {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.#ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.#deps.log.warn(this.#tag(), `send failed: ${(error as Error).message}`);
      return false;
    }
  }

  // ---- registry sync ------------------------------------------------------

  syncServers(): void {
    if (!this.connected) return;
    const snapshot = this.#deps.mcp.snapshotFor(this.cfg.id);
    const changed = snapshot.filter((s) =>
      this.#announcedServers.get(s.serverKey) !== JSON.stringify(s)
    );
    for (const key of [...this.#announcedServers.keys()]) {
      if (!snapshot.some((s) => s.serverKey === key)) {
        this.send({ type: "servers.remove", serverKey: key, reason: "deleted" });
        this.#announcedServers.delete(key);
      }
    }
    if (changed.length > 0) {
      this.send({ type: "servers.upsert", servers: changed });
      for (const s of changed) this.#announcedServers.set(s.serverKey, JSON.stringify(s));
    }
  }

  syncModels(): void {
    if (!this.connected) return;
    const snapshot = this.#deps.llm.modelsFor(this.cfg.id);
    for (const id of [...this.#announcedModels.keys()]) {
      if (!snapshot.some((m) => m.modelId === id)) {
        this.send({ type: "models.remove", modelId: id, reason: "deleted" });
        this.#announcedModels.delete(id);
      }
    }
    const changed = snapshot.filter((m) =>
      this.#announcedModels.get(m.modelId) !== JSON.stringify(m)
    );
    if (changed.length > 0) {
      this.send({ type: "models.upsert", models: changed });
      for (const m of changed) this.#announcedModels.set(m.modelId, JSON.stringify(m));
    }
  }

  // ---- inbound ------------------------------------------------------------

  async #handle(message: InboundMessage): Promise<void> {
    switch (message.type) {
      case "welcome":
        this.welcome = message;
        this.#attempt = 0;
        this.connectedAt = new Date().toISOString();
        this.#deps.log.info(
          this.#tag(),
          `connected as "${message.bridgeName || this.cfg.bridgeId}" (${
            message.organizationName || this.cfg.id
          })`,
        );
        this.#setState("connected");
        this.syncServers();
        this.syncModels();
        this.#startPing(message.heartbeatIntervalMs);
        return;
      case "ping":
        this.send({ type: "pong" });
        return;
      case "pong":
        return;
      case "mcp.request":
        await this.#handleMcpRequest(message);
        return;
      case "service.start":
      case "service.stop":
      case "service.create":
      case "models.refresh":
        await this.#handleCommand(message);
        return;
      case "llm.request":
        await this.#deps.proxy.handle(this.cfg.id, message, (m) => this.send(m));
        return;
      case "llm.abort":
        this.#deps.proxy.abort(message.requestId);
        return;
      case "error":
        this.#deps.log.warn(
          this.#tag(),
          `server error: ${message.code || ""} ${message.message || ""}`,
        );
        return;
      case "revoked":
        this.#deps.log.warn(this.#tag(), "token revoked by Toolbelt");
        return;
      default:
        this.#deps.log.debug(
          this.#tag(),
          `unknown frame ${(message as { type: string }).type}`,
        );
    }
  }

  async #handleMcpRequest(message: McpRequestMessage): Promise<void> {
    try {
      const response = await this.#deps.mcp.request(message.serverKey, message.request);
      this.send({ type: "mcp.response", requestId: message.requestId, response });
    } catch (error) {
      this.send({
        type: "mcp.response",
        requestId: message.requestId,
        error: errorToPayload(error),
      });
    }
  }

  async #handleCommand(message: ServiceCommandMessage): Promise<void> {
    const requestId = message.requestId;
    try {
      switch (message.type) {
        case "service.start":
          await this.#deps.mcp.start(String(message.serverKey));
          break;
        case "service.stop":
          await this.#deps.mcp.stop(String(message.serverKey));
          break;
        case "service.create":
          if (!this.#deps.allowRemoteServerCreate()) {
            throw new Error(
              "Creating servers from Toolbelt is disabled in this bridge's settings",
            );
          }
          if (!message.config) throw new Error("service.create requires a config");
          await this.#deps.createServer(
            { ...message.config, orgId: this.cfg.id } as RemoteServerConfig,
          );
          break;
        case "models.refresh":
          await this.#deps.llm.discover();
          this.syncModels();
          break;
      }
      this.send({ type: "service.result", requestId, ok: true });
      this.syncServers();
    } catch (error) {
      this.send({
        type: "service.result",
        requestId,
        ok: false,
        error: errorToPayload(error),
      });
      this.syncServers();
    }
  }

  // ---- keepalive ----------------------------------------------------------

  #startPing(serverIntervalMs?: number): void {
    this.#stopPing();
    const interval = this.#deps.pingIntervalMs ?? serverIntervalMs ?? 25_000;
    const stale = this.#deps.staleAfterMs ?? interval * 3 + 15_000;
    this.#pingTimer = setInterval(() => {
      if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.#lastMessageAt > stale) {
        this.#deps.log.warn(this.#tag(), "no traffic from Toolbelt; reconnecting");
        try {
          this.#ws.close(4000, "stale");
        } catch {
          /* ignore */
        }
        return;
      }
      this.send({ type: "ping" });
    }, interval);
  }

  #stopPing(): void {
    if (this.#pingTimer !== null) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
  }
}
