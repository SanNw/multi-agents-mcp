# Focused Security Assessment

Date: 2026-10-14. Target: MULTIAGENTS-MCP 0.4.1.

## Scope and Method

Source review and executable adversarial probes of the local stdio MCP,
using isolated temporary state and a synthetic loopback Chat Completions
backend. No production gateway, real API key, user database, or external
provider was attacked. Strix was unavailable; this is a focused manual
assessment with regression tests, not a full independent penetration test
or certification. No paid scanner or autonomous scanning service was used.

The trust model is one trusted local MCP client, not a public HTTP service
or multi-tenant server. Model responses are untrusted proposals. A local
attacker who can already modify private state is outside that boundary.

## Findings and Changes

| Finding | Impact | Resolution |
| --- | --- | --- |
| New job directories inherited umask (755 with umask 022) | Low: another local user could list job filenames. Files remained 600; disclosure of file contents was not demonstrated. | New directories explicitly use 700. Existing directories are not silently modified; operators must verify their permissions. |
| Terminal job status became visible before the final JSON rename | Reliability: another reader could observe success while persisted output was still stale. The original CI reproduced this timing window. | Final status is published in memory after persistence completes. |
| Default configuration depended on caller working directory | Packaging correctness: npm CLI usage outside a source checkout failed. | Default agent configuration resolves relative to the installed module; explicit private overrides remain supported. |

No arbitrary command execution or approval bypass was observed in the
tested stdio paths. This statement is limited to the probes below.

## Reproducible Checks

- `src/security.test.ts`: traversal and private-file proposals, unknown action
  types, injected approval fields, workflow budget limits, private job directory
  creation, invalid state identifiers, credential-pattern redaction, and config
  loading from an unrelated working directory.
- `src/security-mcp.test.ts`: real MCP handshake; traversal requests through
  job/workflow tools; unknown provider rejection; proposed shell command cannot
  execute, even after workflow approval; result recording before approval and
  premature step acceptance are rejected; no duplicate inference while awaiting
  review. A sentinel file proves the proposed command was not executed.
- Existing tests cover profile credential isolation, authentication errors
  without automatic retry, interrupted streams without replay, rejected/failed
  workflow actions, idempotence, uncertain submission and state ownership.
- `scripts/package.test.mjs`: npm package inventory includes executable and
  default configs but excludes test code, source, private state and credentials.

Run through `npm test` on a disposable checkout. CI builds and tests Node 20
and 24; no upstream credentials are required. Dependency audit must be reported
separately and is not proof of exploit coverage.

## Residual Risk and Exclusions

- No Strix scan, fuzzing campaign, load/long-duration exhaustion test, or
  independent review was performed. No public HTTP transport exists to assess.
- Gateway/provider security, real billing behavior and upstream inference
  availability were not pentested.
- Approved commands remain untrusted data: the client must check authorization,
  workspace scope, shell arguments and symlinks before executing them itself.
- State privacy depends on the filesystem. Windows mounts may not enforce
  POSIX modes; use private Linux-native directories. Check existing directories.
- Direct delegation permits large caller-supplied contexts/options; the trusted
  client should apply its own resource and cost budgets. Workflows have stricter
  built-in limits. This is not a hardened untrusted multi-user endpoint.
- Redaction is pattern-based, not a universal secret detector. Do not supply
  secrets as task context. State and model output may contain sensitive text.
- File checkpoints do not provide exactly-once external effects or complete
  guarantees under disk failure or sudden process termination.

Report vulnerabilities privately as described in [SECURITY.md](../SECURITY.md).
