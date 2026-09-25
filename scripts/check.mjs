// scripts/check.mjs — read-only local delivery gate.
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { artifact, generate, metadataForVersion } from "./build.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
async function modules(directory) {
  const entries = await readdir(path.join(root, directory), {
    withFileTypes: true,
  });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const name = `${directory}/${entry.name}`;
      return entry.isDirectory()
        ? modules(name)
        : entry.name.endsWith(".mjs")
          ? [name]
          : [];
    }),
  );
  return files.flat().sort();
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed`);
}

const files = [
  "src/index.user.js",
  ...(await modules("src")),
  ...(await modules("scripts")),
  ...(await modules("test")),
];
run(path.join(root, "node_modules/.bin/prettier"), ["--check", ...files]);
for (const file of files.filter(
  (name) => name.endsWith(".mjs") || name.endsWith(".js"),
)) {
  run(process.execPath, ["--check", file]);
}
const { version } = await metadataForVersion();
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json")));
if (lock.version !== version || lock.packages?.[""]?.version !== version) {
  throw new Error("package.json and lockfile project versions differ");
}
const actual = await readFile(artifact, "utf8");
if (
  !actual.startsWith(`// ==UserScript==\n`) ||
  !actual.includes(`// @version      ${version}\n`)
) {
  throw new Error(
    "generated userscript version/header differs from package.json",
  );
}
if (actual !== (await generate()))
  throw new Error("generated userscript is stale; run npm run build");
run(process.execPath, [
  "--test",
  ...files.filter((name) => name.endsWith(".test.mjs")),
]);
