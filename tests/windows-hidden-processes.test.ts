import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(fullPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
  });
}

describe("Windows child process launch hygiene", () => {
  it("hides every main-process child process window", () => {
    const root = join(process.cwd(), "src", "main");
    const failures: string[] = [];
    const launcherRe = /\b(spawn|execFile|execFileSync|execSync)\s*\(/g;

    for (const file of listTsFiles(root)) {
      const source = readFileSync(file, "utf-8");
      for (const match of source.matchAll(launcherRe)) {
        const block = source.slice(match.index, match.index + 900);
        if (!block.includes("windowsHide")) {
          const line = source.slice(0, match.index).split(/\r?\n/).length;
          failures.push(`${relative(process.cwd(), file)}:${line}:${match[1]}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("starts Hermes Office without npm command wrappers", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "main", "claw3d.ts"),
      "utf-8",
    );

    expect(source).toMatch(/spawnNode\(\s*\[\s*"server\/index\.js"/);
    expect(source).toMatch(
      /spawnNode\(\s*\[\s*"server\/hermes-gateway-adapter\.js"\s*\]/,
    );
    expect(source).not.toContain('spawnNpm(["run", script]');
    expect(source).not.toContain('spawnNpm(["run", "hermes-adapter"]');
  });

  it("propagates the secured local gateway API key to desktop and Office requests", () => {
    const hermesSource = readFileSync(
      join(process.cwd(), "src", "main", "hermes.ts"),
      "utf-8",
    );
    const claw3dSource = readFileSync(
      join(process.cwd(), "src", "main", "claw3d.ts"),
      "utf-8",
    );

    expect(hermesSource).toContain('conn.mode === "local"');
    expect(hermesSource).toContain("API_SERVER_KEY");
    expect(claw3dSource).toContain("HERMES_API_KEY: apiKey");
    expect(claw3dSource).toContain("API_SERVER_KEY");
  });

  it("reports externally managed Hermes gateways as running", () => {
    const hermesSource = readFileSync(
      join(process.cwd(), "src", "main", "hermes.ts"),
      "utf-8",
    );
    const indexSource = readFileSync(
      join(process.cwd(), "src", "main", "index.ts"),
      "utf-8",
    );

    expect(hermesSource).toContain("export async function getGatewayStatus");
    expect(hermesSource).toContain("const ready = await isApiServerReady()");
    expect(indexSource).toMatch(/ipcMain\.handle\("gateway-status", async/);
    expect(indexSource).toContain("return getGatewayStatus();");
    expect(indexSource).toContain("if (await getGatewayStatus()) return true;");
    expect(indexSource).toContain("if (!(await getGatewayStatus()))");
  });
});
