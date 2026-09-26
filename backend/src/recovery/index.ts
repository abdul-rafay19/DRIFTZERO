/**
 * P12 Autonomous Recovery Engine — public exports.
 */

export { runRecovery } from "./recovery-engine.js";
export { recoveryInputSchema } from "./recovery-types.js";
export {
  RecoveryEngineError,
  RecoveryWorkspaceError,
  RecoveryParseError,
  RecoveryUnauthorizedFileError,
  RecoveryExpectedStateMismatchError,
  RecoveryScopeExceededError,
  RecoveryDuplicateRepairError,
} from "./recovery-errors.js";
