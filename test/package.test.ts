import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, root)), "utf8");
const present = (path: string): boolean => existsSync(fileURLToPath(new URL(path, root)));

const pkg = JSON.parse(read("package.json")) as {
  name: string;
  version: string;
  license: string;
  main: string;
  types: string;
  bin: Record<string, string>;
  exports: Record<string, unknown>;
  files: string[];
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const tsconfig = JSON.parse(read("tsconfig.json")) as {
  compilerOptions: { outDir: string; sourceMap?: boolean; declarationMap?: boolean };
};
const outDir = tsconfig.compilerOptions.outDir;

/**
 * These tests are about the package as installed by someone else, which is the
 * one configuration this repo never runs. Nothing here builds — a check that
 * needed `dist` would only pass after `npm run build`, and CI runs the suite
 * first on purpose. So every entry point is traced back to the source file tsc
 * will compile it from instead.
 */
const sourceOf = (entry: string): string => {
  const relative = entry.slice(`./${outDir}/`.length);
  return `src/${relative.replace(/\.d\.ts$/, ".ts").replace(/\.js$/, ".ts")}`;
};

const leaves = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Object.values(value as Record<string, unknown>).flatMap(leaves);

// `./package.json` is exported for tooling that reads the manifest; it is a real
// file rather than something the build emits, so it is not an entry point here.
const entryPoints = [
  pkg.main,
  pkg.types,
  ...Object.values(pkg.bin),
  ...leaves(pkg.exports),
].filter((entry) => entry !== "./package.json");

test("every entry point package.json advertises is one the build emits", () => {
  for (const entry of entryPoints) {
    assert.ok(
      entry.startsWith(`./${outDir}/`),
      `package.json points at ${entry}, which is outside the build's outDir (${outDir})`,
    );
    assert.ok(
      present(sourceOf(entry)),
      `package.json points at ${entry}, but ${sourceOf(entry)} does not exist, so tsc will not emit it`,
    );
  }
});

test("everything the package points at is inside files", () => {
  const shipped = new Set(pkg.files);
  assert.ok(
    shipped.has(outDir),
    `package.json points at ${entryPoints.join(", ")} but files does not ship "${outDir}", so an install would have none of them`,
  );
  for (const extra of ["LICENSE", "CHANGELOG.md"]) {
    assert.ok(present(extra), `${extra} is listed in files but does not exist`);
    assert.ok(shipped.has(extra), `files does not ship ${extra}`);
  }
});

test("the maps in the build point at sources the package ships", () => {
  const { sourceMap, declarationMap } = tsconfig.compilerOptions;
  assert.ok(
    !(sourceMap || declarationMap) || pkg.files.includes("src"),
    "tsc emits maps but files does not ship src/, so every map in the package resolves to a file that is not there",
  );
});

test("src imports nothing an install would not have", () => {
  const declared = new Set(Object.keys(pkg.dependencies));
  const dev = new Set(Object.keys(pkg.devDependencies));
  const files = readdirSync(fileURLToPath(new URL("src", root)), { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".ts"));
  assert.ok(files.length > 0, "found no sources under src/");

  for (const file of files) {
    const source = read(`src/${file}`);
    for (const [, specifier] of source.matchAll(/\bfrom\s+"([^"]+)"/g)) {
      const spec = specifier as string;
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      assert.ok(
        declared.has(name as string),
        dev.has(name as string)
          ? `src/${file} imports ${name}, which is only a devDependency — an install would fail to resolve it`
          : `src/${file} imports ${name}, which package.json does not depend on`,
      );
    }
  }
});

test("the CLI keeps the shebang npm's bin wrapper needs", () => {
  for (const [command, entry] of Object.entries(pkg.bin)) {
    const source = read(sourceOf(entry));
    assert.ok(
      source.startsWith("#!/usr/bin/env node\n"),
      `${sourceOf(entry)} backs the \`${command}\` bin but does not start with a node shebang`,
    );
  }
});

test("the bin still runs itself when npm installs it as a symlink", () => {
  // Every other CLI test calls `main` directly, so nothing else exercises the
  // entry-point guard — and the guard is only ever wrong in an install, where
  // node_modules/.bin/retrace is a link and the file behind it is not.
  const dir = mkdtempSync(join(tmpdir(), "retrace-bin-"));
  try {
    for (const [command, entry] of Object.entries(pkg.bin)) {
      // Named `.ts` because Node picks its type stripping off the extension; the
      // part being reproduced is the link, not the name npm gives it.
      const link = join(dir, `${command}.ts`);
      symlinkSync(fileURLToPath(new URL(sourceOf(entry), root)), link);
      const ran = spawnSync(process.execPath, [...process.execArgv, link, "nope"], {
        encoding: "utf8",
      });
      assert.equal(
        ran.status,
        1,
        `\`${command}\` run through a symlink exited ${ran.status} instead of rejecting an unknown command — its entry-point guard did not fire`,
      );
      assert.match(ran.stderr, /unknown command "nope"/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the licence package.json claims is the one in the repo", () => {
  assert.ok(present("LICENSE"), "package.json declares a licence but the repo has no LICENSE file");
  const license = read("LICENSE");
  assert.ok(
    license.includes(`${pkg.license} License`),
    `package.json says the licence is ${pkg.license}, which is not what LICENSE says`,
  );
});

test("the changelog covers the version about to be published", () => {
  const versions = [...read("CHANGELOG.md").matchAll(/^##\s+(\d+\.\d+\.\d+)/gm)].map((m) => m[1]);
  assert.ok(
    versions.includes(pkg.version),
    `CHANGELOG.md has no entry for ${pkg.version}, the version package.json would publish`,
  );
});

test("publishing runs the gates CI runs", () => {
  // Both hooks run on the way to a tarball, so it is the pair of them that has
  // to cover the gates — `prepare` for the build, because a git install runs
  // that one and nothing else.
  const gates = `${pkg.scripts.prepublishOnly ?? ""} ${pkg.scripts.prepare ?? ""}`;
  for (const script of ["typecheck", "test", "build"]) {
    assert.ok(
      gates.includes(script),
      `nothing on the publish path runs ${script}, so \`npm publish\` could ship a build nothing checked`,
    );
  }
});

test("every name the README imports from the package is actually exported", async () => {
  const index = (await import("../src/index.ts")) as Record<string, unknown>;
  const blocks = [...read("README.md").matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*"retrace"/g)];
  assert.ok(blocks.length > 0, "the README no longer shows importing anything from the package");

  for (const [, list] of blocks) {
    for (const name of (list as string).split(",").map((part) => part.trim())) {
      if (!name || name.startsWith("type ")) continue;
      assert.ok(
        name in index,
        `README imports { ${name} } from "retrace", which src/index.ts does not export`,
      );
    }
  }
});
