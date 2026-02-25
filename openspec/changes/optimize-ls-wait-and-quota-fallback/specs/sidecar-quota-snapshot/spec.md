## ADDED Requirements

### Requirement: Sidecar Quota Collection
The sidecar SHALL collect quota data from local LS user status and publish a normalized snapshot for MCP consumers.

#### Scenario: Sidecar fetches quota successfully
- **WHEN** sidecar polling calls LS user status successfully
- **THEN** sidecar SHALL write a snapshot including timestamp, model quotas, and plan-level credit fields

#### Scenario: Sidecar quota fetch fails temporarily
- **WHEN** a polling cycle fails due to connectivity or parsing error
- **THEN** sidecar SHALL retain the last valid snapshot and record a fetch error without deleting existing state

### Requirement: Snapshot Shape Compatibility
The sidecar snapshot format SHALL be backward-compatible with existing registry consumers.

#### Scenario: Registry contains prior CDP fields
- **WHEN** sidecar updates a registry entry that already includes CDP routing fields
- **THEN** sidecar SHALL preserve existing fields and append/update quota snapshot fields without breaking CDP lookup

### Requirement: Staleness-Aware Quota Consumption
The MCP server SHALL treat stale snapshots as advisory and avoid hard failures.

#### Scenario: Snapshot exceeds freshness threshold
- **WHEN** the server detects that snapshot age exceeds policy freshness threshold
- **THEN** the server SHALL ignore stale quota for hard filtering and use default routing fallback behavior

#### Scenario: Snapshot is missing
- **WHEN** no quota snapshot is available for the target workspace
- **THEN** the server SHALL continue request handling with non-quota routing defaults
