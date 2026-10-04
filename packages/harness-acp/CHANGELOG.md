# @claudexor/harness-acp

## 3.20.1

### Patch Changes

- Updated dependencies [eb506c1]
- Updated dependencies [dc30eda]
- Updated dependencies [705c2c1]
  - @claudexor/schema@3.20.1
  - @claudexor/core@3.20.1
  - @claudexor/secrets@3.20.1
  - @claudexor/util@3.20.1

## 3.20.0

### Minor Changes

- c12828c: Add a generic ACP v1 client harness with GitHub Copilot CLI as its first vendor.
  Use managed tokens and scoped homes, bounded typed streams, process-tree
  cancellation, a free session doctor and explicit paid write conformance.
  Model inventory is advisory; missing cost remains unknown. Copilot ACP is in
  preview: workspace writes are unfenced when permission callbacks are absent.
  Live input, native login and MCP injection are not included in this stage.

  Port permission, environment, launch, translation and lifecycle semantics from
  Róger Valderrama (@germago119), razzant/ouroboros#769, with the Q00 MIT notice
  retained in the new package.

### Patch Changes

- Updated dependencies [c12828c]
  - @claudexor/core@3.20.0
  - @claudexor/util@3.20.0
  - @claudexor/schema@3.20.0
  - @claudexor/secrets@3.20.0
