import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { PersistenceError, persistenceError } from "./errors.js";
import {
  injectFault,
  parseJson,
  type PersistenceOptions,
  resolveTarget,
  serializeJson,
  syncDirectory,
} from "./filesystem.js";

export class AtomicJsonFile<T> {
  readonly #requestedPath: string;
  readonly #options: PersistenceOptions<T>;

  constructor(path: string, options: PersistenceOptions<T> = {}) {
    this.#requestedPath = path;
    this.#options = options;
  }

  async read(): Promise<T | undefined> {
    const target = await resolveTarget(this.#requestedPath);
    let handle;
    try {
      handle = await open(target.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const bytes = await handle.readFile();
      return parseJson(bytes, this.#options.parse);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof PersistenceError) throw error;
      throw persistenceError(error);
    } finally {
      await handle?.close();
    }
  }

  async replace(value: T): Promise<void> {
    const target = await resolveTarget(this.#requestedPath);
    const bytes = Buffer.concat([serializeJson(value), Buffer.from("\n")]);
    const temporaryPath = join(target.directory, `.${basename(target.path)}.tmp-${randomUUID()}`);
    let handle;
    let renamed = false;

    try {
      handle = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await injectFault(this.#options.faultInjector, "write");
      await handle.writeFile(bytes);
      await injectFault(this.#options.faultInjector, "file-fsync");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await injectFault(this.#options.faultInjector, "rename");
      await rename(temporaryPath, target.path);
      renamed = true;
      await syncDirectory(target.directory, this.#options.faultInjector);
    } catch (error) {
      try {
        await handle?.close();
      } catch {
        // Preserve the operation failure; cleanup is best effort.
      }
      if (!renamed) {
        try {
          await rm(temporaryPath, { force: true });
        } catch {
          // Preserve the operation failure; cleanup is best effort.
        }
      }
      throw persistenceError(error);
    }
  }
}
