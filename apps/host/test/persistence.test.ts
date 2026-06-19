import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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

  test("does not begin an append until an earlier read reaches its linearization point", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-read-barrier-");
    const target = join(directory, "events.jsonl");
    await writeFile(target, '{"sequence":0}\n', { mode: 0o600 });
    const readEntered = deferred();
    const releaseRead = deferred();
    let blockedFirstRead = false;
    let writeEntered = false;
    const ledger = new DurableJsonl<{ sequence: number }>(target, {
      faultInjector: async (operation) => {
        if (operation === "read" && !blockedFirstRead) {
          blockedFirstRead = true;
          readEntered.resolve();
          await releaseRead.promise;
        }
        if (operation === "write") writeEntered = true;
      },
    });

    const reading = ledger.readValidPrefix();
    await readEntered.promise;
    const appending = ledger.append({ sequence: 1 });
    await nextTurn();

    expect(writeEntered).toBe(false);
    releaseRead.resolve();
    await expect(reading).resolves.toMatchObject({ records: [{ sequence: 0 }] });
    await expect(appending).resolves.toBeUndefined();
    expect(writeEntered).toBe(true);
  });

  test("does not expose or quarantine a written line before its fsync completes", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-fsync-barrier-");
    const target = join(directory, "events.jsonl");
    const fsyncEntered = deferred();
    const releaseFsync = deferred();
    let blockFirstFsync = true;
    const ledger = new DurableJsonl<{ sequence: number }>(target, {
      faultInjector: async (operation) => {
        if (operation === "file-fsync" && blockFirstFsync) {
          blockFirstFsync = false;
          fsyncEntered.resolve();
          await releaseFsync.promise;
        }
      },
    });

    const appending = ledger.append({ sequence: 1 });
    await fsyncEntered.promise;
    let readSettled = false;
    const reading = ledger.readValidPrefix().then((result) => {
      readSettled = true;
      return result;
    });
    await nextTurn();

    expect(readSettled).toBe(false);
    releaseFsync.resolve();
    await expect(appending).resolves.toBeUndefined();
    await expect(reading).resolves.toEqual({
      records: [{ sequence: 1 }],
      quarantinedTail: null,
    });
    await expect(readdir(join(directory, "events.jsonl.quarantine"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("linearizes 32 interleaved appends and reads in call order", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-linearized-race-");
    const target = join(directory, "events.jsonl");
    const ledger = new DurableJsonl<{ sequence: number }>(target);
    const operations: Array<Promise<unknown>> = [];

    for (let sequence = 0; sequence < 32; sequence += 1) {
      operations.push(ledger.append({ sequence }));
      operations.push(
        ledger.readValidPrefix().then((result) => {
          expect(result.records).toEqual(
            Array.from({ length: sequence + 1 }, (_, current) => ({ sequence: current })),
          );
          expect(result.quarantinedTail).toBeNull();
        }),
      );
    }

    await Promise.all(operations);
    expect(ledger.status).toBe("healthy");
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
      await expect(first.quarantinedTail!.read()).resolves.toEqual(tail);
      const quarantineDirectory = join(directory, "events.jsonl.quarantine");
      const [quarantineName] = await readdir(quarantineDirectory);
      expect((await lstat(join(quarantineDirectory, quarantineName!))).mode & 0o777).toBe(0o600);
      expect(ledger.status).toBe("degraded");
      await expect(ledger.append({ sequence: 3 })).rejects.toMatchObject({ code: "degraded" });

      const second = await ledger.readValidPrefix();
      const reopened = await new DurableJsonl<{ sequence: number }>(target).readValidPrefix();

      expect(second.quarantinedTail?.id).toBe(first.quarantinedTail?.id);
      expect(reopened.quarantinedTail?.id).toBe(first.quarantinedTail?.id);
      expect(await readdir(quarantineDirectory)).toHaveLength(1);
      await expect(first.quarantinedTail!.read()).resolves.toEqual(tail);
      await expect(readFile(target)).resolves.toEqual(original);
    },
  );

  test("does not overwrite or reuse mismatched quarantine evidence", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-quarantine-conflict-");
    const target = join(directory, "events.jsonl");
    const original = Buffer.from('{"sequence":1}\n{"sequence":');
    await writeFile(target, original, { mode: 0o600 });
    await new DurableJsonl<{ sequence: number }>(target).readValidPrefix();
    const quarantineDirectory = join(directory, "events.jsonl.quarantine");
    const [quarantineName] = await readdir(quarantineDirectory);
    const quarantinePath = join(quarantineDirectory, quarantineName!);
    const mismatchedEvidence = Buffer.from("mismatched quarantine evidence");
    await writeFile(quarantinePath, mismatchedEvidence);
    const reopened = new DurableJsonl<{ sequence: number }>(target);

    await expect(reopened.readValidPrefix()).rejects.toMatchObject({ code: "io_failure" });

    expect(reopened.status).toBe("degraded");
    await expect(readFile(quarantinePath)).resolves.toEqual(mismatchedEvidence);
    await expect(readFile(target)).resolves.toEqual(original);
    expect(await readdir(join(directory, "events.jsonl.quarantine"))).toHaveLength(1);
  });

  test("separates different source prefixes when the primary digest collides", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-primary-collision-");
    const target = join(directory, "events.jsonl");
    const tail = Buffer.from('{"sequence":');
    const sourceA = Buffer.concat([Buffer.from('{"source":"A"}\n'), tail]);
    const sourceB = Buffer.concat([Buffer.from('{"source":"B"}\n'), tail]);
    const options = { quarantinePrimaryDigest: () => "forced-primary-collision" };
    await writeFile(target, sourceA, { mode: 0o600 });
    const evidenceA = (
      await new DurableJsonl<{ source: string }>(target, options).readValidPrefix()
    ).quarantinedTail!;
    await writeFile(target, sourceB, { mode: 0o600 });
    const evidenceB = (
      await new DurableJsonl<{ source: string }>(target, options).readValidPrefix()
    ).quarantinedTail!;

    expect(evidenceA.id).not.toBe(evidenceB.id);
    await expect(evidenceA.read()).resolves.toEqual(tail);
    await expect(evidenceB.read()).resolves.toEqual(tail);
    expect(await readdir(join(directory, "events.jsonl.quarantine"))).toHaveLength(2);
    await expect(readFile(target)).resolves.toEqual(sourceB);
  });

  test("rejects evidence replaced with an identical file after the descriptor is issued", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-evidence-replacement-");
    const target = join(directory, "events.jsonl");
    const tail = Buffer.from('{"sequence":');
    await writeFile(target, Buffer.concat([Buffer.from('{"sequence":1}\n'), tail]), {
      mode: 0o600,
    });
    const evidence = (await new DurableJsonl<{ sequence: number }>(target).readValidPrefix())
      .quarantinedTail!;
    const quarantineDirectory = join(directory, "events.jsonl.quarantine");
    const [quarantineName] = await readdir(quarantineDirectory);
    const quarantinePath = join(quarantineDirectory, quarantineName!);
    const originalEvidencePath = join(quarantineDirectory, "original-evidence");
    await rename(quarantinePath, originalEvidencePath);
    await writeFile(quarantinePath, tail, { mode: 0o600 });

    await expect(evidence.read()).rejects.toMatchObject({ code: "io_failure" });

    await expect(readFile(originalEvidencePath)).resolves.toEqual(tail);
    await expect(readFile(quarantinePath)).resolves.toEqual(tail);
  });

  test("rejects inode replacement in the existing-evidence verification window", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-evidence-toctou-");
    const target = join(directory, "events.jsonl");
    const tail = Buffer.from('{"sequence":');
    const source = Buffer.concat([Buffer.from('{"sequence":1}\n'), tail]);
    await writeFile(target, source, { mode: 0o600 });
    await new DurableJsonl<{ sequence: number }>(target).readValidPrefix();
    const quarantineDirectory = join(directory, "events.jsonl.quarantine");
    const [quarantineName] = await readdir(quarantineDirectory);
    const quarantinePath = join(quarantineDirectory, quarantineName!);
    const verified = deferred();
    const releaseVerification = deferred();
    let blockVerification = true;
    const reopened = new DurableJsonl<{ sequence: number }>(target, {
      faultInjector: async (operation) => {
        if (operation === "quarantine-verified" && blockVerification) {
          blockVerification = false;
          verified.resolve();
          await releaseVerification.promise;
        }
      },
    });

    const reading = reopened.readValidPrefix();
    await verified.promise;
    const originalEvidencePath = join(quarantineDirectory, "original-evidence");
    await rename(quarantinePath, originalEvidencePath);
    await writeFile(quarantinePath, tail, { mode: 0o600 });
    releaseVerification.resolve();

    await expect(reading).rejects.toMatchObject({ code: "io_failure" });
    expect(reopened.status).toBe("degraded");
    await expect(readFile(target)).resolves.toEqual(source);
    await expect(readFile(originalEvidencePath)).resolves.toEqual(tail);
    await expect(readFile(quarantinePath)).resolves.toEqual(tail);
  });

  test("does not follow a symbolic-link quarantine candidate", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-evidence-symlink-");
    const target = join(directory, "events.jsonl");
    const tail = Buffer.from('{"sequence":');
    const source = Buffer.concat([Buffer.from('{"sequence":1}\n'), tail]);
    await writeFile(target, source, { mode: 0o600 });
    await new DurableJsonl<{ sequence: number }>(target).readValidPrefix();
    const quarantineDirectory = join(directory, "events.jsonl.quarantine");
    const [quarantineName] = await readdir(quarantineDirectory);
    const quarantinePath = join(quarantineDirectory, quarantineName!);
    const originalEvidencePath = join(quarantineDirectory, "original-evidence");
    const linkedTarget = join(directory, "linked-evidence");
    await rename(quarantinePath, originalEvidencePath);
    await writeFile(linkedTarget, tail, { mode: 0o600 });
    await symlink(linkedTarget, quarantinePath);
    const reopened = new DurableJsonl<{ sequence: number }>(target);

    await expect(reopened.readValidPrefix()).rejects.toMatchObject({
      code: "unsafe_symbolic_link",
    });

    await expect(readFile(linkedTarget)).resolves.toEqual(tail);
    await expect(readFile(originalEvidencePath)).resolves.toEqual(tail);
    await expect(readFile(target)).resolves.toEqual(source);
  });

  test("rejects an unknown quarantine node without changing it", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-evidence-node-");
    const target = join(directory, "events.jsonl");
    const tail = Buffer.from('{"sequence":');
    const source = Buffer.concat([Buffer.from('{"sequence":1}\n'), tail]);
    await writeFile(target, source, { mode: 0o600 });
    await new DurableJsonl<{ sequence: number }>(target).readValidPrefix();
    const quarantineDirectory = join(directory, "events.jsonl.quarantine");
    const [quarantineName] = await readdir(quarantineDirectory);
    const quarantinePath = join(quarantineDirectory, quarantineName!);
    const originalEvidencePath = join(quarantineDirectory, "original-evidence");
    await rename(quarantinePath, originalEvidencePath);
    await mkdir(quarantinePath, { mode: 0o700 });
    const reopened = new DurableJsonl<{ sequence: number }>(target);

    await expect(reopened.readValidPrefix()).rejects.toMatchObject({ code: "io_failure" });

    const unknownNode = await lstat(quarantinePath);
    expect(unknownNode.isDirectory()).toBe(true);
    expect(unknownNode.mode & 0o777).toBe(0o700);
    await expect(readFile(originalEvidencePath)).resolves.toEqual(tail);
    await expect(readFile(target)).resolves.toEqual(source);
  });

  test("bounds concurrent instance quarantine creation to one evidence file", async () => {
    const directory = await temporaryDirectory("yaca-jsonl-evidence-concurrent-");
    const target = join(directory, "events.jsonl");
    const tail = Buffer.from('{"sequence":');
    const source = Buffer.concat([Buffer.from('{"sequence":1}\n'), tail]);
    await writeFile(target, source, { mode: 0o600 });
    const writeEntered = deferred();
    const releaseWrite = deferred();
    let blockCreation = true;
    const creator = new DurableJsonl<{ sequence: number }>(target, {
      faultInjector: async (operation) => {
        if (operation === "quarantine-write" && blockCreation) {
          blockCreation = false;
          writeEntered.resolve();
          await releaseWrite.promise;
        }
      },
    });

    const creating = creator.readValidPrefix();
    await writeEntered.promise;
    const contenders = Array.from({ length: 7 }, () =>
      new DurableJsonl<{ sequence: number }>(target).readValidPrefix(),
    );
    const contenderOutcomes = await Promise.allSettled(contenders);
    expect(
      contenderOutcomes.every(
        (outcome) =>
          outcome.status === "rejected" &&
          (outcome.reason as PersistenceError).code === "io_failure",
      ),
    ).toBe(true);
    releaseWrite.resolve();
    const outcomes = await Promise.allSettled([creating]);

    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<Awaited<typeof creating>> =>
        outcome.status === "fulfilled",
    );
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(
      outcomes
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
        .every((outcome) => (outcome.reason as PersistenceError).code === "io_failure"),
    ).toBe(true);
    expect(await readdir(join(directory, "events.jsonl.quarantine"))).toHaveLength(1);
    expect(new Set(fulfilled.map((outcome) => outcome.value.quarantinedTail!.id)).size).toBe(1);
    await expect(fulfilled[0]!.value.quarantinedTail!.read()).resolves.toEqual(tail);
    await expect(readFile(target)).resolves.toEqual(source);
  });

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
