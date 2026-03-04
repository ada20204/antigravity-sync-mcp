## ADDED Requirements

### Requirement: Fallback to best ready workspace when targetDir produces no match
When `targetDir` is provided but its computed `workspace_id` matches no registry entry, the server SHALL fall back to auto-selecting the highest-ranked `ready` entry from the full registry using `rankRegistryEntries`, rather than returning `workspace_not_found`.

#### Scenario: targetDir mismatch with one ready workspace
- **WHEN** `targetDir` is provided, its `workspace_id` matches no registry entry, and exactly one `ready` entry exists in registry
- **THEN** server SHALL connect to that ready entry and include `matchMode: "auto_fallback"` in the discovered result

#### Scenario: targetDir mismatch with multiple ready workspaces
- **WHEN** `targetDir` is provided, its `workspace_id` matches no registry entry, and multiple `ready` entries exist
- **THEN** server SHALL select the highest-ranked entry per `rankRegistryEntries` order (ready → fresh → host role → priority) and include `matchMode: "auto_fallback"`

#### Scenario: targetDir matches exactly
- **WHEN** `targetDir` is provided and its `workspace_id` matches a registry entry
- **THEN** server SHALL use that entry exclusively and include `matchMode: "exact"`

#### Scenario: No targetDir provided
- **WHEN** `targetDir` is absent or empty
- **THEN** server SHALL auto-select the best ready entry and include `matchMode: "auto_fallback"`

#### Scenario: No ready entries after fallback
- **WHEN** fallback is attempted but no `ready` entries exist in registry
- **THEN** server SHALL return the appropriate not-ready error for the top-ranked entry (e.g. `entry_not_ready`, `entry_stale`)

### Requirement: matchMode reported in discovery diagnostics
The `DiscoveredCDP` result object SHALL include a `matchMode` field with value `"exact"` or `"auto_fallback"`.

#### Scenario: matchMode logged on every discovery
- **WHEN** discovery succeeds
- **THEN** server SHALL log `matchMode` value at INFO level
