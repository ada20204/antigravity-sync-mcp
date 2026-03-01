## ADDED Requirements

### Requirement: Model And Mode Inputs
The `ask-antigravity` tool SHALL accept optional model and mode hints that influence routing decisions.

#### Scenario: Explicit model hint is provided
- **WHEN** a caller provides a supported model hint
- **THEN** the routing policy SHALL attempt that model first unless it is unavailable or exhausted

#### Scenario: Mode hint is provided without model hint
- **WHEN** a caller provides `mode` and no explicit model
- **THEN** the routing policy SHALL select the first available model from that mode's fallback chain

### Requirement: Quota-Aware Candidate Filtering
The routing policy SHALL avoid models whose quota indicates exhaustion or whose status indicates unavailability.

#### Scenario: Candidate model has zero remaining quota
- **WHEN** a candidate model has `remainingFraction` equal to zero in the current quota snapshot
- **THEN** the routing policy SHALL skip that model and evaluate the next candidate

#### Scenario: Candidate model status is unavailable
- **WHEN** model status marks a candidate as unavailable or degraded beyond policy threshold
- **THEN** the routing policy SHALL skip that model and evaluate the next candidate

### Requirement: Deterministic Fallback Behavior
The system SHALL apply deterministic fallback chains so behavior is predictable and testable.

#### Scenario: Primary candidate cannot be used
- **WHEN** the primary candidate is filtered by quota or status checks
- **THEN** the system SHALL route to the next candidate in the configured chain and continue until one is selected or all fail

#### Scenario: No candidate is eligible
- **WHEN** all candidates in the chain are filtered out
- **THEN** the system SHALL fail with a clear routing error that includes why no model could be selected

### Requirement: Routing Decision Transparency
The system SHALL emit routing diagnostics for each request.

#### Scenario: Request routes with fallback
- **WHEN** routing falls back from one or more candidates
- **THEN** the server SHALL include selected model and fallback reasons in logs or response diagnostics
