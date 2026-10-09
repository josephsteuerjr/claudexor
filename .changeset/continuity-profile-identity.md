---
"@claudexor/orchestrator": patch
"@claudexor/harness-claude": patch
---

Keep session history bound to both its harness and profile when locating, moving and continuing it. Recognize Claude's failed missing-session diagnostic and continue through the existing evidence packet instead of retrying the unavailable native session. Previously misplaced histories remain preserved and are not relocated automatically.
