import { assertEquals } from "@std/assert";
import { ConfigStore, defaultConfig } from "../src/config.ts";
import { Logger } from "../src/log.ts";
import { LlmRegistry } from "../src/llm/runtimes.ts";
import { LlmProxy } from "../src/llm/proxy.ts";
import type { OutboundMessage } from "../src/protocol.ts";

function fakeRuntime() {
  const requests: Array<{ path: string; body: unknown; auth: string | null }> = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") {
        return Response.json({ data: [{ id: "llama3" }, { id: "llava" }] });
      }
      if (url.pathname === "/v1/chat/completions") {
        const body = await req.json();
        requests.push({
          path: url.pathname,
          body,
          auth: req.headers.get("authorization"),
        });
        const sse = [
          'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
          "data: [DONE]\n\n",
        ];
        const stream = new ReadableStream({
          async start(c) {
            for (const part of sse) {
              c.enqueue(new TextEncoder().encode(part));
              await new Promise((r) => setTimeout(r, 5));
            }
            c.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("nope", { status: 404 });
    },
  );
  return { server, requests, baseURL: `http://127.0.0.1:${server.addr.port}/v1` };
}

Deno.test("proxy synthesizes /v1/models and streams chat completions", async () => {
  const runtime = fakeRuntime();
  const dir = await Deno.makeTempDir();
  const cfg = defaultConfig();
  cfg.llm.runtimes = [{
    id: "test",
    name: "Test",
    baseURL: runtime.baseURL,
    enabled: true,
    apiKey: "k",
  }];
  const store = new ConfigStore(`${dir}/config.json`, cfg);
  const log = new Logger({ level: "error" });
  const registry = new LlmRegistry(store, log, { intervalMs: 60_000 });
  await registry.discover();
  assertEquals(registry.runtime("test")?.models, ["llama3", "llava"]);
  await registry.setExposure("test", "llama3", ["org-a"]);

  const proxy = new LlmProxy(registry, log);
  const frames: OutboundMessage[] = [];
  const send = (m: OutboundMessage) => frames.push(m);

  await proxy.handle("org-a", {
    type: "llm.request",
    requestId: "r1",
    method: "GET",
    path: "/v1/models",
  }, send);
  const models = JSON.parse((frames[1] as { data: string }).data);
  assertEquals(models.data.map((m: { id: string }) => m.id), ["llama3"]);
  assertEquals(frames[2].type, "llm.response.end");

  frames.length = 0;
  await proxy.handle("org-b", {
    type: "llm.request",
    requestId: "r2",
    method: "POST",
    path: "/v1/chat/completions",
    body: JSON.stringify({ model: "llama3" }),
  }, send);
  assertEquals(frames[0].type, "llm.response.error");

  frames.length = 0;
  await proxy.handle("org-a", {
    type: "llm.request",
    requestId: "r3",
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ model: "llama3", stream: true, messages: [] }),
  }, send);
  assertEquals(frames[0].type, "llm.response.start");
  assertEquals((frames[0] as { status: number }).status, 200);
  const text = frames.filter((f) => f.type === "llm.response.chunk").map((f) =>
    (f as { data: string }).data
  ).join("");
  assertEquals(text.includes("Hel") && text.includes("[DONE]"), true);
  assertEquals(frames.at(-1)?.type, "llm.response.end");
  assertEquals(runtime.requests[0].auth, "Bearer k");
  assertEquals((runtime.requests[0].body as { model: string }).model, "llama3");

  registry.stop();
  await runtime.server.shutdown();
  await Deno.remove(dir, { recursive: true });
});
