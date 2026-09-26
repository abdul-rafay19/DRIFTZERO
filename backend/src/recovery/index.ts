/**
 * P12 Autonomous Recovery Engine — public exports.
 * P13 Recovery Verification — public exports.
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

// P13
export { verifyRecovery } from "./recovery-verification.js";
export { recoveryVerificationInputSchema } from "./recovery-verification-types.js";
export {
  RecoveryVerificationInputError,
  RecoveryVerificationInternalError,
} from "./recovery-verification-errors.js";
