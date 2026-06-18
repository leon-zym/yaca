import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, realpath } from "node:fs/promises";
import { basename, join, relative } from "node:path";
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
  path: string;
  byteLength: number;
}

export interface JsonlReadResult<T> {
  records: T[];
  quarantinedTail: QuarantinedJsonlTail | null;
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
    tail: Buffer,
  ): Promise<QuarantinedJsonlTail> {
    try {
      const requestedDirectory = join(sourceDirectory, `${basename(sourcePath)}.quarantine`);
      await mkdir(requestedDirectory, { mode: 0o700, recursive: true });
      const quarantineDirectory = await realpath(requestedDirectory);
      await chmod(quarantineDirectory, 0o700);
      const relation = relative(sourceDirectory, quarantineDirectory);
      if (relation.startsWith("..") || relation === "" || relation.startsWith("/")) {
        throw new PersistenceError("unsafe_symbolic_link");
      }
      const fingerprint = createHash("sha256").update(source).digest("hex");
      const quarantinePath = join(quarantineDirectory, `tail-${fingerprint}.jsonl`);
      let handle;
      try {
        handle = await open(
          quarantinePath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        await handle.writeFile(tail);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await syncDirectory(quarantineDirectory);
      } catch (error) {
        await handle?.close();
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await open(quarantinePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          await existing.chmod(0o600);
          if (!(await existing.readFile()).equals(tail)) {
            throw new PersistenceError("io_failure");
          }
        } finally {
          await existing.close();
        }
      }
      return { path: quarantinePath, byteLength: tail.byteLength };
    } catch (error) {
      throw persistenceError(error);
    }
  }
}
