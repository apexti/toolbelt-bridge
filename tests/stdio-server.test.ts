import { assert, assertEquals, assertRejects } from "@std/assert";
import { StdioMcpServer } from "../src/mcp/stdio-server.ts";

const fixture = new URL("./fixtures/fake-mcp-server.ts", import.meta.url).pathname;

Deno.test("stdio MCP client: initialize, list, call, list_changed, stop", async () => {
  let toolsChanged = 0;
  const stderr: string[] = [];
  const server = new StdioMcpServer({
    command: Deno.execPath(),
    args: ["run", fixture],
    onToolsChanged: () => toolsChanged++,
    onLog: (stream, line) => stream === "stderr" && stderr.push(line),
  });
  await server.start();
  assertEquals(server.serverInfo?.name, "fake");
  const tools = await server.listTools();
  assertEquals(tools.map((t) => t.name), ["echo", "bump", "crash"]);
  const result = await server.callTool("echo", { text: "hi" }) as {
    content: Array<{ text: string }>;
  };
  assertEquals(result.content[0].text, "hi");
  await server.callTool("bump", {});
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(toolsChanged, 1);
  assertEquals((await server.listTools()).length, 4);
  await assertRejects(() => server.callTool("nope", {}), Error, "unknown tool");
  await server.stop();
  assertEquals(server.running, false);
  await assertRejects(() => server.listTools(), Error, "not running");
});

Deno.test("stdio MCP client reports crashes through onExit", async () => {
  let exitCode: number | null = null;
  const exited = new Promise<void>((resolve) => {
    const server = new StdioMcpServer({
      command: Deno.execPath(),
      args: ["run", fixture],
      onExit: (code) => {
        exitCode = code;
        resolve();
      },
    });
    server.start().then(() => server.callTool("crash", {}).catch(() => {}));
  });
  await exited;
  assertEquals(exitCode, 3);
});

Deno.test("missing commands fail with a clear error", async () => {
  const server = new StdioMcpServer({ command: "definitely-not-a-real-command-xyz" });
  await assertRejects(() => server.start(), Error, "Command not found");
  assert(!server.running);
});
