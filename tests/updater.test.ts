import { assert, assertEquals, assertRejects } from "@std/assert";
import { Logger } from "../src/log.ts";
import {
  assetNameFor,
  compareVersions,
  isCompiledBinary,
  parseChecksums,
  Updater,
} from "../src/updater.ts";

Deno.test("compareVersions handles v-prefix, missing parts, and prereleases", () => {
  assert(compareVersions("v0.2.1", "0.2.0") > 0);
  assert(compareVersions("0.2.1", "0.10.0") < 0);
  assertEquals(compareVersions("1.0", "1.0.0"), 0);
  assert(compareVersions("1.0.0-beta", "1.0.0") < 0);
  assert(compareVersions("1.0.0", "1.0.0-beta") > 0);
});

Deno.test("asset names and checksum parsing", () => {
  assertEquals(assetNameFor("linux", "x86_64"), "toolbelt-bridge-linux-x64");
  assertEquals(assetNameFor("darwin", "aarch64"), "toolbelt-bridge-macos-arm64");
  assertEquals(assetNameFor("windows", "x86_64"), "toolbelt-bridge-windows-x64.exe");
  const sums = parseChecksums(
    "abc\n" + "a".repeat(64) + "  toolbelt-bridge-linux-x64\n" + "b".repeat(64) +
      " *other.exe\n",
  );
  assertEquals(sums.get("toolbelt-bridge-linux-x64"), "a".repeat(64));
  assertEquals(sums.get("other.exe"), "b".repeat(64));
  assertEquals(isCompiledBinary("/usr/bin/deno"), false);
  assertEquals(isCompiledBinary("/opt/toolbelt-bridge-linux-x64"), true);
});

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("updater checks, downloads, verifies, installs and restarts", async () => {
  const dir = await Deno.makeTempDir();
  const execPath = `${dir}/toolbelt-bridge-linux-x64`;
  await Deno.writeTextFile(execPath, "old binary");
  const newBinary = new TextEncoder().encode("new binary v9");
  const goodSum = await sha256(newBinary);
  let serveBadChecksum = false;

  const server: Deno.HttpServer<Deno.NetAddr> = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (req): Response => {
      const p = new URL(req.url).pathname;
      if (p === "/repos/apexti/toolbelt-bridge/releases/latest") {
        const base: string = `http://127.0.0.1:${server.addr.port}`;
        return Response.json({
          tag_name: "v9.0.0",
          html_url: "https://github.com/apexti/toolbelt-bridge/releases/tag/v9.0.0",
          published_at: "2026-09-08T00:00:00Z",
          body: "notes",
          assets: [
            {
              name: "toolbelt-bridge-linux-x64",
              browser_download_url: `${base}/dl/bin`,
              size: newBinary.length,
            },
            { name: "sha256sums.txt", browser_download_url: `${base}/dl/sums` },
          ],
        });
      }
      if (p === "/dl/bin") {
        return new Response(newBinary, {
          headers: { "content-length": String(newBinary.length) },
        });
      }
      if (p === "/dl/sums") {
        return new Response(
          `${serveBadChecksum ? "f".repeat(64) : goodSum}  toolbelt-bridge-linux-x64\n`,
        );
      }
      return new Response("nope", { status: 404 });
    },
  );

  let restarted = 0;
  const phases: string[] = [];
  const updater = new Updater({
    log: new Logger({ level: "error" }),
    version: "0.2.1",
    apiBase: `http://127.0.0.1:${server.addr.port}`,
    execPath,
    os: "linux",
    arch: "x86_64",
    restart: () => {
      restarted++;
      return Promise.resolve();
    },
    onChange: (s) => phases.push(s.phase),
  });

  const state = await updater.check();
  assertEquals(state.latest?.version, "9.0.0");
  assertEquals(state.updateAvailable, true);
  assertEquals(state.canSelfUpdate, true);

  serveBadChecksum = true;
  await assertRejects(() => updater.apply(), Error, "checksum mismatch");
  assertEquals(
    await Deno.readTextFile(execPath),
    "old binary",
    "binary untouched after a bad checksum",
  );
  assertEquals(updater.state.phase, "error");

  serveBadChecksum = false;
  const done = await updater.apply();
  assertEquals(done.installedVersion, "9.0.0");
  assertEquals(done.phase, "restarting");
  assertEquals(restarted, 1);
  assertEquals(await Deno.readTextFile(execPath), "new binary v9");
  assertEquals((await Deno.stat(execPath)).mode! & 0o111, 0o111, "executable bit set");
  assert(
    phases.includes("downloading") && phases.includes("verifying") &&
      phases.includes("installing"),
  );
  await assertRejects(() => updater.apply(), Error, "Already on the latest");

  await server.shutdown();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("updater refuses to self-update when running from source", async () => {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () =>
      Response.json({
        tag_name: "v9.0.0",
        assets: [{
          name: "toolbelt-bridge-linux-x64",
          browser_download_url: "http://x/bin",
        }],
      }),
  );
  const updater = new Updater({
    log: new Logger({ level: "error" }),
    version: "0.2.1",
    apiBase: `http://127.0.0.1:${server.addr.port}`,
    execPath: "/usr/local/bin/deno",
    os: "linux",
    arch: "x86_64",
  });
  const state = await updater.check();
  assertEquals(state.updateAvailable, true);
  assertEquals(state.canSelfUpdate, false);
  assert(state.reason?.includes("source"));
  await assertRejects(() => updater.apply(), Error, "source");
  await server.shutdown();
});
