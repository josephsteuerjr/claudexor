---
"claudexor": minor
---

Add durable thread folders: a thread can carry one optional `folder` label (1–120 characters, `null` = none) that the daemon stores and journals, set through `POST /v2/threads` or `PATCH /v2/threads/:id` and returned on every thread projection. A PATCH that changes only the folder keeps the thread's `updatedAt`, so filing never reorders thread lists or changes the `--resume` target. The macOS sidebar groups threads by folder (the plain list while no thread has one; one section per name, then Ungrouped) with Move to Folder, New Folder…, Rename… and Remove Folder…; folder renames and removals skip threads in the trash and report partial failures, and an engine older than folders is reported as such instead of with a raw validation error.
