/**
 * Read-through proxy for the official MCP Registry, used by the local UI's
 * "Browse registry" panel. Cached briefly; inactive entries dropped.
 */
export const DEFAULT_REGISTRY_URL = "https://registry.modelcontextprotocol.io";
const API_VERSION = "v0.1";
const CACHE_TTL_MS = 10 * 60 * 1000;
const OFFICIAL_META = "io.modelcontextprotocol.registry/official";

interface CacheEntry {
  value: unknown;
  at: number;
}

export class RegistryClient {
  #baseUrl: string;
  #fetch: typeof fetch;
  #cache = new Map<string, CacheEntry>();

  constructor(
    { baseUrl = DEFAULT_REGISTRY_URL, fetchImpl = fetch }: {
      baseUrl?: string;
      fetchImpl?: typeof fetch;
    } = {},
  ) {
    this.#baseUrl = (Deno.env.get("MCP_REGISTRY_BASE_URL") || baseUrl).replace(
      /\/+$/,
      "",
    );
    this.#fetch = fetchImpl;
  }

  async #get(path: string): Promise<unknown> {
    const response = await this.#fetch(`${this.#baseUrl}/${API_VERSION}${path}`, {
      headers: { accept: "application/json", "user-agent": "toolbelt-bridge" },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 404) {
      throw Object.assign(new Error("Not found in the MCP registry"), { status: 404 });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`MCP registry responded ${response.status}`), {
        status: 502,
      });
    }
    return response.json();
  }

  #cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.#cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.value as T);
    return load().then((value) => {
      this.#cache.set(key, { value, at: Date.now() });
      if (this.#cache.size > 200) this.#cache.delete(this.#cache.keys().next().value!);
      return value;
    });
  }

  search(
    { search = "", cursor = "", limit = 30 }: {
      search?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ) {
    const params = new URLSearchParams({
      limit: String(Math.min(100, Math.max(1, limit))),
      version: "latest",
    });
    if (search.trim()) params.set("search", search.trim().slice(0, 200));
    if (cursor) params.set("cursor", cursor);
    return this.#cached(`list|${params.toString()}`, async () => {
      const json = await this.#get(`/servers?${params.toString()}`) as {
        servers?: Array<
          {
            server?: Record<string, unknown>;
            _meta?: Record<string, Record<string, unknown>>;
          }
        >;
        metadata?: { nextCursor?: string; count?: number };
      };
      const servers = (json.servers || []).filter((e) =>
        (e._meta?.[OFFICIAL_META]?.status ?? "active") === "active"
      );
      return {
        servers,
        nextCursor: json.metadata?.nextCursor || null,
        count: servers.length,
      };
    });
  }

  getServer(name: string, version = "latest") {
    if (!/^[^\s/]+\/[^\s/]+$/.test(name)) {
      return Promise.reject(
        Object.assign(new Error("Server name must look like namespace/name"), {
          status: 400,
        }),
      );
    }
    return this.#cached(
      `server|${name}|${version}`,
      () =>
        this.#get(
          `/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
        ),
    );
  }

  clear(): void {
    this.#cache.clear();
  }
}
