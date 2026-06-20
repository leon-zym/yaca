import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { PersistenceError, persistenceError } from "./errors.js";
import {
  assertSafeFile,
  captureLeafState,
  injectFault,
  openVerifiedDirectory,
  parseJson,
  type PersistenceOptions,
  resolveReadOnlyTarget,
  serializeJson,
  syncDirectoryHandle,
  verifyDirectoryIdentity,
  verifyFilePath,
  verifyLeafState,
} from "./filesystem.js";

export class AtomicJsonFile<T> {
  readonly #requestedPath: string;
  readonly #options: PersistenceOptions<T>;

  constructor(path: string, options: PersistenceOptions<T> = {}) {
    this.#requestedPath = path;
    this.#options = options;
  }

  async read(): Promise<T | undefined> {
    const target = await resolveReadOnlyTarget(this.#requestedPath);
    let handle;
    let directoryHandle;
    try {
      directoryHandle = await openVerifiedDirectory(target);
      handle = await open(target.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const descriptor = await handle.stat({ bigint: true });
      assertSafeFile(descriptor, target.parent.device);
      await verifyFilePath(target, descriptor);
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (
        descriptor.dev !== after.dev ||
        descriptor.ino !== after.ino ||
        descriptor.size !== after.size ||
        descriptor.mtimeNs !== after.mtimeNs ||
        descriptor.ctimeNs !== after.ctimeNs
      ) {
        throw new PersistenceError("io_failure");
      }
      await verifyFilePath(target, after);
      return parseJson(bytes, this.#options.parse);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && handle === undefined) {
        try {
          await verifyDirectoryIdentity(target);
        } catch (verificationError) {
          throw persistenceError(verificationError);
        }
        return undefined;
      }
      if (error instanceof PersistenceError) throw error;
      throw persistenceError(error);
    } finally {
      await handle?.close();
      await directoryHandle?.close();
    }
  }

  async replace(value: T): Promise<void> {
    const target = await resolveReadOnlyTarget(this.#requestedPath);
    const initialLeaf = await captureLeafState(target);
    const bytes = Buffer.concat([serializeJson(value), Buffer.from("\n")]);
    const temporaryPath = join(target.directory, `.${basename(target.path)}.tmp-${randomUUID()}`);
    const retainedTemporaryId = randomUUID();
    const temporaryTarget = { ...target, path: temporaryPath };
    let handle;
    let directoryHandle;
    let temporaryIdentity;
    let renamed = false;

    try {
      directoryHandle = await openVerifiedDirectory(target);
      await injectFault(this.#options.faultInjector, "temporary-create");
      // ADR-0005 records Node's missing descriptor-relative path operations.
      // Bracketing checks fail visible swaps; an active same-UID swap between
      // this final check and open/rename remains outside the local threat model.
      await verifyDirectoryIdentity(target);
      await verifyLeafState(target, initialLeaf);
      handle = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      temporaryIdentity = await handle.stat({ bigint: true });
      assertSafeFile(temporaryIdentity, target.parent.device);
      await verifyFilePath(temporaryTarget, temporaryIdentity);
      await verifyLeafState(target, initialLeaf);
      await injectFault(this.#options.faultInjector, "write");
      await verifyLeafState(target, initialLeaf);
      await handle.writeFile(bytes);
      await injectFault(this.#options.faultInjector, "file-fsync");
      await verifyLeafState(target, initialLeaf);
      await handle.sync();
      const durableTemporary = await handle.stat({ bigint: true });
      assertSafeFile(durableTemporary, target.parent.device);
      if (
        temporaryIdentity.dev !== durableTemporary.dev ||
        temporaryIdentity.ino !== durableTemporary.ino
      ) {
        throw new PersistenceError("io_failure");
      }
      temporaryIdentity = durableTemporary;
      await verifyFilePath(temporaryTarget, temporaryIdentity);
      await verifyLeafState(target, initialLeaf);
      await injectFault(this.#options.faultInjector, "rename");
      await verifyDirectoryIdentity(target);
      await verifyFilePath(temporaryTarget, temporaryIdentity);
      await verifyLeafState(target, initialLeaf);
      await rename(temporaryPath, target.path);
      renamed = true;
      await verifyDirectoryIdentity(target);
      await verifyFilePath(target, temporaryIdentity);
      await syncDirectoryHandle(directoryHandle, this.#options.faultInjector);
    } catch (error) {
      const failure = persistenceError(error);
      try {
        await handle?.close();
      } catch {
        // Preserve the operation failure; cleanup is best effort.
      }
      let retainedTemporary = false;
      if (!renamed && temporaryIdentity) {
        retainedTemporary = !(await this.#removeTemporaryIfStillOwned(
          temporaryTarget,
          temporaryIdentity,
        ));
      }
      if (retainedTemporary) {
        throw new PersistenceError(failure.code, {
          kind: "retained_temporary",
          id: retainedTemporaryId,
        });
      }
      throw failure;
    } finally {
      await handle?.close().catch(() => undefined);
      await directoryHandle?.close().catch(() => undefined);
    }
  }

  async #removeTemporaryIfStillOwned(
    temporaryTarget: Awaited<ReturnType<typeof resolveReadOnlyTarget>>,
    identity: BigIntStats,
  ): Promise<boolean> {
    try {
      // Node has no openat/unlinkat seam. Cleanup is attempted only after the held
      // parent and temporary descriptor identities still match; active same-UID
      // path replacement between this check and rm is outside the local threat model.
      await verifyDirectoryIdentity(temporaryTarget);
      await verifyFilePath(temporaryTarget, identity);
      await injectFault(this.#options.faultInjector, "temporary-cleanup");
      await verifyDirectoryIdentity(temporaryTarget);
      await verifyFilePath(temporaryTarget, identity);
      await rm(temporaryTarget.path, { force: true });
      return true;
    } catch {
      // Leaving a private temp is safer than deleting through an untrusted path.
      return false;
    }
  }
}
