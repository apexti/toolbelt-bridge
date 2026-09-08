/**
 * toolbelt-bridge CLI.
 *
 *   toolbelt-bridge                       start (opens the local UI)
 *   toolbelt-bridge serve [--headless] [--port 4747] [--config path]
 *   toolbelt-bridge pair <code|url> [--server https://toolbelt.example.com]
 *   toolbelt-bridge status
 *   toolbelt-bridge version
 */
import { parseArgs } from "@std/cli/parse-args";
import { ConfigStore, loadConfig, saveConfig } from "./config.ts";
import { defaultConfigPath, logsDirFor } from "./paths.ts";
import { Logger, type LogLevel } from "./log.ts";
import { McpManager } from "./mcp/manager.ts";
import { LlmRegistry } from "./llm/runtimes.ts";
import { LlmProxy } from "./llm/proxy.ts";
import { ConnectionManager, currentBridgeInfo } from "./connections/manager.ts";
import { claimPairing, orgConfigFromClaim, parsePairInput } from "./pairing.ts";
import { startUiServer, uiTokenPath } from "./ui/server.ts";
import { VERSION } from "./version.ts";
import { spawnReplacement, Updater } from "./updater.ts";

const HELP = `toolbelt-bridge ${VERSION}

Usage:
  toolbelt-bridge [serve] [options]      Run the bridge and its local UI
  toolbelt-bridge pair <code|url>        Pair with a Toolbelt organization
  toolbelt-bridge status                 Show paired orgs and connection state
  toolbelt-bridge update                 Download and install the latest release
  toolbelt-bridge version

Options:
  --config <path>     Config file (default: ${defaultConfigPath()})
  --port <n>          Local UI port (default: from config, 4747)
  --headless          Do not open the browser
  --no-open           Same as --headless
  --server <url>      Toolbelt URL when pairing with a bare code
  --log-level <lvl>   debug | info | warn | error
`;

async function openBrowser(url: string): Promise<void> {
  const cmd = Deno.build.os === "windows"
    ? ["cmd", "/c", "start", "", url]
    : Deno.build.os === "darwin"
    ? ["open", url]
    : ["xdg-open", url];
  try {
    await new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "null", stderr: "null" })
      .output();
  } catch {
    /* no browser available */
  }
}

async function loadStore(path: string, log?: Logger): Promise<ConfigStore> {
  const { config, migrated, existed } = await loadConfig(path);
  if (!existed || migrated) {
    await saveConfig(path, config);
    log?.info("config", migrated ? `migrated v1 settings to ${path}` : `created ${path}`);
  }
  return new ConfigStore(path, config);
}

async function serve(args: ReturnType<typeof parseArgs>): Promise<void> {
  const configPath = String(args.config || defaultConfigPath());
  const log = new Logger({
    logsDir: logsDirFor(configPath),
    level: String(args["log-level"] || Deno.env.get("LOG_LEVEL") || "info") as LogLevel,
  });
  const store = await loadStore(configPath, log);
  if (args.port) {
    await store.update((cfg) => {
      cfg.ui.port = Number(args.port);
    });
  }
  log.info(
    "bridge",
    `toolbelt-bridge ${VERSION} (${Deno.build.os}/${Deno.build.arch}) config=${configPath}`,
  );

  const mcp = new McpManager(store, log);
  const llm = new LlmRegistry(store, log);
  const proxy = new LlmProxy(llm, log);
  const connections = new ConnectionManager(store, log, mcp, llm, proxy);

  await Updater.cleanupOldBinary();
  let ui: Awaited<ReturnType<typeof startUiServer>> | null = null;
  let stopForRestart: (() => Promise<void>) | null = null;
  const updater = new Updater({
    log,
    restart: async () => {
      log.info("update", "restarting into the new version");
      await stopForRestart?.();
      spawnReplacement();
      await log.flush();
      Deno.exit(0);
    },
    onChange: () => {
      /* state is read on the next UI push */
    },
  });
  ui = await startUiServer({ store, log, mcp, llm, connections, updater });
  llm.start();
  connections.start();
  await mcp.startAll();

  if (store.config.orgs.length === 0) {
    log.info(
      "bridge",
      `not paired yet — open ${ui.url} and enter a pairing code from Toolbelt → Bridges`,
    );
  }
  const headless = args.headless === true || args.open === false;
  if (!headless && store.config.ui.open) await openBrowser(ui.url);

  let shuttingDown = false;
  const stopEverything = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    updater.stop();
    connections.stop();
    llm.stop();
    await mcp.stopAll();
    await ui?.close();
  };
  stopForRestart = stopEverything;
  const shutdown = async () => {
    log.info("bridge", "shutting down");
    await stopEverything();
    await log.flush();
    Deno.exit(0);
  };
  updater.start({
    enabled: () => store.config.updates.check,
    auto: () => store.config.updates.auto,
  });
  Deno.addSignalListener("SIGINT", () => void shutdown());
  if (Deno.build.os !== "windows") {
    Deno.addSignalListener("SIGTERM", () => void shutdown());
  }
}

async function pair(args: ReturnType<typeof parseArgs>): Promise<void> {
  const input = String(args._[1] || "");
  const configPath = String(args.config || defaultConfigPath());
  const store = await loadStore(configPath);
  const target = parsePairInput(input, args.server ? String(args.server) : null);

  // Prefer the running instance so the new org connects immediately.
  try {
    const token = await Deno.readTextFile(uiTokenPath(configPath));
    const response = await fetch(`http://127.0.0.1:${store.config.ui.port}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-token": token.trim() },
      body: JSON.stringify({ input, serverUrl: args.server || null }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error || `pairing failed (${response.status})`);
    }
    console.log(
      `Paired with ${body.orgName} (${body.serverUrl}) — the running bridge is connecting.`,
    );
    return;
  } catch (error) {
    if (
      !(error instanceof Deno.errors.NotFound) &&
      !/ECONNREFUSED|Connection refused|os error/.test(String(error))
    ) {
      if (!(error instanceof TypeError)) throw error;
    }
  }

  const claim = await claimPairing(
    target,
    store.config.installId,
    currentBridgeInfo(store),
  );
  const orgCfg = orgConfigFromClaim(claim, target.serverUrl);
  await store.update((cfg) => {
    cfg.orgs = cfg.orgs.filter((o) => o.id !== orgCfg.id);
    cfg.orgs.push(orgCfg);
  });
  console.log(
    `Paired with ${orgCfg.name} (${orgCfg.serverUrl}). Start the bridge with: toolbelt-bridge`,
  );
}

async function update(args: ReturnType<typeof parseArgs>): Promise<void> {
  const configPath = String(args.config || defaultConfigPath());
  const store = await loadStore(configPath);
  const log = new Logger({ level: "warn" });

  // A running instance should do it, so it can restart itself afterwards.
  try {
    const token = (await Deno.readTextFile(uiTokenPath(configPath))).trim();
    const base = `http://127.0.0.1:${store.config.ui.port}`;
    const headers = { "content-type": "application/json", "x-bridge-token": token };
    const checked = await (await fetch(`${base}/api/update/check`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(30_000),
    })).json();
    if (checked.error) throw new Error(checked.error);
    if (!checked.updateAvailable) {
      console.log(`Already up to date (${checked.currentVersion}).`);
      return;
    }
    if (!checked.canSelfUpdate) {
      console.log(
        `${checked.latest?.tag} is available but cannot be installed automatically: ${checked.reason}`,
      );
      console.log(`Download: ${checked.latest?.url}`);
      return;
    }
    await fetch(`${base}/api/update/apply`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    console.log(
      `Installing ${checked.latest?.tag}; the running bridge will restart itself.`,
    );
    return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound) && !(error instanceof TypeError)) {
      throw error;
    }
  }

  const updater = new Updater({ log, restart: null });
  const state = await updater.check();
  if (state.error) throw new Error(state.error);
  if (!state.updateAvailable) {
    console.log(`Already up to date (${state.currentVersion}).`);
    return;
  }
  if (!state.canSelfUpdate) {
    console.log(
      `${state.latest?.tag} is available but cannot be installed automatically: ${state.reason}`,
    );
    console.log(`Download: ${state.latest?.url}`);
    return;
  }
  console.log(`Installing ${state.latest?.tag} over ${updater.execPath}…`);
  const done = await updater.apply({ restart: false });
  console.log(`Updated to ${done.installedVersion}. Start the bridge again to use it.`);
}

async function status(args: ReturnType<typeof parseArgs>): Promise<void> {
  const configPath = String(args.config || defaultConfigPath());
  const store = await loadStore(configPath);
  console.log(`toolbelt-bridge ${VERSION}`);
  console.log(`config: ${configPath}`);
  console.log(`install: ${store.config.installId}`);
  try {
    const response = await fetch(`http://127.0.0.1:${store.config.ui.port}/api/state`, {
      signal: AbortSignal.timeout(3000),
    });
    const state = await response.json();
    console.log(`running: yes (UI at http://127.0.0.1:${store.config.ui.port})`);
    if (state.update?.updateAvailable) {
      console.log(
        `update: ${state.update.latest?.tag} available (run: toolbelt-bridge update)`,
      );
    }
    for (const org of state.orgs || []) {
      console.log(
        `  ${org.orgName}: ${org.state}${
          org.lastError ? ` (${org.lastError})` : ""
        } — ${org.serversExposed} servers, ${org.modelsExposed} models`,
      );
    }
    for (const server of state.servers || []) {
      console.log(
        `  server ${server.key}: ${server.status} (${server.tools.length} tools)`,
      );
    }
  } catch {
    console.log("running: no");
    for (const org of store.config.orgs) {
      console.log(`  paired: ${org.name} (${org.serverUrl})`);
    }
  }
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["config", "port", "server", "log-level"],
    boolean: ["headless", "open", "help", "version"],
    default: { open: true },
    alias: { h: "help", v: "version" },
  });
  const command = String(args._[0] || "serve");
  try {
    if (args.help || command === "help") console.log(HELP);
    else if (args.version || command === "version") console.log(VERSION);
    else if (command === "serve") await serve(args);
    else if (command === "pair") await pair(args);
    else if (command === "status") await status(args);
    else if (command === "update") await update(args);
    else {
      console.error(`Unknown command "${command}"\n`);
      console.log(HELP);
      Deno.exit(2);
    }
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    Deno.exit(1);
  }
}
