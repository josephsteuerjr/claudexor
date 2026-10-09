# Security Policy

Claudexor is a local-first control plane: it runs on your machine, spawns
vendor coding CLIs with your credentials, serves a loopback-only control API,
and applies patches to your repositories. Security reports matter.

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**, not in public issues:

- Open a private advisory via GitHub Security Advisories
  ("Report a vulnerability" on the repository's **Security** tab), or
- email the maintainer at the address on the GitHub profile that owns this
  repository.

Include what you observed, how to reproduce it, the affected version
(`claudexor --version` or the git SHA), and the impact you expect. A minimal
proof-of-concept helps.

Please do not run automated scanners against infrastructure you do not own on
Claudexor's behalf; the product is local, so a local reproduction is enough.

## Response expectations

This is a small project. Expect an initial acknowledgement within about a
week. Fixes ship in a normal release; if a fix is security-sensitive, the
release notes will say so once users have had a reasonable chance to update.

## Supported versions

Only the latest released version is supported. There are no backported
security fixes for older tags; upgrade to the current release.

## Scope and posture

What Claudexor already does, so you can calibrate reports:

- The control API binds `127.0.0.1` only, requires a bearer token
  (timing-safe comparison), and enforces a loopback host/origin guard;
  `/healthz` is the only unauthenticated route.
- Claudexor-managed secrets use the daemon-owned `0600` file store. Vendor-native
  credentials remain in each vendor's own store, which may use the OS Keychain;
  secret material is redacted from event logs, job records, thread stores, and
  reviewer artifacts.
- No telemetry, analytics, or crash reporting is collected (see the Privacy
  section of the README). Outbound traffic comes from configured model/harness
  routes. Generic Web/Search follows the run's external-context policy (default
  `auto`); Browser MCP/navigation requires explicit Browser opt-in. Remote SSH
  reaches only connections explicitly configured and enabled, after which the
  app may connect and retry their event streams automatically. While the daemon
  runs, it may poll configured vendor quota/status sources in the background
  (including Anthropic `oauth/usage`) to maintain routing and readiness. Public
  GitHub/npm lookups cover release-name checks, updates, and download statistics;
  they are user-invoked except the app's update check, which runs only on app
  foreground (there is no background update timer). Local files named
  `telemetry` contain only on-device run evidence and are never transmitted.
- Harness processes run as the signed-in OS user under each vendor CLI's
  native access mode. Claudexor does not add an outer Seatbelt, container, or
  other OS filesystem boundary. Scoped `HOME` and named profile directories
  select the intended account and separate vendor-written state; they do not
  stop the process from reaching other same-user host paths. In particular,
  trusted `full` can read or mutate out-of-project state, and those effects are
  outside Claudexor's patch capture, review, revert, and rollback custody.
- Repository trust gates authorization for an operator at a surface to request
  native `full`; it is not a containment claim. `workspace_write` and `readonly`
  mean the selected adapter's native policy, whose exact enforcement differs by
  vendor. A run marked `execution.delegated` carries the external orchestrator's
  own authority instead and needs no trust record. Two surfaces can set that
  marker — on a one-shot run, or once on a thread created with
  `workspace: "delegated"` and a `workspaceRoot`, whose every later turn then
  inherits it — and what the exemption costs differs between them, so both are
  stated separately. A control-API client holds the daemon token and can already grant
  itself the allow through `POST /v2/trust`, so requiring a second ceremony
  there bought nothing. An MCP tool caller is the host's model: it holds no
  token and has no trust-writing tool, so for it the marker is a real widening.
  One call with `execution.delegated: true` and `access: "full"` now runs
  unsandboxed native `full` on any `repoPath` without the grant, where before it
  received the typed refusal, and the only remaining control is the host's own
  MCP tool-approval policy. `claudexor_thread_create` with
  `workspace: "delegated"` is the persistent form of the same widening: one
  approved creation call makes every later `claudexor_thread_turn` on that thread
  run with delegated authority in the named `workspaceRoot`, including `full`
  access without a grant, with no further approval beyond each turn call's own. The marker is caller-asserted and is not
  authenticated proof that an external orchestrator is really driving the run.
  It is recorded for an auditor in the run's job params, the recorded run start
  request that Exact Retry replays, and the per-attempt confinement disclosure
  on mutating delegated attempts; the immutable contract records the resulting
  `full` effective profile but not which authority admitted it.
- The macOS app cannot originate the marker: its `RunExecution` carries only
  `isolation`. It can re-issue a run that already recorded one, because Retry
  Exact replays the recorded request and the Run Again draft keeps
  `execution`, so both carry `delegated` forward into a new `full` run without a
  grant; `claudexor retry` and `claudexor run-again` behave the same way.
  Delegation-belt sub-runs cannot set it, and a thread turn cannot set it per
  turn either, because its strict execution schema does not accept the field;
  only a thread's creation-time `workspace: "delegated"` binding makes its turns
  carry it, and that binding cannot be changed afterwards. The app cannot create
  such a thread. Either way the harness runs as the signed-in OS user with no
  outer boundary, as described above: a delegated thread's durable scoped `HOME`
  per (thread, harness, account) separates vendor state, but it is not
  containment, and its `workspaceRoot` is not a confinement root. For an externally orchestrated mutating run, the registered/trusted
  project stays `scope.root` while the harness executes in the caller-supplied
  `execution.workspaceRoot`; neither path relationship nor a second trust
  store is implied.

In scope: the CLI, daemon, control API, MCP/ACP servers, the macOS app, and
the host-integration plugin writers. Out of scope: vulnerabilities in the
third-party vendor CLIs (Codex, Claude Code, Cursor, OpenCode) themselves —
report those to their vendors.
