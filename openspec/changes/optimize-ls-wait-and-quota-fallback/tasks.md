## 1. Artifact And Contract Completion

- [x] 1.1 Finalize technical design for hybrid wait-state and quota-aware routing
- [x] 1.2 Create spec deltas for `ls-wait-state-tracking`, `quota-aware-model-selection`, and `sidecar-quota-snapshot`

## 2. Sidecar Quota Snapshot

- [x] 2.1 Extend sidecar registry entry schema to include normalized quota snapshot fields
- [x] 2.2 Implement quota polling from local LS user status with safe error handling and last-good retention
- [x] 2.3 Add/update unit-safe logic to preserve backward-compatible registry fields during writes

## 3. MCP Server Routing And Wait Engine

- [x] 3.1 Add optional `mode` and `model` inputs to `ask-antigravity` schema with backward compatibility
- [x] 3.2 Implement quota snapshot reader and freshness checks in server runtime
- [x] 3.3 Implement deterministic model chain policy and fallback decision engine
- [x] 3.4 Implement hybrid wait-state module (LS stream -> LS trajectory -> DOM)
- [x] 3.5 Integrate policy selection and wait engine into `ask-antigravity` flow while keeping CDP injection as send path

## 4. Verification

- [x] 4.1 Add/extend tests for model routing policy and wait-state fallback behavior
- [x] 4.2 Build sidecar and MCP server successfully
- [x] 4.3 Run test suite and verify no regressions in existing behavior
