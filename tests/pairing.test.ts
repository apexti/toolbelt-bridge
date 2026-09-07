import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { claimPairing, orgConfigFromClaim, parsePairInput } from "../src/pairing.ts";

Deno.test("parsePairInput accepts pair URLs and bare codes", () => {
  assertEquals(parsePairInput("https://toolbelt.example.com/bridge/pair?code=abc-123"), {
    serverUrl: "https://toolbelt.example.com",
    code: "ABC123",
  });
  assertEquals(parsePairInput(" abc123 ", "https://t.example.com/"), {
    serverUrl: "https://t.example.com",
    code: "ABC123",
  });
  assertThrows(() => parsePairInput("abc123"), Error, "server URL");
  assertThrows(
    () => parsePairInput("https://x.example.com/bridge/pair"),
    Error,
    "no code",
  );
});

Deno.test("claimPairing posts the code and maps the claim to an org config", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          protocolVersion: 2,
          bridgeId: "b1",
          bridgeName: "laptop",
          organizationId: "o1",
          organizationName: "Acme",
          userId: "u1",
          token: "tok",
          wsUrl: "ws://t.example.com/bridge",
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;
  const claim = await claimPairing(
    { serverUrl: "http://t.example.com", code: "ABC123" },
    "install-1",
    { name: "n", version: "v", platform: "linux", arch: "x64", hostname: "h" },
    fetchImpl,
  );
  assertEquals(calls[0].url, "http://t.example.com/api/bridges/pairing/claim");
  assertEquals((calls[0].body as { code: string }).code, "ABC123");
  const org = orgConfigFromClaim(claim, "http://t.example.com");
  assertEquals(org.id, "o1");
  assertEquals(org.name, "Acme");
  assertEquals(org.wsUrl, "ws://t.example.com/bridge");
  assertEquals(org.token, "tok");

  const failing = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: "Pairing code expired" }), {
        status: 410,
      }),
    )) as typeof fetch;
  await assertRejects(
    () => claimPairing({ serverUrl: "http://t", code: "X" }, "i", org as never, failing),
    Error,
    "expired",
  );
});
