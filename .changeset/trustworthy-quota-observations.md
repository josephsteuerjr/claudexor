---
"@claudexor/schema": patch
"@claudexor/daemon": patch
"@claudexor/cli": patch
"@claudexor/orchestrator": patch
"@claudexor/budget": patch
"@claudexor/harness-agy": patch
---

Reconcile older quota refusals with newer account observations, preserve genuine credential rejections without duplicating poller state, and pace quota reads per affected account. Ordinary Accounts and account-catalog reads retain their first observation instead of repeatedly probing vendors. Discover Antigravity models for the selected account, forward explicitly requested unlisted models with disclosure, and preserve known quota-family applicability for new model IDs.
