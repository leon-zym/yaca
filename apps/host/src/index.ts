export { LOOPBACK_HOST, startHost, type RunningHost, type StartHostOptions } from "./host.js";
export {
  prepareYacaPaths,
  type PrepareYacaPathsOptions,
  type YacaPathFaultContext,
  type YacaPathFaultInjector,
  type YacaPathOperation,
  type YacaPaths,
} from "./paths.js";
export {
  AtomicJsonFile,
  DurableJsonl,
  PersistenceError,
  type CorruptTailEvidence,
  type DurableJsonlStatus,
  type JsonlReadResult,
  type PersistenceDiagnostic,
  type PersistenceErrorCode,
  type PersistenceFaultContext,
  type PersistenceFaultInjector,
  type PersistenceOperation,
  type PersistenceOptions,
} from "./platform/persistence/index.js";
export { YACA_VERSION } from "./version.js";
