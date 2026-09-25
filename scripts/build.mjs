// scripts/build.mjs — generate the tracked userscript without modifying source modules.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { rollup } from "rollup";
import prettier from "prettier";

const root = fileURLToPath(new URL("../", import.meta.url));
export const artifact = path.join(root, "src/index.user.js");
const template = path.join(root, "src/metadata.txt");

export async function metadataForVersion() {
  const { version } = JSON.parse(
    await readFile(path.join(root, "package.json")),
  );
  if (
    typeof version !== "string" ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      version,
    )
  ) {
    throw new Error(
      "package.json must contain a valid explicit semver version",
    );
  }
  const text = await readFile(template, "utf8");
  if (
    (text.match(/\{\{VERSION\}\}/g) ?? []).length !== 1 ||
    !/^\/\/ @version\s+\{\{VERSION\}\}$/m.test(text)
  ) {
    throw new Error(
      "metadata template must have exactly one @version placeholder",
    );
  }
  return { version, header: text.replace("{{VERSION}}", version).trimEnd() };
}

export async function generate() {
  const { header } = await metadataForVersion();
  const bundle = await rollup({
    input: path.join(root, "src/main.mjs"),
    treeshake: false,
    onwarn(warning) {
      throw new Error(`Rollup: ${warning.message}`);
    },
  });
  try {
    const { output } = await bundle.generate({
      format: "iife",
      sourcemap: false,
    });
    if (
      output.length !== 1 ||
      output[0].imports.length ||
      output[0].dynamicImports.length
    ) {
      throw new Error("Expected one self-contained browser script");
    }
    const notice =
      "// Generated from src/main.mjs and its src/*.mjs imports. Do not edit; run npm run build.\n";
    const formatted = await prettier.format(output[0].code, {
      filepath: artifact,
    });
    return `${header}\n${notice}${formatted}`;
  } finally {
    await bundle.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await writeFile(artifact, await generate());
}
