/**
 * Local web UI + JSON API on 127.0.0.1. Mutating calls need the per-run token
 * that is injected into the page (and written to <configDir>/ui.token for the
 * CLI). Only loopback Host/Origin values are accepted.
 */
import type { ConfigStore } from "../config.ts";
import type { Logger } from "../log.ts";
import type { McpManager } from "../mcp/manager.ts";
import type { LlmRegistry } from "../llm/runtimes.ts";
import type { ConnectionManager } from "../connections/manager.ts";
import { checkPrerequisites, type PrereqStatus } from "../mcp/prereqs.ts";
import { VERSION } from "../version.ts";
import { RegistryClient } from "../registry.ts";

export interface UiDeps {
  store: ConfigStore;
  log: Logger;
  mcp: McpManager;
  llm: LlmRegistry;
  connections: ConnectionManager;
}

export interface UiServer {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function uiTokenPath(configPath: string): string {
  return `${configPath.replace(/[\\/][^\\/]+$/, "")}/ui.token`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isLocal(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, "");
  return LOCAL_HOSTS.has(host);
}

async function readAsset(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(`./${name}`, import.meta.url));
}

export async function startUiServer(deps: UiDeps): Promise<UiServer> {
  const { store, log, mcp, llm, connections } = deps;
  const token = crypto.randomUUID().replace(/-/g, "") +
    crypto.randomUUID().replace(/-/g, "");
  const tokenPath = uiTokenPath(store.path);
  try {
    await Deno.writeTextFile(tokenPath, token);
    if (Deno.build.os !== "windows") await Deno.chmod(tokenPath, 0o600).catch(() => {});
  } catch (error) {
    log.warn("ui", `could not write ${tokenPath}: ${(error as Error).message}`);
  }

  let prereqs: PrereqStatus[] = [];
  checkPrerequisites().then((p) => {
    prereqs = p;
    notify();
  }).catch(() => {});

  const registry = new RegistryClient();
  const sseClients = new Set<(event: string, data: unknown) => void>();
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  const notify = () => {
    if (notifyTimer !== null) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      const state = buildState();
      for (const push of sseClients) push("state", state);
    }, 150);
  };
  const unsubscribe = [
    store.onChange(notify),
    mcp.onChange(notify),
    llm.onChange(notify),
    connections.onChange(notify),
    log.subscribe((entry) => {
      for (const push of sseClients) push("log", entry);
    }),
  ];

  function buildState() {
    const cfg = store.config;
    return {
      version: VERSION,
      name: cfg.name,
      installId: cfg.installId,
      configPath: store.path,
      platform: `${Deno.build.os}/${Deno.build.arch}`,
      ui: { port: cfg.ui.port, open: cfg.ui.open },
      allowRemoteServerCreate: cfg.allowRemoteServerCreate,
      orgs: connections.list(),
      servers: mcp.list(),
      llm: { runtimes: llm.runtimes(), models: cfg.llm.models },
      prereqs,
    };
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    if (!isLocal(req.headers.get("host"))) return json({ error: "Forbidden" }, 403);
    if (method !== "GET" && method !== "HEAD") {
      const origin = req.headers.get("origin");
      if (origin) {
        try {
          if (!isLocal(new URL(origin).host)) return json({ error: "Forbidden" }, 403);
        } catch {
          return json({ error: "Forbidden" }, 403);
        }
      }
      if (req.headers.get("x-bridge-token") !== token) {
        return json({ error: "Missing or invalid bridge token" }, 401);
      }
    }

    const body = async () => {
      try {
        return (await req.json()) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    const seg = path.split("/").filter(Boolean);

    // ---- static
    if (method === "GET" && path === "/") {
      const html = (await readAsset("index.html")).replace("__BRIDGE_TOKEN__", token);
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (method === "GET" && path === "/app.js") {
      return new Response(await readAsset("app.js"), {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }
    if (method === "GET" && path === "/registry-plan.js") {
      return new Response(await readAsset("registry-plan.js"), {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }

    // ---- events
    if (method === "GET" && path === "/events") {
      const encoder = new TextEncoder();
      let push: (event: string, data: unknown) => void = () => {};
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (event, data) => {
            try {
              controller.enqueue(
                encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
              );
            } catch {
              sseClients.delete(push);
            }
          };
          sseClients.add(push);
          push("state", buildState());
          for (const entry of log.entries(undefined, 100)) push("log", entry);
        },
        cancel() {
          sseClients.delete(push);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    // ---- api
    if (seg[0] !== "api") return json({ error: "Not found" }, 404);

    if (seg[1] === "state" && method === "GET") return json(buildState());

    if (seg[1] === "pair" && method === "POST") {
      const { input, serverUrl } = await body();
      const status = await connections.pair(
        String(input || ""),
        serverUrl ? String(serverUrl) : null,
      );
      return json(status, 201);
    }

    if (seg[1] === "orgs" && seg[2]) {
      const orgId = decodeURIComponent(seg[2]);
      if (method === "DELETE") {
        await connections.unpair(orgId);
        return json({ ok: true });
      }
      if (method === "POST" && seg[3] === "reconnect") {
        connections.reconnect(orgId);
        return json({ ok: true });
      }
    }

    if (seg[1] === "servers") {
      const key = seg[2] ? decodeURIComponent(seg[2]) : null;
      if (key && method === "PUT" && !seg[3]) {
        const input = await body();
        return json(await mcp.upsert(key, input as Parameters<McpManager["upsert"]>[1]));
      }
      if (key && method === "PUT" && seg[3] === "orgs") {
        const { orgs } = await body();
        return json(
          await mcp.setExposure(key, Array.isArray(orgs) ? orgs.map(String) : []),
        );
      }
      if (key && method === "DELETE") {
        await mcp.remove(key);
        return json({ ok: true });
      }
      if (key && method === "POST" && seg[3] === "start") {
        return json(await mcp.start(key));
      }
      if (key && method === "POST" && seg[3] === "stop") return json(await mcp.stop(key));
      if (key && method === "POST" && seg[3] === "restart") {
        return json(await mcp.restart(key));
      }
      if (key && method === "GET" && seg[3] === "logs") {
        const tail = Number(url.searchParams.get("tail") || 200);
        return json({ entries: log.entries(key, tail) });
      }
      if (!key && method === "GET") return json({ servers: mcp.list() });
    }

    if (seg[1] === "llm") {
      if (seg[2] === "runtimes" && seg[3] && method === "PUT") {
        const input = await body();
        await llm.upsertRuntime({ ...input, id: decodeURIComponent(seg[3]) });
        return json({ runtimes: llm.runtimes() });
      }
      if (seg[2] === "runtimes" && seg[3] && method === "DELETE") {
        await llm.removeRuntime(decodeURIComponent(seg[3]));
        return json({ runtimes: llm.runtimes() });
      }
      if (seg[2] === "models" && method === "PUT") {
        const { runtimeId, modelId, orgs, displayName } = await body();
        if (!runtimeId || !modelId) {
          return json({ error: "runtimeId and modelId are required" }, 400);
        }
        await llm.setExposure(
          String(runtimeId),
          String(modelId),
          Array.isArray(orgs) ? orgs.map(String) : [],
          displayName === undefined
            ? undefined
            : (displayName ? String(displayName) : null),
        );
        return json({ models: store.config.llm.models });
      }
      if (seg[2] === "refresh" && method === "POST") {
        await llm.discover();
        return json({ runtimes: llm.runtimes() });
      }
      if (!seg[2] && method === "GET") {
        return json({ runtimes: llm.runtimes(), models: store.config.llm.models });
      }
    }

    if (seg[1] === "registry" && method === "GET") {
      try {
        if (seg[2] === "servers" && !seg[3]) {
          return json(
            await registry.search({
              search: url.searchParams.get("search") || "",
              cursor: url.searchParams.get("cursor") || "",
              limit: Number(url.searchParams.get("limit") || 30),
            }),
          );
        }
        if (seg[2] === "servers" && seg[3]) {
          const name = decodeURIComponent(seg.slice(3).join("/"));
          return json(await registry.getServer(name));
        }
      } catch (error) {
        const status = (error as { status?: number }).status || 502;
        return json({ error: (error as Error).message }, status);
      }
    }

    if (seg[1] === "prereqs" && method === "GET") {
      prereqs = await checkPrerequisites();
      return json({ prereqs });
    }

    if (seg[1] === "logs" && method === "GET") {
      const source = url.searchParams.get("source") || undefined;
      const tail = Number(url.searchParams.get("tail") || 200);
      return json({ entries: log.entries(source, tail) });
    }

    if (seg[1] === "settings" && method === "PUT") {
      const input = await body();
      await store.update((cfg) => {
        if (typeof input.name === "string" && input.name.trim()) {
          cfg.name = input.name.trim().slice(0, 80);
        }
        if (input.port !== undefined) {
          const port = Number(input.port);
          if (Number.isInteger(port) && port > 0 && port < 65536) cfg.ui.port = port;
        }
        if (typeof input.open === "boolean") cfg.ui.open = input.open;
        if (typeof input.allowRemoteServerCreate === "boolean") {
          cfg.allowRemoteServerCreate = input.allowRemoteServerCreate;
        }
      });
      return json(buildState());
    }

    return json({ error: "Not found" }, 404);
  }

  const port = store.config.ui.port;
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port,
    onListen: ({ port }) => log.info("ui", `local UI at http://127.0.0.1:${port}`),
  }, async (req) => {
    try {
      return await route(req);
    } catch (error) {
      const message = (error as Error)?.message || "Request failed";
      log.warn("ui", `${req.method} ${new URL(req.url).pathname}: ${message}`);
      return json({ error: message }, 400);
    }
  });

  return {
    url: `http://127.0.0.1:${server.addr.port}`,
    port: server.addr.port,
    token,
    close: async () => {
      for (const off of unsubscribe) off();
      await server.shutdown();
      try {
        await Deno.remove(tokenPath);
      } catch {
        /* ignore */
      }
    },
  };
}
