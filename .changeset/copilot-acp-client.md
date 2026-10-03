---
"@claudexor/harness-acp": minor
"@claudexor/cli": minor
"@claudexor/core": minor
"@claudexor/workspace": minor
"@claudexor/util": minor
---

Add a generic ACP v1 client harness with GitHub Copilot CLI as its first vendor.
Use managed tokens and scoped homes, bounded typed streams, process-tree
cancellation, a free session doctor and explicit paid write conformance.
Model inventory is advisory; missing cost remains unknown. Copilot ACP is in
preview: workspace writes are unfenced when permission callbacks are absent.
Live input, native login and MCP injection are not included in this stage.

Port permission, environment, launch, translation and lifecycle semantics from
Róger Valderrama (@germago119), razzant/ouroboros#769, with the Q00 MIT notice
retained in the new package.
