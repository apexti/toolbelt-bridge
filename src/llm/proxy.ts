/**
 * Serves `llm.request` frames: `/v1/models` is synthesized from the models
 * exposed to the requesting org; `/v1/chat/completions` (and embeddings) are
 * forwarded to the runtime that hosts the model and streamed back as
 * `llm.response.*` frames.
 */
import type { Logger } from "../log.ts";
import type { LlmRequestMessage, OutboundMessage } from "../protocol.ts";
import type { LlmRegistry } from "./runtimes.ts";

const FORWARDED_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings",
]);
const CHUNK_CHARS = 60_000;

export class LlmProxy {
  #registry: LlmRegistry;
  #log: Logger;
  #fetch: typeof fetch;
  #active = new Map<string, AbortController>();

  constructor(registry: LlmRegistry, log: Logger, fetchImpl: typeof fetch = fetch) {
    this.#registry = registry;
    this.#log = log;
    this.#fetch = fetchImpl;
  }

  abort(requestId: string): void {
    this.#active.get(requestId)?.abort();
  }

  get activeCount(): number {
    return this.#active.size;
  }

  async handle(
    orgId: string,
    msg: LlmRequestMessage,
    send: (m: OutboundMessage) => void,
  ): Promise<void> {
    const requestId = msg.requestId;
    const fail = (message: string, code?: string) =>
      send({ type: "llm.response.error", requestId, error: { message, code } });

    let url: URL;
    try {
      url = new URL(msg.path || "/", "http://bridge.local");
    } catch {
      return fail("Invalid path", "bad_request");
    }
    const method = String(msg.method || "GET").toUpperCase();

    if (url.pathname === "/v1/models" && method === "GET") {
      const models = this.#registry.modelsFor(orgId).filter((m) =>
        m.status === "available"
      );
      const body = JSON.stringify({
        object: "list",
        data: models.map((m) => ({
          id: m.modelId,
          object: "model",
          owned_by: m.runtime,
          created: 0,
        })),
      });
      send({
        type: "llm.response.start",
        requestId,
        status: 200,
        headers: { "content-type": "application/json" },
      });
      send({ type: "llm.response.chunk", requestId, data: body });
      send({ type: "llm.response.end", requestId });
      return;
    }

    if (!FORWARDED_PATHS.has(url.pathname) || method !== "POST") {
      return fail(`Unsupported endpoint ${method} ${url.pathname}`, "not_found");
    }

    let payload: { model?: string } = {};
    try {
      payload = msg.body ? JSON.parse(msg.body) : {};
    } catch {
      return fail("Request body is not valid JSON", "bad_request");
    }
    const modelId = typeof payload.model === "string" ? payload.model : "";
    const resolved = modelId ? this.#registry.resolveModel(modelId, orgId) : null;
    if (!resolved) {
      return fail(
        `Model "${modelId}" is not exposed to this organization`,
        "model_not_exposed",
      );
    }
    if (!resolved.runtime.reachable) {
      return fail(
        `${resolved.runtime.name} is not reachable at ${resolved.runtime.baseURL}`,
        "runtime_unreachable",
      );
    }

    const controller = new AbortController();
    this.#active.set(requestId, controller);
    const target = `${resolved.runtime.baseURL.replace(/\/+$/, "")}${
      url.pathname.replace(/^\/v1/, "")
    }${url.search}`;
    const headers: Record<string, string> = {
      "content-type": msg.headers?.["content-type"] || "application/json",
      accept: msg.headers?.accept || "application/json",
    };
    if (resolved.runtime.apiKey) {
      headers.authorization = `Bearer ${resolved.runtime.apiKey}`;
    }

    this.#log.info("llm", `${modelId} → ${resolved.runtime.name} ${url.pathname}`);
    let started = false;
    try {
      const response = await this.#fetch(target, {
        method,
        headers,
        body: msg.body,
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type") ||
        "application/octet-stream";
      send({
        type: "llm.response.start",
        requestId,
        status: response.status,
        headers: { "content-type": contentType },
      });
      started = true;
      const textual = /json|text|event-stream|xml/i.test(contentType);
      if (!response.body) {
        send({ type: "llm.response.end", requestId });
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        if (textual) {
          const text = decoder.decode(value, { stream: true });
          for (let i = 0; i < text.length; i += CHUNK_CHARS) {
            send({
              type: "llm.response.chunk",
              requestId,
              data: text.slice(i, i + CHUNK_CHARS),
            });
          }
        } else {
          send({
            type: "llm.response.chunk",
            requestId,
            data: encodeBase64(value),
            encoding: "base64",
          });
        }
      }
      const tail = decoder.decode();
      if (tail) send({ type: "llm.response.chunk", requestId, data: tail });
      send({ type: "llm.response.end", requestId });
    } catch (error) {
      const aborted = controller.signal.aborted;
      const message = aborted
        ? "Request aborted"
        : (error as Error)?.message || "Runtime request failed";
      if (!aborted) this.#log.warn("llm", `${modelId}: ${message}`);
      send({
        type: "llm.response.error",
        requestId,
        error: { message, code: aborted ? "aborted" : "runtime_error" },
      });
      void started;
    } finally {
      this.#active.delete(requestId);
    }
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
