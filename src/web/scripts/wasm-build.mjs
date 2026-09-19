// Builds crates/rivals-engine into src/web/wasm with wasm-pack (pinned, fetched through
// npx) and records the git tree hash of crates/ it was built from. The output is
// committed: neither Pages CI nor `npm run dev` has a Rust toolchain. Run
// `npm run wasm:build` after any change under crates/.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WASM_PACK_VERSION = "0.15.0";
export const webDir = resolve(fileURLToPath(import.meta.url), "..", "..");
export const repoDir = resolve(webDir, "..", "..");
export const crateDir = join(repoDir, "crates", "rivals-engine");
export const outDir = join(webDir, "wasm");
export const outName = "rivals_engine";
export const buildJsonPath = join(outDir, "BUILD.json");

function git(args, env = {}) {
  // safecrlf=false: the throwaway index normalises line endings like a commit would;
  // the per-file warnings about that are noise here.
  return execFileSync("git", ["-c", "core.safecrlf=false", ...args], {
    cwd: repoDir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

/**
 * Tree hash of crates/ as it is on disk (tracked, modified and untracked files alike),
 * through a throwaway index. It equals `git rev-parse HEAD:crates` once that state is
 * committed, which is what the CI drift check compares against.
 */
export function cratesTreeHash() {
  const scratch = mkdtempSync(join(tmpdir(), "rivals-engine-index-"));
  const indexFile = join(scratch, "index");
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    git(["read-tree", "HEAD"], env);
    git(["add", "--all", "--", "crates"], env);
    const tree = git(["write-tree"], env);
    return git(["rev-parse", `${tree}:crates`]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function run(command, args, cwd) {
  // npx is a .cmd on Windows, so it needs the shell — which then splits any path with a space.
  const shell = process.platform === "win32";
  const argv = shell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
  execFileSync(command, argv, { cwd, stdio: "inherit", shell });
}

export function build() {
  run(
    "npx",
    [
      "--yes",
      `wasm-pack@${WASM_PACK_VERSION}`,
      "build",
      crateDir,
      "--target",
      "web",
      "--release",
      "--out-dir",
      outDir,
      "--out-name",
      outName,
    ],
    webDir,
  );

  // wasm-pack writes an npm package around the artifact; only the loader, the types and
  // the binary are wanted here. Its .gitignore contains "*" and would un-commit the directory.
  for (const generated of [".gitignore", "package.json", "README.md", "LICENSE"]) {
    rmSync(join(outDir, generated), { force: true });
  }

  const rustc = execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim();
  const wasmBytes = readFileSync(join(outDir, `${outName}_bg.wasm`)).length;
  const build = {
    cratesTreeHash: cratesTreeHash(),
    wasmPack: WASM_PACK_VERSION,
    rustc,
    target: "web",
    wasmBytes,
  };
  writeFileSync(buildJsonPath, `${JSON.stringify(build, null, 2)}\n`);
  console.log(`${outName}_bg.wasm: ${wasmBytes} bytes, crates tree ${build.cratesTreeHash}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!existsSync(crateDir)) {
    console.error(`crate not found: ${crateDir}`);
    process.exit(1);
  }
  build();
}
