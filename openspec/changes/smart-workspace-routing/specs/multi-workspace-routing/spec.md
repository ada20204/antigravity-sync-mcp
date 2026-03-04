## ADDED Requirements

### Requirement: Per-workspace task isolation
The server SHALL maintain a `Map<workspaceKey, AskTask>` instead of a global singleton, where `workspaceKey` is derived from `workspace_id` (preferred), `original_workspace_id`, or `"${ip}:${port}"` as fallback.

#### Scenario: Concurrent tasks on different workspaces
- **WHEN** two `ask-antigravity` calls target different `workspaceKey` values
- **THEN** both SHALL execute concurrently without blocking each other

#### Scenario: Concurrent tasks on same workspace rejected
- **WHEN** an `ask-antigravity` call targets a `workspaceKey` that already has a non-terminal task
- **THEN** server SHALL reject the new call with an error indicating the active task id and status

#### Scenario: Task cleanup on completion
- **WHEN** an `ask-antigravity` task completes, fails, or is cancelled
- **THEN** its entry SHALL be removed from `activeAskTasks` map

### Requirement: workspaceKey present on DiscoveredCDP
The `DiscoveredCDP` result SHALL include a stable `workspaceKey` string computed from the registry entry.

#### Scenario: workspaceKey from workspace_id
- **WHEN** matched registry entry has `workspace_id`
- **THEN** `workspaceKey` SHALL equal `workspace_id`

#### Scenario: workspaceKey fallback for env-override path
- **WHEN** discovery used env-override (`ANTIGRAVITY_CDP_PORT`) and no registry entry exists
- **THEN** `workspaceKey` SHALL equal `"${ip}:${port}"`

### Requirement: antigravity-stop targets specific workspace when multiple are active
`antigravity-stop` SHALL accept an optional `targetDir` parameter for workspace selection.

#### Scenario: Stop with no active tasks
- **WHEN** `antigravity-stop` is called and no tasks are active
- **THEN** server SHALL return "Nothing is running"

#### Scenario: Stop with one active task and no targetDir
- **WHEN** `antigravity-stop` is called, one task is active, and no `targetDir` is provided
- **THEN** server SHALL stop that task (unchanged behavior)

#### Scenario: Stop with multiple active tasks and no targetDir
- **WHEN** `antigravity-stop` is called, multiple tasks are active, and no `targetDir` is provided
- **THEN** server SHALL return an error listing active workspace keys and instructing caller to provide `targetDir`

#### Scenario: Stop with targetDir — exact match required
- **WHEN** `antigravity-stop` is called with `targetDir` that resolves via exact `workspace_id` match to an active task
- **THEN** server SHALL stop only that task

#### Scenario: Stop with targetDir — no exact match
- **WHEN** `antigravity-stop` is called with `targetDir` that produces no exact `workspace_id` match in registry
- **THEN** server SHALL return an error without stopping any task (no fallback auto-selection for stop)
