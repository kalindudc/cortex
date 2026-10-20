// The Electron main process: thin glue around the Node-side modules in
// src/desktop/. It serves the UI over cortex://app, connects to the daemon by
// running the CLI, and answers the renderer's bridge calls after validating
// each one; agent tool checks and installs run the CLI too. Closing,
// reloading or quitting while the renderer reports unsaved drafts asks first
// (src/desktop/draftGuard.ts). Quitting leaves the daemon running; the app
// never signals a pid and never posts shutdown.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  protocol,
  session,
  shell,
  type WebContents,
} from "electron";
import { createAgents, type CortexRun } from "../../src/desktop/agents.ts";
import { startBridge } from "../../src/desktop/bridge.ts";
import { connectDaemon, type DaemonConnection, resolveCortexBin } from "../../src/desktop/daemon.ts";
import { deepLinkPath, parseDeepLink } from "../../src/desktop/deepLink.ts";
import {
  type DraftReport,
  needsGuard,
  parseDraftExport,
  parseDraftReport,
  parseGuardAnswer,
  parseSaveAllAnswer,
  RELEASE_TIMEOUT_MS,
  runGuard,
  SAVE_ALL_TIMEOUT_MS,
} from "../../src/desktop/draftGuard.ts";
import { isAppUrl, isExternalLink, type ParsedBridgeRequest, parseBridgeRequest } from "../../src/desktop/guard.ts";
import { APP_HOST, APP_ORIGIN, APP_SCHEME, type BridgeResponse, CHANNELS } from "../../src/desktop/ipc.ts";
import { socketResponse } from "../../src/desktop/socketFetch.ts";
import { resume } from "../../src/desktop/resume.ts";
import { resolveUiDir, resolveUiFile } from "../../src/desktop/uiFiles.ts";
import type { Update } from "../../src/store.ts";

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'";
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(["notifications", "clipboard-sanitized-write"]);
/** The daemon is gone and nothing was delivered, so one retry cannot apply a write twice. */
const DAEMON_GONE: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOENT"]);
const RESUME_TIMEOUT_MS = 20_000;
const AGENTS_MAX_BUFFER = 4 * 1024 * 1024;
const hidden = process.env.CORTEX_DESKTOP_HIDDEN === "1";

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const packagedResourcesPath = app.isPackaged ? process.resourcesPath : undefined;
let mainWindow: BrowserWindow | null = null;
let connection: Promise<DaemonConnection> | null = null;
const attachments = new Map<number, AbortController>();
const NO_DRAFTS: DraftReport = { dirty: 0, orphaned: 0 };
/** The renderer's last draft report per webContents. */
const draftReports = new Map<number, DraftReport>();
/** Windows the user already answered for: their close, reload or quit goes ahead. */
const cleared = new Set<number>();
/** Windows with a guard dialog open. */
const guarding = new Set<number>();
let requestSeq = 0;
/** Save all requests waiting for their answer, by request id. */
const pendingSaves = new Map<number, { contentsId: number; resolve: (report: DraftReport) => void }>();
/** Release requests waiting for their answer, by request id. */
const pendingReleases = new Map<number, { contentsId: number; resolve: () => void }>();

function databaseArg(): string | undefined {
  const prefix = "--cortex-db=";
  const arg = process.argv.find(a => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

/** One shared connection attempt; a failed attempt is forgotten so the next call tries again. */
function connect(): Promise<DaemonConnection> {
  if (connection) return connection;
  const attempt = connectDaemon({
    cortexBin: resolveCortexBin({ env: process.env, packagedResourcesPath }),
    databasePath: databaseArg(),
  });
  connection = attempt;
  attempt.catch(() => {
    if (connection === attempt) connection = null;
  });
  return attempt;
}

/** Replace a connection that turned out dead; concurrent callers share the new attempt. */
function reconnect(dead: Promise<DaemonConnection>): Promise<DaemonConnection> {
  if (connection === dead) connection = null;
  return connect();
}

/** Main's own copy of the preload sits next to the file `main` names in this package's package.json. */
function bundleDir(): string {
  const appPath = app.getAppPath();
  const pkg = JSON.parse(fs.readFileSync(path.join(appPath, "package.json"), "utf8")) as { main: string };
  return path.dirname(path.resolve(appPath, pkg.main));
}

async function send(conn: DaemonConnection, request: ParsedBridgeRequest): Promise<BridgeResponse> {
  const res = await socketResponse({ socketPath: conn.socketPath, ...request });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return { status: res.status, statusText: res.statusText, headers, body: await res.text() };
}

async function forward(request: ParsedBridgeRequest): Promise<BridgeResponse> {
  const current = connect();
  try {
    return await send(await current, request);
  } catch (err) {
    if (!DAEMON_GONE.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
    return send(await reconnect(current), request);
  }
}

function assertTrusted(event: IpcMainInvokeEvent | IpcMainEvent): void {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || !isAppUrl(frame.url)) {
    throw new Error(`untrusted sender: only the main frame at ${APP_ORIGIN} may use the bridge`);
  }
}

async function attach(sender: WebContents): Promise<void> {
  attachments.get(sender.id)?.abort();
  const controller = new AbortController();
  attachments.set(sender.id, controller);
  const { socketPath } = await connect();
  const post = (channel: string, value: unknown): void => {
    if (!controller.signal.aborted && !sender.isDestroyed()) sender.send(channel, value);
  };
  startBridge({
    socketPath,
    signal: controller.signal,
    targets: { postFrame: frame => post(CHANNELS.frame, frame), postState: state => post(CHANNELS.state, state) },
  }).catch(err => console.error("cortex live bridge stopped:", err));
}

/** A task's updates, read by main itself so the renderer cannot choose what resume runs. */
async function readUpdates(taskId: number): Promise<Update[]> {
  const res = await forward({ method: "GET", path: `/api/tasks/${taskId}/updates`, headers: {} });
  if (res.status !== 200) throw new Error(`task ${taskId}: the daemon answered ${res.status}`);
  return JSON.parse(res.body) as Update[];
}

/** Run a harness program with an argv and no shell; its output is not shown. */
function runHarness(program: string, argv: string[]): Promise<{ code: number | null; missing: boolean }> {
  return new Promise(resolve => {
    const child = spawn(program, argv, { shell: false, stdio: "ignore", timeout: RESUME_TIMEOUT_MS });
    child.once("error", (err: NodeJS.ErrnoException) => resolve({ code: null, missing: err.code === "ENOENT" }));
    child.once("exit", code => resolve({ code, missing: false }));
  });
}

/** Run the app's own cortex with an argv and no shell, keeping its output even when it fails. */
function runCortex(argv: readonly string[], timeoutMs: number): Promise<CortexRun> {
  return new Promise(resolve => {
    execFile(
      resolveCortexBin({ env: process.env, packagedResourcesPath }),
      [...argv],
      { env: process.env, timeout: timeoutMs, maxBuffer: AGENTS_MAX_BUFFER, encoding: "utf8", shell: false },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const code = typeof err.code === "number" ? err.code : null;
        const reason = err.killed ? `timed out after ${timeoutMs / 1000}s` : err.message;
        resolve({ code, stdout, stderr: stderr.trim() ? stderr : reason });
      },
    );
  });
}

const agents = createAgents({ run: runCortex });

function registerIpc(): void {
  ipcMain.handle(CHANNELS.request, (event, raw: unknown) => {
    assertTrusted(event);
    return forward(parseBridgeRequest(raw));
  });
  ipcMain.handle(CHANNELS.resume, (event, raw: unknown) => {
    assertTrusted(event);
    return resume({ updates: readUpdates, run: runHarness, copy: text => clipboard.writeText(text), env: process.env }, raw);
  });
  ipcMain.handle(CHANNELS.agents, (event, raw: unknown) => {
    assertTrusted(event);
    return agents(raw);
  });
  ipcMain.handle(CHANNELS.attach, event => {
    assertTrusted(event);
    return attach(event.sender);
  });
  ipcMain.on(CHANNELS.draftsState, (event, raw: unknown) => {
    try {
      assertTrusted(event);
      draftReports.set(event.sender.id, parseDraftReport(raw));
    } catch (err) {
      console.error("cortex: ignored a draft report:", (err as Error).message);
    }
  });
  ipcMain.handle(CHANNELS.draftsSaved, (event, raw: unknown) => {
    assertTrusted(event);
    const { id, report } = parseSaveAllAnswer(raw);
    const pending = pendingSaves.get(id);
    // A late answer to an older request, or one from another window, is ignored.
    if (!pending || pending.contentsId !== event.sender.id) return;
    pendingSaves.delete(id);
    draftReports.set(event.sender.id, report);
    pending.resolve(report);
  });
  ipcMain.handle(CHANNELS.draftsReleased, (event, raw: unknown) => {
    assertTrusted(event);
    const { id } = parseGuardAnswer(raw);
    const pending = pendingReleases.get(id);
    if (!pending || pending.contentsId !== event.sender.id) return;
    pendingReleases.delete(id);
    pending.resolve();
  });
  ipcMain.handle(CHANNELS.draftExport, (event, raw: unknown) => {
    assertTrusted(event);
    return exportDraft(event.sender, raw);
  });
}

async function exportDraft(sender: WebContents, raw: unknown): Promise<{ saved: boolean }> {
  const draft = parseDraftExport(raw);
  const options = {
    defaultPath: path.join(app.getPath("documents"), draft.fileName),
    filters: [{ name: "Markdown", extensions: ["md"] }],
  };
  const win = BrowserWindow.fromWebContents(sender);
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { saved: false };
  await fs.promises.writeFile(result.filePath, draft.text, "utf8");
  return { saved: true };
}

/**
 * Ask the renderer to stop warning before unload, and wait for its answer (or
 * the timeout, after which will-prevent-unload still lets the unload go ahead).
 */
function requestRelease(contents: WebContents): Promise<void> {
  const id = ++requestSeq;
  return new Promise(resolve => {
    const done = (): void => {
      clearTimeout(timer);
      pendingReleases.delete(id);
      resolve();
    };
    const timer = setTimeout(done, RELEASE_TIMEOUT_MS);
    pendingReleases.set(id, { contentsId: contents.id, resolve: done });
    contents.send(CHANNELS.draftsRelease, { id });
  });
}

function requestSaveAll(contents: WebContents): Promise<DraftReport> {
  const id = ++requestSeq;
  return new Promise(resolve => {
    pendingSaves.set(id, { contentsId: contents.id, resolve });
    contents.send(CHANNELS.draftsSaveAll, { id });
  });
}

const mustGuard = (contentsId: number): boolean =>
  !cleared.has(contentsId) && needsGuard(draftReports.get(contentsId) ?? NO_DRAFTS);

/** Ask about the window's unsaved drafts; `proceed` runs once the user chose to leave. */
async function guard(win: BrowserWindow, proceed: () => void): Promise<void> {
  const contents = win.webContents;
  const id = contents.id;
  if (guarding.has(id)) return;
  guarding.add(id);
  try {
    const outcome = await runGuard({
      report: draftReports.get(id) ?? NO_DRAFTS,
      ask: async d => {
        const { response } = await dialog.showMessageBox(win, {
          type: "warning",
          message: d.message,
          detail: d.detail,
          buttons: [...d.buttons],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
        });
        return response;
      },
      saveAll: () => requestSaveAll(contents),
      timeoutMs: SAVE_ALL_TIMEOUT_MS,
    });
    if (outcome === "leave" && !win.isDestroyed()) {
      cleared.add(id);
      // Reload, close and quit all run the page's beforeunload again; while
      // it is armed, Chromium may cancel the navigation without asking.
      await requestRelease(contents);
      if (!win.isDestroyed()) proceed();
    }
  } finally {
    guarding.delete(id);
    for (const [requestId, pending] of pendingSaves) if (pending.contentsId === id) pendingSaves.delete(requestId);
  }
}

function guardQuit(event: Electron.Event): void {
  const win = BrowserWindow.getAllWindows().find(w => mustGuard(w.webContents.id));
  if (!win) return;
  event.preventDefault();
  void guard(win, () => app.quit());
}

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function registerScheme(uiDir: string): void {
  protocol.handle(APP_SCHEME, async request => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST || (request.method !== "GET" && request.method !== "HEAD")) return notFound();
    const file = resolveUiFile(uiDir, url.pathname);
    if (!file) return notFound();
    const headers: Record<string, string> = { "content-type": file.mime, "x-content-type-options": "nosniff" };
    if (file.mime.startsWith("text/html")) headers["content-security-policy"] = CSP;
    const body = request.method === "HEAD" ? null : new Uint8Array(await fs.promises.readFile(file.file));
    return new Response(body, { status: 200, headers });
  });
}

function lockDownPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
}

function openExternal(url: string): void {
  if (isExternalLink(url)) shell.openExternal(url).catch(() => {});
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: {
      preload: path.join(bundleDir(), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;
  const contents = win.webContents;
  const id = contents.id;
  contents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternal(url);
  });
  contents.on("will-redirect", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  contents.on("destroyed", () => {
    attachments.get(id)?.abort();
    attachments.delete(id);
    draftReports.delete(id);
    cleared.delete(id);
  });
  // A new document starts with no drafts and reports its own.
  contents.on("did-navigate", () => {
    draftReports.delete(id);
    cleared.delete(id);
  });
  win.on("close", event => {
    if (!mustGuard(id)) return;
    event.preventDefault();
    void guard(win, () => win.close());
  });
  // The renderer arms beforeunload while drafts are unsaved, so a reload
  // lands here. Once the user answered, preventing this event lets it unload.
  contents.on("will-prevent-unload", event => {
    if (!mustGuard(id)) {
      event.preventDefault();
      return;
    }
    void guard(win, () => contents.reload());
  });
  win.once("ready-to-show", () => {
    if (!hidden) win.show();
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  void win.loadURL(`${APP_ORIGIN}${deepLinkPath(parseDeepLink(process.argv))}`);
}

async function start(): Promise<void> {
  try {
    await connect();
  } catch (err) {
    dialog.showErrorBox("Cortex could not reach its daemon", (err as Error).message);
    app.exit(1);
    return;
  }
  registerScheme(resolveUiDir({ env: process.env, packagedResourcesPath }));
  lockDownPermissions();
  registerIpc();
  createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const win = mainWindow;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    if (!hidden) win.show();
    win.focus();
    const link = parseDeepLink(argv);
    if (link) win.webContents.send(CHANNELS.open, link);
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", guardQuit);
  app.whenReady().then(start, err => {
    console.error(err);
    app.exit(1);
  });
}
