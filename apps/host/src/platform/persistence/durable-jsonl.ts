import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
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
  #inspected = false;
  #pending: Promise<void> = Promise.resolve();
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
    const operation = this.#pending.then(() => {
      if (this.#status === "degraded") throw new PersistenceError("degraded");
      return this.#append(value);
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  async readValidPrefix(): Promise<JsonlReadResult<T>> {
    await this.#pending;
    return this.#readValidPrefix();
  }

  async #readValidPrefix(): Promise<JsonlReadResult<T>> {
    const target = await resolveTarget(this.#requestedPath);
    let handle;
    let bytes: Buffer;
    try {
      handle = await open(target.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      await handle.chmod(0o600);
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
      bytes.subarray(offset),
    );
    return { records, quarantinedTail };
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
    tail: Buffer,
  ): Promise<QuarantinedJsonlTail> {
    try {
      const requestedDirectory = join(sourceDirectory, `${basename(sourcePath)}.quarantine`);
      await mkdir(requestedDirectory, { mode: 0o700, recursive: true });
      const quarantineDirectory = await realpath(requestedDirectory);
      const relation = relative(sourceDirectory, quarantineDirectory);
      if (relation.startsWith("..") || relation === "" || relation.startsWith("/")) {
        throw new PersistenceError("unsafe_symbolic_link");
      }
      const quarantinePath = join(quarantineDirectory, `tail-${randomUUID()}.jsonl`);
      const handle = await open(
        quarantinePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(tail);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(quarantineDirectory);
      return { path: quarantinePath, byteLength: tail.byteLength };
    } catch (error) {
      throw persistenceError(error);
    }
  }
}
