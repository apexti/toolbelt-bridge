/**
 * Local LLM runtimes (Ollama, LM Studio, vLLM, or any OpenAI-compatible base
 * URL): periodic discovery via GET {baseURL}/models and per-org exposure of
 * individual models. Exposure keys are `${runtimeId}/${modelId}`.
 */
import type { ConfigStore, LlmRuntimeConfig } from "../config.ts";
import type { Logger } from "../log.ts";
import type { ModelPayload, ModelRuntime } from "../protocol.ts";

export interface RuntimeState extends LlmRuntimeConfig {
  kind: ModelRuntime;
  reachable: boolean;
  models: string[];
  error: string | null;
  checkedAt: string | null;
}

export interface ResolvedModel {
  runtime: RuntimeState;
  modelId: string;
}

export function runtimeKind(id: string): ModelRuntime {
  if (id === "ollama" || id === "lmstudio" || id === "vllm") return id;
  return "openai-compatible";
}

export class LlmRegistry {
  #store: ConfigStore;
  #log: Logger;
  #fetch: typeof fetch;
  #states = new Map<string, RuntimeState>();
  #listeners = new Set<() => void>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #intervalMs: number;
  #probeTimeoutMs: number;

  constructor(
    store: ConfigStore,
    log: Logger,
    { fetchImpl = fetch, intervalMs = 30_000, probeTimeoutMs = 2500 }: {
      fetchImpl?: typeof fetch;
      intervalMs?: number;
      probeTimeoutMs?: number;
    } = {},
  ) {
    this.#store = store;
    this.#log = log;
    this.#fetch = fetchImpl;
    this.#intervalMs = intervalMs;
    this.#probeTimeoutMs = probeTimeoutMs;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }

  start(): void {
    this.discover().catch(() => {});
    this.#timer = setInterval(() => this.discover().catch(() => {}), this.#intervalMs);
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  runtimes(): RuntimeState[] {
    return this.#store.config.llm.runtimes.map((cfg) => {
      const state = this.#states.get(cfg.id);
      return {
        ...cfg,
        kind: runtimeKind(cfg.id),
        reachable: state?.reachable ?? false,
        models: state?.models ?? [],
        error: state?.error ?? null,
        checkedAt: state?.checkedAt ?? null,
      };
    });
  }

  runtime(id: string): RuntimeState | null {
    return this.runtimes().find((r) => r.id === id) || null;
  }

  async discover(): Promise<void> {
    let changed = false;
    for (const cfg of this.#store.config.llm.runtimes) {
      const previous = this.#states.get(cfg.id);
      if (!cfg.enabled) {
        if (previous?.reachable || previous?.models.length) changed = true;
        this.#states.set(cfg.id, {
          ...this.#stateFrom(cfg),
          reachable: false,
          models: [],
          error: "disabled",
        });
        continue;
      }
      const next = await this.#probe(cfg);
      if (
        !previous || previous.reachable !== next.reachable ||
        previous.models.join("\n") !== next.models.join("\n")
      ) {
        changed = true;
        if (next.reachable) {
          this.#log.info(
            "llm",
            `${cfg.name}: ${next.models.length} models at ${cfg.baseURL}`,
          );
        } else if (previous?.reachable) {
          this.#log.warn("llm", `${cfg.name}: unreachable (${next.error})`);
        }
      }
      this.#states.set(cfg.id, next);
    }
    if (changed) this.#emit();
  }

  #stateFrom(cfg: LlmRuntimeConfig): RuntimeState {
    return {
      ...cfg,
      kind: runtimeKind(cfg.id),
      reachable: false,
      models: [],
      error: null,
      checkedAt: new Date().toISOString(),
    };
  }

  async #probe(cfg: LlmRuntimeConfig): Promise<RuntimeState> {
    const state = this.#stateFrom(cfg);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
      const response = await this.#fetch(`${cfg.baseURL.replace(/\/+$/, "")}/models`, {
        headers,
        signal: AbortSignal.timeout(this.#probeTimeoutMs),
      });
      if (!response.ok) {
        state.error = `HTTP ${response.status}`;
        return state;
      }
      const json = await response.json() as {
        data?: Array<{ id?: string }>;
        models?: Array<{ name?: string }>;
      };
      const ids = Array.isArray(json?.data)
        ? json.data.map((m) => m?.id).filter((id): id is string => typeof id === "string")
        : Array.isArray(json?.models)
        ? json.models.map((m) => m?.name).filter((n): n is string =>
          typeof n === "string"
        )
        : [];
      state.reachable = true;
      state.models = [...new Set(ids)].sort();
    } catch (error) {
      state.error = (error as Error)?.message || "unreachable";
    }
    return state;
  }

  /** Models exposed to one org, in protocol form. */
  modelsFor(orgId: string): ModelPayload[] {
    const out: ModelPayload[] = [];
    const runtimes = this.runtimes();
    for (const [key, exposure] of Object.entries(this.#store.config.llm.models)) {
      if (!exposure.orgs.includes(orgId)) continue;
      const slash = key.indexOf("/");
      if (slash < 0) continue;
      const runtimeId = key.slice(0, slash);
      const modelId = key.slice(slash + 1);
      const runtime = runtimes.find((r) => r.id === runtimeId);
      if (!runtime) continue;
      const available = runtime.enabled && runtime.reachable &&
        runtime.models.includes(modelId);
      out.push({
        modelId,
        runtime: runtime.kind,
        displayName: exposure.displayName || null,
        capabilities: {},
        status: available ? "available" : "unavailable",
      });
    }
    // Two runtimes exposing the same model id would collide server-side; keep the first.
    const seen = new Set<string>();
    return out.filter((m) => (seen.has(m.modelId) ? false : (seen.add(m.modelId), true)));
  }

  /** Which runtime should serve `modelId` for this org. */
  resolveModel(modelId: string, orgId: string): ResolvedModel | null {
    const runtimes = this.runtimes();
    let fallback: ResolvedModel | null = null;
    for (const [key, exposure] of Object.entries(this.#store.config.llm.models)) {
      if (!exposure.orgs.includes(orgId)) continue;
      if (!key.endsWith(`/${modelId}`)) continue;
      const runtime = runtimes.find((r) =>
        r.id === key.slice(0, key.length - modelId.length - 1)
      );
      if (!runtime || !runtime.enabled) continue;
      if (runtime.reachable && runtime.models.includes(modelId)) {
        return { runtime, modelId };
      }
      fallback ||= { runtime, modelId };
    }
    return fallback;
  }

  async setExposure(
    runtimeId: string,
    modelId: string,
    orgs: string[],
    displayName?: string | null,
  ): Promise<void> {
    const key = `${runtimeId}/${modelId}`;
    await this.#store.update((cfg) => {
      const unique = [...new Set(orgs.map(String))];
      if (unique.length === 0) delete cfg.llm.models[key];
      else {cfg.llm.models[key] = {
          orgs: unique,
          displayName: displayName ?? cfg.llm.models[key]?.displayName ?? null,
        };}
    });
    this.#emit();
  }

  async upsertRuntime(
    input: Partial<LlmRuntimeConfig> & { id?: string; baseURL?: string },
  ): Promise<void> {
    const id = String(input.id || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
    if (!id) throw new Error("Runtime id is required");
    const baseURL = String(input.baseURL || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(baseURL)) {
      throw new Error("Base URL must start with http:// or https://");
    }
    await this.#store.update((cfg) => {
      const existing = cfg.llm.runtimes.find((r) => r.id === id);
      if (existing) {
        existing.name = input.name ? String(input.name) : existing.name;
        existing.baseURL = baseURL;
        existing.enabled = input.enabled !== false;
        existing.apiKey = input.apiKey === undefined
          ? existing.apiKey
          : (input.apiKey || null);
      } else {
        cfg.llm.runtimes.push({
          id,
          name: input.name ? String(input.name) : id,
          baseURL,
          enabled: input.enabled !== false,
          builtin: false,
          apiKey: input.apiKey || null,
        });
      }
    });
    await this.discover();
    this.#emit();
  }

  async removeRuntime(id: string): Promise<void> {
    await this.#store.update((cfg) => {
      const runtime = cfg.llm.runtimes.find((r) => r.id === id);
      if (runtime?.builtin) {
        throw new Error("Built-in runtimes can be disabled but not removed");
      }
      cfg.llm.runtimes = cfg.llm.runtimes.filter((r) => r.id !== id);
      for (const key of Object.keys(cfg.llm.models)) {
        if (key.startsWith(`${id}/`)) delete cfg.llm.models[key];
      }
    });
    this.#states.delete(id);
    this.#emit();
  }
}
