import { chmod, lstat, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AtomicJsonFile,
  DurableJsonl,
  PersistenceError,
  type PersistenceOperation,
} from "@yaca/host";
import { afterEach, describe, expect, test } from "vitest";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

function failAt(target: PersistenceOperation): (operation: PersistenceOperation) => void {
  return (operation) => {
    if (operation === target) {
      throw Object.assign(new Error("injected system operation failure"), { code: "EIO" });
    }
  };
}

describe("AtomicJsonFile", () => {
  test("durably replaces JSON and reconstructs the value", async () => {
    const directory = await temporaryDirectory("yaca-atomic-json-");
    const target = join(directory, "state.json");
    const file = new AtomicJsonFile<{ revision: number; label: string }>(target);

    await expect(file.read()).resolves.toBeUndefined();
    await file.replace({ revision: 1, label: "old" });
    await file.replace({ revision: 2, label: "new" });

    await expect(file.read()).resolves.toEqual({ revision: 2, label: "new" });
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
  });

  test.each([
    ["write", "old"],
    ["file-fsync", "old"],
    ["rename", "old"],
    ["directory-fsync", "new"],
  ] satisfies ReadonlyArray<readonly [PersistenceOperation, string]>)(
    "leaves only a complete old or new value after a %s failure",
    async (operation, visibleLabel) => {
      const directory = await temporaryDirectory(`yaca-atomic-${operation}-`);
      const target = join(directory, "state.json");
      await new AtomicJsonFile<{ label: string }>(target).replace({ label: "old" });

      const failing = new AtomicJsonFile<{ label: string }>(target, {
        faultInjector: failAt(operation),
      });
      await expect(failing.replace({ label: "new" })).rejects.toMatchObject({
        code: "io_failure",
      });

      await expect(new AtomicJsonFile<{ label: string }>(target).read()).resolves.toEqual({
        label: visibleLabel,
      });
      expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
    },
  );

  test("classifies cross-device rename without exposing the target path", async () => {
    const directory = await temporaryDirectory("yaca-atomic-exdev-");
    const target = join(directory, "private-state.json");
    const file = new AtomicJsonFile(target, {
      faultInjector: (operation) => {
        if (operation === "rename") {
          throw Object.assign(new Error(`rename leaked ${target}`), { code: "EXDEV" });
        }
      },
    });

    const failure = await file.replace({ revision: 1 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PersistenceError);
    expect(failure).toMatchObject({ code: "cross_device_rename" });
    expect((failure as Error).message).not.toContain(target);
    expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  test("rejects a symbolic-link JSON file without changing its target", async () => {
    const directory = await temporaryDirectory("yaca-atomic-link-");
    const outside = join(directory, "outside.json");
    const linked = join(directory, "state.json");
    await writeFile(outside, '{"protected":true}\n');
    await symlink(outside, linked);

    await expect(new AtomicJsonFile(linked).replace({ protected: false })).rejects.toMatchObject({
      code: "unsafe_symbolic_link",
    });
    await expect(readFile(outside, "utf8")).resolves.toBe('{"protected":true}\n');
  });
});

describe("DurableJsonl", () => {
  test("serializes concurrent appends into an ordered, durable valid prefix", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-order-");
    const target = join(directory, "events.jsonl");
    const ledger = new DurableJsonl<{ sequence: number }>(target);

    await Promise.all(Array.from({ length: 24 }, (_, sequence) => ledger.append({ sequence })));

    await expect(ledger.readValidPrefix()).resolves.toMatchObject({
      records: Array.from({ length: 24 }, (_, sequence) => ({ sequence })),
      quarantinedTail: null,
    });
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
  });

  test.each([
    ["write", []],
    ["file-fsync", [{ sequence: 1 }]],
    ["directory-fsync", [{ sequence: 1 }]],
  ] satisfies ReadonlyArray<readonly [PersistenceOperation, Array<{ sequence: number }>]>)(
    "locks queued and future appends after an uncertain %s failure",
    async (operation, recordsAfterFailure) => {
      const directory = await temporaryDirectory(`yaca-jsonl-${operation}-`);
      const target = join(directory, "events.jsonl");
      let injected = false;
      const ledger = new DurableJsonl<{ sequence: number }>(target, {
        faultInjector: (currentOperation) => {
          if (!injected && currentOperation === operation) {
            injected = true;
            throw Object.assign(new Error("injected"), { code: "EIO" });
          }
        },
      });

      const uncertain = ledger.append({ sequence: 1 });
      const alreadyQueued = ledger.append({ sequence: 2 });

      await expect(uncertain).rejects.toMatchObject({ code: "io_failure" });
      await expect(alreadyQueued).rejects.toMatchObject({ code: "degraded" });
      expect(ledger.status).toBe("degraded");
      await expect(ledger.readValidPrefix()).resolves.toMatchObject({
        records: recordsAfterFailure,
      });
      await expect(ledger.append({ sequence: 3 })).rejects.toMatchObject({
        code: "degraded",
      });
    },
  );

  test("settles every concurrently queued append after the first uncertain failure", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-concurrent-failure-");
    const target = join(directory, "events.jsonl");
    let injected = false;
    const ledger = new DurableJsonl<{ sequence: number }>(target, {
      faultInjector: (operation) => {
        if (!injected && operation === "write") {
          injected = true;
          throw Object.assign(new Error(`injected at ${target}`), { code: "EIO" });
        }
      },
    });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 16 }, (_, sequence) => ledger.append({ sequence })),
    );

    expect(outcomes.map((outcome) => outcome.status)).toEqual(Array(16).fill("rejected"));
    expect(
      outcomes.map((outcome) =>
        outcome.status === "rejected" ? (outcome.reason as PersistenceError).code : "fulfilled",
      ),
    ).toEqual(["io_failure", ...Array(15).fill("degraded")]);
    expect(ledger.status).toBe("degraded");
    const laterFailure = await ledger.append({ sequence: 99 }).catch((error: unknown) => error);
    expect(laterFailure).toMatchObject({ code: "degraded" });
    expect((laterFailure as Error).message).not.toContain(target);
    await expect(ledger.readValidPrefix()).resolves.toMatchObject({ records: [] });
  });

  test.each([
    ["torn", Buffer.from('{"sequence":')],
    ["corrupt", Buffer.from('not-json\n{"sequence":3}\n')],
  ])(
    "returns the ordered valid prefix and quarantines a %s tail without mutation",
    async (_, tail) => {
      const directory = await temporaryDirectory("yaca-jsonl-tail-");
      const target = join(directory, "events.jsonl");
      const prefix = Buffer.from('{"sequence":1}\n{"sequence":2}\n');
      const original = Buffer.concat([prefix, tail]);
      await writeFile(target, original, { mode: 0o600 });
      const ledger = new DurableJsonl<{ sequence: number }>(target);

      const first = await ledger.readValidPrefix();

      expect(first.records).toEqual([{ sequence: 1 }, { sequence: 2 }]);
      expect(first.quarantinedTail?.byteLength).toBe(tail.byteLength);
      await expect(readFile(first.quarantinedTail!.path)).resolves.toEqual(tail);
      expect((await lstat(first.quarantinedTail!.path)).mode & 0o777).toBe(0o600);
      expect(ledger.status).toBe("degraded");
      await expect(ledger.append({ sequence: 3 })).rejects.toMatchObject({ code: "degraded" });

      const second = await ledger.readValidPrefix();
      expect(second.quarantinedTail?.path).not.toBe(first.quarantinedTail?.path);
      await expect(readFile(first.quarantinedTail!.path)).resolves.toEqual(tail);
      await expect(readFile(target)).resolves.toEqual(original);
    },
  );

  test("reopens an existing partial tail as degraded before any append", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-reopen-tail-");
    const target = join(directory, "events.jsonl");
    const prefix = Buffer.from('{"sequence":1}\n');
    const tail = Buffer.from('{"sequence":');
    const original = Buffer.concat([prefix, tail]);
    await writeFile(target, original, { mode: 0o600 });
    const reopened = new DurableJsonl<{ sequence: number }>(target);

    await expect(reopened.append({ sequence: 2 })).rejects.toMatchObject({ code: "degraded" });

    expect(reopened.status).toBe("degraded");
    await expect(readFile(target)).resolves.toEqual(original);
    const quarantineDirectory = join(directory, "events.jsonl.quarantine");
    const quarantineEntries = await readdir(quarantineDirectory);
    expect(quarantineEntries).toHaveLength(1);
    const quarantinePath = join(quarantineDirectory, quarantineEntries[0]!);
    await expect(readFile(quarantinePath)).resolves.toEqual(tail);
    expect((await lstat(quarantinePath)).mode & 0o777).toBe(0o600);
  });

  test("rejects a symbolic-link ledger without changing its target", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-link-");
    const outside = join(directory, "outside.jsonl");
    const linked = join(directory, "events.jsonl");
    await writeFile(outside, '{"protected":true}\n');
    await symlink(outside, linked);

    await expect(new DurableJsonl(linked).append({ protected: false })).rejects.toMatchObject({
      code: "unsafe_symbolic_link",
    });
    await expect(readFile(outside, "utf8")).resolves.toBe('{"protected":true}\n');
  });
});
