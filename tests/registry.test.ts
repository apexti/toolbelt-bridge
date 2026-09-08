import { assertEquals, assertRejects } from "@std/assert";
import { RegistryClient } from "../src/registry.ts";

const entry = (name: string, status = "active") => ({
  server: { name, description: "d", version: "1.0.0" },
  _meta: { "io.modelcontextprotocol.registry/official": { status, isLatest: true } },
});

Deno.test("registry client searches, filters inactive, caches, and loads detail", async () => {
  const calls: string[] = [];
  const fetchImpl = ((url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/servers?")) {
      return Promise.resolve(
        Response.json({
          servers: [entry("a/x"), entry("a/y", "deleted")],
          metadata: { nextCursor: "n" },
        }),
      );
    }
    if (u.endsWith("/servers/a%2Fx/versions/latest")) {
      return Promise.resolve(Response.json(entry("a/x")));
    }
    return Promise.resolve(new Response("nope", { status: 404 }));
  }) as typeof fetch;
  const client = new RegistryClient({ baseUrl: "http://reg.test", fetchImpl });
  const first = await client.search({ search: "x" });
  assertEquals(first.servers.length, 1);
  assertEquals(first.nextCursor, "n");
  await client.search({ search: "x" });
  assertEquals(calls.length, 1);
  const detail = await client.getServer("a/x") as { server: { name: string } };
  assertEquals(detail.server.name, "a/x");
  await assertRejects(() => client.getServer("a/missing"), Error, "Not found");
  await assertRejects(() => client.getServer("bad"), Error, "namespace/name");
});
