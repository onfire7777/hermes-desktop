import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { ExecFileException } from "child_process";

const { TEST_HOME, execFileMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path");
  return {
    TEST_HOME: path.join(os.tmpdir(), `hermes-cronjobs-test-${Date.now()}`),
    execFileMock: vi.fn(),
  };
});

vi.mock("child_process", () => ({
  default: { execFile: execFileMock },
  execFile: execFileMock,
}));

vi.mock("../src/main/installer", () => ({
  HERMES_HOME: TEST_HOME,
  HERMES_PYTHON: "C:\\Hermes\\venv\\Scripts\\python.exe",
  hermesCliArgs: (args: string[] = []) => ["-m", "hermes_cli.main", ...args],
}));

vi.mock("../src/main/hermes", () => ({
  isRemoteMode: () => false,
  getApiUrl: () => "http://127.0.0.1:8642",
  getRemoteAuthHeader: () => ({}),
}));

import { createCronJob, listCronJobs } from "../src/main/cronjobs";

beforeEach(() => {
  execFileMock.mockReset();
  mkdirSync(join(TEST_HOME, "hermes-agent"), { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_HOME))
    rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("cron job integration helpers", () => {
  it("creates jobs using the current Hermes CLI positional prompt contract", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (
          err: ExecFileException | null,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        callback(null, "created\n", "");
      },
    );

    const result = await createCronJob(
      "1h",
      "Run the scheduled report -- without treating this text as flags",
      "Hourly report",
      "discord",
      "work",
    );

    expect(result.success).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [, args, options] = execFileMock.mock.calls[0];
    expect(args).toEqual([
      "-m",
      "hermes_cli.main",
      "-p",
      "work",
      "cron",
      "create",
      "1h",
      "Run the scheduled report -- without treating this text as flags",
      "--name",
      "Hourly report",
      "--deliver",
      "discord",
    ]);
    expect(args).not.toContain("--");
    expect(options).toMatchObject({
      cwd: join(TEST_HOME, "hermes-agent"),
      timeout: 15000,
      windowsHide: true,
    });
  });

  it("normalizes the current Hermes jobs.json schema for the schedules UI", async () => {
    const cronDir = join(TEST_HOME, "cron");
    mkdirSync(cronDir, { recursive: true });
    writeFileSync(
      join(cronDir, "jobs.json"),
      JSON.stringify({
        jobs: [
          {
            id: "job-1",
            name: "Paperclip report",
            prompt: "Summarize recent work",
            schedule: { kind: "interval", minutes: 360, display: "every 360m" },
            state: "scheduled",
            enabled: true,
            next_run_at: "2026-05-14T11:34:24.003837-07:00",
            deliver: "discord:#paperclip",
            script: "paperclip_6h_report_context.py",
          },
        ],
      }),
    );

    const jobs = await listCronJobs(true);

    expect(jobs).toEqual([
      expect.objectContaining({
        id: "job-1",
        name: "Paperclip report",
        schedule: "every 360m",
        state: "active",
        enabled: true,
        deliver: ["discord:#paperclip"],
        script: "paperclip_6h_report_context.py",
      }),
    ]);
  });
});
