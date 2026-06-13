import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveRun({ stderr, stdout });
      else
        reject(
          new Error(`${command} ${args.join(" ")} failed (${String(code)})\n${stdout}\n${stderr}`),
        );
    });
  });
}

const temporary = await mkdtemp(join(tmpdir(), "yaca-pack-smoke-"));
let hostProcess;

try {
  const packDirectory = join(temporary, "pack");
  const installDirectory = join(temporary, "install");
  const home = join(temporary, "home");
  await Promise.all([mkdir(packDirectory), mkdir(installDirectory), mkdir(home)]);

  await run("pnpm", ["pack", "--pack-destination", packDirectory]);
  const tarballName = (await readdir(packDirectory)).find((name) => name.endsWith(".tgz"));
  if (!tarballName) throw new Error("pnpm pack did not produce a tarball");
  const tarball = join(packDirectory, tarballName);
  const archive = await run("tar", ["-tzf", tarball]);
  for (const expected of ["package/apps/host/dist/cli.js", "package/apps/web/dist/index.html"]) {
    if (!archive.stdout.split("\n").includes(expected))
      throw new Error(`tarball is missing ${expected}`);
  }

  await writeFile(
    join(installDirectory, "package.json"),
    `${JSON.stringify({ name: "yaca-pack-consumer", private: true }, null, 2)}\n`,
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: installDirectory,
    env: { ...process.env, HOME: home },
  });

  const installedManifest = JSON.parse(
    await readFile(join(installDirectory, "node_modules", "yaca", "package.json"), "utf8"),
  );
  if (Object.keys(installedManifest.dependencies ?? {}).length !== 0) {
    throw new Error("published yaca package must not duplicate bundled Host runtime dependencies");
  }

  const bin = join(installDirectory, "node_modules", ".bin", "yaca");
  const environment = { ...process.env, HOME: home, NO_COLOR: "1" };
  const help = await run(bin, ["--help"], { cwd: installDirectory, env: environment });
  const version = await run(bin, ["--version"], { cwd: installDirectory, env: environment });
  if (!help.stdout.includes("Usage: yaca [start] [options]"))
    throw new Error("installed yaca help failed");
  if (version.stdout.trim() !== installedManifest.version) {
    throw new Error("installed yaca version does not match its published manifest");
  }

  hostProcess = spawn(bin, ["start", "--port", "0"], {
    cwd: installDirectory,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  hostProcess.stdout.setEncoding("utf8");
  const url = await new Promise((resolveUrl, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error(`installed yaca did not start: ${output}`)),
      10_000,
    );
    hostProcess.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/yaca listening at (http:\/\/127\.0\.0\.1:\d+)/u);
      if (match?.[1]) {
        clearTimeout(timeout);
        resolveUrl(match[1]);
      }
    });
    hostProcess.on("exit", (code) =>
      reject(new Error(`installed yaca exited early: ${String(code)}`)),
    );
  });

  const health = await fetch(`${url}/api/health`).then((response) => response.json());
  const shell = await fetch(url).then((response) => response.text());
  if (health.status !== "ok" || health.version !== installedManifest.version) {
    throw new Error("installed yaca health response is invalid");
  }
  if (!shell.includes("<title>yaca</title>"))
    throw new Error("installed yaca Web shell is missing");

  hostProcess.kill("SIGTERM");
  await new Promise((resolveExit) => hostProcess.once("exit", resolveExit));
  hostProcess = undefined;
  const runEntries = await readdir(join(home, ".yaca", "run"));
  if (runEntries.includes("host.lock")) throw new Error("installed yaca did not release host.lock");

  process.stdout.write(`pack smoke passed: ${tarballName}\n`);
} finally {
  hostProcess?.kill("SIGTERM");
  await rm(temporary, { force: true, recursive: true });
}
