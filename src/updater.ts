/**
 * Self-update: checks the GitHub release feed, downloads the binary for this
 * platform, verifies it against the release's sha256sums.txt, swaps it over
 * the running executable, and hands off to a restart callback.
 *
 * Only works for compiled binaries in a writable location; otherwise the
 * state carries a reason and the UI falls back to a download link.
 */
import type { Logger } from "./log.ts";
import { VERSION } from "./version.ts";

export const DEFAULT_UPDATE_REPO = "apexti/toolbelt-bridge";
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdatePhase =
  | "idle"
  | "checking"
  | "downloading"
  | "verifying"
  | "installing"
  | "restarting"
  | "error";

export interface ReleaseInfo {
  version: string;
  tag: string;
  url: string;
  publishedAt: string | null;
  assetName: string;
  assetUrl: string | null;
  assetSize: number | null;
  checksumsUrl: string | null;
  notes: string | null;
}

export interface UpdateState {
  currentVersion: string;
  latest: ReleaseInfo | null;
  updateAvailable: boolean;
  canSelfUpdate: boolean;
  reason: string | null;
  phase: UpdatePhase;
  progress: number | null; // 0..1 while downloading
  error: string | null;
  checkedAt: string | null;
  installedVersion: string | null; // set after a successful install (pre-restart)
}

export interface UpdaterOptions {
  log: Logger;
  repo?: string;
  version?: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  execPath?: string;
  os?: string;
  arch?: string;
  restart?: (() => Promise<void>) | null;
  onChange?: (state: UpdateState) => void;
}

/** semver-ish compare: returns <0, 0, >0. Pre-releases sort before releases. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = String(v || "").trim().replace(/^v/i, "").match(
      /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/,
    );
    if (!m) return { nums: [0, 0, 0], pre: null as string | null };
    return {
      nums: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)],
      pre: m[4] ?? null,
    };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export function assetNameFor(
  os: string = Deno.build.os,
  arch: string = Deno.build.arch,
): string {
  const osName = os === "darwin" ? "macos" : os;
  const archName = arch === "x86_64" ? "x64" : arch === "aarch64" ? "arm64" : arch;
  return `toolbelt-bridge-${osName}-${archName}${os === "windows" ? ".exe" : ""}`;
}

/** `<sha256>  <filename>` lines (sha256sum format). */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of String(text || "").split("\n")) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m) out.set(m[2].trim(), m[1].toLowerCase());
  }
  return out;
}

export function isCompiledBinary(execPath: string = Deno.execPath()): boolean {
  const base = execPath.split(/[\\/]/).pop()?.toLowerCase() || "";
  return base !== "deno" && base !== "deno.exe";
}

async function sha256Hex(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Updater {
  state: UpdateState;
  #log: Logger;
  #repo: string;
  #fetch: typeof fetch;
  #apiBase: string;
  #execPath: string;
  #os: string;
  #arch: string;
  #restart: (() => Promise<void>) | null;
  #onChange?: (state: UpdateState) => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #busy = false;

  constructor(options: UpdaterOptions) {
    this.#log = options.log;
    this.#repo = Deno.env.get("TOOLBELT_BRIDGE_UPDATE_REPO") || options.repo ||
      DEFAULT_UPDATE_REPO;
    this.#fetch = options.fetchImpl || fetch;
    this.#apiBase = (options.apiBase || "https://api.github.com").replace(/\/+$/, "");
    this.#execPath = options.execPath || Deno.execPath();
    this.#os = options.os || Deno.build.os;
    this.#arch = options.arch || Deno.build.arch;
    this.#restart = options.restart ?? null;
    this.#onChange = options.onChange;
    this.state = {
      currentVersion: options.version || VERSION,
      latest: null,
      updateAvailable: false,
      canSelfUpdate: false,
      reason: null,
      phase: "idle",
      progress: null,
      error: null,
      checkedAt: null,
      installedVersion: null,
    };
  }

  #set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.#onChange?.(this.state);
  }

  get execPath(): string {
    return this.#execPath;
  }

  /** Whether this process can replace its own binary. */
  async selfUpdateCapability(): Promise<{ ok: boolean; reason: string | null }> {
    if (!isCompiledBinary(this.#execPath)) {
      return {
        ok: false,
        reason: "Running from source; update with git pull / deno task instead",
      };
    }
    const probe = `${this.#execPath}.write-test-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await Deno.writeTextFile(probe, "");
      await Deno.remove(probe);
      return { ok: true, reason: null };
    } catch {
      return {
        ok: false,
        reason:
          `The bridge cannot write to ${this.#execPath}; download the new build manually`,
      };
    }
  }

  async check(): Promise<UpdateState> {
    if (this.#busy) return this.state;
    this.#busy = true;
    this.#set({ phase: "checking", error: null });
    try {
      const response = await this.#fetch(
        `${this.#apiBase}/repos/${this.#repo}/releases/latest`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": `toolbelt-bridge/${this.state.currentVersion}`,
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
      const json = await response.json() as {
        tag_name?: string;
        html_url?: string;
        published_at?: string;
        body?: string;
        assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>;
      };
      const tag = String(json.tag_name || "");
      const assetName = assetNameFor(this.#os, this.#arch);
      const asset = (json.assets || []).find((a) => a.name === assetName);
      const sums = (json.assets || []).find((a) =>
        /^sha256sums?\.txt$/i.test(a.name || "")
      );
      const latest: ReleaseInfo = {
        version: tag.replace(/^v/i, ""),
        tag,
        url: json.html_url || `https://github.com/${this.#repo}/releases`,
        publishedAt: json.published_at || null,
        assetName,
        assetUrl: asset?.browser_download_url || null,
        assetSize: asset?.size ?? null,
        checksumsUrl: sums?.browser_download_url || null,
        notes: json.body ? String(json.body).slice(0, 4000) : null,
      };
      const capability = await this.selfUpdateCapability();
      const updateAvailable =
        compareVersions(latest.version, this.state.currentVersion) > 0;
      this.#set({
        latest,
        updateAvailable,
        canSelfUpdate: capability.ok && Boolean(latest.assetUrl),
        reason: capability.ok
          ? (latest.assetUrl ? null : `No build for ${assetName} in ${tag}`)
          : capability.reason,
        phase: "idle",
        checkedAt: new Date().toISOString(),
      });
      if (updateAvailable) {
        this.#log.info(
          "update",
          `${tag} is available (running ${this.state.currentVersion})`,
        );
      }
    } catch (error) {
      this.#set({
        phase: "error",
        error: `Update check failed: ${(error as Error).message}`,
        checkedAt: new Date().toISOString(),
      });
    } finally {
      this.#busy = false;
    }
    return this.state;
  }

  /**
   * Download, verify, and install the latest release over this binary, then
   * call the restart callback (if any). Resolves with the state; on success
   * `installedVersion` is set before the restart callback runs.
   */
  async apply({ restart = true }: { restart?: boolean } = {}): Promise<UpdateState> {
    if (this.#busy) throw new Error("An update is already in progress");
    if (!this.state.latest) await this.check();
    const latest = this.state.latest;
    if (!latest?.assetUrl) {
      throw new Error(this.state.reason || "No release asset for this platform");
    }
    if (!this.state.updateAvailable) {
      throw new Error(`Already on the latest version (${this.state.currentVersion})`);
    }
    const capability = await this.selfUpdateCapability();
    if (!capability.ok) {
      throw new Error(capability.reason || "Self-update is not possible here");
    }

    this.#busy = true;
    const tmp = `${this.#execPath}.update-${latest.version}.tmp`;
    try {
      this.#set({ phase: "downloading", progress: 0, error: null });
      this.#log.info("update", `downloading ${latest.assetName} ${latest.tag}`);
      await this.#download(latest.assetUrl, tmp, latest.assetSize);

      this.#set({ phase: "verifying", progress: null });
      await this.#verify(latest, tmp);

      this.#set({ phase: "installing" });
      await this.#install(tmp);
      this.#set({ installedVersion: latest.version, updateAvailable: false });
      this.#log.info("update", `installed ${latest.tag} at ${this.#execPath}`);

      if (restart && this.#restart) {
        this.#set({ phase: "restarting" });
        await this.#restart();
      } else {
        this.#set({ phase: "idle" });
      }
    } catch (error) {
      await Deno.remove(tmp).catch(() => {});
      this.#set({ phase: "error", error: `Update failed: ${(error as Error).message}` });
      throw error;
    } finally {
      this.#busy = false;
    }
    return this.state;
  }

  async #download(url: string, dest: string, expectedSize: number | null): Promise<void> {
    const response = await this.#fetch(url, {
      headers: { "user-agent": `toolbelt-bridge/${this.state.currentVersion}` },
      redirect: "follow",
    });
    if (!response.ok || !response.body) {
      throw new Error(`download failed (${response.status})`);
    }
    const total = Number(response.headers.get("content-length")) || expectedSize || 0;
    let received = 0;
    const file = await Deno.open(dest, { write: true, create: true, truncate: true });
    try {
      const reader = response.body.getReader();
      const writer = file.writable.getWriter();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.length;
        await writer.write(value);
        if (total > 0) this.#set({ progress: Math.min(1, received / total) });
      }
      await writer.close();
    } catch (error) {
      try {
        file.close();
      } catch {
        /* already closed by writer */
      }
      throw error;
    }
  }

  async #verify(latest: ReleaseInfo, path: string): Promise<void> {
    if (!latest.checksumsUrl) {
      throw new Error("release has no sha256sums.txt to verify against");
    }
    const response = await this.#fetch(latest.checksumsUrl, { redirect: "follow" });
    if (!response.ok) throw new Error(`could not fetch checksums (${response.status})`);
    const expected = parseChecksums(await response.text()).get(latest.assetName);
    if (!expected) throw new Error(`${latest.assetName} is not listed in sha256sums.txt`);
    const actual = await sha256Hex(path);
    if (actual !== expected) {
      throw new Error("checksum mismatch; the download was discarded");
    }
  }

  async #install(tmp: string): Promise<void> {
    if (this.#os !== "windows") {
      await Deno.chmod(tmp, 0o755);
      await Deno.rename(tmp, this.#execPath); // atomic on the same filesystem
      return;
    }
    // Windows: a running exe cannot be overwritten but can be renamed aside.
    const old = `${this.#execPath}.old`;
    await Deno.remove(old).catch(() => {});
    await Deno.rename(this.#execPath, old);
    try {
      await Deno.rename(tmp, this.#execPath);
    } catch (error) {
      await Deno.rename(old, this.#execPath).catch(() => {});
      throw error;
    }
  }

  /** Remove a leftover `.old` binary from a previous Windows update. */
  static async cleanupOldBinary(execPath: string = Deno.execPath()): Promise<void> {
    await Deno.remove(`${execPath}.old`).catch(() => {});
  }

  /** Periodic checks; `auto()` decides whether a found update is applied. */
  start({ initialDelayMs = 10_000, intervalMs = CHECK_INTERVAL_MS, enabled, auto }: {
    initialDelayMs?: number;
    intervalMs?: number;
    enabled: () => boolean;
    auto: () => boolean;
  }): void {
    const tick = async () => {
      this.#timer = null;
      if (enabled()) {
        await this.check();
        if (auto() && this.state.updateAvailable && this.state.canSelfUpdate) {
          this.#log.info("update", "automatic update enabled; installing");
          await this.apply({ restart: true }).catch((error) =>
            this.#log.error("update", (error as Error).message)
          );
        }
      }
      this.#timer = setTimeout(tick, intervalMs);
    };
    this.#timer = setTimeout(tick, initialDelayMs);
  }

  stop(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}

/** Re-exec this binary with the same arguments; the caller exits afterwards. */
export function spawnReplacement(
  execPath: string = Deno.execPath(),
  args: string[] = Deno.args,
): void {
  const child = new Deno.Command(execPath, {
    args,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...Deno.env.toObject(), TOOLBELT_BRIDGE_RESTARTED: "1" },
  }).spawn();
  child.unref();
}
