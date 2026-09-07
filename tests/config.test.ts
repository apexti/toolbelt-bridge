import { assert, assertEquals, assertMatch } from "@std/assert";
import { ConfigStore, loadConfig, migrateConfig, saveConfig } from "../src/config.ts";

Deno.test("migrates a v1 settings.json", () => {
  const cfg = migrateConfig({
    apikey: "secret",
    bridgeConnectionId: "conn-1",
    bridgeName: "toolbelt-bridge",
    mcpServers: {
      "My Home": {
        command: "npx",
        args: ["@modelcontextprotocol/server-filesystem", "/home/me"],
        options: { shell: true, cwd: "/tmp" },
        env: { A: "1" },
      },
    },
  });
  assertEquals(cfg.version, 2);
  assertEquals(cfg.installId, "conn-1");
  assertEquals(cfg.orgs, []);
  const server = cfg.mcpServers["my-home"];
  assert(server, "server key slugified");
  assertEquals(server.command, "npx");
  assertEquals(server.cwd, "/tmp");
  assertEquals(server.env, { A: "1" });
  assertEquals(server.orgs, []);
  assertEquals(cfg.llm.runtimes.map((r) => r.id), ["ollama", "lmstudio", "vllm"]);
});

Deno.test("keeps v2 config and merges builtin runtimes", () => {
  const cfg = migrateConfig({
    version: 2,
    installId: "abc",
    name: "box",
    orgs: [{
      id: "o1",
      name: "Acme",
      serverUrl: "https://t",
      wsUrl: "wss://t/bridge",
      bridgeId: "b1",
      token: "x",
    }],
    mcpServers: {
      fs: { command: "npx", args: [], env: {}, autoStart: false, orgs: ["o1"] },
      "bad key!": { command: "x" },
    },
    llm: {
      runtimes: [{
        id: "ollama",
        name: "Ollama",
        baseURL: "http://127.0.0.1:11434/v1",
        enabled: false,
      }, { id: "mine", name: "Mine", baseURL: "http://x/v1", enabled: true }],
      models: { "ollama/llama": { orgs: ["o1"] } },
    },
  });
  assertEquals(cfg.installId, "abc");
  assertEquals(cfg.orgs.length, 1);
  assertEquals(Object.keys(cfg.mcpServers), ["fs"]);
  assertEquals(cfg.mcpServers.fs.autoStart, false);
  const ollama = cfg.llm.runtimes.find((r) => r.id === "ollama")!;
  assertEquals(ollama.enabled, false);
  assertEquals(ollama.builtin, true);
  assert(cfg.llm.runtimes.some((r) => r.id === "mine" && r.builtin === false));
  assertEquals(cfg.llm.models["ollama/llama"].orgs, ["o1"]);
});

Deno.test("save/load round trip and ConfigStore.update", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/nested/config.json`;
  const first = await loadConfig(path);
  assertEquals(first.existed, false);
  assertMatch(first.config.installId, /^[0-9a-f-]{36}$/);
  await saveConfig(path, first.config);
  const store = new ConfigStore(path, first.config);
  let changes = 0;
  store.onChange(() => changes++);
  await store.update((cfg) => {
    cfg.name = "renamed";
  });
  assertEquals(changes, 1);
  const again = await loadConfig(path);
  assertEquals(again.existed, true);
  assertEquals(again.migrated, false);
  assertEquals(again.config.name, "renamed");
  if (Deno.build.os !== "windows") {
    const mode = (await Deno.stat(path)).mode! & 0o777;
    assertEquals(mode, 0o600);
  }
  await Deno.remove(dir, { recursive: true });
});
