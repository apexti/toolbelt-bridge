#!/usr/bin/env node

import { Command } from "commander";
import dotenv from "dotenv";
import { McpBridgeServer } from "./bridge-server.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Load environment variables
dotenv.config();

// Get package info
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packagePath = join(__dirname, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));

// Get settings path - use current working directory
const settingsPath = join(process.cwd(), "settings.json");

// Function to load API key from settings
function loadApiKeyFromSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (settings.apikey) {
        return settings.apikey;
      }
    }
  } catch (error) {
    console.error("Error loading settings:", error);
  }
  return null;
}

// Create CLI program
const program = new Command();

program
  .name("mcp-bridge")
  .description("Toolbelt MCP Bridge - Connect local MCP servers to Toolbelt")
  .version(packageJson.version);

program
  .command("start")
  .description("Start the MCP bridge server")
  .option(
    "-k, --api-key <apiKey>",
    "API key for authentication",
    loadApiKeyFromSettings() || process.env.API_KEY
  )
  .option(
    "-t, --toolbelt-url <url>",
    "Toolbelt bridge URL",
    process.env.TOOLBELT_URL || "wss://toolbelt.apexti.dev/bridge"
  )
  .option(
    "-s, --server-adapter",
    "Start a server adapter for external MCP servers",
    false
  )
  .option("-p, --port <port>", "Port for the server adapter", "0")
  .option(
    "--reject-unauthorized <boolean>",
    "Reject unauthorized SSL certificates",
    "true"
  )
  .option("--debug", "Enable verbose debug logging from MCP servers", false)
  .action(async (options) => {
    try {
      // Validate required options
      if (!options.apiKey) {
        console.error(
          "Error: API key is required. Provide it with --api-key, set API_KEY environment variable, or ensure it exists in settings.json"
        );
        process.exit(1);
      }

      console.log("Starting MCP Bridge...");
      console.log(`Toolbelt URL: ${options.toolbeltUrl}`);
      console.log(`Log level: ${process.env.LOG_LEVEL || (options.debug ? 'debug' : 'info')} (${options.debug ? 'from --debug flag' : process.env.LOG_LEVEL ? 'from LOG_LEVEL env var' : 'default'})`);

      // Create and start the bridge
      const bridge = new McpBridgeServer({
        apiKey: options.apiKey,
        toolbeltUrl: options.toolbeltUrl,
        rejectUnauthorized: options.rejectUnauthorized !== "false",
        logLevel: process.env.LOG_LEVEL || (options.debug ? "debug" : "info"),
        debug: options.debug || process.env.LOG_LEVEL === 'debug',
      });

      // Handle process termination
      process.on("SIGINT", async () => {
        console.log("\nReceived SIGINT. Shutting down...");
        await bridge.stop();
        process.exit(0);
      });

      process.on("SIGTERM", async () => {
        console.log("\nReceived SIGTERM. Shutting down...");
        await bridge.stop();
        process.exit(0);
      });

      // Start the bridge
      await bridge.start();

      console.log("MCP Bridge is running. Press Ctrl+C to stop.");
    } catch (error) {
      console.error("Error starting MCP Bridge:", error);
      process.exit(1);
    }
  });

// Add a command to run an MCP server and connect it to the bridge
program
  .command("run <serverPackage>")
  .description("Run an MCP server and connect it to the bridge")
  .option(
    "-k, --api-key <apiKey>",
    "API key for authentication",
    loadApiKeyFromSettings() || process.env.API_KEY
  )
  .option(
    "-t, --toolbelt-url <url>",
    "Toolbelt bridge URL",
    process.env.TOOLBELT_URL || "wss://toolbelt.apexti.dev/bridge"
  )
  .option("-a, --args <args>", "Additional arguments to pass to the server", "")
  .option(
    "--transport-type <type>",
    "Transport type (websocket or stdio)",
    "websocket"
  )
  .option(
    "--reject-unauthorized <boolean>",
    "Reject unauthorized SSL certificates",
    "true"
  )
  .option("--debug", "Enable verbose debug logging from MCP servers", false)
  .action(async (serverPackage, options) => {
    try {
      // Validate required options
      if (!options.apiKey) {
        console.error(
          "Error: API key is required. Provide it with --api-key, set API_KEY environment variable, or ensure it exists in settings.json"
        );
        process.exit(1);
      }

      console.log(`Starting MCP Bridge with server: ${serverPackage}`);
      console.log(`Toolbelt URL: ${options.toolbeltUrl}`);
      console.log(`Transport type: ${options.transportType}`);

      // Create and start the bridge
      const bridge = new McpBridgeServer({
        apiKey: options.apiKey,
        toolbeltUrl: options.toolbeltUrl,
        rejectUnauthorized: options.rejectUnauthorized !== "false",
        logLevel: process.env.LOG_LEVEL || (options.debug ? "debug" : "info"),
        debug: options.debug || process.env.LOG_LEVEL === 'debug',
      });

      // Start the bridge
      await bridge.start();

      // Handle process termination
      const cleanup = async () => {
        if (serverAdapter) {
          await serverAdapter.stop();
        }
        await bridge.stop();
        if (serverProcess && !serverProcess.killed) {
          serverProcess.kill();
        }
        process.exit(0);
      };

      process.on("SIGINT", async () => {
        console.log("\nReceived SIGINT. Shutting down...");
        await cleanup();
      });

      process.on("SIGTERM", async () => {
        console.log("\nReceived SIGTERM. Shutting down...");
        await cleanup();
      });

      let serverAdapter = null;
      let serverProcess = null;

      if (options.transportType === "stdio") {
        // Run the MCP server with stdio transport
        console.log(`Starting ${serverPackage} with stdio transport`);

        // Create a server instance that will be registered with the bridge
        const serverName = serverPackage.split("/").pop() || "mcp-server";
        const serverId = `${serverName}-${Date.now()}`;

        // Create the command and arguments array for the server
        const command = "npx";
        const args = [
          "-y",
          serverPackage,
          ...options.args.split(" ").filter((arg) => arg.trim() !== ""),
        ];

        console.log(`Command: ${command} ${args.join(" ")}`);

        // Create a proper StdioClientTransport - this will manage the process for us
        const transport = new StdioClientTransport({
          command: command,
          args: args,
        });

        // Create an MCP client with the transport
        const mcpClient = new Client(
          {
            name: "toolbelt-bridge",
            version: packageJson.version,
          },
          {
            capabilities: {
              prompts: {},
              resources: {},
              tools: {},
            },
          }
        );

        // We need to keep track of the process so we can terminate it properly
        serverProcess = null;
        let toolsList = [];

        try {
          // Connect to the server via the client
          await mcpClient.connect(transport);
          console.log(`Connected to ${serverName}`);

          // Get the process now
          serverProcess = transport.process;

          // Add handlers for logging - simple output handling
          if (serverProcess && serverProcess.stdout) {
            serverProcess.stdout.on("data", (data) => {
              const output = data.toString().trim();
              if (output && options.debug) {
                console.log(`${serverName}: ${output}`);
              }
            });
          }

          if (serverProcess && serverProcess.stderr) {
            serverProcess.stderr.on("data", (data) => {
              const output = data.toString().trim();
              if (output) {
                console.error(`${serverName}: ${output}`);
              }
            });
          }

          // Try to list tools immediately to check the connection
          try {
            toolsList = await mcpClient.listTools();
            const toolCount = Array.isArray(toolsList)
              ? toolsList.length
              : toolsList.tools
                ? toolsList.tools.length
                : 0;
            console.log(`${serverName}: ${toolCount} tools available`);
          } catch (toolError) {
            console.log(
              `${serverName}: Could not list tools yet - ${toolError.message}`
            );
          }

          // Create a server adapter for the stdio transport that uses the mcpClient
          const server = {
            name: serverName,
            id: serverId,
            description: `MCP server for ${serverName} (stdio)`,
            authType: "none",
            isCodedServer: true,
            tools: Array.isArray(toolsList)
              ? toolsList.map((tool) =>
                  typeof tool === "string" ? tool : tool.name || String(tool)
                )
              : toolsList.tools
                ? toolsList.tools.map((tool) =>
                    typeof tool === "string" ? tool : tool.name || String(tool)
                  )
                : [], // Extract tool names safely
            hasPreFetchedTools: true, // Flag to indicate we already have tools
            client: mcpClient,

            // Connect to the server
            connect: async (bridgeTransport) => {
              // Create a sendRequest function and attach it to the transport
              bridgeTransport.sendRequest = async (request) => {
                try {
                  // Convert the bridge request format to MCP client format
                  let result;

                  if (
                    request.method === "tools/list" ||
                    request.type === "list_tools"
                  ) {
                    result = await mcpClient.listTools();
                    return { tools: result };
                  } else if (
                    request.method &&
                    request.method.startsWith("tools/")
                  ) {
                    // Handle tool call
                    const toolName = request.method.split("/")[1];
                    result = await mcpClient.callTool({
                      name: toolName,
                      arguments: request.params || {},
                    });
                    return { result };
                  } else if (request.type === "call_tool") {
                    result = await mcpClient.callTool({
                      name: request.name,
                      arguments: request.arguments || {},
                    });
                    return { result };
                  } else {
                    throw new Error(
                      `Unsupported request type: ${request.method || request.type}`
                    );
                  }
                } catch (error) {
                  console.error(
                    `${serverName} request failed: ${error.message}`
                  );
                  throw error;
                }
              };

              // Set up onRequest handler as well for incoming requests
              bridgeTransport.onRequest = async (request) => {
                return bridgeTransport.sendRequest(request);
              };

              return bridgeTransport;
            },

            // Disconnect from the server
            disconnect: async () => {
              try {
                await mcpClient.disconnect();
                console.log(`${serverName}: Disconnected`);
              } catch (error) {
                console.error(
                  `${serverName}: Disconnect error - ${error.message}`
                );
              }
            },
          };

          // Register the server with the bridge
          await bridge.registerServer(server);
          console.log(`${serverName}: Registered with bridge`);
        } catch (error) {
          console.error(
            `Error connecting MCP client to ${serverName}: ${error.message}`
          );
          process.exit(1);
        }

        // Handle server process exit
        if (serverProcess) {
          serverProcess.on("exit", async (code) => {
            console.log(`Server process exited with code ${code}`);
            await cleanup();
          });
        }
      } else {
        console.error(`Unknown transport type: ${options.transportType}`);
        process.exit(1);
      }

      // Handle server process exit
      if (serverProcess) {
        serverProcess.on("exit", async (code) => {
          console.log(`Server process exited with code ${code}`);
          await cleanup();
        });
      }

      console.log("MCP Bridge is running with server. Press Ctrl+C to stop.");
    } catch (error) {
      console.error("Error running MCP server:", error);
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse(process.argv);

// If no command is provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
