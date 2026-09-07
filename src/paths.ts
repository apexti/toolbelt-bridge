import { join } from "@std/path";

/** Per-OS config directory for the bridge (override with --config / env). */
export function defaultConfigDir(): string {
  const env = Deno.env.get("TOOLBELT_BRIDGE_HOME");
  if (env) return env;
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || ".";
  switch (Deno.build.os) {
    case "darwin":
      return join(home, "Library", "Application Support", "toolbelt-bridge");
    case "windows":
      return join(
        Deno.env.get("APPDATA") || join(home, "AppData", "Roaming"),
        "toolbelt-bridge",
      );
    default:
      return join(
        Deno.env.get("XDG_CONFIG_HOME") || join(home, ".config"),
        "toolbelt-bridge",
      );
  }
}

export function defaultConfigPath(): string {
  return Deno.env.get("TOOLBELT_BRIDGE_CONFIG") ||
    join(defaultConfigDir(), "config.json");
}

export function logsDirFor(configPath: string): string {
  const dir = configPath.replace(/[\\/][^\\/]+$/, "");
  return join(dir, "logs");
}

export async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}
