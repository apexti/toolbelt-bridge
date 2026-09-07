/**
 * deno task compile [target]
 * Builds dist/toolbelt-bridge-<os>-<arch>[.exe] for one or all targets.
 */
const TARGETS: Record<string, string> = {
  "x86_64-unknown-linux-gnu": "toolbelt-bridge-linux-x64",
  "aarch64-unknown-linux-gnu": "toolbelt-bridge-linux-arm64",
  "x86_64-apple-darwin": "toolbelt-bridge-macos-x64",
  "aarch64-apple-darwin": "toolbelt-bridge-macos-arm64",
  "x86_64-pc-windows-msvc": "toolbelt-bridge-windows-x64.exe",
};
const RELEASE_TARGETS = [
  "x86_64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
];

const requested = Deno.args[0] ? [Deno.args[0]] : RELEASE_TARGETS;
await Deno.mkdir("dist", { recursive: true });
for (const target of requested) {
  const output = TARGETS[target];
  if (!output) {
    console.error(`unknown target ${target}; known: ${Object.keys(TARGETS).join(", ")}`);
    Deno.exit(2);
  }
  console.log(`compiling ${target} → dist/${output}`);
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "compile",
      "--allow-net",
      "--allow-run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-sys",
      "--include",
      "src/ui",
      "--target",
      target,
      "--output",
      `dist/${output}`,
      "src/main.ts",
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) Deno.exit(result.code);
}
