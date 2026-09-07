// Minimal MCP server over stdio for tests: echo + bump (list_changed) + crash.
const encoder = new TextEncoder();
const write = (msg: unknown) =>
  Deno.stdout.write(encoder.encode(JSON.stringify(msg) + "\n"));
let extraTools = 0;
const tools = () => [
  {
    name: "echo",
    description: "Echo text",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
  {
    name: "bump",
    description: "Add a tool",
    inputSchema: { type: "object", properties: {} },
  },
  { name: "crash", description: "Exit", inputSchema: { type: "object", properties: {} } },
  ...Array.from(
    { length: extraTools },
    (_, i) => ({
      name: `extra${i + 1}`,
      description: "",
      inputSchema: { type: "object" },
    }),
  ),
];
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk, { stream: true });
  let idx: number;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      await write({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "fake", version: "9.9.9" },
        },
      });
    } else if (msg.method === "tools/list") {
      await write({ jsonrpc: "2.0", id: msg.id, result: { tools: tools() } });
    } else if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params || {};
      if (name === "echo") {
        await write({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: String(args?.text ?? "") }] },
        });
      } else if (name === "bump") {
        extraTools += 1;
        await write({ jsonrpc: "2.0", id: msg.id, result: { content: [] } });
        await write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      } else if (name === "crash") {
        console.error("crashing on request");
        Deno.exit(3);
      } else {await write({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `unknown tool ${name}` },
        });}
    } else if (msg.id !== undefined) {
      await write({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `unknown method ${msg.method}` },
      });
    }
  }
}
