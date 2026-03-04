## ADDED Requirements

### Requirement: list-workspaces MCP tool
The server SHALL expose a `list-workspaces` tool that reads the local registry and returns all schema-compatible entries without establishing a CDP connection.

#### Scenario: Returns all ready workspaces
- **WHEN** `list-workspaces` is called and registry contains multiple entries in `ready` state
- **THEN** server SHALL return all of them with fields: `workspacePath`, `workspaceId`, `state`, `port`, `role`, `verifiedAt`

#### Scenario: Returns non-ready workspaces with state indicated
- **WHEN** `list-workspaces` is called and some entries are not in `ready` state
- **THEN** server SHALL include those entries with their actual `state` value so caller can distinguish

#### Scenario: Empty registry
- **WHEN** `list-workspaces` is called and registry has no workspace entries
- **THEN** server SHALL return an empty list with a message indicating no workspaces are open

#### Scenario: Includes quota summary when available
- **WHEN** a registry entry contains a `quota` snapshot
- **THEN** server SHALL include `quotaSummary` with model count and `promptCredits.remaining` value

#### Scenario: No CDP connection made
- **WHEN** `list-workspaces` is called
- **THEN** server SHALL NOT open any WebSocket or CDP connection — registry read only
