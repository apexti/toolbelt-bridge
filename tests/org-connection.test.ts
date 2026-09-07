import { assert, assertEquals } from "@std/assert";
import { Logger } from "../src/log.ts";
import { OrgConnection } from "../src/connections/org-connection.ts";
import type { OutboundMessage, ServerPayload } from "../src/protocol.ts";

function fakeToolbelt() {
  const received: OutboundMessage[] = [];
  const waiters: Array<
    { match: (m: OutboundMessage) => boolean; resolve: (m: OutboundMessage) => void }
  > = [];
  let socket: WebSocket | null = null;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req) => {
    if (new URL(req.url).pathname !== "/bridge") {
      return new Response("nope", { status: 404 });
    }
    const { socket: ws, response } = Deno.upgradeWebSocket(req);
    socket = ws;
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as OutboundMessage;
      const idx = waiters.findIndex((w) => w.match(msg));
      if (idx >= 0) waiters.splice(idx, 1)[0].resolve(msg);
      else received.push(msg);
      if (msg.type === "hello") {
        ws.send(
          JSON.stringify({
            type: "welcome",
            protocolVersion: 2,
            bridgeId: "b1",
            bridgeName: "laptop",
            organizationId: "o1",
            organizationName: "Acme",
            userId: "u1",
            serverTime: "now",
            heartbeatIntervalMs: 60_000,
          }),
        );
      }
    };
    return response;
  });
  const next = (match: (m: OutboundMessage) => boolean) => {
    const idx = received.findIndex(match);
    if (idx >= 0) return Promise.resolve(received.splice(idx, 1)[0]);
    return new Promise<OutboundMessage>((resolve) => waiters.push({ match, resolve }));
  };
  return {
    server,
    next,
    send: (m: unknown) => socket!.send(JSON.stringify(m)),
    close: (code: number, reason: string) => socket!.close(code, reason),
    wsUrl: `ws://127.0.0.1:${server.addr.port}/bridge`,
  };
}

Deno.test("org connection: hello → welcome → registry sync, requests, commands, revoke", async () => {
  const tb = fakeToolbelt();
  const servers: ServerPayload[] = [
    {
      serverKey: "fs",
      name: "fs",
      status: "running",
      tools: [{ name: "read_file", description: "", inputSchema: {} }],
    },
  ];
  const calls: string[] = [];
  const states: string[] = [];
  const conn = new OrgConnection(
    {
      id: "o1",
      name: "Acme",
      serverUrl: "http://x",
      wsUrl: tb.wsUrl,
      bridgeId: "b1",
      token: "tok",
    },
    {
      mcp: {
        snapshotFor: () => servers,
        request: (key, req) => {
          calls.push(`${key}:${req.method}`);
          return Promise.resolve({ tools: [] });
        },
        start: () => Promise.resolve(),
        stop: (key) => {
          calls.push(`stop:${key}`);
          servers[0].status = "stopped";
          return Promise.resolve();
        },
      },
      llm: {
        modelsFor: () => [{ modelId: "llama3", runtime: "ollama", status: "available" }],
        discover: () => Promise.resolve(),
      },
      proxy: { handle: () => Promise.resolve(), abort: () => {} },
      log: new Logger({ level: "error" }),
      bridgeInfo: () => ({
        name: "n",
        version: "v",
        platform: "linux",
        arch: "x64",
        hostname: "h",
      }),
      allowRemoteServerCreate: () => false,
      createServer: () => Promise.resolve(),
      onState: (c) => states.push(c.state),
    },
  );
  conn.setInstallId("install-1");
  conn.connect();

  const hello = await tb.next((m) => m.type === "hello") as {
    token: string;
    installId: string;
    protocolVersion: number;
  };
  assertEquals(hello.token, "tok");
  assertEquals(hello.installId, "install-1");
  assertEquals(hello.protocolVersion, 2);

  const upsert = await tb.next((m) => m.type === "servers.upsert") as {
    servers: ServerPayload[];
  };
  assertEquals(upsert.servers[0].serverKey, "fs");
  const models = await tb.next((m) => m.type === "models.upsert") as {
    models: Array<{ modelId: string }>;
  };
  assertEquals(models.models[0].modelId, "llama3");
  assertEquals(conn.state, "connected");

  tb.send({
    type: "mcp.request",
    requestId: "q1",
    serverKey: "fs",
    request: { method: "tools/list" },
  });
  const response = await tb.next((m) => m.type === "mcp.response") as {
    requestId: string;
    response: unknown;
  };
  assertEquals(response.requestId, "q1");
  assertEquals(calls, ["fs:tools/list"]);

  tb.send({ type: "service.stop", requestId: "c1", serverKey: "fs" });
  const result = await tb.next((m) => m.type === "service.result") as { ok: boolean };
  assertEquals(result.ok, true);
  const resync = await tb.next((m) => m.type === "servers.upsert") as {
    servers: ServerPayload[];
  };
  assertEquals(resync.servers[0].status, "stopped");

  tb.send({
    type: "service.create",
    requestId: "c2",
    config: { serverKey: "x", command: "y" },
  });
  const denied = await tb.next((m) => m.type === "service.result") as {
    ok: boolean;
    error: { message: string };
  };
  assertEquals(denied.ok, false);
  assert(denied.error.message.includes("disabled"));

  tb.send({ type: "ping" });
  await tb.next((m) => m.type === "pong");

  tb.close(4403, "revoked");
  await new Promise((r) => setTimeout(r, 100));
  assertEquals(conn.state, "revoked");
  conn.close();
  await tb.server.shutdown();
});
