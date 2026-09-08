/* Toolbelt Bridge local UI — dependency-free. State arrives over SSE. */
import {
  buildInstallOptions,
  formatCommand,
  missingRequiredInputs,
  resolveInstallOption,
  summarizeServer,
} from "/registry-plan.js";

(() => {
  const TOKEN = globalThis.BRIDGE_TOKEN;
  const app = document.getElementById("app");
  const toastEl = document.getElementById("toast");
  let state = null;
  const logs = [];
  const ui = { logSource: "", showLogs: true, expanded: new Set() };
  const reg = { open: false, query: "", results: [], nextCursor: null, loading: false, error: null, selected: null, options: [], optionId: null, values: {}, serverKey: "", orgs: [] };

  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const toast = (msg, bad = false) => {
    toastEl.textContent = msg;
    toastEl.style.background = bad ? "var(--bad)" : "var(--text)";
    toastEl.classList.add("show");
    setTimeout(() => toastEl.classList.remove("show"), 3000);
  };
  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { "content-type": "application/json", "x-bridge-token": TOKEN },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = {};
    try {
      json = await res.json();
    } catch { /* ignore */ }
    if (!res.ok) {
      throw new Error(json.error || `${method} ${path} failed (${res.status})`);
    }
    return json;
  }
  const act = (fn) => async (ev) => {
    const btn = ev?.currentTarget;
    if (btn) btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  // ---------- SSE
  function connect() {
    const es = new EventSource("/events");
    es.addEventListener("state", (e) => {
      state = JSON.parse(e.data);
      render();
    });
    es.addEventListener("log", (e) => {
      logs.push(JSON.parse(e.data));
      if (logs.length > 2000) logs.splice(0, logs.length - 2000);
      renderLogs();
    });
    es.onerror = () => {
      document.getElementById("conn-summary").textContent =
        "bridge not reachable — is it running?";
    };
  }

  // ---------- rendering
  const stateDot = (
    s,
  ) => ({
    connected: "ok",
    connecting: "warn",
    reconnecting: "warn",
    error: "bad",
    revoked: "bad",
    idle: "",
  }[s] || "");
  const statusDot = (s) => ({ running: "ok", stopped: "", error: "bad" }[s] || "");

  function orgChips(selected, name) {
    if (!state.orgs.length) {
      return `<span class="muted small">pair with an organization first</span>`;
    }
    return `<div class="chips">${
      state.orgs.map((o) =>
        `<label class="chip"><input type="checkbox" data-org="${esc(o.orgId)}" name="${
          esc(name)
        }" ${selected.includes(o.orgId) ? "checked" : ""}/> ${esc(o.orgName)}</label>`
      ).join("")
    }</div>`;
  }

  function render() {
    if (!state) return;
    document.getElementById("meta").textContent =
      `${state.name} · v${state.version} · ${state.platform}`;
    const online = state.orgs.filter((o) => o.state === "connected").length;
    document.getElementById("conn-summary").textContent = state.orgs.length
      ? `${online}/${state.orgs.length} organizations connected`
      : "not paired";
    const missingPrereq = (state.prereqs || []).find((p) => p.id === "node" && !p.found);
    app.innerHTML = `
      ${
      missingPrereq
        ? `<div class="banner bad">Node.js was not found. MCP servers launched with <code>npx</code> need it — <a href="https://nodejs.org" target="_blank">install Node.js</a>, then restart the bridge.</div>`
        : ""
    }
      ${renderOrgs()}
      ${renderServers()}
      ${renderModels()}
      ${renderPrereqs()}
      ${renderSettings()}
      ${renderLogsSection()}
    `;
    bind();
    renderLogs();
  }

  function renderOrgs() {
    const rows = state.orgs.map((o) => `
      <tr>
        <td><span class="dot ${stateDot(o.state)}"></span>${esc(o.orgName)}${
      o.isPersonal ? ' <span class="muted small">(personal)</span>' : ""
    }<div class="small muted">${esc(o.serverUrl)} · bridge “${
      esc(o.bridgeName || o.bridgeId)
    }”</div></td>
        <td>${esc(o.state)}${
      o.lastError ? `<div class="small muted">${esc(o.lastError)}</div>` : ""
    }</td>
        <td class="small muted">${o.serversExposed} servers · ${o.modelsExposed} models</td>
        <td class="row">
          <button data-act="reconnect" data-org="${esc(o.orgId)}">Reconnect</button>
          <button class="danger" data-act="unpair" data-org="${
      esc(o.orgId)
    }">Forget</button>
        </td>
      </tr>`).join("");
    return `<section>
      <h2>Organizations <span class="count">${state.orgs.length}</span></h2>
      ${
      state.orgs.length
        ? `<table><thead><tr><th>Organization</th><th>Connection</th><th>Exposed</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : `<div class="empty">Not paired yet. In Toolbelt open <b>Bridges → Pair a bridge</b>, then paste the pair URL or code here.</div>`
    }
      <form class="grid" id="pair-form">
        <label>Pair URL or code<input name="input" placeholder="https://toolbelt.example.com/bridge/pair?code=ABC123" required /></label>
        <label>Toolbelt URL (only for a bare code)<input name="serverUrl" placeholder="https://toolbelt.example.com" /></label>
        <button class="primary" type="submit">Pair</button>
      </form>
    </section>`;
  }

  function renderServers() {
    const rows = state.servers.map((s) => `
      <tr>
        <td><span class="dot ${statusDot(s.status)}"></span><b>${
      esc(s.key)
    }</b><div class="small mono muted">${esc(s.config.command)} ${
      esc(s.config.args.join(" "))
    }</div>${
      s.lastError
        ? `<div class="small" style="color:var(--bad)">${esc(s.lastError)}</div>`
        : ""
    }</td>
        <td>${esc(s.status)}${
      s.pid ? `<div class="small muted">pid ${s.pid}</div>` : ""
    }</td>
        <td>${s.tools.length} tools ${
      s.tools.length
        ? `<details><summary>show</summary><div class="small mono">${
          s.tools.map((t) => esc(t.name)).join(", ")
        }</div></details>`
        : ""
    }</td>
        <td>${orgChips(s.config.orgs, `server-orgs:${s.key}`)}</td>
        <td class="row">
          ${
      s.status === "running"
        ? `<button data-act="stop" data-key="${
          esc(s.key)
        }">Stop</button><button data-act="restart" data-key="${
          esc(s.key)
        }">Restart</button>`
        : `<button data-act="start" data-key="${esc(s.key)}">Start</button>`
    }
          <button data-act="logs" data-key="${esc(s.key)}">Logs</button>
          <button class="danger" data-act="remove" data-key="${
      esc(s.key)
    }">Remove</button>
        </td>
      </tr>`).join("");
    return `<section>
      <h2>MCP servers <span class="count">${state.servers.length}</span></h2>
      ${
      state.servers.length
        ? `<table><thead><tr><th>Server</th><th>Status</th><th>Tools</th><th>Exposed to</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : `<div class="empty">No servers yet. Add one below — for example <code>npx @modelcontextprotocol/server-filesystem ~/Documents</code>.</div>`
    }
      <details ${state.servers.length ? "" : "open"}><summary>Add a server</summary>
      <form class="grid" id="server-form">
        <label>Key (id)<input name="key" placeholder="filesystem" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" required /></label>
        <label>Command<input name="command" placeholder="npx" required /></label>
        <label>Arguments (one per line or space-separated)<textarea name="args" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/home/me"></textarea></label>
        <label>Environment (KEY=VALUE per line)<textarea name="env"></textarea></label>
        <label>Working directory<input name="cwd" placeholder="(optional)" /></label>
        <label>Description<input name="description" placeholder="(optional)" /></label>
        <label>Icon (emoji or image URL)<input name="icon" placeholder="🗂️" /></label>
        <label>Expose to ${orgChips([], "new-server-orgs")}</label>
        <label><span>Auto-start</span><select name="autoStart"><option value="true">yes</option><option value="false">no</option></select></label>
        <button class="primary" type="submit">Add server</button>
      </form></details>
      ${renderRegistry()}
    </section>`;
  }

  const TYPE_LABELS = { npm: "npm", pypi: "PyPI", oci: "Docker", nuget: "NuGet", mcpb: "MCPB" };

  function renderRegistry() {
    if (!reg.open) {
      return `<div style="margin-top:10px"><button data-act="reg-open">Browse the MCP registry…</button> <span class="small muted">Find servers on the official registry and add them here.</span></div>`;
    }
    if (reg.selected) return renderRegistryDetail();
    const rows = reg.results.map((e, i) => `
      <tr>
        <td><b>${esc(e.title)}</b> <span class="small muted">${esc(e.name)}</span><div class="small muted">${esc(e.description)}</div></td>
        <td class="small">${e.registryTypes.map((t) => `<span class="chip">${esc(TYPE_LABELS[t] || t)}</span>`).join(" ")}${e.hasRemote ? ' <span class="chip">remote</span>' : ""}</td>
        <td><button data-act="reg-select" data-index="${i}" ${e.hasPackage ? "" : "disabled title=\"No runnable package; connect it as a Remote MCP from Toolbelt\""}>Choose</button></td>
      </tr>`).join("");
    return `<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">
      <div class="row"><b>MCP registry</b><span class="spacer" style="flex:1"></span><button data-act="reg-close">Close</button></div>
      <form class="grid" id="reg-search" style="grid-template-columns:1fr auto"><label>Search<input name="q" value="${esc(reg.query)}" placeholder="github, postgres, filesystem…" /></label><button class="primary" type="submit" ${reg.loading ? "disabled" : ""}>Search</button></form>
      ${reg.error ? `<div class="small" style="color:var(--bad)">${esc(reg.error)}</div>` : ""}
      ${rows ? `<table><thead><tr><th>Server</th><th>Packages</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">${reg.loading ? "Searching…" : "No results yet."}</div>`}
      ${reg.nextCursor ? `<button data-act="reg-more" ${reg.loading ? "disabled" : ""}>Load more</button>` : ""}
      <p class="small muted">Listings come from the official MCP Registry. Review a server's repository before running it; packages run on this machine.</p>
    </div>`;
  }

  function regOption() {
    return reg.options.find((o) => o.id === reg.optionId) || null;
  }

  function regPreview(option) {
    try {
      return formatCommand(resolveInstallOption(option, reg.values));
    } catch {
      const filler = Object.fromEntries(missingRequiredInputs(option, reg.values).map((i) => [i.key, `<${i.label}>`]));
      try { return formatCommand(resolveInstallOption(option, { ...filler, ...reg.values })); } catch { return ""; }
    }
  }

  function renderRegistryDetail() {
    const e = reg.selected;
    const option = regOption();
    const inputs = option ? option.inputs.map((inp) => {
      const v = reg.values[inp.key] ?? "";
      const label = `${esc(inp.label)}${inp.isRequired ? " *" : ""}`;
      if (inp.choices && inp.choices.length) return `<label>${label}<select data-reg-input="${esc(inp.key)}">${inp.choices.map((c) => `<option ${((v || inp.default) === c) ? "selected" : ""}>${esc(c)}</option>`).join("")}</select><span class="muted">${esc(inp.description)}</span></label>`;
      if (inp.format === "boolean") return `<label><span>${label}</span><select data-reg-input="${esc(inp.key)}"><option value="false" ${/^(true|1|yes)$/i.test(v || inp.default || "") ? "" : "selected"}>no</option><option value="true" ${/^(true|1|yes)$/i.test(v || inp.default || "") ? "selected" : ""}>yes</option></select></label>`;
      return `<label>${label}<input data-reg-input="${esc(inp.key)}" type="${inp.isSecret ? "password" : "text"}" value="${esc(v)}" placeholder="${esc(inp.placeholder || inp.default || "")}" /><span class="muted">${esc(inp.description)}</span></label>`;
    }).join("") : "";
    const missing = option ? missingRequiredInputs(option, reg.values) : [];
    return `<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">
      <div class="row"><button data-act="reg-back">← Back</button><b>${esc(e.title)}</b> <span class="small muted">${esc(e.name)}</span>${e.repository ? ` <a class="small" href="${esc(e.repository)}" target="_blank" rel="noopener">repository</a>` : ""}</div>
      <div class="small muted" style="margin:6px 0">${esc(e.description)}</div>
      ${reg.options.map((o) => `<label class="row" style="margin:4px 0;${o.supported ? "" : "opacity:.6"}"><input type="radio" name="reg-option" value="${esc(o.id)}" ${o.id === reg.optionId ? "checked" : ""} ${o.supported ? "" : "disabled"} /> <span>${esc(o.label)} <span class="small muted">${esc(o.supported ? `needs ${o.prerequisite}` : o.unsupportedReason)}</span></span></label>`).join("")}
      ${option ? `<form class="grid" id="reg-install">
        ${inputs}
        <label>Server key<input name="serverKey" value="${esc(reg.serverKey)}" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" required /></label>
        <label>Expose to ${orgChips(reg.orgs, "reg-orgs")}</label>
        <label class="full" style="grid-column:1/-1"><span>Command</span><code class="mono" style="display:block;padding:6px;background:var(--bg);border-radius:6px">${esc(regPreview(option))}</code></label>
        <button class="primary" type="submit" ${missing.length ? "disabled" : ""}>Add server</button>
        ${missing.length ? `<span class="small muted">Required: ${esc(missing.map((m) => m.label).join(", "))}</span>` : ""}
      </form>` : ""}
    </div>`;
  }

  async function regSearch(more = false) {
    reg.loading = true; reg.error = null; render();
    try {
      const params = new URLSearchParams({ limit: "30" });
      if (reg.query.trim()) params.set("search", reg.query.trim());
      if (more && reg.nextCursor) params.set("cursor", reg.nextCursor);
      const data = await api("GET", `/api/registry/servers?${params}`);
      const entries = (data.servers || []).map((s) => ({ ...summarizeServer(s), raw: s }));
      reg.results = more ? [...reg.results, ...entries] : entries;
      reg.nextCursor = data.nextCursor || null;
    } catch (e) { reg.error = e.message; } finally { reg.loading = false; render(); }
  }

  async function regSelect(entry) {
    reg.selected = entry; reg.options = []; reg.optionId = null; reg.values = {}; reg.orgs = []; render();
    try {
      const detail = await api("GET", `/api/registry/servers/${encodeURIComponent(entry.name)}`);
      reg.options = buildInstallOptions(detail).filter((o) => o.kind === "package");
      const first = reg.options.find((o) => o.supported);
      reg.optionId = first ? first.id : null;
      reg.serverKey = first ? regDefaultKey(first) : "";
    } catch (e) { reg.error = e.message; }
    render();
  }

  function regDefaultKey(option) {
    try { return resolveInstallOption(option, Object.fromEntries(option.inputs.map((i) => [i.key, "x"]))).serverKey; } catch { return "server"; }
  }
    const runtimes = state.llm.runtimes;
    const exposure = state.llm.models || {};
    const blocks = runtimes.map((r) => {
      const models = r.models.map((m) => {
        const key = `${r.id}/${m}`;
        const orgs = exposure[key]?.orgs || [];
        return `<tr><td class="mono">${esc(m)}</td><td>${
          orgChips(orgs, `model-orgs:${key}`)
        }</td></tr>`;
      }).join("");
      const stale = Object.keys(exposure).filter((k) =>
        k.startsWith(`${r.id}/`) && !r.models.includes(k.slice(r.id.length + 1))
      );
      return `<div style="margin-bottom:12px">
        <div class="row"><span class="dot ${
        r.enabled ? (r.reachable ? "ok" : "bad") : ""
      }"></span><b>${esc(r.name)}</b> <span class="small muted mono">${
        esc(r.baseURL)
      }</span>
          <span class="small muted">${
        r.enabled
          ? (r.reachable
            ? `${r.models.length} models`
            : `unreachable${r.error ? ` (${esc(r.error)})` : ""}`)
          : "disabled"
      }</span>
          <span class="spacer" style="flex:1"></span>
          <button data-act="runtime-toggle" data-runtime="${
        esc(r.id)
      }" data-enabled="${r.enabled}">${r.enabled ? "Disable" : "Enable"}</button>
          ${
        r.builtin
          ? ""
          : `<button class="danger" data-act="runtime-remove" data-runtime="${
            esc(r.id)
          }">Remove</button>`
      }
        </div>
        ${
        models
          ? `<table><thead><tr><th>Model</th><th>Exposed to</th></tr></thead><tbody>${models}</tbody></table>`
          : ""
      }
        ${
        stale.length
          ? `<div class="small muted">Previously exposed but no longer listed by the runtime: ${
            stale.map((k) => esc(k.slice(r.id.length + 1))).join(", ")
          }</div>`
          : ""
      }
      </div>`;
    }).join("");
    return `<section>
      <h2>Local models <button data-act="llm-refresh" style="margin-left:auto">Refresh</button></h2>
      <p class="small muted">Models exposed to an organization appear in its model picker under “Organization Models”; requests are tunnelled through this bridge, so nothing on your machine needs to be reachable from the internet.</p>
      ${blocks || `<div class="empty">No runtimes configured.</div>`}
      <details><summary>Add an OpenAI-compatible runtime</summary>
      <form class="grid" id="runtime-form">
        <label>Id<input name="id" placeholder="my-server" required /></label>
        <label>Name<input name="name" placeholder="My server" /></label>
        <label>Base URL<input name="baseURL" placeholder="http://127.0.0.1:8080/v1" required /></label>
        <label>API key (optional)<input name="apiKey" type="password" /></label>
        <button class="primary" type="submit">Add runtime</button>
      </form></details>
    </section>`;
  }

  function renderPrereqs() {
    const rows = (state.prereqs || []).map((p) =>
      `<tr><td><span class="dot ${p.found ? "ok" : ""}"></span>${
        esc(p.label)
      }</td><td class="mono small">${
        p.found
          ? esc(p.version || p.path || "found")
          : `<span class="muted">not found</span>`
      }</td><td class="small muted">${esc(p.hint)}</td></tr>`
    ).join("");
    return `<section><h2>Prerequisites <button data-act="prereqs" style="margin-left:auto">Re-check</button></h2>
      ${
      rows
        ? `<table><tbody>${rows}</tbody></table>`
        : `<div class="empty">Checking…</div>`
    }</section>`;
  }

  function renderSettings() {
    return `<section><h2>Settings</h2>
      <form class="grid" id="settings-form">
        <label>Bridge name<input name="name" value="${esc(state.name)}" /></label>
        <label>Local UI port (applies on restart)<input name="port" type="number" value="${state.ui.port}" /></label>
        <label><span>Open browser on start</span><select name="open"><option value="true" ${
      state.ui.open ? "selected" : ""
    }>yes</option><option value="false" ${
      state.ui.open ? "" : "selected"
    }>no</option></select></label>
        <label><span>Allow Toolbelt to add servers to this bridge</span><select name="allowRemoteServerCreate"><option value="true" ${
      state.allowRemoteServerCreate ? "selected" : ""
    }>yes</option><option value="false" ${
      state.allowRemoteServerCreate ? "" : "selected"
    }>no</option></select></label>
        <button class="primary" type="submit">Save</button>
      </form>
      <p class="small muted">Config: <code>${
      esc(state.configPath)
    }</code> · install id <code>${esc(state.installId)}</code></p>
    </section>`;
  }

  function renderLogsSection() {
    const sources = [...new Set(logs.map((l) => l.source))].sort();
    return `<section><h2>Logs
      <select id="log-source" style="width:auto;margin-left:auto"><option value="">all</option>${
      sources.map((s) =>
        `<option value="${esc(s)}" ${ui.logSource === s ? "selected" : ""}>${
          esc(s)
        }</option>`
      ).join("")
    }</select></h2>
      <pre class="logs" id="log-body"></pre></section>`;
  }

  function renderLogs() {
    const body = document.getElementById("log-body");
    if (!body) return;
    const list = logs.filter((l) => !ui.logSource || l.source === ui.logSource).slice(
      -400,
    );
    body.textContent = list.map((l) =>
      `${l.ts.slice(11, 19)} ${l.level.padEnd(5)} ${l.source}: ${l.message}`
    ).join("\n");
    body.scrollTop = body.scrollHeight;
  }

  // ---------- events
  function bind() {
    app.querySelectorAll("button[data-act]").forEach((btn) => {
      const { act: action, key, org, runtime } = btn.dataset;
      btn.addEventListener(
        "click",
        act(async () => {
          if (action === "start" || action === "stop" || action === "restart") {
            await api("POST", `/api/servers/${encodeURIComponent(key)}/${action}`);
          } else if (action === "remove") {
            if (confirm(`Remove server "${key}"?`)) {
              await api("DELETE", `/api/servers/${encodeURIComponent(key)}`);
            }
          } else if (action === "logs") {
            ui.logSource = key;
            render();
          } else if (action === "reconnect") {
            await api("POST", `/api/orgs/${encodeURIComponent(org)}/reconnect`);
          } else if (action === "unpair") {
            if (
              confirm(
                "Forget this organization on this bridge? Remove the bridge from Toolbelt's Bridges page too.",
              )
            ) {
              await api("DELETE", `/api/orgs/${encodeURIComponent(org)}`);
            }
          } else if (action === "llm-refresh") await api("POST", "/api/llm/refresh");
          else if (action === "prereqs") {
            const r = await api("GET", "/api/prereqs");
            state.prereqs = r.prereqs;
            render();
          } else if (action === "runtime-toggle") {
            await api("PUT", `/api/llm/runtimes/${encodeURIComponent(runtime)}`, {
              ...state.llm.runtimes.find((r) => r.id === runtime),
              enabled: btn.dataset.enabled !== "true",
            });
          } else if (action === "runtime-remove") {
            await api("DELETE", `/api/llm/runtimes/${encodeURIComponent(runtime)}`);
          }
        }),
      );
    });
    app.querySelectorAll("input[type=checkbox][data-org]").forEach((box) => {
      box.addEventListener(
        "change",
        act(async () => {
          const name = box.name;
          const selected = [
            ...app.querySelectorAll(`input[name="${CSS.escape(name)}"]:checked`),
          ].map((b) => b.dataset.org);
          if (name.startsWith("server-orgs:")) {
            await api("PUT", `/api/servers/${encodeURIComponent(name.slice(12))}/orgs`, {
              orgs: selected,
            });
          } else if (name.startsWith("model-orgs:")) {
            const key = name.slice(11);
            const slash = key.indexOf("/");
            await api("PUT", "/api/llm/models", {
              runtimeId: key.slice(0, slash),
              modelId: key.slice(slash + 1),
              orgs: selected,
            });
          }
        }),
      );
    });
    const form = (id, fn) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("submit", (e) => {
          e.preventDefault();
          act(() => fn(new FormData(el), el))();
        });
      }
    };
    form("pair-form", async (fd) => {
      await api("POST", "/api/pair", {
        input: fd.get("input"),
        serverUrl: fd.get("serverUrl") || null,
      });
      toast("Paired");
    });
    form("server-form", async (fd, el) => {
      const key = String(fd.get("key")).trim();
      const argsText = String(fd.get("args") || "").trim();
      const args = argsText
        ? (argsText.includes("\n") ? argsText.split("\n") : argsText.split(/\s+/)).map((
          a,
        ) => a.trim()).filter(Boolean)
        : [];
      const env = {};
      for (const line of String(fd.get("env") || "").split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      const orgs = [...el.querySelectorAll(`input[name="new-server-orgs"]:checked`)].map((
        b,
      ) => b.dataset.org);
      await api("PUT", `/api/servers/${encodeURIComponent(key)}`, {
        command: fd.get("command"),
        args,
        env,
        cwd: fd.get("cwd") || null,
        description: fd.get("description") || null,
        icon: fd.get("icon") || null,
        autoStart: fd.get("autoStart") === "true",
        orgs,
      });
      toast(`Added ${key}`);
    });
    form("runtime-form", async (fd) => {
      await api("PUT", `/api/llm/runtimes/${encodeURIComponent(String(fd.get("id")))}`, {
        name: fd.get("name"),
        baseURL: fd.get("baseURL"),
        apiKey: fd.get("apiKey") || null,
        enabled: true,
      });
      toast("Runtime added");
    });
    form("settings-form", async (fd) => {
      await api("PUT", "/api/settings", {
        name: fd.get("name"),
        port: Number(fd.get("port")),
        open: fd.get("open") === "true",
        allowRemoteServerCreate: fd.get("allowRemoteServerCreate") === "true",
      });
      toast("Saved");
    });
    app.querySelectorAll("button[data-act^='reg-']").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        const a = btn.dataset.act;
        if (a === "reg-open") { reg.open = true; render(); if (!reg.results.length) regSearch(); }
        else if (a === "reg-close") { reg.open = false; reg.selected = null; render(); }
        else if (a === "reg-back") { reg.selected = null; render(); }
        else if (a === "reg-more") regSearch(true);
        else if (a === "reg-select") regSelect(reg.results[Number(btn.dataset.index)]);
      });
    });
    form("reg-search", async (fd) => { reg.query = String(fd.get("q") || ""); await regSearch(); });
    app.querySelectorAll("input[name='reg-option']").forEach((r) => r.addEventListener("change", () => {
      reg.optionId = r.value; reg.values = {}; const o = regOption(); reg.serverKey = o ? regDefaultKey(o) : ""; render();
    }));
    app.querySelectorAll("[data-reg-input]").forEach((el) => el.addEventListener("input", () => { reg.values[el.dataset.regInput] = el.value; const code = app.querySelector("#reg-install code"); const o = regOption(); if (code && o) code.textContent = regPreview(o); }));
    app.querySelectorAll("[data-reg-input]").forEach((el) => el.addEventListener("change", () => { reg.values[el.dataset.regInput] = el.value; }));
    app.querySelectorAll("input[name='reg-orgs']").forEach((box) => box.addEventListener("change", () => { reg.orgs = [...app.querySelectorAll("input[name='reg-orgs']:checked")].map((b) => b.dataset.org); }));
    form("reg-install", async (fd) => {
      const option = regOption(); if (!option) return;
      const resolved = resolveInstallOption(option, reg.values);
      const key = String(fd.get("serverKey") || resolved.serverKey).trim();
      await api("PUT", `/api/servers/${encodeURIComponent(key)}`, { command: resolved.command, args: resolved.args, env: resolved.env, description: resolved.description || null, icon: reg.selected.icon || null, autoStart: true, orgs: reg.orgs });
      toast(`Added ${key}`); reg.selected = null; reg.open = false; render();
    });
    const src = document.getElementById("log-source");
    if (src) {
      src.addEventListener("change", () => {
        ui.logSource = src.value;
        renderLogs();
      });
    }
  }

  connect();
})();
