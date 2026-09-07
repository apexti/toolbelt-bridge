# Toolbelt Bridge

Run MCP servers and local LLM runtimes (Ollama, LM Studio, vLLM, or any OpenAI-compatible
server) on your own machine and use them from
[Toolbelt](https://github.com/apexti/toolbelt) — per organization, with nothing on your
machine exposed to the internet.

The bridge is a single native binary (built with Deno) with a small local web UI at
http://127.0.0.1:4747.

## Install

Download the latest release for your platform from the **Releases** page (or from Toolbelt
→ Bridges → _Download bridge_):

| Platform            | File                              |
| ------------------- | --------------------------------- |
| Linux x64           | `toolbelt-bridge-linux-x64`       |
| macOS Apple Silicon | `toolbelt-bridge-macos-arm64`     |
| macOS Intel         | `toolbelt-bridge-macos-x64`       |
| Windows x64         | `toolbelt-bridge-windows-x64.exe` |

```bash
chmod +x toolbelt-bridge-linux-x64
./toolbelt-bridge-linux-x64            # starts the bridge and opens the local UI
```

macOS: the binaries are not notarized yet, so the first launch needs
`xattr -d com.apple.quarantine ./toolbelt-bridge-macos-arm64`.

Verify downloads against `sha256sums.txt` attached to each release.

## Pair with an organization

1. In Toolbelt open **Bridges → Pair a bridge** in the organization you want (or your
   personal space). You get a code and a pair URL, valid for ten minutes.
2. Paste the URL into the bridge's local UI, or run
   `toolbelt-bridge pair "https://toolbelt.example.com/bridge/pair?code=ABC123"`.

A bridge can be paired with several organizations. Each MCP server and each local model is
exposed to exactly the organizations you tick in the local UI. Inside an organization,
what you expose is visible only to you until you share it from Toolbelt's Bridges page.

## MCP servers

Add a server in the local UI (command, arguments, environment, working directory, icon).
Servers launched with `npx` need Node.js on this machine; Python servers via `uvx` need
[uv](https://docs.astral.sh/uv/). The _Prerequisites_ panel shows what was found.

Servers auto-restart after a crash (up to five times in ten minutes) and their output is
written to `<config dir>/logs/<server>.log`.

## Local models

The bridge probes Ollama (`:11434`), LM Studio (`:1234`) and vLLM (`:8000`) every 30
seconds and lists the models it finds. Tick the organizations a model should be available
in; it then appears in that organization's model picker under **Organization Models**, and
chat requests are tunnelled through the bridge's WebSocket to the runtime. Other
OpenAI-compatible servers can be added with their base URL and an optional API key.

## Command line

```
toolbelt-bridge [serve] [--headless] [--port 4747] [--config <path>]
toolbelt-bridge pair <code|url> [--server https://toolbelt.example.com]
toolbelt-bridge status
toolbelt-bridge version
```

Config lives in `~/.config/toolbelt-bridge/config.json` (Linux),
`~/Library/Application Support/toolbelt-bridge/config.json` (macOS) or
`%APPDATA%\toolbelt-bridge\config.json` (Windows), mode 0600 — it contains the bridge
tokens. `TOOLBELT_BRIDGE_CONFIG` overrides the path. A v1 `settings.json` from the Node
bridge is migrated automatically when passed as `--config`.

## Development

Requires [Deno](https://deno.com) 2.x.

```bash
deno task dev                # run from source
deno task test
deno task check              # type-check, lint, fmt
deno task compile:linux      # dist/toolbelt-bridge-linux-x64 (see scripts/compile.ts)
```

Releases are built by GitHub Actions on `v*` tags for all four targets, with
`sha256sums.txt`. Bump `src/version.ts` and `deno.json` before tagging.

The wire protocol is documented in Toolbelt's `docs/bridge-protocol-v2.md`.
