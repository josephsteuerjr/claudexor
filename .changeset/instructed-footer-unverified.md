---
"@claudexor/schema": patch
"@claudexor/orchestrator": patch
---

On routes where the WorkReport footer is only requested (Cursor, Antigravity, ACP), a missing or broken footer no longer fails the run: the run succeeds with `work_state.state: unverified`, a typed `unverified_reason`, and the complete answer kept, including a trailing JSON or code block that is not the footer. Valid `needs_input`/`incomplete` reports still veto, and the native Codex/Claude envelopes stay strict.
