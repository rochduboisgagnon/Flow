// What a child process inherits from Flow, and what it must not.
//
// 2026-07-31, security pass. Flow spawns two things today - the whisper-server
// sidecar and a PowerShell focus probe - and neither passed an `env` option, so
// both inherited the ENTIRE environment of the app: every credential the user
// happens to have exported in the shell that launched it.
//
// Today that is mostly harmless. Neither child phones home, and a hostile local
// process could read the environment anyway. What makes it worth fixing now is
// what comes next: the provider wave spawns `claude`, and an inherited
// ANTHROPIC_API_KEY there does not merely leak - it silently BILLS a machine
// key instead of the subscription. The rule has to exist before the call site
// that needs it, or that call site will copy the pattern beside it.
//
// ---------------------------------------------------------------------------
// WHY A DENY LIST AND NOT AN ALLOW LIST
//
// An allow list is the stronger shape and it is the wrong one here. PowerShell
// and whisper-server need a working Windows environment - PATH, SystemRoot,
// TEMP, the locale, the GPU driver's own variables, things this file cannot
// enumerate and would be guessing at. An allow list that guesses breaks the
// child in ways that surface as "transcription stopped working on one machine".
//
// So: remove what is dangerous, keep the rest. That is weaker in theory and
// correct in practice, and saying so plainly is better than implying a
// guarantee this does not give.
// ---------------------------------------------------------------------------

/** Credentials and controls that no child Flow spawns has any business seeing.
 *
 * Two kinds, and the second is the one people forget:
 *
 *  - SECRETS: model-provider keys, cloud credentials, registry tokens. A
 *    transcription binary gaining the ability to bill an account is absurd, and
 *    absurd is the right word for the reason to strip them.
 *  - EXECUTION CONTROLS: NODE_OPTIONS can inject `--require` into any Node
 *    child, which turns an inherited variable into arbitrary code in a process
 *    Flow started. ELECTRON_RUN_AS_NODE changes what an Electron binary even
 *    IS when launched. Neither is a secret; both are more dangerous than one.
 */
export const STRIPPED_CHILD_ENV = [
  // Anthropic - and CLAUDE_CODE_USE_* is the pair that redirects billing.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  // Other model providers
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  // Source forges
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  // Cloud
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_SECRET",
  "GOOGLE_APPLICATION_CREDENTIALS",
  // Execution controls, not secrets - see the note above.
  "NODE_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
] as const;

/** Prefixes stripped wholesale, because these families grow faster than a list
 * can be maintained and a missed one is a credential in a child process. */
export const STRIPPED_CHILD_ENV_PREFIXES = [
  "npm_config_",
  "AWS_",
  "AZURE_",
  // P2 (vague P, 2026-08-02): the two families that decide WHO PAYS for a
  // `claude` this app spawns, as prefixes rather than as names.
  //
  // The exact list above already had five of them and still missed
  // ANTHROPIC_CUSTOM_HEADERS - which is the whole argument for prefixes made
  // concrete: an enumerated list of a growing family is a list that is wrong
  // the day the family grows, and being wrong here means silently billing a
  // machine key instead of the subscription.
  "ANTHROPIC_",
  "CLAUDE_CODE_USE_",
] as const;

/**
 * The environment to hand a spawned child.
 *
 * Pure and total: takes the parent environment, returns a copy without the
 * dangerous names. Never mutates its input - `process.env` is shared with
 * everything else in the process, and a function that quietly emptied it would
 * break Flow itself in a way nobody would connect back to here.
 */
export function childEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const exact = new Set<string>(STRIPPED_CHILD_ENV.map((n) => n.toUpperCase()));
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (exact.has(upper)) continue;
    // Windows environment variable names are case-insensitive, so the prefix
    // test has to be too - otherwise `aws_secret_access_key` walks straight
    // through a list written in capitals.
    if (STRIPPED_CHILD_ENV_PREFIXES.some((p) => upper.startsWith(p.toUpperCase()))) continue;
    out[key] = value;
  }
  return out;
}
