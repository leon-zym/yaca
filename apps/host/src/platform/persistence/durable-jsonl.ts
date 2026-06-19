import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { PersistenceError, persistenceError } from "./errors.js";
import {
  injectFault,
  parseJson,
  type PersistenceOptions,
  resolveTarget,
  serializeJson,
  syncDirectory,
} from "./filesystem.js";

export interface QuarantinedJsonlTail {
  readonly id: string;
  readonly byteLength: number;
  readonly read: () => Promise<Buffer>;
}

interface EvidenceFileIdentity {
  device: bigint;
  inode: bigint;
}

export interface JsonlReadResult<T> {
  records: T[];
  quarantinedTail: QuarantinedJsonlTail | null;
}

export type DurableJsonlStatus = "healthy" | "degraded";

export interface DurableJsonlOptions<T> extends PersistenceOptions<T> {
  quarantinePrimaryDigest?: (source: Uint8Array) => string;
}

export class DurableJsonl<T> {
  readonly #requestedPath: string;
  readonly #options: DurableJsonlOptions<T>;
  #degradedResult: JsonlReadResult<T> | undefined;
  #inspected = false;
  #queue: Promise<void> = Promise.resolve();
  #status: DurableJsonlStatus = "healthy";

  constructor(path: string, options: DurableJsonlOptions<T> = {}) {
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
    const target = await resolveTarget(this.#requestedPath);
    let handle;
    let bytes: Buffer;
    try {
      handle = await open(target.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      await handle.chmod(0o600);
      await injectFault(this.#options.faultInjector, "read");
      bytes = await handle.readFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#inspected = true;
        return { records: [], quarantinedTail: null };
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
    if (offset === bytes.length) return { records, quarantinedTail: null };
    this.#status = "degraded";
    const quarantinedTail = await this.#quarantine(
      target.directory,
      target.path,
      bytes,
      offset,
      bytes.subarray(offset),
    );
    this.#degradedResult = { records, quarantinedTail };
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

  async #quarantine(
    sourceDirectory: string,
    sourcePath: string,
    source: Buffer,
    validPrefixByteLength: number,
    tail: Buffer,
  ): Promise<QuarantinedJsonlTail> {
    try {
      const requestedDirectory = join(sourceDirectory, `${basename(sourcePath)}.quarantine`);
      const quarantineDirectory = await this.#prepareQuarantineDirectory(
        sourceDirectory,
        requestedDirectory,
      );
      const primaryDigest =
        this.#options.quarantinePrimaryDigest?.(source) ??
        createHash("sha256").update("yaca:source-primary\0").update(source).digest("hex");
      const identity = JSON.stringify({
        version: 1,
        primaryDigest,
        secondaryDigest: createHash("sha512")
          .update("yaca:source-secondary\0")
          .update(source)
          .digest("hex"),
        sourceByteLength: source.byteLength,
        validPrefixByteLength,
        validPrefixDigest: createHash("sha256")
          .update("yaca:valid-prefix\0")
          .update(source.subarray(0, validPrefixByteLength))
          .digest("hex"),
        tailByteLength: tail.byteLength,
        tailDigest: createHash("sha256").update("yaca:tail\0").update(tail).digest("hex"),
      });
      const id = createHash("sha256").update(identity).digest("hex");
      const quarantinePath = join(quarantineDirectory, `tail-${id}.jsonl`);
      let handle;
      try {
        handle = await open(
          quarantinePath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        await handle.chmod(0o600);
        await injectFault(this.#options.faultInjector, "quarantine-write");
        await handle.writeFile(tail);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await syncDirectory(quarantineDirectory);
      } catch (error) {
        await handle?.close();
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const verified = await this.#readEvidence(quarantinePath, tail);
      return Object.freeze({
        id,
        byteLength: tail.byteLength,
        read: () =>
          this.#readEvidence(quarantinePath, tail, verified.identity).then(({ bytes }) => bytes),
      });
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async #prepareQuarantineDirectory(
    sourceDirectory: string,
    requestedDirectory: string,
  ): Promise<string> {
    let candidate;
    try {
      candidate = await lstat(requestedDirectory, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await mkdir(requestedDirectory, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      candidate = await lstat(requestedDirectory, { bigint: true });
    }

    if (candidate.isSymbolicLink()) throw new PersistenceError("unsafe_symbolic_link");
    if (!candidate.isDirectory()) throw new PersistenceError("io_failure");
    const owner = process.getuid?.();
    if (
      (candidate.mode & 0o777n) !== 0o700n ||
      (owner !== undefined && candidate.uid !== BigInt(owner))
    ) {
      throw new PersistenceError("io_failure");
    }
    const quarantineDirectory = await realpath(requestedDirectory);
    const relation = relative(sourceDirectory, quarantineDirectory);
    if (relation.startsWith("..") || relation === "" || isAbsolute(relation)) {
      throw new PersistenceError("unsafe_symbolic_link");
    }
    const verified = await lstat(requestedDirectory, { bigint: true });
    if (
      !verified.isDirectory() ||
      verified.dev !== candidate.dev ||
      verified.ino !== candidate.ino ||
      (verified.mode & 0o777n) !== 0o700n ||
      (owner !== undefined && verified.uid !== BigInt(owner))
    ) {
      throw new PersistenceError("io_failure");
    }
    await injectFault(this.#options.faultInjector, "quarantine-directory-verified");
    const finalIdentity = await lstat(requestedDirectory, { bigint: true });
    if (finalIdentity.isSymbolicLink()) throw new PersistenceError("unsafe_symbolic_link");
    if (
      !finalIdentity.isDirectory() ||
      finalIdentity.dev !== verified.dev ||
      finalIdentity.ino !== verified.ino ||
      (finalIdentity.mode & 0o777n) !== 0o700n ||
      (owner !== undefined && finalIdentity.uid !== BigInt(owner))
    ) {
      throw new PersistenceError("io_failure");
    }
    return quarantineDirectory;
  }

  async #readEvidence(
    path: string,
    expectedBytes: Buffer,
    expectedIdentity?: EvidenceFileIdentity,
  ): Promise<{ bytes: Buffer; identity: EvidenceFileIdentity }> {
    let handle;
    try {
      const candidate = await lstat(path, { bigint: true });
      if (candidate.isSymbolicLink()) throw new PersistenceError("unsafe_symbolic_link");
      if (!candidate.isFile()) throw new PersistenceError("io_failure");
      const owner = process.getuid?.();
      if (
        candidate.nlink !== 1n ||
        (candidate.mode & 0o777n) !== 0o600n ||
        (owner !== undefined && candidate.uid !== BigInt(owner))
      ) {
        throw new PersistenceError("io_failure");
      }
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await handle.stat({ bigint: true });
      if (
        !opened.isFile() ||
        opened.dev !== candidate.dev ||
        opened.ino !== candidate.ino ||
        opened.nlink !== 1n ||
        (opened.mode & 0o777n) !== 0o600n ||
        (owner !== undefined && opened.uid !== BigInt(owner))
      ) {
        throw new PersistenceError("io_failure");
      }
      const before = opened;
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        after.nlink !== 1n ||
        (after.mode & 0o777n) !== 0o600n ||
        (owner !== undefined && after.uid !== BigInt(owner)) ||
        !bytes.equals(expectedBytes)
      ) {
        throw new PersistenceError("io_failure");
      }
      if (
        expectedIdentity &&
        (expectedIdentity.device !== after.dev || expectedIdentity.inode !== after.ino)
      ) {
        throw new PersistenceError("io_failure");
      }
      await injectFault(this.#options.faultInjector, "quarantine-verified");
      const pathIdentity = await lstat(path, { bigint: true });
      if (
        !pathIdentity.isFile() ||
        pathIdentity.dev !== after.dev ||
        pathIdentity.ino !== after.ino ||
        pathIdentity.nlink !== 1n ||
        (pathIdentity.mode & 0o777n) !== 0o600n ||
        (owner !== undefined && pathIdentity.uid !== BigInt(owner))
      ) {
        throw new PersistenceError("io_failure");
      }
      return { bytes, identity: { device: after.dev, inode: after.ino } };
    } catch (error) {
      throw persistenceError(error);
    } finally {
      await handle?.close();
    }
  }
}
