## 1. Core Implementation - Port Allocation Logic

- [x] 1.1 Add `allocateFreeCdpPort(registry, portRange)` helper function in `extension.js`
- [x] 1.2 Implement registry scanning logic to extract occupied ports from `local_endpoint.port` fields
- [x] 1.3 Implement sequential port selection (lowest available in range)
- [x] 1.4 Add fallback to first port when all ports occupied
- [x] 1.5 Add error handling for registry read failures (missing file, malformed JSON)

## 2. Launch Integration

- [x] 2.1 Update `executeManualLaunch()` to call `allocateFreeCdpPort()` before `buildLaunchArgsForWorkspace()`
- [x] 2.2 Preserve `cdpFixedPort` precedence (fixed port overrides allocation)
- [x] 2.3 Pass allocated port to `buildLaunchArgsForWorkspace()` instead of global `antigravityLaunchPort`
- [x] 2.4 Add logging for allocated port: `Launching with allocated port=${allocatedPort} workspace=${workspacePath}`
- [x] 2.5 Add warning log when all ports occupied: `All CDP ports (9000-9014) occupied, falling back to 9000`

## 3. CDP Probe Range Optimization

- [x] 3.1 Change `DEFAULT_CDP_PORT_SPEC` constant from `'9000-9014,8997-9003,9229,7800-7850'` to `'9000-9014'`
- [x] 3.2 Verify `parsePortCandidates()` correctly parses new spec (should return 15 ports)
- [x] 3.3 Verify `buildCdpProbePlan()` uses new range (no changes needed, reads from constant)

## 4. Unit Tests

- [x] 4.1 Test `allocateFreeCdpPort()` with empty registry (expect 9000)
- [x] 4.2 Test `allocateFreeCdpPort()` with one occupied port (expect 9001)
- [x] 4.3 Test `allocateFreeCdpPort()` with non-sequential occupied ports (9000, 9002, 9004 → expect 9001)
- [x] 4.4 Test `allocateFreeCdpPort()` with all ports occupied (expect 9000 fallback)
- [x] 4.5 Test `allocateFreeCdpPort()` with missing registry file (expect 9000)
- [x] 4.6 Test `allocateFreeCdpPort()` with malformed registry JSON (expect 9000)
- [x] 4.7 Test `parsePortCandidates('9000-9014')` returns 15 ports
- [x] 4.8 Test `parsePortCandidates('9000-9014,8997-9003,9229,7800-7850')` returns 70 ports (verify old behavior)

## 5. Integration Tests

- [ ] 5.1 Launch first Antigravity window, verify registry has `local_endpoint.port: 9000`
- [ ] 5.2 Launch second window, verify registry has two entries with ports 9000 and 9001
- [ ] 5.3 Launch third window, verify registry has three entries with ports 9000, 9001, 9002
- [ ] 5.4 Close second window (port 9001), launch fourth window, verify it reuses port 9001
- [ ] 5.5 Configure `cdpFixedPort: 9010`, launch window, verify it uses 9010 regardless of registry
- [ ] 5.6 Verify CDP connections to each port reach the correct window (test multi-window routing)

## 6. Probe Performance Validation

- [ ] 6.1 Measure probe time with old spec (70 ports) as baseline
- [ ] 6.2 Measure probe time with new spec (15 ports), verify 79% reduction
- [ ] 6.3 Test custom `cdpPortCandidates` config override (e.g., `9000-9020`) works correctly

## 7. Backward Compatibility Tests

- [ ] 7.1 Single-window launch with default config uses port 9000 (no behavior change)
- [ ] 7.2 Existing `antigravityLaunchPort: 9005` config still respected (allocation starts from 9005 if available)
- [ ] 7.3 Existing `cdpFixedPort` config still takes precedence over allocation
- [ ] 7.4 Registry entries from old sidecar version (fixed port 9000) are read correctly

## 8. Error Handling and Edge Cases

- [ ] 8.1 Test port exhaustion scenario (15 windows open, 16th falls back to 9000)
- [ ] 8.2 Verify warning log appears on port exhaustion
- [ ] 8.3 Test registry with invalid port values (null, string, negative) are skipped
- [ ] 8.4 Test registry with `__control__` entries are ignored during port scan
- [ ] 8.5 Test simultaneous launch race condition (manual test: launch two windows at exact same time)

## 9. Documentation and Logging

- [x] 9.1 Add code comments to `allocateFreeCdpPort()` explaining algorithm
- [x] 9.2 Verify launch logs include allocated port for debugging
- [x] 9.3 Update sidecar README with new default CDP port range (if applicable)
- [x] 9.4 Add changelog entry: "Fixed multi-window CDP port conflicts, reduced probe time by 79%"

## 10. Build and Deployment

- [x] 10.1 Build sidecar VSIX with changes: `vsce package`
- [ ] 10.2 Install VSIX in Antigravity for manual testing
- [x] 10.3 Verify no TypeScript/ESLint errors in `extension.js`
- [ ] 10.4 Test sidecar activation and CDP discovery with new code
- [ ] 10.5 Verify rollback path: install previous VSIX, confirm old behavior restored
