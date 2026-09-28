// Saved worlds/accounts. Native passwords are resolved by /login, never fetched.
const LAUNCHER_SELECTION_KEY = "anima.launcher.selection.v1";
let launcherData = { servers: [], accounts: [], passwords: false, persistent: false };
let launcherServerId = "", launcherAccountId = "";
let launcherReady = false, launcherWorking = false, launcherConnecting = false;
let launcherInitPromise = null, launcherAuthKey = "";
let launcherSelection = { server: "", accounts: {} };
let launcherRecoverable = false, launcherWorldsPreview = null, launcherFileGeneration = 0, launcherDownloadUrl = null;
let launcherCancelSavePrompt = null;
const LAUNCHER_BACKUP_LIMIT = 1024 * 1024;
const launcherEl = id => document.getElementById(id);
const launcherText = (id, text) => { const el = launcherEl(id); if (el) el.textContent = text; };
const launcherUid = () => typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "p-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
const launcherServer = () => launcherData.servers.find(s => s.id === launcherServerId);
const launcherAccount = () => launcherData.accounts.find(a => a.id === launcherAccountId && a.server_id === launcherServerId);
const launcherValue = id => (launcherEl(id)?.value || "").trim();
function launcherBusy() { return launcherWorking || launcherConnecting; }
function launcherLoginBlocked() { return !launcherReady || launcherBusy(); }
function launcherDate(time) { return time ? new Date(time).toLocaleString() : "Not yet"; }
function launcherRememberSelection() {
  launcherSelection.server = launcherServerId;
  launcherSelection.accounts[launcherServerId] = launcherAccountId;
  try { localStorage.setItem(LAUNCHER_SELECTION_KEY, JSON.stringify(launcherSelection)); } catch (_) {}
}
function launcherUnavailable(error) {
  if (error.recoverable) { launcherRecoverable = true; launcherReady = false; launcherEl("lg-backup-tools").open = true; }
  return error;
}
async function launcherRawRequest(body) {
  const res = await fetch("launcher", {
    method: body ? "POST" : "GET", headers: { "X-Anima-Launcher": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || "Profile storage is unavailable. Reopen Anima and try again.");
    error.recoverable = data.recoverable === true;
    throw launcherUnavailable(error);
  }
  return data;
}
async function launcherRequest(body) {
  const data = await launcherRawRequest(body);
  if (!Array.isArray(data.servers) || !Array.isArray(data.accounts)) throw new Error("Invalid profile response.");
  return data;
}
async function launcherCommand(body) {
  launcherData = await launcherRequest(body);
}
function launcherSetBusy(value) {
  launcherWorking = value;
  for (const el of document.querySelectorAll("#lg-account-fields input, #lg-account-fields select, #lg-account-fields textarea, #lg-account-fields button, #lg-library button")) el.disabled = value || launcherConnecting || !launcherReady;
  launcherPasswordHint();
  const refresh = launcherEl("lg-refresh-server");
  if (refresh) refresh.disabled = value || launcherConnecting || !launcherServer() || !launcherReady;
  if (!value) {
    launcherEl("lg-remove-server").disabled = !launcherServer() || launcherConnecting || !launcherReady;
    launcherEl("lg-remove-account").disabled = !launcherAccount() || launcherConnecting || !launcherReady;
  }
  const retry = launcherEl("lg-retry-profiles");
  if (retry) { retry.hidden = launcherReady; retry.disabled = value; }
  launcherBackupState();
  if (typeof updateLoginProfileAvailability === "function") updateLoginProfileAvailability();
}
function launcherPasswordHint() {
  const checkbox = launcherEl("lg-save-password"), input = launcherEl("lg-pass");
  if (!checkbox || !input) return;
  checkbox.disabled = !launcherData.passwords || launcherBusy() || !launcherReady;
  if (!launcherData.passwords) checkbox.checked = false;
  const account = launcherAccount(), server = launcherServer();
  const matching = account && server && account.username === launcherValue("lg-user") && launcherMatchesServer(server);
  input.placeholder = matching && account.remember_password ? "Saved securely · type to replace" : "Enter password";
  launcherText("lg-password-note", !launcherData.passwords
    ? "Password saving is available in the desktop app."
    : matching && account.remember_password
      ? "A password is saved in the system vault. Uncheck and save to remove it."
      : "Optional. Stored in macOS Keychain or Windows Credential Manager.");
}
function launcherMatchesServer(server) {
  return server.host === launcherValue("lg-host").replace(/^\[|\]$/g, "").toLowerCase() && server.port === Number(launcherValue("lg-port")) && server.shard === Number(launcherValue("lg-shard"));
}
function launcherRenderLibrary() {
  const list = launcherEl("lg-server-list"); if (!list) return;
  list.replaceChildren();
  for (const server of launcherData.servers) {
    const button = document.createElement("button"); button.type = "button"; button.className = "launcher-server";
    button.setAttribute("aria-pressed", String(server.id === launcherServerId)); button.disabled = launcherBusy();
    const name = document.createElement("strong"); name.textContent = server.name;
    const note = document.createElement("small");
    const count = launcherData.accounts.filter(a => a.server_id === server.id).length;
    note.textContent = `${count} account${count === 1 ? "" : "s"} · ${server.cache ? server.cache.reachable ? "last check reachable" : "last check failed" : "not checked"}`;
    button.append(name, note); button.addEventListener("click", () => { if (!launcherBusy()) launcherSelectServer(server.id); }); list.append(button);
  }
  if (!launcherData.servers.length) { const empty = document.createElement("p"); empty.className = "launcher-muted"; empty.textContent = "Your saved servers will appear here."; list.append(empty); }
}
function launcherRenderAccounts() {
  const select = launcherEl("lg-account-list"); select.replaceChildren();
  const option = document.createElement("option"); option.value = ""; option.textContent = "Enter another account"; select.append(option);
  for (const account of launcherData.accounts.filter(a => a.server_id === launcherServerId)) {
    const row = document.createElement("option"); row.value = account.id;
    row.textContent = account.label === account.username ? account.username : `${account.label} · ${account.username}`;
    select.append(row);
  }
  select.value = launcherAccountId;
}
function launcherSelectServer(id) {
  const server = launcherData.servers.find(s => s.id === id);
  launcherServerId = server?.id || "";
  launcherEl("lg-server-settings").open = !server;
  launcherEl("lg-server-name").value = server?.name || "";
  launcherEl("lg-host").value = server?.host || "127.0.0.1";
  launcherEl("lg-port").value = String(server?.port || 2594);
  launcherEl("lg-shard").value = String(server?.shard || 0);
  launcherEl("lg-server-notes").value = server?.notes || "";
  launcherSelectAccount(launcherSelection.accounts[launcherServerId] || "");
  launcherRenderLibrary(); launcherRenderInfo(); launcherRememberSelection(); launcherText("lg-profile-msg", "");
}
function launcherSelectAccount(id) {
  const account = launcherData.accounts.find(a => a.id === id && a.server_id === launcherServerId);
  launcherAccountId = account?.id || "";
  launcherEl("lg-account-settings").open = false;
  launcherEl("lg-user").value = account?.username || "";
  launcherEl("lg-account-label").value = account?.label || "";
  launcherEl("lg-pass").value = "";
  launcherEl("lg-save-password").checked = !!account?.remember_password;
  launcherRenderAccounts(); launcherRenderInfo(); launcherPasswordHint(); launcherRememberSelection();
  launcherEl("lg-remove-account").disabled = !account;
  launcherEl("lg-remove-server").disabled = !launcherServer();
}
function launcherRenderInfo() {
  const server = launcherServer(), cache = server?.cache, account = launcherAccount();
  launcherText("lg-info-name", server?.name || "A world awaits");
  launcherText("lg-info-address", server ? `${server.host}:${server.port}${server.shard ? " · shard " + server.shard : ""}` : "Save a server to keep its details here.");
  launcherText("lg-info-status", cache ? cache.reachable ? "Reachable at last check" : "Unreachable at last check" : "Not checked");
  const status = launcherEl("lg-info-status"); if (status) status.dataset.state = cache ? cache.reachable ? "reachable" : "unreachable" : "unknown";
  const stats = launcherEl("lg-info-stats"); stats.replaceChildren();
  const pairs = cache ? [["TCP response", cache.latency_ms == null ? "—" : `${cache.latency_ms} ms`], ["Reported clients", cache.clients == null ? "Not reported" : String(cache.clients)], ["Server uptime", cache.uptime_hours == null ? "Not reported" : `${cache.uptime_hours} hours`]] : [];
  if (cache?.reported_name) pairs.unshift(["Server name", cache.reported_name]);
  for (const [label, value] of pairs) { const row = document.createElement("div"), dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = label; dd.textContent = value; row.append(dt, dd); stats.append(row); }
  launcherText("lg-info-time", cache ? `Checked ${launcherDate(cache.checked_at)}. ${cache.details_at ? "Reported details: " + launcherDate(cache.details_at) + "." : "This server did not provide public status details."}` : "A manual check uses no account or password. Results are cached, not live.");
  launcherText("lg-info-notes", server?.notes || "");
  const chars = launcherEl("lg-cached-characters"); chars.replaceChildren();
  for (const slot of account?.characters || []) { const row = document.createElement("div"); row.textContent = `${slot.name} · slot ${slot.index + 1}`; chars.append(row); }
  launcherText("lg-character-time", account?.last_used ? `Cached at last authentication: ${launcherDate(account.last_used)}. Log in to refresh.` : "Log in with this account to cache its character list.");
  launcherEl("lg-refresh-server").disabled = !server || launcherBusy() || !launcherReady;
}
function launcherServerForm() {
  const host = launcherValue("lg-host").replace(/^\[|\]$/g, "").toLowerCase(), port = Number(launcherValue("lg-port")), shard = Number(launcherValue("lg-shard"));
  if (!host || host.length > 253 || !/^[a-z0-9.:-]+$/i.test(host)) throw new Error("Enter a hostname or IP address without a URL or port.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be between 1 and 65535.");
  if (!Number.isInteger(shard) || shard < 0 || shard > 65535) throw new Error("Shard index must be between 0 and 65535.");
  const server = { op: "save_server", id: launcherServerId || launcherUid(), name: launcherValue("lg-server-name") || host, host, port, shard, notes: launcherEl("lg-server-notes").value || "" };
  return server;
}
async function launcherSaveServer() {
  const form = launcherServerForm(), previous = launcherServer();
  if (previous && !launcherMatchesServer(previous) && launcherData.accounts.some(a => a.server_id === previous.id && a.remember_password)) {
    if (!confirm("Changing this server address or shard removes its saved passwords and cached characters. Continue?")) throw new Error("Server changes were not saved.");
  }
  await launcherCommand(form); launcherServerId = form.id;
  launcherEl("lg-server-settings").open = false;
  launcherEl("lg-server-name").value = form.name; launcherEl("lg-host").value = form.host;
  if (previous && !launcherMatchesServer(previous)) { launcherEl("lg-save-password").checked = false; launcherAccountId = ""; }
  launcherRenderLibrary(); launcherRenderAccounts(); launcherRenderInfo(); launcherRememberSelection();
}
function launcherAccountCredentials() {
  const username = launcherValue("lg-user"), password = launcherEl("lg-pass").value || "";
  if (!username || username.length > 30 || /[^\x20-\x7e]/.test(username)) throw new Error("Enter a UO username using up to 30 ASCII characters.");
  if (password.length > 30 || /[^\x20-\x7e]/.test(password)) throw new Error("UO passwords support up to 30 ASCII characters.");
  return { username, password };
}
async function launcherSaveAccount() {
  const { username, password } = launcherAccountCredentials();
  await launcherSaveServer();
  // Reusing an existing username updates it instead of creating duplicate profiles.
  const same = launcherData.accounts.find(a => a.server_id === launcherServerId && a.username === username);
  const id = same?.id || launcherAccountId || launcherUid();
  const form = { op: "save_account", id, server_id: launcherServerId, label: launcherValue("lg-account-label") || username, username, password, remember_password: !!launcherEl("lg-save-password").checked };
  await launcherCommand(form); launcherAccountId = id;
  launcherEl("lg-account-label").value = form.label;
  launcherRenderLibrary(); launcherRenderAccounts(); launcherRenderInfo(); launcherPasswordHint(); launcherRememberSelection();
}
async function launcherAction(action, message) {
  if (launcherBusy() || !launcherReady) return;
  launcherSetBusy(true); launcherText("lg-profile-msg", "Saving…");
  try { await action(); launcherText("lg-profile-msg", message); }
  catch (e) { launcherText("lg-profile-msg", e.message); }
  finally { launcherSetBusy(false); }
}
async function launcherPrepareLogin() {
  if (launcherInitPromise) await launcherInitPromise;
  if (!launcherReady) throw new Error("Profiles are not available. Reopen Anima before connecting.");
  launcherSetBusy(true);
  try {
    const form = launcherServerForm(), credentials = launcherAccountCredentials();
    const server = launcherServer(), account = launcherAccount();
    const matching = server && account && launcherMatchesServer(server) && account.username === credentials.username;
    const remember = !!launcherEl("lg-save-password").checked;
    const changed = !matching || server.name !== form.name || server.notes !== form.notes
      || account.label !== (launcherValue("lg-account-label") || credentials.username) || account.remember_password !== remember
      || (remember && !!credentials.password);
    let save = false;
    if (changed) {
      const choice = await launcherConfirmSave();
      if (choice === null) return null;
      save = choice;
    }
    if (save) await launcherSaveAccount();
    return { account_id: save || matching ? launcherAccountId : null,
      host: form.host, port: form.port, shard: form.shard, ...credentials };
  } finally { launcherSetBusy(false); }
}
function launcherConfirmSave() {
  const panel = launcherEl("lg-save-prompt"), password = launcherEl("lg-confirm-password");
  password.disabled = !launcherData.passwords;
  const account = launcherAccount(), server = launcherServer();
  const sameAccount = !account || (server && launcherMatchesServer(server) && account.username === launcherValue("lg-user"));
  password.checked = !password.disabled && sameAccount && launcherEl("lg-save-password").checked;
  launcherText("lg-confirm-password-note", password.disabled ? "Password saving is available in the desktop app."
    : "Saved passwords use macOS Keychain or Windows Credential Manager.");
  return new Promise(resolve => {
    const saved = () => { launcherEl("lg-save-password").checked = password.checked; finish(true); };
    const once = () => finish(false);
    const cancel = e => { if (e) e.preventDefault(); finish(null); };
    const finish = choice => {
      launcherCancelSavePrompt = null;
      launcherEl("lg-connect-saved").removeEventListener("click", saved);
      launcherEl("lg-connect-once").removeEventListener("click", once);
      launcherEl("lg-connect-cancel").removeEventListener("click", cancel);
      panel.removeEventListener("cancel", cancel);
      panel.close(); resolve(choice);
    };
    launcherCancelSavePrompt = cancel;
    launcherEl("lg-connect-saved").addEventListener("click", saved);
    launcherEl("lg-connect-once").addEventListener("click", once);
    launcherEl("lg-connect-cancel").addEventListener("click", cancel);
    panel.addEventListener("cancel", cancel);
    panel.showModal();
  });
}
function launcherOnAuth(auth, slots) {
  if (!launcherEl("lg-shell")) return;
  if (auth !== "login" && auth !== "error" && launcherCancelSavePrompt) launcherCancelSavePrompt();
  launcherConnecting = auth === "connecting";
  launcherEl("lg-shell").classList.toggle("character-stage", auth === "characters");
  launcherSetBusy(launcherWorking);
  if (auth !== "characters") { if (auth === "login" || auth === "error") launcherAuthKey = ""; return; }
  launcherEl("lg-pass").value = "";
  const key = JSON.stringify([launcherAccountId, slots || []]);
  if (!launcherReady || key === launcherAuthKey) return;
  launcherAuthKey = key;
  launcherRequest().then(data => { launcherData = data; launcherRenderInfo(); }).catch(e => launcherText("lg-profile-msg", e.message));
}
function initLauncher() {
  if (launcherInitPromise || !launcherEl("lg-server-list")) return;
  launcherEl("lg-new-server").addEventListener("click", () => { if (!launcherBusy()) launcherSelectServer(""); });
  launcherEl("lg-new-account").addEventListener("click", () => { if (!launcherBusy()) { launcherSelectAccount(""); launcherText("lg-profile-msg", ""); } });
  launcherEl("lg-account-list").addEventListener("change", e => launcherSelectAccount(e.target.value));
  for (const id of ["lg-user", "lg-host", "lg-port", "lg-shard"]) launcherEl(id).addEventListener("input", launcherPasswordHint);
  launcherEl("lg-save-server").addEventListener("click", () => launcherAction(launcherSaveServer, "Server saved."));
  launcherEl("lg-save-account").addEventListener("click", () => launcherAction(launcherSaveAccount, "Account saved."));
  launcherEl("lg-remove-account").addEventListener("click", () => launcherAction(async () => {
    const account = launcherAccount(); if (!account || !confirm(`Remove ${account.label} from this device, including its saved password? Your game account is not deleted.`)) return;
    await launcherCommand({ op: "delete_account", id: account.id }); launcherSelectAccount(""); launcherRenderLibrary();
  }, "Account library updated."));
  launcherEl("lg-remove-server").addEventListener("click", () => launcherAction(async () => {
    const server = launcherServer(); if (!server || !confirm(`Remove ${server.name} and its saved accounts and passwords from this device? Game accounts are not deleted.`)) return;
    await launcherCommand({ op: "delete_server", id: server.id }); launcherSelectServer(launcherData.servers[0]?.id || "");
  }, "Server library updated."));
  launcherEl("lg-refresh-server").addEventListener("click", () => launcherAction(async () => {
    launcherText("lg-profile-msg", "Checking server without logging in…");
    await launcherCommand({ op: "refresh", id: launcherServerId }); launcherRenderLibrary(); launcherRenderInfo();
  }, "Server check cached."));
  launcherEl("lg-retry-profiles")?.addEventListener("click", launcherLoadProfiles);
  launcherWireBackups();
  launcherLoadProfiles();
}
function launcherLoadProfiles() {
  launcherReady = false; launcherRecoverable = false;
  launcherSetBusy(true);
  launcherInitPromise = (async () => {
    try {
      try { const selected = JSON.parse(localStorage.getItem(LAUNCHER_SELECTION_KEY) || "null"); if (selected && typeof selected.accounts === "object" && selected.accounts) launcherSelection = selected; } catch (_) {}
      launcherData = await launcherRequest();
      launcherReady = true;
      launcherSelectServer(launcherData.servers.some(s => s.id === launcherSelection.server) ? launcherSelection.server : launcherData.servers[0]?.id || "");
      launcherText("lg-storage-note", launcherData.persistent ? "Saved on this device, shared by your Anima windows." : "Profiles last for this session only.");
    } catch (e) {
      launcherRecoverable = e.recoverable === true;
      launcherText("lg-profile-msg", e.message); launcherText("lg-storage-note", "Profiles could not be loaded. Existing files have not been changed.");
      if (launcherRecoverable) launcherEl("lg-backup-tools").open = true;
    }
    finally { launcherSetBusy(false); }
  })();
}

function launcherValidateBackup(value) {
  const fields = (v, allowed) => {
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !allowed.includes(k))) throw new Error("Invalid worlds backup. Password fields and unsupported fields are not accepted.");
  };
  const text = (v, max, empty = false) => {
    if (typeof v !== "string" || (!empty && !v.trim()) || new TextEncoder().encode(v).length > max) throw new Error("A backup field is empty or too long.");
    return v;
  };
  fields(value, ["format", "version", "servers"]);
  if (value.format !== "anima-worlds" || value.version !== 1 || !Array.isArray(value.servers) || value.servers.length > 100) throw new Error("Choose a supported Anima worlds backup with up to 100 servers.");
  let accounts = 0;
  for (const s of value.servers) {
    fields(s, ["name", "host", "port", "shard", "notes", "relay", "accounts"]);
    text(s.name, 80); text(s.host, 253); text(s.notes, 2000, true);
    if (!/^[a-z0-9.:-]+$/i.test(s.host) || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535 || !Number.isInteger(s.shard) || s.shard < 0 || s.shard > 65535) throw new Error("A backup server has an invalid host, port or shard.");
    if (s.relay != null) {
      text(s.relay, 2048); const relay = new URL(s.relay);
      if (!["ws:", "wss:"].includes(relay.protocol) || relay.username || relay.password) throw new Error("A relay must use ws:// or wss:// without credentials.");
    }
    if (!Array.isArray(s.accounts)) throw new Error("A backup server has an invalid account list.");
    accounts += s.accounts.length;
    for (const a of s.accounts) {
      fields(a, ["label", "username"]); text(a.label, 80); text(a.username, 30);
      if (/[^\x20-\x7e]/.test(a.username)) throw new Error("UO usernames must use printable ASCII.");
    }
  }
  if (accounts > 500) throw new Error("A backup can contain up to 500 accounts.");
  if (new TextEncoder().encode(JSON.stringify(value)).length > LAUNCHER_BACKUP_LIMIT) throw new Error("Choose a worlds backup smaller than 1 MB.");
  return value;
}
function launcherBackupState() {
  const busy = launcherBusy();
  const recover = launcherEl("lg-recover-worlds");
  if (!recover) return;
  recover.hidden = !launcherRecoverable; recover.disabled = busy;
  launcherEl("lg-worlds-file").disabled = busy || !launcherReady;
  launcherEl("lg-import-worlds").disabled = busy || !launcherReady || !launcherWorldsPreview;
  launcherEl("lg-cancel-worlds").disabled = busy;
  launcherEl("lg-settings-data").disabled = busy;
}
function launcherWorldsMessage(message) { launcherText("lg-worlds-message", message); }
function launcherDownloadResult(success, source) {
  if (source !== launcherDownloadUrl) return;
  launcherWorldsMessage(success ? "Worlds backup saved in your Downloads folder." : "The backup could not be saved. Check your Downloads folder and use the Save link to retry.");
}
async function launcherExportWorlds() {
  if (!launcherReady || launcherBusy()) return;
  launcherSetBusy(true);
  try {
    const backup = await launcherRawRequest({ op: "export" });
    launcherValidateBackup(backup);
    if (launcherDownloadUrl) URL.revokeObjectURL(launcherDownloadUrl);
    launcherDownloadUrl = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2) + "\n"], { type: "application/json" }));
    const link = launcherEl("lg-worlds-download");
    link.href = launcherDownloadUrl; link.download = "anima-worlds.json"; link.hidden = false; link.textContent = "Save anima-worlds.json";
    launcherWorldsMessage("Backup prepared. It contains server details and usernames; keep the file private. Passwords are excluded.");
    link.click();
  } catch (error) { launcherWorldsMessage(error.message || "The backup could not be prepared."); }
  finally { launcherSetBusy(false); }
}
function launcherPreviewWorlds(text, name) {
  launcherWorldsPreview = null; launcherEl("lg-worlds-preview").hidden = true;
  try {
    if (new TextEncoder().encode(text).length > LAUNCHER_BACKUP_LIMIT) throw new Error("Choose a worlds backup smaller than 1 MB.");
    const backup = launcherValidateBackup(JSON.parse(text));
    launcherWorldsPreview = backup;
    const count = backup.servers.reduce((n, s) => n + s.accounts.length, 0);
    launcherText("lg-worlds-summary", `${name} · ${backup.servers.length} servers · ${count} accounts`);
    const list = launcherEl("lg-worlds-list"); list.replaceChildren();
    for (const server of backup.servers) {
      const row = document.createElement("li"); row.textContent = `${server.name} · ${server.host}:${server.port} · ${server.accounts.length} accounts`; list.append(row);
    }
    launcherEl("lg-worlds-preview").hidden = false;
    launcherWorldsMessage("Review the servers before adding them. Importing does not connect to any server.");
  } catch (error) { launcherWorldsMessage(error instanceof SyntaxError ? "This file is not valid JSON. Your profiles have not changed." : error.message); }
  launcherEl("lg-cancel-worlds").hidden = !launcherWorldsPreview;
  launcherBackupState();
}
async function launcherImportWorlds() {
  if (!launcherReady || launcherBusy() || !launcherWorldsPreview) return;
  launcherSetBusy(true);
  try {
    const backup = launcherWorldsPreview;
    launcherData = await launcherRequest({ op: "import", backup });
    launcherWorldsPreview = null; launcherEl("lg-worlds-preview").hidden = true;
    launcherEl("lg-cancel-worlds").hidden = true;
    if (launcherServer()) {
      launcherRenderLibrary(); launcherRenderAccounts(); launcherRenderInfo(); launcherPasswordHint();
    } else launcherSelectServer(launcherData.servers[0]?.id || "");
    const added = launcherData.imported;
    launcherWorldsMessage(`Added ${added.servers} servers and ${added.accounts} accounts. Existing profiles and passwords were kept.`);
  } catch (error) { launcherWorldsMessage(error.message || "Could not import this backup. Your profiles have not changed."); }
  finally { launcherSetBusy(false); }
}
async function launcherRecoverWorlds() {
  if (!launcherRecoverable || launcherBusy()) return;
  if (!confirm("Keep an exact copy of the unreadable profiles and start an empty library? You can then add profiles or import a worlds backup. Existing passwords stay in the OS vault.")) return;
  launcherSetBusy(true);
  try {
    const copy = (await launcherRequest({ op: "recover" })).recovery_copy;
    launcherLoadProfiles(); await launcherInitPromise;
    launcherWorldsMessage(`Original profiles kept at ${copy}. Add your servers or import a worlds backup.`);
  } catch (error) { launcherWorldsMessage(error.message || "Recovery failed. Your original profiles have not changed."); }
  finally { launcherSetBusy(false); }
}
function launcherWireBackups() {
  launcherEl("lg-export-worlds").addEventListener("click", launcherExportWorlds);
  launcherEl("lg-import-worlds").addEventListener("click", launcherImportWorlds);
  launcherEl("lg-recover-worlds").addEventListener("click", launcherRecoverWorlds);
  launcherEl("lg-cancel-worlds").addEventListener("click", () => {
    launcherFileGeneration++; launcherWorldsPreview = null; launcherEl("lg-worlds-preview").hidden = true; launcherEl("lg-cancel-worlds").hidden = true; launcherWorldsMessage("Import cancelled. Profiles have not changed."); launcherBackupState();
  });
  launcherEl("lg-worlds-file").addEventListener("change", async event => {
    const generation = ++launcherFileGeneration, file = event.target.files?.[0];
    launcherWorldsPreview = null; launcherEl("lg-worlds-preview").hidden = true; launcherBackupState();
    launcherEl("lg-cancel-worlds").hidden = true;
    if (!file || launcherBusy() || !launcherReady) return;
    launcherEl("lg-cancel-worlds").hidden = false; launcherWorldsMessage("Reading " + file.name + "…");
    try {
      if (file.size > LAUNCHER_BACKUP_LIMIT) throw new Error("Choose a worlds backup smaller than 1 MB.");
      const text = await file.text();
      if (generation === launcherFileGeneration) launcherPreviewWorlds(text, file.name);
    } catch (error) { if (generation === launcherFileGeneration) launcherWorldsMessage(error.message || "The selected file could not be read."); }
    finally { if (generation === launcherFileGeneration) { event.target.value = ""; launcherEl("lg-cancel-worlds").hidden = !launcherWorldsPreview; } }
  });
}
