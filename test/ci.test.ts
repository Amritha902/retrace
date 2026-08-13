import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const workflow = readFileSync(fileURLToPath(new URL(".github/workflows/ci.yml", root)), "utf8");
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("package.json", root)), "utf8")) as {
  scripts: Record<string, string>;
  engines: { node: string };
};

/**
 * The workflow is scanned as text rather than parsed as YAML, because what these
 * tests care about — which commands run — is the same whether a step spells them
 * inline or inside a block scalar, and the repo has no YAML parser to add.
 */
const matchAll = (pattern: RegExp): string[] =>
  [...workflow.matchAll(pattern)].map((m) => m[1] as string);

const scriptsRun = matchAll(/npm run ([\w:-]+)/g);
const filesRun = matchAll(/^\s*-?\s*run: node ([\w./-]+)/gm);

test("CI runs the three gates the project promises", () => {
  for (const gate of ["typecheck", "build"]) {
    assert.ok(scriptsRun.includes(gate), `.github/workflows/ci.yml never runs \`npm run ${gate}\``);
  }
  // `test` is the one gate npm has a bare alias for, so accept either spelling.
  assert.ok(
    scriptsRun.includes("test") || /^\s*-?\s*run: npm test\s*$/m.test(workflow),
    ".github/workflows/ci.yml never runs the test suite",
  );
});

test("every script CI runs exists in package.json", () => {
  for (const script of scriptsRun) {
    assert.ok(
      script in pkg.scripts,
      `.github/workflows/ci.yml runs \`npm run ${script}\`, which package.json does not define`,
    );
  }
});

test("every file CI runs directly exists", () => {
  assert.ok(filesRun.length > 0, "CI runs no scripts directly; the demo smoke step is gone");
  for (const file of filesRun) {
    assert.ok(
      existsSync(fileURLToPath(new URL(file, root))),
      `.github/workflows/ci.yml runs \`node ${file}\`, which does not exist`,
    );
  }
});

test("CI runs on every Node version package.json claims to support", () => {
  const versions = (/node:\s*\[([^\]]*)\]/.exec(workflow)?.[1] ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/["']/g, ""))
    .filter(Boolean);
  assert.ok(versions.length > 0, "the CI matrix names no Node versions");

  const floor = /^>=\s*(\d+)(?:\.(\d+))?/.exec(pkg.engines.node);
  assert.ok(floor, `engines.node is "${pkg.engines.node}", which is not a >= range`);
  const [major, minor = "0"] = [Number(floor[1]), floor[2]];

  for (const version of versions) {
    const [entryMajor, entryMinor] = version.split(".").map(Number);
    // A bare major in the matrix is setup-node asking for the newest release of
    // that line, so it clears the floor whenever the line itself does.
    const meetsFloor =
      entryMinor === undefined
        ? (entryMajor as number) >= major
        : (entryMajor as number) > major ||
          ((entryMajor as number) === major && entryMinor >= Number(minor));
    assert.ok(
      meetsFloor,
      `CI tests Node ${version}, below the engines.node floor of ${pkg.engines.node}`,
    );
  }
  assert.ok(
    versions.some((v) => Number(v.split(".")[0]) === major),
    `CI never tests Node ${major}, the oldest version engines.node admits`,
  );
});

test("CI proves the suite passes with no API key", () => {
  const config = workflow
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.ok(
    !config.includes("ANTHROPIC_API_KEY"),
    "CI sets ANTHROPIC_API_KEY, so it no longer proves the suite runs without one",
  );
});
