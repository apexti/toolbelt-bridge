/**
 * Bridge configuration (config v2) with migration from the v1 Node bridge's
 * settings.json. Stored as JSON with mode 0600; tokens live here.
 */
import { ensureDir } from "./paths.ts";

export interface OrgConnectionConfig {
  id: string; // Toolbelt organization id
  name: string;
  serverUrl: string; // https://toolbelt.example.com
  wsUrl: string; // wss://toolbelt.example.com/bridge
  bridgeId: string;
  bridgeName?: string | null;
  token: string;
  isPersonal?: boolean;
  pairedAt?: string;
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string | null;
  autoStart: boolean;
  icon?: string | null;
  description?: string | null;
  orgs: string[]; // org ids this server is exposed to
}

export interface LlmRuntimeConfig {
  id: string; // "ollama" | "lmstudio" | "vllm" | custom id
  name: string;
  baseURL: string; // OpenAI-compatible base, e.g. http://127.0.0.1:11434/v1
  enabled: boolean;
  builtin?: boolean;
  apiKey?: string | null; // for user-added OpenAI-compatible runtimes
}

export interface LlmModelConfig {
  orgs: string[];
  displayName?: string | null;
}

export interface BridgeConfig {
  version: 2;
  installId: string;
  name: string;
  ui: { port: number; open: boolean };
  allowRemoteServerCreate: boolean;
  orgs: OrgConnectionConfig[];
  mcpServers: Record<string, McpServerConfig>;
  llm: {
    runtimes: LlmRuntimeConfig[];
    models: Record<string, LlmModelConfig>; // key: `${runtimeId}/${modelId}`
  };
}

export const DEFAULT_UI_PORT = 4747;

export const BUILTIN_RUNTIMES: LlmRuntimeConfig[] = [
  {
    id: "ollama",
    name: "Ollama",
    baseURL: "http://127.0.0.1:11434/v1",
    enabled: true,
    builtin: true,
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    baseURL: "http://127.0.0.1:1234/v1",
    enabled: true,
    builtin: true,
  },
  {
    id: "vllm",
    name: "vLLM",
    baseURL: "http://127.0.0.1:8000/v1",
    enabled: true,
    builtin: true,
  },
];

function hostname(): string {
  try {
    return Deno.hostname();
  } catch {
    return "bridge";
  }
}

export function defaultConfig(): BridgeConfig {
  return {
    version: 2,
    installId: crypto.randomUUID(),
    name: hostname(),
    ui: { port: DEFAULT_UI_PORT, open: true },
    allowRemoteServerCreate: true,
    orgs: [],
    mcpServers: {},
    llm: { runtimes: BUILTIN_RUNTIMES.map((r) => ({ ...r })), models: {} },
  };
}

const SERVER_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function isValidServerKey(key: string): boolean {
  return SERVER_KEY_RE.test(key);
}

export function normalizeServerConfig(
  input: Partial<McpServerConfig> & { command?: string },
): McpServerConfig {
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.env || {})) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = String(v ?? "");
  }
  return {
    command: String(input.command || "").trim(),
    args,
    env,
    cwd: input.cwd ? String(input.cwd) : null,
    autoStart: input.autoStart !== false,
    icon: input.icon ? String(input.icon).slice(0, 20_000) : null,
    description: input.description ? String(input.description).slice(0, 500) : null,
    orgs: Array.isArray(input.orgs) ? input.orgs.map(String) : [],
  };
}

/** Accept a v1 settings.json ({apikey, bridgeConnectionId, mcpServers}) or a v2 file. */
export function migrateConfig(raw: unknown): BridgeConfig {
  const base = defaultConfig();
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;
  if (obj.version === 2) {
    const cfg = obj as unknown as BridgeConfig;
    const runtimes = Array.isArray(cfg.llm?.runtimes) ? cfg.llm.runtimes : [];
    const merged = BUILTIN_RUNTIMES.map((builtin) => {
      const saved = runtimes.find((r) => r.id === builtin.id);
      return saved ? { ...builtin, ...saved, builtin: true } : { ...builtin };
    });
    for (const r of runtimes) {
      if (!merged.some((m) => m.id === r.id)) merged.push({ ...r, builtin: false });
    }
    const mcpServers: Record<string, McpServerConfig> = {};
    for (const [key, value] of Object.entries(cfg.mcpServers || {})) {
      if (isValidServerKey(key)) {
        mcpServers[key] = normalizeServerConfig(value as McpServerConfig);
      }
    }
    return {
      ...base,
      ...cfg,
      version: 2,
      installId: typeof cfg.installId === "string" && cfg.installId
        ? cfg.installId
        : base.installId,
      name: typeof cfg.name === "string" && cfg.name ? cfg.name : base.name,
      ui: { ...base.ui, ...(cfg.ui || {}) },
      allowRemoteServerCreate: cfg.allowRemoteServerCreate !== false,
      orgs: Array.isArray(cfg.orgs) ? cfg.orgs : [],
      mcpServers,
      llm: { runtimes: merged, models: cfg.llm?.models || {} },
    };
  }
  // v1: { apikey, bridgeConnectionId, bridgeName, mcpServers: { name: { command, args, options, env } } }
  const v1Servers = (obj.mcpServers && typeof obj.mcpServers === "object")
    ? obj.mcpServers as Record<string, Record<string, unknown>>
    : {};
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(v1Servers)) {
    const key =
      name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+/, "").slice(0, 64) ||
      "server";
    const options = (server.options || {}) as Record<string, unknown>;
    mcpServers[key] = normalizeServerConfig({
      command: String(server.command || ""),
      args: (server.args as string[]) || [],
      env: (server.env as Record<string, string>) || {},
      cwd: typeof options.cwd === "string" ? options.cwd : null,
      autoStart: true,
      orgs: [],
    });
  }
  return {
    ...base,
    installId: typeof obj.bridgeConnectionId === "string" && obj.bridgeConnectionId
      ? obj.bridgeConnectionId
      : base.installId,
    mcpServers,
  };
}

export async function loadConfig(
  path: string,
): Promise<{ config: BridgeConfig; migrated: boolean; existed: boolean }> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { config: defaultConfig(), migrated: false, existed: false };
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`Config at ${path} is not valid JSON`);
  }
  const migrated =
    !(raw && typeof raw === "object" && (raw as { version?: number }).version === 2);
  return { config: migrateConfig(raw), migrated, existed: true };
}

export async function saveConfig(path: string, config: BridgeConfig): Promise<void> {
  const dir = path.replace(/[\\/][^\\/]+$/, "");
  await ensureDir(dir);
  const tmp = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(config, null, 2) + "\n");
  if (Deno.build.os !== "windows") {
    try {
      await Deno.chmod(tmp, 0o600);
    } catch {
      /* best effort */
    }
  }
  await Deno.rename(tmp, path);
}

/** Small mutable holder so subsystems share one config object and one save path. */
export class ConfigStore {
  #path: string;
  #config: BridgeConfig;
  #listeners = new Set<() => void>();

  constructor(path: string, config: BridgeConfig) {
    this.#path = path;
    this.#config = config;
  }

  get path(): string {
    return this.#path;
  }

  get config(): BridgeConfig {
    return this.#config;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async update(mutate: (config: BridgeConfig) => void): Promise<BridgeConfig> {
    mutate(this.#config);
    await saveConfig(this.#path, this.#config);
    for (const listener of this.#listeners) listener();
    return this.#config;
  }
}
