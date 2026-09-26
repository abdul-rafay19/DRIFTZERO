/**
 * Internal types for IBM Bob integration.
 *
 * IBM Bob is the sole AI provider for DriftZero.
 * Access is via Bob Shell (the `bob` CLI binary) in non-interactive mode.
 *
 * API contract (from official documentation):
 *   - Inference key: set BOBSHELL_API_KEY, invoke `bob --auth-method api-key -p "<prompt>"`
 *   - General key:   same invocation; requires --team-id and --instance-id flags for inference
 *   - Output:        stdout text response from the bob process
 */

export type BobKeyType = "inference" | "general";

/**
 * A request sent to Bob via Bob Shell.
 */
export interface BobRequest {
  /** The prompt text to send to Bob. */
  prompt: string;
  /**
   * Team ID — required when using a General API key.
   * Not needed for Inference keys.
   */
  teamId?: string;
  /**
   * Instance ID — required when using a General API key.
   * Not needed for Inference keys.
   */
  instanceId?: string;
}

/**
 * Normalized response from Bob, owned by DriftZero.
 * Callers outside the bob/ module work with this type only.
 */
export interface BobResponse {
  /** The text content returned by Bob. */
  content: string;
  /** Wall-clock duration of the inference call in milliseconds. */
  durationMs: number;
}
