/**
 * Bridge ⇄ Toolbelt protocol v2 message types. The server-side reference is
 * docs/bridge-protocol-v2.md in the Toolbelt repo.
 */
export const PROTOCOL_VERSION = 2;

export type ServerStatus = "running" | "stopped" | "error";
export type ModelStatus = "available" | "unavailable";
export type ModelRuntime = "ollama" | "lmstudio" | "vllm" | "openai-compatible";

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ServerPayload {
  serverKey: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  authType?: string;
  configSchema?: Record<string, unknown> | null;
  status: ServerStatus;
  lastError?: string | null;
  tools: ToolDefinition[];
}

export interface ModelPayload {
  modelId: string;
  runtime: ModelRuntime;
  displayName?: string | null;
  capabilities?: { imageInput?: boolean; contextLength?: number };
  status: ModelStatus;
}

export interface BridgeInfo {
  name: string;
  version: string;
  platform: string;
  arch: string;
  hostname: string;
}

export interface HelloMessage {
  type: "hello";
  protocolVersion: number;
  token: string;
  installId: string;
  bridgeId?: string;
  bridgeInfo: BridgeInfo;
}

export interface WelcomeMessage {
  type: "welcome";
  protocolVersion: number;
  bridgeId: string;
  bridgeName?: string;
  organizationId: string;
  organizationName?: string | null;
  userId: string;
  serverTime: string;
  heartbeatIntervalMs?: number;
}

export interface McpRequestMessage {
  type: "mcp.request";
  requestId: string;
  serverKey: string;
  request: { method: string; params?: unknown; id?: unknown };
  authContext?: Record<string, unknown>;
}

export interface ServiceCommandMessage {
  type: "service.start" | "service.stop" | "service.create" | "models.refresh";
  requestId: string;
  serverKey?: string;
  config?: RemoteServerConfig;
}

export interface RemoteServerConfig {
  serverKey: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string | null;
  description?: string | null;
  icon?: string | null;
  autoStart?: boolean;
  /** Set by the receiving connection: the org that asked for the server. */
  orgId?: string;
}

export interface LlmRequestMessage {
  type: "llm.request";
  requestId: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface LlmAbortMessage {
  type: "llm.abort";
  requestId: string;
}

export type InboundMessage =
  | WelcomeMessage
  | { type: "ping" }
  | { type: "pong" }
  | McpRequestMessage
  | ServiceCommandMessage
  | LlmRequestMessage
  | LlmAbortMessage
  | { type: "error"; code?: string; message?: string; requestId?: string }
  | { type: "revoked" };

export type OutboundMessage =
  | HelloMessage
  | { type: "ping" }
  | { type: "pong" }
  | { type: "servers.upsert"; servers: ServerPayload[] }
  | { type: "servers.remove"; serverKey: string; reason: "stopped" | "deleted" }
  | { type: "tools.changed"; serverKey: string; tools: ToolDefinition[] }
  | { type: "models.upsert"; models: ModelPayload[] }
  | { type: "models.remove"; modelId: string; reason: "unavailable" | "deleted" }
  | {
    type: "mcp.response";
    requestId: string;
    response?: unknown;
    error?: { message: string; code?: string };
  }
  | {
    type: "service.result";
    requestId: string;
    ok: boolean;
    server?: ServerPayload;
    error?: { message: string };
  }
  | {
    type: "llm.response.start";
    requestId: string;
    status: number;
    headers: Record<string, string>;
  }
  | {
    type: "llm.response.chunk";
    requestId: string;
    data: string;
    encoding?: "utf8" | "base64";
  }
  | { type: "llm.response.end"; requestId: string }
  | {
    type: "llm.response.error";
    requestId: string;
    error: { message: string; code?: string };
  };

/** Close codes sent by the server. */
export const CLOSE_CODES = {
  HEARTBEAT_TIMEOUT: 4000,
  UNSUPPORTED_PROTOCOL: 4400,
  AUTH_FAILED: 4401,
  REVOKED: 4403,
  SUPERSEDED: 4409,
} as const;
