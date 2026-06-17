export { LOOPBACK_HOST, startHost, type RunningHost, type StartHostOptions } from "./host.js";
export { prepareYacaPaths, type PrepareYacaPathsOptions, type YacaPaths } from "./paths.js";
export {
  AtomicJsonFile,
  DurableJsonl,
  PersistenceError,
  type JsonlReadResult,
  type PersistenceErrorCode,
  type PersistenceFaultInjector,
  type PersistenceOperation,
  type PersistenceOptions,
  type QuarantinedJsonlTail,
} from "./platform/persistence/index.js";
export { YACA_VERSION } from "./version.js";
