import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { build } from "esbuild";

const hostRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(hostRoot, "../..");
const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));

await build({
  absWorkingDir: hostRoot,
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  bundle: true,
  define: {
    __YACA_VERSION__: JSON.stringify(manifest.version),
  },
  entryPoints: ["src/cli.ts", "src/index.ts"],
  format: "esm",
  outdir: "dist",
  platform: "node",
  sourcemap: false,
  target: "node22.19",
});
