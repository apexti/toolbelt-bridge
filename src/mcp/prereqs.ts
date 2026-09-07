/**
 * Prerequisite detection: which runtimes local MCP servers can be launched
 * with (node/npx, uv/uvx, python, docker) and whether Ollama is installed.
 * Also resolves a bare command to an executable path, honouring PATHEXT on
 * Windows so `npx` finds `npx.cmd`.
 */
export interface PrereqStatus {
  id: string;
  label: string;
  found: boolean;
  path?: string | null;
  version?: string | null;
  hint: string;
}

const PREREQS = [
  {
    id: "node",
    label: "Node.js",
    commands: ["node"],
    hint: "Needed for npx-based MCP servers — https://nodejs.org",
  },
  { id: "npx", label: "npx", commands: ["npx"], hint: "Ships with Node.js" },
  {
    id: "uvx",
    label: "uv / uvx",
    commands: ["uvx"],
    hint: "Needed for Python MCP servers — https://docs.astral.sh/uv/",
  },
  {
    id: "python",
    label: "Python",
    commands: ["python3", "python"],
    hint: "Optional; some servers run as python -m …",
  },
  {
    id: "docker",
    label: "Docker",
    commands: ["docker"],
    hint: "Optional; for containerised MCP servers",
  },
  {
    id: "ollama",
    label: "Ollama",
    commands: ["ollama"],
    hint: "Optional; local models via http://127.0.0.1:11434",
  },
];

const pathCache = new Map<string, string | null>();

export async function resolveCommand(command: string): Promise<string | null> {
  if (!command) return null;
  if (/[\\/]/.test(command)) {
    try {
      await Deno.stat(command);
      return command;
    } catch {
      return null;
    }
  }
  if (pathCache.has(command)) return pathCache.get(command)!;
  const pathVar = Deno.env.get("PATH") || "";
  const sep = Deno.build.os === "windows" ? ";" : ":";
  const exts = Deno.build.os === "windows"
    ? (Deno.env.get("PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").map((e) =>
      e.toLowerCase()
    )
    : [""];
  const candidates = Deno.build.os === "windows" && !/\.[a-z0-9]+$/i.test(command)
    ? ["", ...exts].map((ext) => command + ext)
    : [command];
  for (const dir of pathVar.split(sep).filter(Boolean)) {
    for (const name of candidates) {
      const full = `${dir}${Deno.build.os === "windows" ? "\\" : "/"}${name}`;
      try {
        const info = await Deno.stat(full);
        if (info.isFile) {
          pathCache.set(command, full);
          return full;
        }
      } catch {
        /* keep looking */
      }
    }
  }
  pathCache.set(command, null);
  return null;
}

export function clearCommandCache(): void {
  pathCache.clear();
}

async function versionOf(path: string): Promise<string | null> {
  try {
    const out = await new Deno.Command(path, {
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).output();
    const text = new TextDecoder().decode(out.stdout || out.stderr).trim().split("\n")[0];
    return text.slice(0, 80) || null;
  } catch {
    return null;
  }
}

export async function checkPrerequisites(): Promise<PrereqStatus[]> {
  clearCommandCache();
  const results: PrereqStatus[] = [];
  for (const prereq of PREREQS) {
    let path: string | null = null;
    for (const cmd of prereq.commands) {
      path = await resolveCommand(cmd);
      if (path) break;
    }
    results.push({
      id: prereq.id,
      label: prereq.label,
      found: Boolean(path),
      path,
      version: path ? await versionOf(path) : null,
      hint: prereq.hint,
    });
  }
  return results;
}
