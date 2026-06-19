import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { PersistenceError, persistenceError } from "./errors.js";
import {
  injectFault,
  parseJson,
  type PersistenceOptions,
  resolveReadOnlyTarget,
  resolveTarget,
  serializeJson,
  syncDirectory,
} from "./filesystem.js";

const MAX_LEDGER_READ_BYTES = 268_435_456;
const MAX_CORRUPT_TAIL_BYTES = MAX_LEDGER_READ_BYTES;

interface LedgerIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly user: bigint;
  readonly links: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly modifiedAt: bigint;
  readonly changedAt: bigint;
}

export interface CorruptTailEvidence {
  readonly id: string;
  readonly byteLength: number;
  readonly read: () => Promise<Buffer>;
}

export interface JsonlReadResult<T> {
  records: T[];
  corruptTail: CorruptTailEvidence | null;
}

export type DurableJsonlStatus = "healthy" | "degraded";

export class DurableJsonl<T> {
  readonly #requestedPath: string;
  readonly #options: PersistenceOptions<T>;
  #degradedResult: JsonlReadResult<T> | undefined;
  #inspected = false;
  #queue: Promise<void> = Promise.resolve();
  #status: DurableJsonlStatus = "healthy";

  constructor(path: string, options: PersistenceOptions<T> = {}) {
    this.#requestedPath = path;
    this.#options = options;
  }

  get status(): DurableJsonlStatus {
    return this.#status;
  }

  append(value: T): Promise<void> {
    if (this.#status === "degraded") {
      return Promise.reject(new PersistenceError("degraded"));
    }
    return this.#enqueue(() => {
      if (this.#status === "degraded") throw new PersistenceError("degraded");
      return this.#append(value);
    });
  }

  readValidPrefix(): Promise<JsonlReadResult<T>> {
    return this.#enqueue(() => this.#readValidPrefix());
  }

  async #readValidPrefix(): Promise<JsonlReadResult<T>> {
    if (this.#degradedResult) return this.#degradedResult;
    const target = await resolveReadOnlyTarget(this.#requestedPath);
    let handle;
    let bytes: Buffer;
    let identity: LedgerIdentity;
    try {
      const pathBefore = await lstat(target.path, { bigint: true });
      this.#assertSafeLedger(pathBefore);
      handle = await open(
        target.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const before = await handle.stat({ bigint: true });
      this.#assertSafeLedger(before);
      this.#assertSameLedger(pathBefore, before);
      if (before.size > BigInt(MAX_LEDGER_READ_BYTES)) {
        throw new PersistenceError("content_too_large");
      }
      await injectFault(this.#options.faultInjector, "read");
      bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      this.#assertSameLedger(before, after);
      if (after.size !== BigInt(bytes.byteLength)) throw new PersistenceError("io_failure");
      const pathAfter = await lstat(target.path, { bigint: true });
      this.#assertSameLedger(after, pathAfter);
      identity = this.#identity(after);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#inspected = true;
        return { records: [], corruptTail: null };
      }
      throw persistenceError(error);
    } finally {
      await handle?.close();
    }

    const records: T[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline === -1) break;
      try {
        records.push(parseJson(bytes.subarray(offset, newline), this.#options.parse));
        offset = newline + 1;
      } catch (error) {
        if (!(error instanceof PersistenceError) || error.code !== "invalid_json") throw error;
        break;
      }
    }

    this.#inspected = true;
    if (offset === bytes.length) return { records, corruptTail: null };
    this.#status = "degraded";
    const tail = bytes.subarray(offset);
    const tailDigest = createHash("sha256").update(tail).digest("hex");
    const id = createHash("sha256")
      .update("yaca:corrupt-tail:v1\0")
      .update(createHash("sha256").update(bytes).digest())
      .update(String(offset))
      .update("\0")
      .update(tailDigest)
      .digest("hex");
    const corruptTail = Object.freeze({
      id,
      byteLength: tail.byteLength,
      read: () => this.#readCorruptTail(target.path, identity, offset, tail.byteLength, tailDigest),
    });
    this.#degradedResult = { records, corruptTail };
    return this.#degradedResult;
  }

  #enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #append(value: T): Promise<void> {
    if (!this.#inspected) await this.#readValidPrefix();
    if (this.#status === "degraded") throw new PersistenceError("degraded");
    const target = await resolveTarget(this.#requestedPath);
    const bytes = Buffer.concat([serializeJson(value), Buffer.from("\n")]);
    let handle;
    try {
      handle = await open(
        target.path,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.chmod(0o600);
      await injectFault(this.#options.faultInjector, "write");
      await handle.writeFile(bytes);
      await injectFault(this.#options.faultInjector, "file-fsync");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await syncDirectory(target.directory, this.#options.faultInjector);
    } catch (error) {
      this.#status = "degraded";
      try {
        await handle?.close();
      } catch {
        // Preserve the operation failure.
      }
      throw persistenceError(error);
    }
  }

  async #readCorruptTail(
    path: string,
    expected: LedgerIdentity,
    offset: number,
    byteLength: number,
    expectedDigest: string,
  ): Promise<Buffer> {
    if (byteLength > MAX_CORRUPT_TAIL_BYTES) {
      throw new PersistenceError("content_too_large");
    }
    let handle;
    try {
      const pathBefore = await lstat(path, { bigint: true });
      this.#assertIdentity(expected, pathBefore);
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat({ bigint: true });
      this.#assertIdentity(expected, before);
      const bytes = Buffer.alloc(byteLength);
      let readOffset = 0;
      while (readOffset < byteLength) {
        const { bytesRead } = await handle.read(
          bytes,
          readOffset,
          byteLength - readOffset,
          offset + readOffset,
        );
        if (bytesRead === 0) throw new PersistenceError("io_failure");
        readOffset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      this.#assertIdentity(expected, after);
      if (createHash("sha256").update(bytes).digest("hex") !== expectedDigest) {
        throw new PersistenceError("io_failure");
      }
      await injectFault(this.#options.faultInjector, "corrupt-tail-verified");
      const pathAfter = await lstat(path, { bigint: true });
      this.#assertIdentity(expected, pathAfter);
      return bytes;
    } catch (error) {
      throw persistenceError(error);
    } finally {
      await handle?.close();
    }
  }

  #assertSafeLedger(stat: BigIntStats): void {
    if (stat.isSymbolicLink()) throw new PersistenceError("unsafe_symbolic_link");
    const owner = process.getuid?.();
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      (stat.mode & 0o777n) !== 0o600n ||
      (owner !== undefined && stat.uid !== BigInt(owner))
    ) {
      throw new PersistenceError("io_failure");
    }
  }

  #assertSameLedger(expected: BigIntStats, actual: BigIntStats): void {
    this.#assertSafeLedger(actual);
    if (
      expected.dev !== actual.dev ||
      expected.ino !== actual.ino ||
      expected.size !== actual.size ||
      expected.mtimeNs !== actual.mtimeNs ||
      expected.ctimeNs !== actual.ctimeNs
    ) {
      throw new PersistenceError("io_failure");
    }
  }

  #identity(stat: BigIntStats): LedgerIdentity {
    return {
      device: stat.dev,
      inode: stat.ino,
      user: stat.uid,
      links: stat.nlink,
      mode: stat.mode & 0o777n,
      size: stat.size,
      modifiedAt: stat.mtimeNs,
      changedAt: stat.ctimeNs,
    };
  }

  #assertIdentity(expected: LedgerIdentity, actual: BigIntStats): void {
    this.#assertSafeLedger(actual);
    if (
      expected.device !== actual.dev ||
      expected.inode !== actual.ino ||
      expected.user !== actual.uid ||
      expected.links !== actual.nlink ||
      expected.mode !== (actual.mode & 0o777n) ||
      expected.size !== actual.size ||
      expected.modifiedAt !== actual.mtimeNs ||
      expected.changedAt !== actual.ctimeNs
    ) {
      throw new PersistenceError("io_failure");
    }
  }
}
