## ADDED Requirements

### Requirement: Emit no_workspace_ever_opened when registry has no entries
The server SHALL detect "never opened" state as: registry file missing OR registry contains zero non-`__control__` entries. In this state it SHALL emit error code `no_workspace_ever_opened` and suppress cold-start launch entirely.

#### Scenario: Registry file does not exist
- **WHEN** `discoverCDPDetailed` is called and registry file is absent
- **THEN** server SHALL return error code `no_workspace_ever_opened` (not `registry_missing`)

#### Scenario: Registry exists but has no workspace entries
- **WHEN** `discoverCDPDetailed` is called and registry contains only `__control__` keys
- **THEN** server SHALL return error code `no_workspace_ever_opened`

#### Scenario: Cold-start suppressed on no_workspace_ever_opened
- **WHEN** `ask-antigravity` receives `no_workspace_ever_opened` from discovery
- **THEN** server SHALL NOT call `launchAntigravityForWorkspace`
- **THEN** server SHALL return a human-readable message instructing the user to open Antigravity manually

### Requirement: Guidance message content
The error message returned to the caller SHALL instruct the user to open their project in Antigravity and complete first-time authorization before retrying.

#### Scenario: Message includes actionable instruction
- **WHEN** `no_workspace_ever_opened` error is returned to caller
- **THEN** message SHALL contain text directing user to open Antigravity, open their workspace folder, and retry after authorization is complete

#### Scenario: Message does not suggest auto-launch
- **WHEN** `no_workspace_ever_opened` error is returned
- **THEN** message SHALL NOT suggest or attempt automatic launch
