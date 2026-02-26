export { db, ensureLocalUser, getAppDb, getAppDbPath } from "./appDb.js";
export {
  PROJECT_DB_DATA_DIRNAME,
  PROJECT_DB_DIRNAME,
  PROJECT_DB_FILENAME,
  PROJECT_DB_SCHEMA_VERSION,
  ProjectDbError,
  closeAllProjectDbs,
  closeProjectDb,
  detectProjectDbMetadata,
  ensureProjectDb,
  getProjectConfig,
  getProjectDb,
  getProjectDbPath,
  isProjectDbError,
  upsertProjectConfig
} from "./projectDb.js";
export {
  SPLIT_PERSISTENCE_PHASES,
  getSplitPersistencePhase,
  isCleanupPhaseEnabled,
  resolveProjectDatabase
} from "./splitPersistence.js";
export type { SplitPersistenceBackend, SplitPersistenceIntent, SplitPersistencePhase } from "./splitPersistence.js";
