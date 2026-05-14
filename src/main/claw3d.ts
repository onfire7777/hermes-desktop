import { spawn, ChildProcess, execSync, spawnSync } from "child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { createConnection } from "net";
import { request } from "http";
import { getEnhancedPath, HERMES_HOME } from "./installer";
import { stripAnsi, safeWriteFile } from "./utils";
import { readEnv } from "./config";

const HERMES_OFFICE_REPO = "https://github.com/fathah/hermes-office";
const HERMES_OFFICE_DIR = join(HERMES_HOME, "hermes-office");
const DEV_PID_FILE = join(HERMES_HOME, "claw3d-dev.pid");
const ADAPTER_PID_FILE = join(HERMES_HOME, "claw3d-adapter.pid");
const PORT_FILE = join(HERMES_HOME, "claw3d-port");
const WS_URL_FILE = join(HERMES_HOME, "claw3d-ws-url");
const DEFAULT_PORT = 3000;
const configuredAdapterPort = Number(process.env.HERMES_DESKTOP_ADAPTER_PORT);
const DEFAULT_ADAPTER_PORT =
  Number.isFinite(configuredAdapterPort) && configuredAdapterPort > 0
    ? Math.floor(configuredAdapterPort)
    : 18789;
const DEFAULT_WS_URL = `ws://localhost:${DEFAULT_ADAPTER_PORT}`;
const CLAW3D_SETTINGS_DIR = join(homedir(), ".openclaw", "claw3d");

let devServerProcess: ChildProcess | null = null;
let adapterProcess: ChildProcess | null = null;
let devServerLogs = "";
let adapterLogs = "";
let devServerError = "";
let adapterError = "";

export interface ResolvedCommand {
  command: string;
  windowsScript: boolean;
}

interface CommandInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export function isWindowsCommandScript(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command);
}

export function pickWindowsCommandCandidate(
  candidates: string[],
): ResolvedCommand | null {
  const normalized = candidates
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const executable = normalized.find((candidate) => /\.exe$/i.test(candidate));
  if (executable) {
    return { command: executable, windowsScript: false };
  }

  const script = normalized.find(isWindowsCommandScript);
  if (script) {
    return { command: script, windowsScript: true };
  }

  const fallback = normalized[0];
  return fallback ? { command: fallback, windowsScript: false } : null;
}

function resolveCommandOnPath(
  command: string,
  envPath: string,
): ResolvedCommand | null {
  const lookupCommand = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookupCommand, [command], {
    encoding: "utf8",
    env: { ...process.env, PATH: envPath },
    timeout: 5000,
    windowsHide: true,
  });

  if (result.error || result.status !== 0 || !result.stdout) return null;

  const candidates = result.stdout.split(/\r?\n/);
  if (process.platform === "win32") {
    return pickWindowsCommandCandidate(candidates);
  }

  const resolved = candidates
    .map((candidate) => candidate.trim())
    .find(Boolean);
  return resolved ? { command: resolved, windowsScript: false } : null;
}

function resolveCommand(command: string, envPath: string): ResolvedCommand {
  const resolved = resolveCommandOnPath(command, envPath);
  if (resolved) return resolved;

  return {
    command,
    windowsScript:
      process.platform === "win32" && isWindowsCommandScript(command),
  };
}

function quoteWindowsCmdArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function buildWindowsScriptCommandLine(
  command: string,
  args: string[],
): string {
  const parts = [quoteWindowsCmdArg(command), ...args.map(quoteWindowsCmdArg)];
  return `"${parts.join(" ")}"`;
}

function createCommandInvocation(
  resolved: ResolvedCommand,
  args: string[],
): CommandInvocation {
  if (resolved.windowsScript) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        buildWindowsScriptCommandLine(resolved.command, args),
      ],
      windowsVerbatimArguments: true,
    };
  }

  return { command: resolved.command, args };
}

function getSavedPort(): number {
  try {
    const port = parseInt(readFileSync(PORT_FILE, "utf-8").trim(), 10);
    return isNaN(port) ? DEFAULT_PORT : port;
  } catch {
    return DEFAULT_PORT;
  }
}

export function setClaw3dPort(port: number): void {
  safeWriteFile(PORT_FILE, String(port));
  // Re-write .env with updated port
  writeClaw3dSettings();
}

export function getClaw3dPort(): number {
  return getSavedPort();
}

function getSavedWsUrl(): string {
  try {
    const url = readFileSync(WS_URL_FILE, "utf-8").trim();
    return url || DEFAULT_WS_URL;
  } catch {
    return DEFAULT_WS_URL;
  }
}

function hasProductionBuild(): boolean {
  return existsSync(join(HERMES_OFFICE_DIR, ".next", "BUILD_ID"));
}

export function setClaw3dWsUrl(url: string): void {
  safeWriteFile(WS_URL_FILE, url);
  // Also update the settings.json so Claw3D picks it up
  writeClaw3dSettings(url);
}

export function getClaw3dWsUrl(): string {
  return getSavedWsUrl();
}

/**
 * Write Claw3D settings to ~/.openclaw/claw3d/settings.json
 * and .env in the claw3d directory so onboarding is skipped.
 */
function writeClaw3dSettings(wsUrl?: string): void {
  const url = wsUrl || getSavedWsUrl();

  // Write ~/.openclaw/claw3d/settings.json
  try {
    mkdirSync(CLAW3D_SETTINGS_DIR, { recursive: true });
    const settingsPath = join(CLAW3D_SETTINGS_DIR, "settings.json");

    // Preserve existing settings if present
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      /* fresh */
    }

    const existingGateway =
      existing.gateway &&
      typeof existing.gateway === "object" &&
      !Array.isArray(existing.gateway)
        ? (existing.gateway as Record<string, unknown>)
        : {};
    const existingProfiles =
      existingGateway.profiles &&
      typeof existingGateway.profiles === "object" &&
      !Array.isArray(existingGateway.profiles)
        ? (existingGateway.profiles as Record<string, unknown>)
        : {};

    const settings = {
      ...existing,
      adapter: "hermes",
      url,
      token: "",
      gateway: {
        ...existingGateway,
        url,
        token: "",
        adapterType: "hermes",
        profiles: {
          ...existingProfiles,
          hermes: { url, token: "" },
        },
        lastKnownGood: {
          url,
          token: "",
          adapterType: "hermes",
        },
      },
    };
    safeWriteFile(settingsPath, JSON.stringify(settings, null, 2));
  } catch {
    /* non-fatal */
  }

  // Write .env in claw3d directory
  try {
    if (existsSync(HERMES_OFFICE_DIR)) {
      const envPath = join(HERMES_OFFICE_DIR, ".env");
      const port = getSavedPort();
      const envContent = [
        "# Auto-configured by Hermes Desktop",
        `PORT=${port}`,
        `HOST=127.0.0.1`,
        `NEXT_PUBLIC_GATEWAY_URL=${url}`,
        `CLAW3D_GATEWAY_URL=${url}`,
        `CLAW3D_GATEWAY_TOKEN=`,
        `CLAW3D_GATEWAY_ADAPTER_TYPE=hermes`,
        `UPSTREAM_ALLOWLIST=localhost,127.0.0.1`,
        `HERMES_ADAPTER_PORT=${DEFAULT_ADAPTER_PORT}`,
        `HERMES_MODEL=hermes`,
        `HERMES_AGENT_NAME=Hermes`,
        `HERMES_HOME=${join(homedir(), ".hermes")}`,
        `OPENCLAW_STATE_DIR=${join(homedir(), ".openclaw")}`,
        "",
      ].join("\n");
      safeWriteFile(envPath, envContent);
    }
  } catch {
    /* non-fatal */
  }
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.setTimeout(300); // 300ms is plenty for localhost
    socket.on("connect", () => {
      socket.destroy();
      resolve(true); // port is in use
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false); // port is free
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function readHttpPath(
  port: number,
  path: string,
): Promise<{ statusCode: number; body: string } | null> {
  return new Promise((resolve) => {
    let body = "";
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        timeout: 1200,
      },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 4096) req.destroy();
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 0, body });
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

async function isCompatibleOfficeServer(port: number): Promise<boolean> {
  const response = await readHttpPath(port, "/api/task-store");
  if (!response || response.statusCode !== 200) return false;

  try {
    const parsed = JSON.parse(response.body) as { tasks?: unknown };
    return Array.isArray(parsed.tasks);
  } catch {
    return false;
  }
}

function findListeningPid(port: number): number | null {
  try {
    if (process.platform === "win32") {
      const output = execSync("netstat -ano -p tcp", {
        timeout: 2000,
        windowsHide: true,
      }).toString();
      const escapedPort = String(port).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const listenRe = new RegExp(
        `^\\s*TCP\\s+127\\.0\\.0\\.1:${escapedPort}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`,
        "im",
      );
      const match = output.match(listenRe);
      const pid = match ? parseInt(match[1], 10) : NaN;
      return Number.isFinite(pid) ? pid : null;
    }

    const output = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
      timeout: 5000,
      windowsHide: true,
    })
      .toString()
      .trim()
      .split(/\r?\n/)[0];
    const pid = parseInt(output, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function getProcessCommandLine(pid: number): string {
  try {
    if (process.platform === "win32") {
      try {
        return execSync(
          `wmic process where processid=${pid} get CommandLine /value`,
          { timeout: 5000, windowsHide: true },
        )
          .toString()
          .replace(/^CommandLine=/i, "")
          .trim();
      } catch {
        return execSync(
          `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
          { timeout: 5000, windowsHide: true },
        )
          .toString()
          .trim();
      }
    }

    return execSync(`ps -p ${pid} -o command=`, {
      timeout: 5000,
      windowsHide: true,
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

function normalizeCommandLine(commandLine: string): string {
  return commandLine.replace(/\\/g, "/").toLowerCase();
}

function isHermesAdapterCommand(commandLine: string): boolean {
  const cmd = normalizeCommandLine(commandLine);
  return (
    cmd.includes("server/hermes-gateway-adapter.js") ||
    cmd.includes("run hermes-adapter")
  );
}

function isHermesOfficeServerCommand(commandLine: string): boolean {
  const cmd = normalizeCommandLine(commandLine);
  return (
    cmd.includes("server/index.js") ||
    ((cmd.includes("npm-cli.js") || cmd.includes("/npm")) &&
      (cmd.includes(" run start") || cmd.includes(" run dev")))
  );
}

function getOfficeServerOwner(
  port: number,
): { pid: number; commandLine: string; isHermesOffice: boolean } | null {
  const pid = findListeningPid(port);
  if (!pid) return null;

  const commandLine = getProcessCommandLine(pid);
  return {
    pid,
    commandLine,
    isHermesOffice: isHermesOfficeServerCommand(commandLine),
  };
}

function officeUnresponsiveError(port: number): string {
  return `Hermes Office is already on port ${port}, but it is not responding. Press Start to restart it.`;
}

async function attachCompatibleDevServer(port: number): Promise<boolean> {
  if (!(await isCompatibleOfficeServer(port))) return false;

  const pid = findListeningPid(port);
  if (pid) writePid(DEV_PID_FILE, pid);
  devServerError = "";
  return true;
}

function attachCompatibleAdapter(): boolean {
  const pid = findListeningPid(DEFAULT_ADAPTER_PORT);
  if (!pid) return false;

  if (!isHermesAdapterCommand(getProcessCommandLine(pid))) return false;

  writePid(ADAPTER_PID_FILE, pid);
  adapterError = "";
  return true;
}

function cleanupStalePid(
  file: string,
  isExpectedCommand: (cmd: string) => boolean,
): void {
  const pid = readPid(file);
  if (!pid) return;
  if (
    !isProcessRunning(pid) ||
    !isExpectedCommand(getProcessCommandLine(pid))
  ) {
    cleanupPid(file);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOfficeServer(
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await attachCompatibleDevServer(port)) return true;
    await delay(250);
  } while (Date.now() < deadline);
  return false;
}

async function waitForCompatibleAdapter(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (attachCompatibleAdapter()) return true;
    await delay(250);
  } while (Date.now() < deadline);
  return false;
}

async function waitForPortFree(
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await checkPort(port))) return true;
    await delay(250);
  } while (Date.now() < deadline);
  return false;
}

export interface Claw3dStatus {
  cloned: boolean;
  installed: boolean;
  devServerRunning: boolean;
  adapterRunning: boolean;
  running: boolean; // true when both dev + adapter are up
  port: number;
  portInUse: boolean;
  wsUrl: string;
  error: string; // last error from either process
}

export interface Claw3dSetupProgress {
  step: number;
  totalSteps: number;
  title: string;
  detail: string;
  log: string;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(file: string): number | null {
  try {
    const pid = parseInt(readFileSync(file, "utf-8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function writePid(file: string, pid: number): void {
  safeWriteFile(file, String(pid));
}

function cleanupPid(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    /* ignore */
  }
}

function isDevServerRunning(): boolean {
  if (devServerProcess && !devServerProcess.killed) return true;
  const pid = readPid(DEV_PID_FILE);
  if (
    pid &&
    isProcessRunning(pid) &&
    isHermesOfficeServerCommand(getProcessCommandLine(pid))
  ) {
    return true;
  }
  cleanupPid(DEV_PID_FILE);
  return false;
}

export async function getClaw3dStatus(): Promise<Claw3dStatus> {
  const cloned = existsSync(join(HERMES_OFFICE_DIR, "package.json"));
  const installed = existsSync(join(HERMES_OFFICE_DIR, "node_modules"));
  const port = getSavedPort();
  const devRunning = await attachCompatibleDevServer(port);
  let recoverableOfficeOwner = false;
  if (!devRunning) {
    const owner = getOfficeServerOwner(port);
    recoverableOfficeOwner = Boolean(owner?.isHermesOffice);
    if (owner?.isHermesOffice) {
      writePid(DEV_PID_FILE, owner.pid);
      devServerError = officeUnresponsiveError(port);
    } else {
      cleanupStalePid(DEV_PID_FILE, isHermesOfficeServerCommand);
    }
  }
  // Only report a conflict when the occupied port is not already Hermes Office.
  let portInUse = false;
  if (!devRunning && !recoverableOfficeOwner) {
    portInUse = await checkPort(port);
  }
  const adapterUp = attachCompatibleAdapter();
  if (!adapterUp) {
    cleanupStalePid(ADAPTER_PID_FILE, isHermesAdapterCommand);
  }
  const error = devServerError || adapterError;
  return {
    cloned,
    installed,
    devServerRunning: devRunning,
    adapterRunning: adapterUp,
    running: devRunning && adapterUp,
    port,
    portInUse,
    wsUrl: getSavedWsUrl(),
    error,
  };
}

let _cachedNpmCommand: ResolvedCommand | null = null;
let _cachedNodeCommand: ResolvedCommand | null = null;

function resolveExistingCommand(
  candidates: (string | undefined)[],
): ResolvedCommand | null {
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    return {
      command: candidate,
      windowsScript:
        process.platform === "win32" && isWindowsCommandScript(candidate),
    };
  }
  return null;
}

function findNode(envPath = getEnhancedPath()): ResolvedCommand {
  if (_cachedNodeCommand) return _cachedNodeCommand;

  const home = homedir();
  const resolvedOnPath = resolveCommandOnPath("node", envPath);
  if (resolvedOnPath) {
    _cachedNodeCommand = resolvedOnPath;
    return resolvedOnPath;
  }

  const candidates =
    process.platform === "win32"
      ? [
          process.env.NVM_SYMLINK
            ? join(process.env.NVM_SYMLINK, "node.exe")
            : undefined,
          process.env.ProgramFiles
            ? join(process.env.ProgramFiles, "nodejs", "node.exe")
            : "C:\\Program Files\\nodejs\\node.exe",
          process.env["ProgramFiles(x86)"]
            ? join(process.env["ProgramFiles(x86)"], "nodejs", "node.exe")
            : "C:\\Program Files (x86)\\nodejs\\node.exe",
          process.env.LOCALAPPDATA
            ? join(process.env.LOCALAPPDATA, "Programs", "nodejs", "node.exe")
            : join(home, "AppData", "Local", "Programs", "nodejs", "node.exe"),
          join(home, ".volta", "bin", "node.exe"),
          join(
            home,
            ".local",
            "share",
            "fnm",
            "aliases",
            "default",
            "bin",
            "node.exe",
          ),
          join(home, ".fnm", "aliases", "default", "bin", "node.exe"),
          join(home, "AppData", "Local", "OpenAI", "Codex", "bin", "node.exe"),
        ]
      : [
          join(home, ".volta", "bin", "node"),
          join(home, ".asdf", "shims", "node"),
          join(
            home,
            ".local",
            "share",
            "fnm",
            "aliases",
            "default",
            "bin",
            "node",
          ),
          join(home, ".fnm", "aliases", "default", "bin", "node"),
          "/usr/local/bin/node",
          "/opt/homebrew/bin/node",
        ];

  _cachedNodeCommand =
    resolveExistingCommand(candidates) || resolveCommand("node", envPath);
  return _cachedNodeCommand;
}

function findNpm(envPath = getEnhancedPath()): ResolvedCommand {
  if (_cachedNpmCommand) return _cachedNpmCommand;

  const home = homedir();

  if (process.platform === "win32") {
    const resolved = resolveCommandOnPath("npm", envPath);
    if (resolved) {
      _cachedNpmCommand = resolved;
      return resolved;
    }
  }

  // Try common locations first (no process spawn). Includes nvm,
  // nvm-windows, volta, asdf, fnm, and system paths.
  const candidates = [
    ...(process.platform === "win32"
      ? [
          process.env.NVM_SYMLINK
            ? join(process.env.NVM_SYMLINK, "npm.cmd")
            : undefined,
          join(home, "AppData", "Roaming", "npm", "npm.cmd"),
          process.env.ProgramFiles
            ? join(process.env.ProgramFiles, "nodejs", "npm.cmd")
            : undefined,
          process.env["ProgramFiles(x86)"]
            ? join(process.env["ProgramFiles(x86)"], "nodejs", "npm.cmd")
            : undefined,
          process.env.LOCALAPPDATA
            ? join(process.env.LOCALAPPDATA, "Programs", "nodejs", "npm.cmd")
            : join(home, "AppData", "Local", "Programs", "nodejs", "npm.cmd"),
          join(home, ".volta", "bin", "npm.cmd"),
          join(home, ".volta", "bin", "npm.exe"),
          join(home, ".asdf", "shims", "npm.cmd"),
          join(
            home,
            ".local",
            "share",
            "fnm",
            "aliases",
            "default",
            "bin",
            "npm.cmd",
          ),
          join(home, ".fnm", "aliases", "default", "bin", "npm.cmd"),
        ]
      : []),
    join(home, ".volta", "bin", "npm"),
    join(home, ".asdf", "shims", "npm"),
    join(home, ".local", "share", "fnm", "aliases", "default", "bin", "npm"),
    join(home, ".fnm", "aliases", "default", "bin", "npm"),
    "/usr/local/bin/npm",
    "/opt/homebrew/bin/npm",
  ].filter((candidate): candidate is string => Boolean(candidate));

  // Discover nvm npm dynamically (active version)
  const nvmDir = process.env.NVM_DIR || join(home, ".nvm");
  const nvmVersions = join(nvmDir, "versions", "node");
  if (existsSync(nvmVersions)) {
    try {
      const versions = readdirSync(nvmVersions)
        .filter((d: string) => d.startsWith("v"))
        .sort()
        .reverse();
      for (const v of versions) {
        candidates.unshift(
          join(
            nvmVersions,
            v,
            "bin",
            process.platform === "win32" ? "npm.cmd" : "npm",
          ),
        );
      }
    } catch {
      /* non-fatal */
    }
  }

  for (const c of candidates) {
    if (existsSync(c)) {
      _cachedNpmCommand = {
        command: c,
        windowsScript:
          process.platform === "win32" && isWindowsCommandScript(c),
      };
      return _cachedNpmCommand;
    }
  }

  // Fallback path lookup only runs once because the result is cached.
  if (process.platform !== "win32") {
    const resolved = resolveCommandOnPath("npm", envPath);
    if (resolved) {
      _cachedNpmCommand = resolved;
      return resolved;
    }
  }

  _cachedNpmCommand = resolveCommand("npm", envPath);
  return _cachedNpmCommand;
}

function spawnNode(
  args: string[],
  options: Parameters<typeof spawn>[2],
): ChildProcess {
  const envPath =
    options?.env && typeof options.env.PATH === "string"
      ? options.env.PATH
      : getEnhancedPath();
  const invocation = createCommandInvocation(findNode(envPath), args);
  return spawn(invocation.command, invocation.args, {
    ...options,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

export async function setupClaw3d(
  onProgress: (progress: Claw3dSetupProgress) => void,
): Promise<void> {
  const totalSteps = 3;
  let log = "";

  function emit(step: number, title: string, text: string): void {
    log += text;
    onProgress({
      step,
      totalSteps,
      title,
      detail: text.trim().slice(0, 120),
      log,
    });
  }

  const env = {
    ...process.env,
    PATH: getEnhancedPath(),
    HOME: homedir(),
    TERM: "dumb",
  };
  const git = resolveCommand("git", env.PATH);

  // Step 1: Clone (or pull if already cloned)
  const cloned = existsSync(join(HERMES_OFFICE_DIR, "package.json"));

  if (!cloned) {
    emit(1, "Cloning Claw3D repository...", "Cloning from GitHub...\n");
    await new Promise<void>((resolve, reject) => {
      const gitClone = createCommandInvocation(git, [
        "clone",
        HERMES_OFFICE_REPO,
        HERMES_OFFICE_DIR,
      ]);
      const proc = spawn(gitClone.command, gitClone.args, {
        cwd: homedir(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: gitClone.windowsVerbatimArguments,
      });

      proc.stdout?.on("data", (data: Buffer) => {
        emit(1, "Cloning Claw3D repository...", stripAnsi(data.toString()));
      });
      proc.stderr?.on("data", (data: Buffer) => {
        emit(1, "Cloning Claw3D repository...", stripAnsi(data.toString()));
      });

      proc.on("close", (code) => {
        if (code === 0) {
          emit(1, "Cloning Claw3D repository...", "Clone complete.\n");
          resolve();
        } else {
          reject(new Error(`git clone failed (exit code ${code})`));
        }
      });
      proc.on("error", (err) =>
        reject(new Error(`Failed to run git: ${err.message}`)),
      );
    });
  } else {
    emit(
      1,
      "Claw3D already cloned",
      "Repository already exists, pulling latest...\n",
    );
    await new Promise<void>((resolve) => {
      const gitPull = createCommandInvocation(git, ["pull", "--ff-only"]);
      const proc = spawn(gitPull.command, gitPull.args, {
        cwd: HERMES_OFFICE_DIR,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: gitPull.windowsVerbatimArguments,
      });

      proc.stdout?.on("data", (data: Buffer) => {
        emit(1, "Updating Claw3D...", stripAnsi(data.toString()));
      });
      proc.stderr?.on("data", (data: Buffer) => {
        emit(1, "Updating Claw3D...", stripAnsi(data.toString()));
      });

      proc.on("close", (code) => {
        if (code === 0) resolve();
        else resolve(); // non-fatal: pull failures shouldn't block setup
      });
      proc.on("error", () => resolve());
    });
  }

  // Step 2: npm install
  emit(2, "Installing dependencies...", "Running npm install...\n");
  const npm = createCommandInvocation(findNpm(env.PATH), ["install"]);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(npm.command, npm.args, {
      cwd: HERMES_OFFICE_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: npm.windowsVerbatimArguments,
    });

    proc.stdout?.on("data", (data: Buffer) => {
      emit(2, "Installing dependencies...", stripAnsi(data.toString()));
    });
    proc.stderr?.on("data", (data: Buffer) => {
      emit(2, "Installing dependencies...", stripAnsi(data.toString()));
    });

    proc.on("close", (code) => {
      if (code === 0) {
        emit(
          2,
          "Installing dependencies...",
          "Dependencies installed successfully.\n",
        );
        resolve();
      } else {
        reject(new Error(`npm install failed (exit code ${code})`));
      }
    });
    proc.on("error", (err) =>
      reject(new Error(`Failed to run npm: ${err.message}`)),
    );
  });

  // Write config files so Claw3D skips onboarding and the production build
  // gets the correct public gateway defaults.
  writeClaw3dSettings();

  // Step 3: production build
  emit(3, "Building Claw3D...", "Running npm run build...\n");
  const npmBuild = createCommandInvocation(findNpm(env.PATH), ["run", "build"]);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(npmBuild.command, npmBuild.args, {
      cwd: HERMES_OFFICE_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: npmBuild.windowsVerbatimArguments,
    });

    proc.stdout?.on("data", (data: Buffer) => {
      emit(3, "Building Claw3D...", stripAnsi(data.toString()));
    });
    proc.stderr?.on("data", (data: Buffer) => {
      emit(3, "Building Claw3D...", stripAnsi(data.toString()));
    });

    proc.on("close", (code) => {
      if (code === 0) {
        emit(3, "Building Claw3D...", "Build complete.\n");
        resolve();
      } else {
        reject(new Error(`npm run build failed (exit code ${code})`));
      }
    });
    proc.on("error", (err) =>
      reject(new Error(`Failed to run npm build: ${err.message}`)),
    );
  });
}

function killProcessTree(proc: ChildProcess): void {
  if (proc.pid) {
    if (process.platform === "win32") {
      try {
        execSync(`taskkill /PID ${proc.pid} /T /F`, {
          stdio: "ignore",
          windowsHide: true,
        });
        return;
      } catch {
        try {
          proc.kill();
        } catch {
          /* already dead */
        }
        return;
      }
    }

    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    }
    // Fallback: SIGKILL after 3 seconds
    setTimeout(() => {
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }, 3000);
  }
}

export function startDevServer(): boolean {
  if (isDevServerRunning()) return true;
  if (!existsSync(join(HERMES_OFFICE_DIR, "node_modules"))) return false;

  devServerError = "";
  devServerLogs = "";
  const port = getSavedPort();
  const wsUrl = getSavedWsUrl();
  const script = hasProductionBuild() ? "start" : "dev";
  const env = {
    ...process.env,
    PATH: getEnhancedPath(),
    HOME: homedir(),
    TERM: "dumb",
    PORT: String(port),
    HOST: "127.0.0.1",
    NEXT_PUBLIC_GATEWAY_URL: wsUrl,
    CLAW3D_GATEWAY_URL: wsUrl,
    CLAW3D_GATEWAY_TOKEN: "",
    CLAW3D_GATEWAY_ADAPTER_TYPE: "hermes",
    UPSTREAM_ALLOWLIST: "localhost,127.0.0.1",
    HERMES_ADAPTER_PORT: String(DEFAULT_ADAPTER_PORT),
    HERMES_MODEL: "hermes",
    HERMES_AGENT_NAME: "Hermes",
    HERMES_HOME: join(homedir(), ".hermes"),
    OPENCLAW_STATE_DIR: join(homedir(), ".openclaw"),
  };
  const proc = spawnNode(
    ["server/index.js", ...(script === "dev" ? ["--dev"] : [])],
    {
      cwd: HERMES_OFFICE_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );

  devServerProcess = proc;
  if (proc.pid) writePid(DEV_PID_FILE, proc.pid);

  proc.stdout?.on("data", (data: Buffer) => {
    devServerLogs += stripAnsi(data.toString());
    // Keep only last 2000 chars
    if (devServerLogs.length > 2000) devServerLogs = devServerLogs.slice(-2000);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const text = stripAnsi(data.toString());
    devServerLogs += text;
    if (devServerLogs.length > 2000) devServerLogs = devServerLogs.slice(-2000);
    // Capture real errors (not warnings)
    if (
      /error|EADDRINUSE|ENOENT|failed|fatal/i.test(text) &&
      !/warning/i.test(text)
    ) {
      devServerError = text.trim().slice(0, 300);
    }
  });

  proc.on("close", (code) => {
    if (code && code !== 0 && !devServerError) {
      devServerError = `Dev server exited with code ${code}. Check if port ${port} is available.`;
    }
    devServerProcess = null;
    cleanupPid(DEV_PID_FILE);
  });

  proc.unref();
  return true;
}

export function stopDevServer(): void {
  if (devServerProcess) {
    killProcessTree(devServerProcess);
    devServerProcess = null;
  }

  const listeningPid = findListeningPid(getSavedPort());
  if (
    listeningPid &&
    isHermesOfficeServerCommand(getProcessCommandLine(listeningPid))
  ) {
    if (process.platform === "win32") {
      try {
        execSync(`taskkill /PID ${listeningPid} /T /F`, {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        /* already dead */
      }
    } else {
      try {
        process.kill(-listeningPid, "SIGTERM");
      } catch {
        try {
          process.kill(listeningPid, "SIGTERM");
        } catch {
          /* already dead */
        }
      }
    }
  }

  const pid = readPid(DEV_PID_FILE);
  if (pid && isHermesOfficeServerCommand(getProcessCommandLine(pid))) {
    if (process.platform === "win32") {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        /* already dead */
      }
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already dead */
        }
      }
    }
  }
  cleanupPid(DEV_PID_FILE);
}

export function startAdapter(): boolean {
  if (adapterProcess && !adapterProcess.killed) return true;
  if (attachCompatibleAdapter()) return true;
  cleanupStalePid(ADAPTER_PID_FILE, isHermesAdapterCommand);
  if (!existsSync(join(HERMES_OFFICE_DIR, "node_modules"))) return false;

  adapterError = "";
  adapterLogs = "";
  const hermesEnv = readEnv();
  const apiKey =
    hermesEnv.API_SERVER_KEY ||
    hermesEnv.HERMES_API_KEY ||
    process.env.API_SERVER_KEY ||
    process.env.HERMES_API_KEY ||
    "";
  const env = {
    ...process.env,
    PATH: getEnhancedPath(),
    HOME: homedir(),
    TERM: "dumb",
    HERMES_API_URL: "http://127.0.0.1:8642",
    HERMES_API_KEY: apiKey,
    HERMES_ADAPTER_PORT: String(DEFAULT_ADAPTER_PORT),
    HERMES_MODEL: "hermes",
    HERMES_AGENT_NAME: "Hermes",
    HERMES_HOME: join(homedir(), ".hermes"),
    OPENCLAW_STATE_DIR: join(homedir(), ".openclaw"),
  };
  const proc = spawnNode(["server/hermes-gateway-adapter.js"], {
    cwd: HERMES_OFFICE_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  adapterProcess = proc;
  if (proc.pid) writePid(ADAPTER_PID_FILE, proc.pid);

  proc.stdout?.on("data", (data: Buffer) => {
    adapterLogs += stripAnsi(data.toString());
    if (adapterLogs.length > 2000) adapterLogs = adapterLogs.slice(-2000);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const text = stripAnsi(data.toString());
    adapterLogs += text;
    if (adapterLogs.length > 2000) adapterLogs = adapterLogs.slice(-2000);
    if (
      /error|EADDRINUSE|ENOENT|failed|fatal/i.test(text) &&
      !/warning/i.test(text)
    ) {
      adapterError = text.trim().slice(0, 300);
    }
  });

  proc.on("close", (code) => {
    if (code && code !== 0 && !adapterError) {
      adapterError = `Hermes adapter exited with code ${code}`;
    }
    adapterProcess = null;
    cleanupPid(ADAPTER_PID_FILE);
  });

  proc.unref();
  return true;
}

export function stopAdapter(): void {
  if (adapterProcess) {
    killProcessTree(adapterProcess);
    adapterProcess = null;
  }

  const listeningPid = findListeningPid(DEFAULT_ADAPTER_PORT);
  if (
    listeningPid &&
    isHermesAdapterCommand(getProcessCommandLine(listeningPid))
  ) {
    if (process.platform === "win32") {
      try {
        execSync(`taskkill /PID ${listeningPid} /T /F`, {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        /* already dead */
      }
    } else {
      try {
        process.kill(-listeningPid, "SIGTERM");
      } catch {
        try {
          process.kill(listeningPid, "SIGTERM");
        } catch {
          /* already dead */
        }
      }
    }
  }

  const pid = readPid(ADAPTER_PID_FILE);
  if (pid && isHermesAdapterCommand(getProcessCommandLine(pid))) {
    if (process.platform === "win32") {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        /* already dead */
      }
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already dead */
        }
      }
    }
  }
  cleanupPid(ADAPTER_PID_FILE);
}

export async function startAll(): Promise<{
  success: boolean;
  error?: string;
}> {
  if (!existsSync(join(HERMES_OFFICE_DIR, "node_modules"))) {
    return {
      success: false,
      error: "Claw3D is not installed. Please install it first.",
    };
  }

  const port = getSavedPort();
  writeClaw3dSettings();

  // Start dev server
  let devOk = await attachCompatibleDevServer(port);
  if (!devOk) {
    const owner = getOfficeServerOwner(port);
    if (owner?.isHermesOffice) {
      devServerError = officeUnresponsiveError(port);
      stopDevServer();
      await waitForPortFree(port, 5000);
    } else if (await checkPort(port)) {
      return {
        success: false,
        error: `Port ${port} is in use by another process. Change the Office port in settings or stop the process using that port.`,
      };
    }
  }
  devOk = await attachCompatibleDevServer(port);
  if (!devOk && (await checkPort(port))) {
    return {
      success: false,
      error: `Port ${port} is in use by another process. Change the Office port in settings or stop the process using that port.`,
    };
  }
  if (!devOk) devOk = startDevServer();
  if (!devOk) {
    return {
      success: false,
      error: `Failed to start dev server on port ${port}`,
    };
  }
  devOk = await waitForOfficeServer(port, 20000);
  if (!devOk) {
    return {
      success: false,
      error: `Hermes Office did not become ready on http://localhost:${port}.`,
    };
  }

  // Start adapter
  let adapterOk = attachCompatibleAdapter();
  if (!adapterOk) adapterOk = startAdapter();
  if (!adapterOk) {
    return { success: false, error: "Failed to start Hermes adapter" };
  }
  adapterOk = await waitForCompatibleAdapter(12000);
  if (!adapterOk) {
    return {
      success: false,
      error:
        adapterError ||
        `Hermes adapter did not start listening on ws://localhost:${DEFAULT_ADAPTER_PORT}.`,
    };
  }

  return { success: true };
}

export function stopAll(): void {
  stopDevServer();
  stopAdapter();
  devServerError = "";
  adapterError = "";
}

export function getClaw3dLogs(): string {
  return [
    devServerLogs ? `=== Dev Server ===\n${devServerLogs}` : "",
    adapterLogs ? `=== Adapter ===\n${adapterLogs}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
