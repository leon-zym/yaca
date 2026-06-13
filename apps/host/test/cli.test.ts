import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const hostRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(hostRoot, "../..");
const cliPath = join(hostRoot, "dist", "cli.js");
const temporaryRoots: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();

afterEach(async () => {
  for (const child of children) child.kill("SIGTERM");
  children.clear();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function runCli(
  ...args: string[]
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: hostRoot,
      env: { ...process.env, NO_COLOR: "1" },
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
    child.on("close", (code) => resolveRun({ code, stderr, stdout }));
  });
}

describe("yaca CLI", () => {
  test("prints help and version without starting the Host", async () => {
    const help = await runCli("--help");
    const version = await runCli("--version");

    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: yaca [start] [options]");
    expect(help.stdout).not.toContain("--data-dir");
    expect(help.stdout).not.toContain("--web-root");
    expect(version).toEqual({ code: 0, stderr: "", stdout: "0.1.0\n" });
  });

  test("starts on an ephemeral loopback port using .yaca below the process home", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "yaca-cli-"));
    temporaryRoots.push(temporary);
    const home = join(temporary, "home");
    const ignoredYacaHome = join(temporary, "ignored-yaca-home");
    const dataRoot = join(home, ".yaca");
    await mkdir(home);

    const child = spawn(
      process.execPath,
      [cliPath, "start", "--host", "127.0.0.1", "--port", "0"],
      {
        cwd: hostRoot,
        env: { ...process.env, HOME: home, NO_COLOR: "1", YACA_HOME: ignoredYacaHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.add(child);
    child.stdout.setEncoding("utf8");

    const url = await new Promise<string>((resolveUrl, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error(`CLI did not start: ${output}`)), 10_000);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/yaca listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match?.[1]) {
          clearTimeout(timeout);
          resolveUrl(match[1]);
        }
      });
      child.on("exit", (code) => reject(new Error(`CLI exited early with ${String(code)}`)));
    });

    expect(await fetch(url).then((response) => response.text())).toContain("<title>yaca</title>");
    expect((await readdir(dataRoot)).sort()).toEqual([
      "agent",
      "app",
      "content",
      "logs",
      "run",
      "tmp",
      "trash",
    ]);

    child.kill("SIGTERM");
    await new Promise((resolveExit) => child.once("exit", resolveExit));
    children.delete(child);
    await expect(readdir(join(dataRoot, "run"))).resolves.not.toContain("host.lock");
    await expect(readdir(ignoredYacaHome)).rejects.toThrow();
  });

  test("starts from the root development command with an explicit development version", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "yaca-dev-cli-"));
    temporaryRoots.push(temporary);
    const home = join(temporary, "home");
    await mkdir(home);

    const child = spawn("pnpm", ["dev", "--port", "0"], {
      cwd: repositoryRoot,
      env: { ...process.env, HOME: home, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const url = await new Promise<string>((resolveUrl, reject) => {
      let output = "";
      const timeout = setTimeout(
        () => reject(new Error(`development CLI did not start: ${output}`)),
        10_000,
      );
      const capture = (chunk: string) => {
        output += chunk;
        const match = output.match(/yaca listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match?.[1]) {
          clearTimeout(timeout);
          resolveUrl(match[1]);
        }
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.on("exit", (code) =>
        reject(new Error(`development CLI exited early with ${String(code)}: ${output}`)),
      );
    });

    const health = await fetch(`${url}/api/health`).then((response) => response.json());
    expect(health).toMatchObject({ status: "ok", version: "0.0.0-dev" });

    child.kill("SIGTERM");
    await new Promise((resolveExit) => child.once("exit", resolveExit));
    children.delete(child);
  });

  test("restarts after SIGKILL leaves a stale Host lock", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "yaca-crash-cli-"));
    temporaryRoots.push(temporary);
    const home = join(temporary, "home");
    const lockPath = join(home, ".yaca", "run", "host.lock");
    await mkdir(home);

    const start = () => {
      const child = spawn(process.execPath, [cliPath, "start", "--port", "0"], {
        cwd: hostRoot,
        env: { ...process.env, HOME: home, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.add(child);
      child.stdout.setEncoding("utf8");
      return child;
    };
    const waitForUrl = (child: ReturnType<typeof spawn>) =>
      new Promise<string>((resolveUrl, reject) => {
        let output = "";
        const timeout = setTimeout(() => reject(new Error(`CLI did not start: ${output}`)), 10_000);
        child.stdout?.on("data", (chunk) => {
          output += chunk;
          const match = output.match(/yaca listening at (http:\/\/127\.0\.0\.1:\d+)/);
          if (match?.[1]) {
            clearTimeout(timeout);
            resolveUrl(match[1]);
          }
        });
        child.on("exit", (code) => reject(new Error(`CLI exited early with ${String(code)}`)));
      });

    const crashed = start();
    await waitForUrl(crashed);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ pid: crashed.pid });
    crashed.kill("SIGKILL");
    await new Promise((resolveExit) => crashed.once("exit", resolveExit));
    children.delete(crashed);
    await expect(access(lockPath)).resolves.toBeUndefined();

    const restarted = start();
    const restartedUrl = await waitForUrl(restarted);
    expect(
      await fetch(`${restartedUrl}/api/health`).then((response) => response.json()),
    ).toMatchObject({ status: "ok" });
    restarted.kill("SIGTERM");
    await new Promise((resolveExit) => restarted.once("exit", resolveExit));
    children.delete(restarted);
    await expect(access(lockPath)).rejects.toThrow();
  });
});
