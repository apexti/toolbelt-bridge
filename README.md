# Toolbelt MCP Bridge

The Toolbelt MCP Bridge allows you to run MCP (Model Context Protocol) servers locally on your machine while connecting them to your Toolbelt account. This enables you to:

1. Run private MCP servers that don't need to be hosted in the cloud
2. Develop and test new MCP servers locally before deployment
3. Use specialized MCP servers that require local resources
4. Maintain control over your data and services

## Installation

```bash
# Clone the repository (if you haven't already)
git clone https://github.com/yourusername/toolbelt.git
cd toolbelt/mcp-bridge

# Install dependencies
npm install
```

## Configuration

Create a `.env` file in the mcp-bridge directory with the following variables:

```
TOOLBELT_URL=wss://toolbelt.apexti.dev/bridge
API_KEY=your-api-key
```

You can get your API Key from your Toolbelt account settings.

## Usage

### Starting the Bridge

```bash
npm start server
```

This will start the bridge and connect to your Toolbelt account. Any MCP servers you register with the bridge will be available in your Toolbelt account.

### Running External MCP Servers

The bridge supports several ways to run external MCP servers:

#### 1. Run an MCP Server with npx

You can run any MCP server package directly with the bridge:

```bash
# Run with stdio transport (for servers that communicate via standard I/O)
npm run mcp-bridge run @modelcontextprotocol/server-memory --transport-type stdio

# Run with additional arguments
npm run mcp-bridge run @modelcontextprotocol/server-memory -- -a "--port=3000"

# Disable SSL verification for development with local HTTPS servers
npm run mcp-bridge run @modelcontextprotocol/server-memory --reject-unauthorized false
```

This will:

1. Start the bridge
2. Start a server adapter (for WebSocket transport)
3. Run the specified MCP server package with npx
4. Connect the server to the bridge

#### 2. Start a Server Adapter

If you want to run multiple MCP servers or have more control over how they're started:

```bash
# Start a server adapter on a random port
npm run mcp-bridge server

# Start a server adapter on a specific port
npm run mcp-bridge server -p 8080
```

This will start the bridge and a server adapter. You'll see a connection URL that you can use to connect your MCP servers to the bridge.

#### 3. Start the Bridge with a Server Adapter

You can also start the bridge with a server adapter in one command:

```bash
npm run mcp-bridge start -s
```

### Using with Custom MCP Servers

You can register custom MCP servers with the bridge programmatically:

```javascript
import { McpBridgeServer } from "@toolbelt/mcp-bridge";
import { YourCustomMcpServer } from "./your-custom-server.js";

// Create and initialize your MCP server
const customServer = new YourCustomMcpServer();
await customServer.initialize();

// Create and start the bridge
const bridge = new McpBridgeServer({
  apiKey: "your-api-key",
  toolbeltUrl: "wss://yourtoolbelt.app/bridge",
});

// Start the bridge
await bridge.start();

// Register your custom server with the bridge
await bridge.registerServer(customServer);

console.log(`${customServer.name} registered with the bridge`);
```

## Development

For development with auto-restart on file changes:

```bash
npm run dev
```

## License

MIT
