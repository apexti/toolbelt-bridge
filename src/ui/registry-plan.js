/**
 * Turns an official MCP Registry entry (server.json, schema 2025-12-11) into
 * concrete install options:
 *   - "remote"  → a URL (+ headers) to connect as a Remote MCP
 *   - "package" → a stdio launch (command, args, env) to run on a bridge
 * and collects the user inputs each option needs (arguments, environment
 * variables, headers, URL variables), with isSecret/isRequired/choices
 * preserved so a form can be built from them.
 *
 * Plain ESM with no imports: the same file is used by the Toolbelt frontend
 * and by the bridge's local UI (bridge/src/ui/registry-plan.js). Keep in sync.
 */

export const REGISTRY_OFFICIAL_META = "io.modelcontextprotocol.registry/official";

const PLACEHOLDER_RE = /\{([^{}]+)\}/g;

function placeholders(text) {
  const out = [];
  if (typeof text !== "string") return out;
  for (const match of text.matchAll(PLACEHOLDER_RE)) out.push(match[1]);
  return out;
}

function inputMeta(source, key, label, target) {
  return {
    key,
    label,
    target,
    description: source?.description || "",
    isRequired: source?.isRequired === true,
    isSecret: source?.isSecret === true,
    default: source?.default ?? "",
    choices: Array.isArray(source?.choices) ? source.choices : null,
    format: source?.format || "string",
    placeholder: source?.placeholder || "",
  };
}

/** Compact, display-oriented view of a registry list/detail entry. */
export function summarizeServer(entry) {
  const server = entry?.server || entry || {};
  const meta = entry?._meta?.[REGISTRY_OFFICIAL_META] || {};
  const packages = Array.isArray(server.packages) ? server.packages : [];
  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  const icon = Array.isArray(server.icons)
    ? server.icons.find((i) => /^https:\/\//.test(i?.src || ""))?.src || null
    : null;
  const transports = new Set();
  for (const r of remotes) if (r?.type) transports.add(r.type);
  for (const p of packages) {
    if (p?.transport?.type) transports.add(p.transport.type);
  }
  return {
    name: server.name || "",
    title: server.title || server.name?.split("/").pop() || "",
    description: server.description || "",
    version: server.version || "",
    repository: server.repository?.url || null,
    websiteUrl: server.websiteUrl || null,
    icon,
    status: meta.status || "active",
    isLatest: meta.isLatest !== false,
    publishedAt: meta.publishedAt || null,
    updatedAt: meta.updatedAt || null,
    packages,
    remotes,
    hasRemote: remotes.length > 0,
    hasPackage: packages.some((p) => p?.transport?.type === "stdio"),
    transports: [...transports],
    registryTypes: [
      ...new Set(packages.map((p) => p?.registryType).filter(Boolean)),
    ],
  };
}

function collectArgumentInputs(args, prefix, inputs) {
  const rendered = [];
  (Array.isArray(args) ? args : []).forEach((arg, index) => {
    if (!arg || typeof arg !== "object") return;
    const isNamed = arg.type === "named";
    const label = isNamed ? arg.name : arg.valueHint || `argument ${index + 1}`;
    const id = `${prefix}:${isNamed ? arg.name : arg.valueHint || index}`;
    if (typeof arg.value === "string") {
      for (const variable of placeholders(arg.value)) {
        const key = `var:${variable}`;
        if (!inputs.some((i) => i.key === key)) {
          inputs.push(
            inputMeta(arg.variables?.[variable], key, variable, "variable"),
          );
        }
      }
      rendered.push({ ...arg, id, fixed: true });
    } else {
      inputs.push(inputMeta(arg, id, label, "argument"));
      rendered.push({ ...arg, id, fixed: false });
    }
  });
  return rendered;
}

function collectKeyValueInputs(list, prefix, inputs) {
  const rendered = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item?.name) continue;
    const id = `${prefix}:${item.name}`;
    if (typeof item.value === "string") {
      for (const variable of placeholders(item.value)) {
        const key = `var:${variable}`;
        if (!inputs.some((i) => i.key === key)) {
          inputs.push(
            inputMeta(item.variables?.[variable], key, variable, "variable"),
          );
        }
      }
      rendered.push({ ...item, id, fixed: true });
    } else {
      inputs.push(
        inputMeta(
          item,
          id,
          item.name,
          prefix === "env" ? "environment" : "header",
        ),
      );
      rendered.push({ ...item, id, fixed: false });
    }
  }
  return rendered;
}

function packageCommand(pkg) {
  const identifier = String(pkg.identifier || "").trim();
  const version = String(pkg.version || "").trim();
  switch (pkg.registryType) {
    case "npm":
      return {
        command: "npx",
        target: version && version !== "latest" ? `${identifier}@${version}` : identifier,
        prereq: "Node.js (npx)",
      };
    case "pypi":
      return {
        command: "uvx",
        target: version && version !== "latest"
          ? `${identifier}==${version}`
          : identifier,
        prereq: "uv (uvx)",
      };
    case "oci":
      return {
        command: "docker",
        target: /:[^/]+$/.test(identifier) || !version
          ? identifier
          : `${identifier}:${version}`,
        prereq: "Docker",
        leading: ["run", "-i", "--rm"],
      };
    case "nuget":
      return {
        command: "dnx",
        target: version ? `${identifier}@${version}` : identifier,
        prereq: ".NET SDK (dnx)",
        separator: "--",
      };
    default:
      return null;
  }
}

/**
 * @param {object} entry registry list/detail entry (or bare server.json)
 * @returns {Array<object>} install options
 */
export function buildInstallOptions(entry) {
  const server = entry?.server || entry || {};
  const summary = summarizeServer(entry);
  const options = [];

  (Array.isArray(server.remotes) ? server.remotes : []).forEach(
    (remote, index) => {
      if (!remote?.url) return;
      const inputs = [];
      for (const variable of placeholders(remote.url)) {
        inputs.push(
          inputMeta(
            remote.variables?.[variable],
            `var:${variable}`,
            variable,
            "variable",
          ),
        );
      }
      const headers = collectKeyValueInputs(remote.headers, "header", inputs);
      options.push({
        id: `remote:${index}`,
        kind: "remote",
        label: `Remote (${remote.type || "streamable-http"})`,
        transport: remote.type || "streamable-http",
        url: remote.url,
        headers,
        inputs,
        supported: true,
        serverName: summary.name,
        title: summary.title,
        description: summary.description,
      });
    },
  );

  (Array.isArray(server.packages) ? server.packages : []).forEach(
    (pkg, index) => {
      if (!pkg?.identifier) return;
      const transport = pkg.transport?.type || "stdio";
      const inputs = [];
      const runtimeArgs = collectArgumentInputs(
        pkg.runtimeArguments,
        "rt",
        inputs,
      );
      const packageArgs = collectArgumentInputs(
        pkg.packageArguments,
        "arg",
        inputs,
      );
      const env = collectKeyValueInputs(
        pkg.environmentVariables,
        "env",
        inputs,
      );
      const cmd = packageCommand(pkg);
      let supported = true;
      let unsupportedReason = null;
      if (!cmd) {
        supported = false;
        unsupportedReason = `Packages of type "${
          pkg.registryType || "unknown"
        }" have to be installed by hand`;
      } else if (transport !== "stdio") {
        supported = false;
        unsupportedReason =
          `This package exposes an HTTP endpoint (${transport}); bridges run stdio servers`;
      }
      options.push({
        id: `package:${index}`,
        kind: "package",
        label: `${pkg.registryType || "package"} · ${pkg.identifier}${
          pkg.version ? ` ${pkg.version}` : ""
        }`,
        transport,
        registryType: pkg.registryType || null,
        identifier: pkg.identifier,
        version: pkg.version || null,
        runtimeHint: pkg.runtimeHint || null,
        command: cmd?.command || null,
        prerequisite: cmd?.prereq || null,
        runtimeArgs,
        packageArgs,
        env,
        inputs,
        supported,
        unsupportedReason,
        serverName: summary.name,
        title: summary.title,
        description: summary.description,
        _cmd: cmd,
      });
    },
  );

  return options;
}

function valueFor(input, values) {
  const raw = values?.[input.key];
  if (raw === undefined || raw === null || raw === "") {
    return input.default ?? "";
  }
  return String(raw);
}

function substitute(template, option, values) {
  return String(template).replace(PLACEHOLDER_RE, (_, name) => {
    const input = option.inputs.find((i) => i.key === `var:${name}`);
    return input ? valueFor(input, values) : "";
  });
}

function renderArgs(list, option, values) {
  const out = [];
  for (const arg of list) {
    let value;
    if (arg.fixed) value = substitute(arg.value, option, values);
    else {
      const input = option.inputs.find((i) => i.key === arg.id);
      value = input ? valueFor(input, values) : "";
    }
    const isBoolean = arg.format === "boolean";
    if (arg.type === "named") {
      if (isBoolean) {
        if (/^(true|1|yes)$/i.test(value)) out.push(arg.name);
      } else if (value !== "") {
        out.push(arg.name, value);
      }
    } else if (value !== "") {
      out.push(value);
    }
  }
  return out;
}

function renderKeyValues(list, option, values) {
  const out = {};
  for (const item of list) {
    const value = item.fixed
      ? substitute(item.value, option, values)
      : valueFor(option.inputs.find((i) => i.key === item.id) || {}, values);
    if (value !== "") out[item.name] = value;
  }
  return out;
}

/** Inputs that are required but still empty (after defaults). */
export function missingRequiredInputs(option, values) {
  return (option?.inputs || []).filter(
    (input) => input.isRequired && valueFor(input, values) === "",
  );
}

/**
 * Resolve an option with user-provided values into something launchable.
 * package → { command, args, env, serverKey, description }
 * remote  → { url, headers, name, description }
 */
export function resolveInstallOption(option, values = {}) {
  if (!option) throw new Error("No install option selected");
  const missing = missingRequiredInputs(option, values);
  if (missing.length > 0) {
    throw new Error(
      `Missing required: ${missing.map((m) => m.label).join(", ")}`,
    );
  }
  if (option.kind === "remote") {
    return {
      kind: "remote",
      url: substitute(option.url, option, values),
      headers: renderKeyValues(option.headers, option, values),
      transport: option.transport,
      name: option.title || option.serverName,
      description: option.description,
    };
  }
  if (!option.supported || !option._cmd) {
    throw new Error(
      option.unsupportedReason ||
        "This option cannot be installed automatically",
    );
  }
  const cmd = option._cmd;
  const args = [
    ...(cmd.leading || []),
    ...renderArgs(option.runtimeArgs, option, values),
    cmd.target,
    ...(cmd.separator ? [cmd.separator] : []),
    ...renderArgs(option.packageArgs, option, values),
  ];
  return {
    kind: "package",
    command: cmd.command,
    args,
    env: renderKeyValues(option.env, option, values),
    serverKey: suggestServerKey(option.serverName),
    description: option.description,
    name: option.title || option.serverName,
  };
}

/** `io.github.acme/weather-server` → `weather-server`. */
export function suggestServerKey(serverName) {
  const tail = String(serverName || "")
    .split("/")
    .pop() || "server";
  return (
    tail
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "server"
  );
}

/** Human-readable preview of a resolved package option. */
export function formatCommand(resolved) {
  if (!resolved || resolved.kind !== "package") return "";
  const quote = (s) => (/[\s"']/.test(s) ? JSON.stringify(s) : s);
  return [resolved.command, ...resolved.args.map(quote)].join(" ");
}
