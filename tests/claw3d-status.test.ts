import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { spawn, type ChildProcess } from "child_process";

const { TEST_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os");
  const adapterPort = 42000 + Math.floor(Math.random() * 10000);
  process.env.HERMES_DESKTOP_ADAPTER_PORT = String(adapterPort);
  return {
    TEST_HOME: path.join(os.tmpdir(), `hermes-claw3d-test-${Date.now()}`),
  };
});

vi.mock("../src/main/installer", () => ({
  HERMES_HOME: TEST_HOME,
  getEnhancedPath: () => process.env.PATH || "",
}));

import { getClaw3dStatus, setClaw3dPort } from "../src/main/claw3d";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function spawnWedgedOfficeServer(officeDir: string): Promise<{
  child: ChildProcess;
  port: number;
}> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const child = spawn(process.execPath, ["server/index.js"], {
      cwd: officeDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const timeout = setTimeout(() => {
      fail(new Error("Office test process did not report a port"));
      child.kill("SIGTERM");
    }, 5000);

    child.once("error", (err) => {
      clearTimeout(timeout);
      fail(new Error(`Office test process failed: ${err.message}`));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      fail(
        new Error(
          `Office test process exited before listening: code=${code} signal=${signal}`,
        ),
      );
    });
    child.stdout?.once("data", (data: Buffer) => {
      const port = Number(data.toString().trim());
      if (!Number.isFinite(port)) {
        clearTimeout(timeout);
        fail(new Error(`Office test process reported invalid port: ${data}`));
        return;
      }
      clearTimeout(timeout);
      settled = true;
      resolve({ child, port });
    });
  });
}

async function stopChildProcess(proc: ChildProcess): Promise<void> {
  if (!proc.pid || proc.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      resolve();
    }, 2000);
    proc.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    try {
      proc.kill("SIGTERM");
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}

describe("Claw3D desktop status", () => {
  let server: Server | null = null;
  let child: ChildProcess | null = null;

  beforeEach(() => {
    mkdirSync(join(TEST_HOME, "hermes-office", "node_modules"), {
      recursive: true,
    });
  });

  afterEach(async () => {
    if (server?.listening) await close(server);
    server = null;
    if (child) await stopChildProcess(child);
    child = null;
    if (existsSync(TEST_HOME))
      rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("attaches to an already-running Hermes Office server instead of reporting a port conflict", async () => {
    server = createServer((req, res) => {
      if (req.url === "/api/task-store") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ tasks: [] }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    const port = await listen(server);
    setClaw3dPort(port);

    const status = await getClaw3dStatus();

    expect(status.installed).toBe(true);
    expect(status.devServerRunning).toBe(true);
    expect(status.portInUse).toBe(false);
  });

  it("does not attach to an unrelated local service on the configured port", async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end("<html><body>not office</body></html>");
    });
    const port = await listen(server);
    setClaw3dPort(port);

    const status = await getClaw3dStatus();

    expect(status.devServerRunning).toBe(false);
    expect(status.portInUse).toBe(true);
  });

  it("reports a tracked but unresponsive Office server as recoverable instead of a port conflict", async () => {
    const officeDir = join(TEST_HOME, "fake-office");
    mkdirSync(join(officeDir, "server"), { recursive: true });
    writeFileSync(
      join(officeDir, "server", "index.js"),
      [
        "const { createServer } = require('http');",
        "const server = createServer((_req, _res) => {",
        "  // Leave the request open to simulate a wedged Claw3D process.",
        "});",
        "server.listen(0, '127.0.0.1', () => {",
        "  console.log(server.address().port);",
        "});",
        "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
      ].join("\n"),
    );
    const spawned = await spawnWedgedOfficeServer(officeDir);
    child = spawned.child;
    const { port } = spawned;
    setClaw3dPort(port);
    writeFileSync(join(TEST_HOME, "claw3d-dev.pid"), String(child.pid));

    const status = await getClaw3dStatus();

    expect(status.devServerRunning).toBe(false);
    expect(status.portInUse).toBe(false);
    expect(status.error).toContain("not responding");
  });

  it("does not treat a stale dev PID as a running Office server", async () => {
    writeFileSync(join(TEST_HOME, "claw3d-dev.pid"), String(process.pid));

    const status = await getClaw3dStatus();

    expect(status.devServerRunning).toBe(false);
    expect(status.running).toBe(false);
  });

  it("does not treat a stale adapter PID as a running Hermes adapter", async () => {
    writeFileSync(join(TEST_HOME, "claw3d-adapter.pid"), String(process.pid));

    const status = await getClaw3dStatus();

    expect(status.adapterRunning).toBe(false);
    expect(status.running).toBe(false);
  });
});
