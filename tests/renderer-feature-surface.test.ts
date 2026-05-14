import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = join(__dirname, "..");
const screensDir = join(ROOT, "src", "renderer", "src", "screens");
const layoutSrc = readFileSync(
  join(screensDir, "Layout", "Layout.tsx"),
  "utf-8",
);
const preloadSrc = readFileSync(
  join(ROOT, "src", "preload", "index.ts"),
  "utf-8",
);

function walkTsx(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const file = join(dir, entry);
    if (statSync(file).isDirectory()) files.push(...walkTsx(file));
    else if (file.endsWith(".tsx")) files.push(file);
  }
  return files;
}

function uniqueMatches(src: string, pattern: RegExp): string[] {
  return [...new Set([...src.matchAll(pattern)].map((m) => m[1]))].sort();
}

describe("renderer feature surface", () => {
  it("keeps every sidebar destination mounted by the layout", () => {
    const navViews = uniqueMatches(
      layoutSrc,
      /\{\s*view:\s*"([^"]+)".*?labelKey:\s*"navigation\.[^"]+"\s*\}/g,
    );
    const mountedViews = [
      ...new Set(
        [...layoutSrc.matchAll(/visitedViews\.has\("([^"]+)"\)/g)]
          .map((m) => m[1])
          .concat(
            [...layoutSrc.matchAll(/paneStyle\("([^"]+)"\)/g)].map((m) => m[1]),
          ),
      ),
    ].sort();

    expect(navViews).toEqual([
      "agents",
      "chat",
      "gateway",
      "kanban",
      "memory",
      "models",
      "office",
      "providers",
      "schedules",
      "sessions",
      "settings",
      "skills",
      "soul",
      "tools",
    ]);
    expect(mountedViews).toEqual(expect.arrayContaining(navViews));
  });

  it("exposes every Hermes API method used by renderer screens", () => {
    const screenApis = new Map<string, string[]>();
    for (const file of walkTsx(screensDir)) {
      const src = readFileSync(file, "utf-8");
      const methods = uniqueMatches(src, /window\.hermesAPI\.(\w+)/g);
      if (methods.length > 0) screenApis.set(relative(ROOT, file), methods);
    }

    const exposedMethods = new Set(
      uniqueMatches(preloadSrc, /^\s{2}(\w+)\s*:/gm),
    );
    const missing = [...screenApis.entries()].flatMap(([file, methods]) =>
      methods
        .filter((method) => !exposedMethods.has(method))
        .map((method) => `${file}: ${method}`),
    );

    expect(screenApis.size).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });
});
