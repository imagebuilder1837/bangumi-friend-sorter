import test from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

async function snapshot(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = {};
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(file, base));
    else result[path.relative(base, file)] = await readFile(file, "utf8");
  }
  return result;
}

test("check rejects stale output, version drift, format and syntax errors without rewriting files", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "friend-sorter-check-"));
  try {
    for (const name of [
      "src",
      "scripts",
      "test",
      "package.json",
      "package-lock.json",
    ]) {
      await cp(path.join(root, name), path.join(sandbox, name), {
        recursive: true,
      });
    }
    // A successful sandbox check must not recursively run this gate's own test.
    await rm(path.join(sandbox, "test/check-gate.test.mjs"));
    await symlink(
      path.join(root, "node_modules"),
      path.join(sandbox, "node_modules"),
      "dir",
    );
    const script = path.join(sandbox, "src/index.user.js");
    const lockPath = path.join(sandbox, "package-lock.json");
    const entry = path.join(sandbox, "src/main.mjs");
    const original = {
      script: await readFile(script, "utf8"),
      lock: await readFile(lockPath, "utf8"),
      entry: await readFile(entry, "utf8"),
    };
    const check = () =>
      spawnSync(process.execPath, ["scripts/check.mjs"], {
        cwd: sandbox,
        encoding: "utf8",
        timeout: 60_000,
      });
    for (const [name, corrupt] of [
      [
        "stale artifact",
        async () => writeFile(script, `${original.script}// stale\n`),
      ],
      [
        "version drift",
        async () => {
          const lock = JSON.parse(original.lock);
          lock.version = "999.0.0";
          await writeFile(lockPath, JSON.stringify(lock));
        },
      ],
      ["format error", async () => writeFile(script, `${original.script}  \n`)],
      [
        "syntax error",
        async () => writeFile(entry, `${original.entry}const = ;\n`),
      ],
    ]) {
      await corrupt();
      const before = await snapshot(sandbox);
      const result = check();
      assert.notEqual(result.status, 0, `${name}: check must fail`);
      assert.deepEqual(
        await snapshot(sandbox),
        before,
        `${name}: check must be read-only`,
      );
      if (name === "stale artifact") {
        const rebuilt = spawnSync(process.execPath, ["scripts/build.mjs"], {
          cwd: sandbox,
          encoding: "utf8",
        });
        assert.equal(rebuilt.status, 0, rebuilt.stderr);
        assert.equal(check().status, 0, "rebuilding repairs a stale artifact");
      }
      await writeFile(script, original.script);
      await writeFile(lockPath, original.lock);
      await writeFile(entry, original.entry);
    }
    const rebuilt = spawnSync(process.execPath, ["scripts/build.mjs"], {
      cwd: sandbox,
      encoding: "utf8",
    });
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    const before = await snapshot(sandbox);
    const result = check();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      await snapshot(sandbox),
      before,
      "passing check must be read-only too",
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
