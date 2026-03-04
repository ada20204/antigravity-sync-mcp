## ADDED Requirements

### Requirement: Sidecar allocates unique CDP ports per window

The sidecar SHALL allocate a unique CDP port from the range `9000-9014` for each Antigravity window launch, reading the registry to identify occupied ports and selecting the next available port.

#### Scenario: First window launch with empty registry
- **WHEN** sidecar launches the first Antigravity window and registry has no workspace entries
- **THEN** sidecar SHALL allocate port 9000 and launch with `--remote-debugging-port=9000`

#### Scenario: Second window launch with one occupied port
- **WHEN** sidecar launches a second Antigravity window and registry shows port 9000 occupied
- **THEN** sidecar SHALL allocate port 9001 and launch with `--remote-debugging-port=9001`

#### Scenario: Launch with multiple occupied ports
- **WHEN** sidecar launches a window and registry shows ports 9000, 9001, 9003 occupied
- **THEN** sidecar SHALL allocate port 9002 (first available) and launch with `--remote-debugging-port=9002`

#### Scenario: All ports occupied (exhaustion)
- **WHEN** sidecar launches a window and all ports 9000-9014 are occupied in registry
- **THEN** sidecar SHALL fall back to port 9000 and log a warning message

#### Scenario: User-configured fixed port overrides allocation
- **WHEN** user has configured `cdpFixedPort: 9010` and sidecar launches a window
- **THEN** sidecar SHALL use port 9010 regardless of registry state (existing behavior preserved)

### Requirement: Registry entries reflect actual CDP ports

Each workspace entry in the registry SHALL contain the actual CDP port used by that window in the `local_endpoint.port` field.

#### Scenario: Multiple windows have distinct ports in registry
- **WHEN** three Antigravity windows are launched on ports 9000, 9001, 9002
- **THEN** registry SHALL contain three workspace entries with `local_endpoint.port` values of 9000, 9001, and 9002 respectively

#### Scenario: Registry port matches actual debugger endpoint
- **WHEN** server reads registry entry with `local_endpoint.port: 9005`
- **THEN** connecting to `127.0.0.1:9005/json/list` SHALL return the CDP target for that workspace

### Requirement: CDP probe range is 9000-9014

The sidecar SHALL use `9000-9014` as the default CDP port candidate range for probing, removing unused port ranges.

#### Scenario: Default probe range contains 15 ports
- **WHEN** sidecar initializes with default configuration
- **THEN** `DEFAULT_CDP_PORT_SPEC` SHALL equal `"9000-9014"` (15 ports)

#### Scenario: Probe does not scan removed ranges
- **WHEN** sidecar probes for CDP endpoints with default configuration
- **THEN** sidecar SHALL NOT probe ports 7800-7850, 8997-8999, or 9229

#### Scenario: User can override probe range via config
- **WHEN** user configures `cdpPortCandidates: "9000-9020"`
- **THEN** sidecar SHALL probe ports 9000-9020 (21 ports)

### Requirement: Backward compatibility with single-window setups

Single-window Antigravity setups SHALL continue to use port 9000 by default with no behavior change.

#### Scenario: Single window uses port 9000
- **WHEN** user opens one Antigravity window with default configuration
- **THEN** sidecar SHALL allocate port 9000 (same as previous behavior)

#### Scenario: Existing config values remain valid
- **WHEN** user has `antigravityLaunchPort: 9005` configured
- **THEN** sidecar SHALL attempt to allocate port 9005 if available, otherwise select next available port

### Requirement: Port allocation is deterministic and sequential

Port allocation SHALL be deterministic, selecting the lowest available port in the range to ensure predictable behavior.

#### Scenario: Allocation selects lowest available port
- **WHEN** registry shows ports 9000, 9002, 9004 occupied
- **THEN** sidecar SHALL allocate port 9001 (lowest available)

#### Scenario: Allocation is idempotent for same registry state
- **WHEN** allocation function is called twice with identical registry state
- **THEN** both calls SHALL return the same port number

### Requirement: Port allocation handles registry read failures gracefully

If registry read fails, sidecar SHALL fall back to default port 9000 to ensure launch succeeds.

#### Scenario: Registry file missing
- **WHEN** sidecar attempts to allocate port and registry file does not exist
- **THEN** sidecar SHALL allocate port 9000 and proceed with launch

#### Scenario: Registry file corrupted
- **WHEN** sidecar attempts to allocate port and registry JSON is malformed
- **THEN** sidecar SHALL allocate port 9000 and log a warning

### Requirement: Allocation logs port selection for debugging

Sidecar SHALL log the allocated CDP port during launch to aid debugging.

#### Scenario: Launch logs allocated port
- **WHEN** sidecar launches Antigravity with allocated port 9003
- **THEN** sidecar SHALL log message containing `port=9003` and `workspace=<path>`

#### Scenario: Exhaustion logs warning
- **WHEN** all ports 9000-9014 are occupied and sidecar falls back to 9000
- **THEN** sidecar SHALL log warning message indicating port exhaustion
