---
"@claudexor/harness-codex": patch
---

Codex app-server runs bind finality to the root thread. Frames of native sub-agent threads (codex proactive multi-agent mode) stay on the timeline tagged with their thread, their tokens stay counted and their text becomes a status row, but they never supply the final answer, the terminal turn, the steer target or a root failure; after the root turn completes, settlement is re-checked on any frame or after the poll interval.
