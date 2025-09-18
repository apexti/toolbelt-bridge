import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";
import { spawn } from "child_process"; // Needed for process management
import { createServer as createHttpServer } from "http";
import { startStdioService } from "./stdio-utils.js";
import fs from "fs";
import { dirname } from "path";
import path from "path";
import { fileURLToPath } from "url";

// Get the directory path for the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * McpBridgeServer
 *
 * This class implements a bridge server that connects to the Toolbelt app
 * and allows local MCP servers to be used remotely through the Toolbelt interface.
 */
class McpBridgeServer {
  /**
   * Create a new McpBridgeServer
   * @param {Object} config - Configuration options
   * @param {string} config.apiKey - API key for authentication
   * @param {string} config.toolbeltUrl - URL of the Toolbelt bridge endpoint
   * @param {string} [config.logLevel="info"] - Logging level (e.g., "debug", "info", "warn", "error")
   */
  constructor(config = {}) {
    this.apiKey = config.apiKey;
    this.toolbeltUrl = config.toolbeltUrl || "wss://toolbelt.apexti.dev/bridge";
    this.localServers = new Map(); // Maps server name to { server: mcpServerInstance, process: childProcess } or similar
    this.serverIdsMap = new Map(); // Maps server ID to server name for lookup by ID
    this.clients = new Map(); // Maps server name to client
    this.isConnected = false;
    this.userId = null;
    this.pendingRequests = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.pingInterval = null;
    this.logLevel = config.logLevel || "info";
    this.settingsPath = path.join(process.cwd(), "settings.json");

    // Allow disabling SSL verification for development
    this.rejectUnauthorized = config.rejectUnauthorized !== false;

    // Load settings if they exist
    this.loadSettings();

    // Initialize connectionId after loading settings (in case it was loaded from settings)
    if (!this.connectionId) {
      this.connectionId = uuidv4();
    }
  }

  /**
   * Load settings from the settings file
   * @private
   */
  loadSettings() {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(this.settingsPath, "utf8"));
        this.log("info", "Loaded settings from file");

        // Use saved connectionId if available
        if (settings.bridgeConnectionId) {
          this.connectionId = settings.bridgeConnectionId;
          this.log("info", `Using saved connection ID: ${this.connectionId}`);
        }

        // Restore saved servers if any
        if (settings.mcpServers) {
          this.log(
            "info",
            `Found ${Object.keys(settings.mcpServers).length} saved servers`
          );
          // We'll restore these servers when start() is called
          this.savedServers = settings.mcpServers;
        }
      }
    } catch (error) {
      this.log("error", "Error loading settings:", error);
    }
  }

  /**
   * Save current settings to the settings file
   * @private
   */
  saveSettings() {
    try {
      const settings = {
        apikey: this.apiKey,
        bridgeConnectionId: this.connectionId,
        bridgeName: "toolbelt-bridge",
        mcpServers: {},
      };

      // Save information about each server
      for (const [name, serverData] of this.localServers.entries()) {
        // Get the server instance
        const server = serverData.server;

        const transport = server.client.transport;
        settings.mcpServers[name] = {
          command: server.command,
          args: server.args || [],
          options: server.options || { shell: true, cwd: process.cwd() },
          env: server.env || undefined,
        };
      }

      // Also preserve any servers from savedServers that aren't currently running
      if (this.savedServers) {
        for (const [name, serverConfig] of Object.entries(this.savedServers)) {
          if (!settings.mcpServers[name]) {
            settings.mcpServers[name] = serverConfig;
          }
        }
      }

      fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2));
      this.log("info", "Settings saved to file");
    } catch (error) {
      this.log("error", "Error saving settings:", error);
    }
  }

  /**
   * Log messages based on the configured log level
   * @param {string} level - The log level (debug, info, warn, error)
   * @param {...any} args - Arguments to log
   */
  log(level, ...args) {
    const levels = { debug: 1, info: 2, warn: 3, error: 4 };
    if (levels[level] >= levels[this.logLevel]) {
      console[level === "debug" ? "log" : level](
        `[${level.toUpperCase()}]`,
        ...args
      );
    }
  }

  /**
   * Start the bridge server
   * @returns {Promise<void>}
   */
  async start() {
    this.log("info", "Starting MCP Bridge Server...");

    // Restore saved servers if any
    if (this.savedServers) {
      this.log("info", "Restoring saved servers...");
      for (const [name, serverConfig] of Object.entries(this.savedServers)) {
        try {
          await this.handleStartServiceRequest({
            serviceConfig: {
              name,
              command: serverConfig.command,
              args: serverConfig.args,
              options: { shell: true, cwd: process.cwd() },
              env: serverConfig.env || {},
            },
            requestId: `restore-${name}-${Date.now()}`,
          });
        } catch (error) {
          this.log("error", `Failed to restore server ${name}:`, error);
        }
      }
      this.savedServers = null;
    }

    this.connectToToolbelt();
    return this;
  }

  /**
   * Connect to the Toolbelt app
   * @private
   */
  connectToToolbelt() {
    this.log("info", `Connecting to Toolbelt at ${this.toolbeltUrl}`);
    this.log(
      "info",
      `Using API key: ${this.apiKey ? this.apiKey.substring(0, 8) + "..." : "None"}`
    );

    try {
      const wsOptions = {
        headers: {
          "API-Key": this.apiKey,
          "Connection-ID": this.connectionId,
        },
      };

      // If the URL is using wss:// protocol and rejectUnauthorized is false,
      // disable SSL verification for development purposes
      if (this.toolbeltUrl.startsWith("wss://") && !this.rejectUnauthorized) {
        this.log("warn", "SSL verification disabled for development");
        wsOptions.rejectUnauthorized = false;
      }

      this.ws = new WebSocket(this.toolbeltUrl, wsOptions);

      this.ws.on("open", () => {
        this.log("info", "Connected to Toolbelt");
        this.isConnected = true;
        this.reconnectAttempts = 0;

        // Start ping-pong to keep connection alive
        this.startPingPong();
      });

      this.ws.on("message", (data) => {
        this.handleMessage(data);
      });

      this.ws.on("close", () => {
        this.isConnected = false;
        this.handleDisconnect();
      });

      this.ws.on("error", (error) => {
        this.log("error", "WebSocket error:", error);
      });
    } catch (error) {
      this.log("error", "Error connecting to Toolbelt:", error);
      this.handleDisconnect();
    }
  }

  /**
   * Start ping-pong to keep connection alive
   * @private
   */
  startPingPong() {
    // Clear any existing interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    // Start a new interval
    this.pingInterval = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.log("debug", "Sending ping");
        this.ws.send(JSON.stringify({ type: "ping" }));
      } else {
        clearInterval(this.pingInterval);
      }
    }, 30000); // 30 seconds
  }

  /**
   * Handle disconnection from Toolbelt
   * @private
   */
  handleDisconnect() {
    this.log("warn", "Disconnected from Toolbelt");

    // Clear ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    // Reject all pending requests
    for (const [requestId, { reject }] of this.pendingRequests.entries()) {
      reject(new Error("Disconnected from Toolbelt"));
      this.pendingRequests.delete(requestId);
    }

    // Attempt to reconnect with exponential backoff
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      this.log("info", `Attempting to reconnect in ${delay}ms...`);

      setTimeout(() => {
        this.reconnectAttempts++;
        this.connectToToolbelt();
      }, delay);
    } else {
      this.log(
        "error",
        "Max reconnection attempts reached. Please restart the bridge manually."
      );
    }
  }

  /**
   * Get server data by name or ID
   * @param {string} nameOrId - The server name or ID
   * @returns {Object|null} - The server data or null if not found
   */
  getServerData(nameOrId) {
    // Try direct lookup by name first
    if (this.localServers.has(nameOrId)) {
      return this.localServers.get(nameOrId);
    }

    // Try lookup by ID if not found by name
    const serverName = this.serverIdsMap.get(nameOrId);
    if (serverName && this.localServers.has(serverName)) {
      return this.localServers.get(serverName);
    }

    return null;
  }

  /**
   * Register an MCP server with the bridge
   * This might be called manually or when a service is started remotely
   * @param {Object} mcpServer - The MCP server instance
   * @param {Object} [processHandle=null] - Optional handle to the running process
   * @returns {Promise<Object>} - The registered server info
   */
  async registerServer(mcpServer, processHandle = null) {
    const serverName = mcpServer.name;

    // Use a stable ID based on connection ID and server name instead of timestamp
    // This ensures the same service gets the same ID across restarts
    const serverId = mcpServer.id || `${serverName}-${this.connectionId}`;

    if (this.localServers.has(serverName)) {
      this.log("warn", `Server ${serverName} already registered`);
      return this.localServers.get(serverName);
    }

    this.log("info", `Registering server: ${serverName} with ID: ${serverId}`);
    // Get command and args from the server or process
    let command = mcpServer.command;
    let args = mcpServer.args || [];
    let options = mcpServer.options || { shell: true, cwd: process.cwd() };

    // If we have a process handle, try to get command info from it
    if (processHandle) {
      command = processHandle.spawnfile || processHandle.argv[0];
      args = processHandle.argv.slice(1) || [];
      options = {
        shell: true,
        cwd: processHandle.cwd || process.cwd(),
      };
    }

    // If we have a client with transport, get command info from there

    const serverData = {
      server: {
        ...mcpServer,
        command,
        args,
        options,
        env: mcpServer.env || undefined,
      },
      process: processHandle,
      id: serverId,
      name: serverName,
      description: mcpServer.description || `MCP server for ${serverName}`,
      authType: mcpServer.authType || "none",
      icon: mcpServer.icon || null,
      isCodedServer:
        mcpServer.isCodedServer !== undefined ? mcpServer.isCodedServer : true,
      configSchema: mcpServer.configSchema || null,
      tools: mcpServer.tools || [], // Use pre-fetched tools if available
    };

    // Store the server data and ID mapping
    this.localServers.set(serverName, serverData);
    this.serverIdsMap.set(serverId, serverName);

    if (mcpServer.client) {
      this.clients.set(serverName, mcpServer.client);
    }

    // Save settings after registering the server
    this.saveSettings();

    // If already connected to Toolbelt and authenticated, advertise this server
    if (this.isConnected && this.userId) {
      this.sendServerRegistration(serverName, serverData, serverData.tools);
    }

    // Schedule tool fetching after a delay if not pre-fetched and client exists
    if (!mcpServer.hasPreFetchedTools && mcpServer.client) {
      setTimeout(() => {
        this.fetchToolsAndUpdateServer(serverName);
      }, 2000); // 2-second delay
    } else if (!mcpServer.client) {
      this.log(
        "warn",
        `No client available for ${serverName}, cannot fetch tools automatically.`
      );
    } else {
      this.log(
        "info",
        `Server ${serverName} already has tools or client missing, skipping fetch`
      );
    }

    return serverData;
  }

  /**
   * Fetch tools from a server and update its registration
   * @param {string} serverName - The name of the server
   * @private
   */
  async fetchToolsAndUpdateServer(serverName, retryCount = 0) {
    const serverData = this.localServers.get(serverName);
    const client = this.clients.get(serverName);

    if (!serverData) {
      this.log(
        "warn",
        `Cannot fetch tools - server ${serverName} not found in localServers.`
      );
      return;
    }
    if (!client) {
      this.log(
        "warn",
        `Cannot fetch tools - client for ${serverName} not found.`
      );
      return;
    }

    // Maximum 5 retry attempts
    const maxRetries = 5;

    try {
      this.log("info", `Fetching tools for server ${serverName}...`);
      const response = await client.listTools();

      // Extract tools (same logic as before)
      let tools = [];
      if (response) {
        if (response.tools) {
          // Check if tools is an array or an object with a tools property
          if (Array.isArray(response.tools)) {
            tools = response.tools;
          } else if (
            typeof response.tools === "object" &&
            response.tools.tools &&
            Array.isArray(response.tools.tools)
          ) {
            // Handle nested tools: { tools: { tools: [] } }
            this.log(
              "debug",
              `Found nested tools structure, extracting inner tools array`
            );
            tools = response.tools.tools;
          }
        } else if (response.result && Array.isArray(response.result)) {
          tools = response.result;
        } else if (response.data && Array.isArray(response.data)) {
          tools = response.data;
        } else if (Array.isArray(response)) {
          tools = response;
        }

        // Get tool names for logging only
        const toolNames = tools
          .map((tool) =>
            typeof tool === "string" ? tool : tool.name || "unnamed"
          )
          .filter(Boolean);

        this.log(
          "debug",
          `Extracted ${tools.length} tools for ${serverName}: ${toolNames.join(", ")}`
        );
      }

      // Update the server's tools in our map
      serverData.tools = tools;

      // Re-advertise the server with the updated tools if connected
      if (this.isConnected && this.userId) {
        this.sendServerRegistration(serverName, serverData, tools);
      } else {
        this.log(
          "info",
          `Not connected to Toolbelt, tool update for ${serverName} will be sent on reconnect`
        );
      }
    } catch (error) {
      this.log(
        "error",
        `Error fetching tools from ${serverName}: ${error.message}`
      );
      // Retry logic (same as before)
      if (retryCount < maxRetries) {
        const delay = Math.min(Math.pow(2, retryCount) * 1000, 30000);
        this.log(
          "warn",
          `Retrying tool fetch for ${serverName} in ${delay}ms (attempt ${retryCount + 1}/${maxRetries})`
        );
        setTimeout(() => {
          this.fetchToolsAndUpdateServer(serverName, retryCount + 1);
        }, delay);
      } else {
        this.log(
          "error",
          `Maximum retries reached for fetching tools from ${serverName}`
        );
        // Advertise even with potentially empty tools
        if (this.isConnected && this.userId) {
          this.sendServerRegistration(
            serverName,
            serverData,
            serverData.tools || []
          );
        }
      }
    }
  }

  /**
   * Unregister an MCP server from the bridge
   * @param {string} serverNameOrId - The name or ID of the server to unregister
   * @returns {Promise<boolean>} - True if the server was unregistered
   */
  async unregisterServer(serverNameOrId) {
    // Get server data by name or ID
    const serverData = this.getServerData(serverNameOrId);
    if (!serverData) {
      this.log("warn", `Server ${serverNameOrId} not registered`);
      return false;
    }

    const serverName = serverData.name;
    const serverId = serverData.id;

    this.log("info", `Unregistering server: ${serverName} (ID: ${serverId})`);

    try {
      // Stop the process if we have a handle
      if (serverData.process) {
        this.log("info", `Stopping process for server ${serverName}...`);
        // Attempt graceful shutdown first, then force kill
        serverData.process.kill("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2s
        if (!serverData.process.killed) {
          this.log(
            "warn",
            `Process for ${serverName} did not exit gracefully, sending SIGKILL.`
          );
          serverData.process.kill("SIGKILL");
        }
      }
      // Disconnect MCP client if it exists
      if (serverData.server?.disconnect) {
        try {
          await serverData.server.disconnect();
        } catch (disconnectError) {
          this.log(
            "error",
            `Error disconnecting MCP client for ${serverName}:`,
            disconnectError
          );
        }
      }

      // Remove the server and client from maps
      this.localServers.delete(serverName);
      this.serverIdsMap.delete(serverId);
      this.clients.delete(serverName);

      // Save settings after unregistering the server
      this.saveSettings();

      // If connected to Toolbelt, notify of removal
      if (this.isConnected && this.ws.readyState === WebSocket.OPEN) {
        this.log("info", `Notifying Toolbelt of server removal: ${serverName}`);
        this.ws.send(
          JSON.stringify({
            type: "unregister_server",
            serverName,
            serverId, // Include both name and ID for flexibility
          })
        );
      } else {
        this.log(
          "warn",
          `Cannot notify Toolbelt of server removal: WebSocket not open.`
        );
      }

      return true;
    } catch (error) {
      this.log("error", `Error unregistering server ${serverName}:`, error);
      // Still try to remove from local maps
      this.localServers.delete(serverName);
      this.serverIdsMap.delete(serverId);
      this.clients.delete(serverName);
      // Still try to save settings
      this.saveSettings();
      return false;
    }
  }

  /**
   * Advertise all registered servers to the Toolbelt app
   * @private
   */
  advertiseServers() {
    this.log(
      "info",
      `Advertising ${this.localServers.size} registered servers to Toolbelt`
    );
    for (const [name, serverData] of this.localServers.entries()) {
      this.sendServerRegistration(name, serverData, serverData.tools || []);
      // Re-fetch tools just in case they changed while disconnected
      if (this.clients.has(name)) {
        setTimeout(() => {
          this.fetchToolsAndUpdateServer(name);
        }, 1000);
      }
    }
  }

  /**
   * Send server registration to Toolbelt
   * @param {string} name - The server name
   * @param {Object} serverData - The server data object from localServers map
   * @param {Array} tools - The list of tools
   * @private
   */
  sendServerRegistration(name, serverData, tools) {
    const serverInfo = {
      type: "register_server",
      server: {
        name: serverData.name,
        id: serverData.id,
        description: serverData.description,
        authType: serverData.authType,
        icon: serverData.icon,
        isCodedServer: serverData.isCodedServer,
        configSchema: serverData.configSchema,
        tools: tools || [],
      },
    };

    // Log only tool names for brevity
    const toolSummary = (tools || [])
      .map((tool) => (typeof tool === "string" ? tool : tool.name || "unnamed"))
      .join(", ");

    this.log(
      "debug",
      `Sending server registration details for ${name} with ${tools?.length || 0} tools: ${toolSummary}`
    );

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(serverInfo));
    } else {
      this.log(
        "warn",
        `Cannot send server registration for ${name}: WebSocket not open`
      );
    }
  }

  /**
   * Handle a message from the Toolbelt app
   * @param {Buffer|string} data - The message data
   * @private
   */
  async handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      this.log("debug", `Received message from Toolbelt: ${message.type}`);

      switch (message.type) {
        case "ping":
          this.log("debug", "Received ping, sending pong");
          this.ws.send(JSON.stringify({ type: "pong" }));
          break;

        case "pong":
          this.log("debug", "Received pong");
          break;

        case "welcome":
          this.log(
            "info",
            `Welcome message received. User ID: ${message.userId || "None"}`
          );
          if (message.userId) {
            this.userId = message.userId;
            this.advertiseServers(); // Advertise now that we are authenticated
          }
          break;

        case "mcp_request":
          await this.handleMcpRequest(message);
          break;

        case "start_service":
          await this.handleStartServiceRequest(message);
          break;

        case "stop_service":
          await this.handleStopServiceRequest(message);
          break;

        // We don't expect these from Toolbelt, they are responses *to* Toolbelt
        // case "service_started":
        // case "service_stopped":
        // case "start_service_error":
        // case "stop_service_error":
        case "registration_success": // Keep these for potential future use
          this.log(
            "info",
            `Server ${message.serverName} registration confirmed by Toolbelt`
          );
          break;
        case "registration_error":
          this.log(
            "error",
            `Toolbelt reported error registering server ${message.serverName}: ${message.error}`
          );
          break;

        default:
          this.log("warn", `Unknown message type received: ${message.type}`);
      }
    } catch (error) {
      this.log(
        "error",
        "Error handling message:",
        error,
        "Raw data:",
        data.toString()
      );
    }
  }

  /**
   * Handle an MCP request from Toolbelt
   * @param {Object} message - The request message
   * @private
   */
  async handleMcpRequest(message) {
    const { serverName, serverId, requestId, request, authContext } = message;

    // Use either name or ID, preferring ID if provided
    const lookupId = serverId || serverName;
    this.log("debug", `Handling MCP request for ${lookupId}:`, request);

    const serverData = this.getServerData(lookupId);
    const client = serverData ? this.clients.get(serverData.name) : null;

    if (!serverData || !client) {
      this.log(
        "error",
        `Server or client not found for MCP request ${requestId}. Tried: ${lookupId}`
      );
      this.sendResponse(requestId, {
        error: `Server not found or not running locally.`,
      });
      return;
    }

    try {
      const mcpRequest = { id: request.id || uuidv4(), ...request };

      this.log(
        "debug",
        `Sending request to local server ${serverData.name}: ${JSON.stringify(mcpRequest)}`
      );

      if (request.method === "tools/call") {
        try {
          // Extract the tool name and arguments
          const toolName = request.params?.name;
          const toolArgs = request.params?.arguments || {};

          console.log(`Handling filesystem tool call: ${toolName}`, toolArgs);
          const response = await client.callTool(request.params);

          this.sendResponse(requestId, { response });
        } catch (error) {
          console.error(`Error handling filesystem tool call:`, error);
          this.sendResponse(requestId, {
            error:
              error.message || "Unknown error processing filesystem operation",
          });
        }
      } else if (request.method === "tools/list") {
        try {
          const response = await client.listTools();
          // Log the response for debugging
          console.log(
            `Got raw response for tools/list from ${serverName}:`,
            response
          );

          // Extract tools from the response if present
          let tools = [];
          if (response && response.tools && Array.isArray(response.tools)) {
            tools = response.tools;
            console.log(
              `Extracted ${tools.length} tools from server ${serverName}`
            );
          } else if (response && Array.isArray(response)) {
            tools = response;
            console.log(
              `Extracted ${tools.length} tools from array response from ${serverName}`
            );
          } else {
            console.log(`No tools found in response from ${serverName}`);
          }

          // Update the server's tools array if we found tools
          if (tools.length > 0) {
            const server = this.localServers.get(serverName);
            server.tools = tools;

            // Log tool names for debugging
            const toolNames = tools
              .map((tool) =>
                typeof tool === "string" ? tool : tool.name || "unnamed"
              )
              .filter(Boolean);
            console.log(
              `Server ${serverName} now has ${tools.length} tools: ${toolNames.join(", ")}`
            );
          }

          // Send response with tools (original response if it had tools, or our fallback tools)
          const toolsResponse = {
            tools: tools,
          };

          this.sendResponse(requestId, { response: toolsResponse });
        } catch (error) {
          console.error(
            `Error handling tools/list request for ${serverName}:`,
            error
          );
          this.sendResponse(requestId, {
            error: error.message || "Unknown error",
          });
        }
      } else if (request.method === "initialize") {
        const response = {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: { name: serverName, version: "1.0.0" },
        };
        this.sendResponse(requestId, { response });
      } else {
        console.warn(`Unknown request method: ${request.method}`);
        this.sendResponse(requestId, {
          error: `Unknown request method: ${request.method}`,
        });
      }
    } catch (error) {
      console.error(`Error handling MCP request for ${serverName}:`, error);
      this.sendResponse(requestId, {
        error: error.message || "Unknown error",
      });
    }
  }

  /**
   * Handle request from Toolbelt to start a service.
   * @param {Object} message - The start_service message
   */
  async handleStartServiceRequest(message) {
    const { serviceConfig, requestId, authContext } = message;
    this.log(
      "info",
      `Received request (${requestId}) to start service with config:`,
      serviceConfig
    );

    let newServerData;
    try {
      // Basic validation
      if (!serviceConfig || !serviceConfig.name) {
        throw new Error("Invalid service configuration");
      }

      // Check if a service with this name already exists
      if (this.localServers.has(serviceConfig.name)) {
        throw new Error(
          `Service with name ${serviceConfig.name} already exists`
        );
      }

      // Start the service using our new utility
      if (serviceConfig.command) {
        this.log(
          "info",
          `Starting service using stdio-utils: ${serviceConfig.name}`
        );

        // Split command into command and args if it's a space-separated string
        let command = serviceConfig.command;
        let args = serviceConfig.args || [];

        if (typeof command === "string" && command.includes(" ")) {
          const parts = command.split(" ");
          command = parts[0];
          args = [...parts.slice(1), ...args];
        }

        // Create options object with environment variables if provided
        let options = serviceConfig.options || {
          shell: true,
          cwd: process.cwd(),
        };

        // Handle environment variables
        if (serviceConfig.env && typeof serviceConfig.env === "object") {
          // Start with a copy of the current process environment
          this.log(
            "info",
            `Adding ${Object.keys(serviceConfig.env).length} environment variables for ${serviceConfig.name}`
          );
        }

        // Use startStdioService from stdio-utils.js
        const server = await startStdioService({
          name: serviceConfig.name,
          command: command,
          args: args,
          options: serviceConfig.options || { shell: true, cwd: process.cwd() },
          env: serviceConfig.env || {},
          description:
            serviceConfig.description ||
            `MCP server for ${serviceConfig.name} (stdio)`,
          authType: serviceConfig.authType || "none",
        });

        console.log("start serviceConfig", serviceConfig);
        // Store the command and args in the server object for persistence
        server.command = command;
        server.args = args;
        server.options = options;
        if (serviceConfig.env) {
          server.env = serviceConfig.env;
        }

        // Register the server with the bridge
        newServerData = await this.registerServer(server, server.process);

        this.log(
          "info",
          `Service "${newServerData.name}" started successfully.`
        );

        // Save settings after starting the service
        this.saveSettings();

        // Send confirmation back to Toolbelt
        this.sendResponse(requestId, {
          type: "service_started", // Use explicit type
          status: "Service started successfully",
          serviceInfo: {
            // Send back info about the newly started service
            id: newServerData.id,
            name: newServerData.name,
            description: newServerData.description,
            authType: newServerData.authType,
            icon: newServerData.icon,
            tools: newServerData.tools,
          },
        });
      } else {
        throw new Error("Unsupported service type or missing config");
      }
    } catch (error) {
      this.log(
        "error",
        `Failed to start service for request ${requestId}:`,
        error
      );
      this.sendResponse(requestId, {
        type: "start_service_error", // Use explicit type
        error: error.message || "Failed to start service locally.",
      });
    }
  }

  /**
   * Handle request from Toolbelt to stop a service.
   * @param {Object} message - The stop_service message
   */
  async handleStopServiceRequest(message) {
    const { serverName, serverId, requestId, authContext } = message;

    // Use either name or ID, preferring ID if provided
    const lookupId = serverId || serverName;
    this.log(
      "info",
      `Received request (${requestId}) to stop service: ${lookupId}`
    );

    const serverData = this.getServerData(lookupId);

    if (!serverData) {
      this.log(
        "error",
        `Service ${lookupId} not found for stop request ${requestId}.`
      );
      this.sendResponse(requestId, {
        type: "stop_service_error",
        error: `Service not found locally.`,
      });
      return;
    }

    try {
      const unregistered = await this.unregisterServer(serverData.name);
      if (unregistered) {
        this.log("info", `Service ${serverData.name} stopped successfully.`);
        this.sendResponse(requestId, {
          type: "service_stopped",
          status: "Service stopped successfully",
          serviceInfo: {
            name: serverData.name,
            id: serverData.id,
          }, // Confirm which service was stopped
        });
      } else {
        throw new Error(
          `Failed to unregister/stop service ${serverData.name}.`
        );
      }
    } catch (error) {
      this.log(
        "error",
        `Failed to stop service ${serverData.name} for request ${requestId}:`,
        error
      );
      this.sendResponse(requestId, {
        type: "stop_service_error",
        error: error.message || `Failed to stop service locally.`,
      });
    }
  }

  /**
   * Send a response to Toolbelt
   * @param {string} requestId - The ID of the request being responded to
   * @param {Object} data - The response data (can include type, status, error, serviceInfo, response)
   * @private
   */
  sendResponse(requestId, data) {
    const response = {
      type: data.type || "mcp_response", // Default to mcp_response if type isn't specified
      requestId,
      ...data, // Spread the rest of the data object
    };

    this.log(
      "debug",
      `Sending response to Toolbelt for request ${requestId}:`,
      response
    );

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(response));
    } else {
      this.log(
        "error",
        `Cannot send response for request ${requestId}: WebSocket not open`
      );
    }
  }

  /**
   * Stop the bridge server
   * @returns {Promise<void>}
   */
  async stop() {
    this.log("info", "Stopping MCP Bridge Server...");

    // Clear ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    // Store current server configurations before unregistering
    const serverConfigs = {};
    for (const [name, serverData] of this.localServers.entries()) {
      const server = serverData.server;
      if (server && server.command) {
        serverConfigs[name] = {
          command: server.command,
          args: server.args || [],
          options: server.options || { shell: true, cwd: process.cwd() },
          env: server.env || undefined,
        };
      }
    }

    // Disconnect all servers gracefully
    const unregisterPromises = [];
    for (const name of this.localServers.keys()) {
      unregisterPromises.push(this.unregisterServer(name));
    }
    try {
      await Promise.all(unregisterPromises);
      this.log("info", "All local servers unregistered.");
    } catch (error) {
      this.log("error", "Error during batch unregistration on stop:", error);
    }

    // Clear maps
    this.localServers.clear();
    this.serverIdsMap.clear();
    this.clients.clear();

    // Close WebSocket connection
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // Save final settings with preserved server configurations
    try {
      const settings = {
        apikey: this.apiKey,
        bridgeConnectionId: this.connectionId,
        bridgeName: "toolbelt-bridge",
        mcpServers: serverConfigs,
      };
      fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2));
      this.log("info", "Final settings saved to file");
    } catch (error) {
      this.log("error", "Error saving final settings:", error);
    }

    this.log("info", "MCP Bridge Server stopped");
  }
}

export { McpBridgeServer };
