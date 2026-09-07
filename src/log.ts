/**
 * Logging: an in-memory ring buffer (for the local UI) plus buffered per-source
 * files under <configDir>/logs. Child process output is appended via
 * `child(source, line)` and flushed on a timer instead of per chunk.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogEntry {
  ts: string;
  level: LogLevel;
  source: string;
  message: string;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  #entries: LogEntry[] = [];
  #max: number;
  #listeners = new Set<(entry: LogEntry) => void>();
  #fileBuffers = new Map<string, string[]>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #logsDir: string | null;
  level: LogLevel;

  constructor(
    { logsDir = null, level = "info", max = 2000 }: {
      logsDir?: string | null;
      level?: LogLevel;
      max?: number;
    } = {},
  ) {
    this.#logsDir = logsDir;
    this.level = level;
    this.#max = max;
  }

  entries(source?: string, tail = 200): LogEntry[] {
    const list = source
      ? this.#entries.filter((e) => e.source === source)
      : this.#entries;
    return list.slice(-tail);
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  log(level: LogLevel, source: string, message: string): void {
    const entry: LogEntry = { ts: new Date().toISOString(), level, source, message };
    this.#entries.push(entry);
    if (this.#entries.length > this.#max) {
      this.#entries.splice(0, this.#entries.length - this.#max);
    }
    for (const listener of this.#listeners) listener(entry);
    if (LEVELS[level] >= LEVELS[this.level]) {
      const line = `${entry.ts} [${level.toUpperCase()}] ${source}: ${message}`;
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    }
    this.#queueFile(
      "bridge",
      `${entry.ts} [${level.toUpperCase()}] ${source}: ${message}`,
    );
  }

  debug(source: string, message: string): void {
    this.log("debug", source, message);
  }
  info(source: string, message: string): void {
    this.log("info", source, message);
  }
  warn(source: string, message: string): void {
    this.log("warn", source, message);
  }
  error(source: string, message: string): void {
    this.log("error", source, message);
  }

  /** Output from a managed child process (one line at a time). */
  child(source: string, stream: "stdout" | "stderr", line: string): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level: stream === "stderr" ? "warn" : "debug",
      source,
      message: line,
    };
    this.#entries.push(entry);
    if (this.#entries.length > this.#max) {
      this.#entries.splice(0, this.#entries.length - this.#max);
    }
    for (const listener of this.#listeners) listener(entry);
    if (this.level === "debug") console.log(`[${source}:${stream}] ${line}`);
    this.#queueFile(source, `${entry.ts} ${line}`);
  }

  #queueFile(name: string, line: string): void {
    if (!this.#logsDir) return;
    const safe = name.replace(/[^a-z0-9._-]+/gi, "_");
    const buffer = this.#fileBuffers.get(safe) || [];
    buffer.push(line);
    this.#fileBuffers.set(safe, buffer);
    if (this.#flushTimer === null) {
      this.#flushTimer = setTimeout(() => {
        this.#flushTimer = null;
        this.flush().catch(() => {});
      }, 500);
    }
  }

  async flush(): Promise<void> {
    if (!this.#logsDir) return;
    const pending = [...this.#fileBuffers.entries()];
    this.#fileBuffers.clear();
    try {
      await Deno.mkdir(this.#logsDir, { recursive: true });
    } catch {
      /* exists */
    }
    for (const [name, lines] of pending) {
      const path = `${this.#logsDir}/${name}.log`;
      try {
        await Deno.writeTextFile(path, lines.join("\n") + "\n", { append: true });
      } catch {
        /* ignore file errors */
      }
    }
  }
}
