## ADDED Requirements

### Requirement: Layered Wait State Determination
The system SHALL determine `ask-antigravity` generation completion using LS reactive updates first, LS trajectory polling second, and DOM polling as a final fallback.

#### Scenario: LS reactive updates determine completion
- **WHEN** the server resolves a cascade identifier and successfully subscribes to reactive updates
- **THEN** the wait state engine SHALL use reactive update terminal signals as the primary completion source

#### Scenario: LS stream unavailable falls back to trajectory polling
- **WHEN** reactive updates cannot be started or terminate without a usable terminal signal
- **THEN** the wait state engine SHALL poll trajectory status before using DOM polling

#### Scenario: LS state sources unavailable falls back to DOM polling
- **WHEN** the server cannot use reactive updates or trajectory polling for the active request
- **THEN** the server SHALL continue waiting using the existing DOM polling completion check

### Requirement: Backward-Compatible Ask Flow
The system SHALL preserve successful `ask-antigravity` behavior for callers that provide only a `prompt` argument.

#### Scenario: Legacy prompt-only call still completes
- **WHEN** a caller invokes `ask-antigravity` with only `prompt`
- **THEN** the server SHALL send the prompt and return the extracted final answer using fallback-safe waiting behavior

### Requirement: Wait Source Diagnostics
The system SHALL record which wait source completed the request for observability and debugging.

#### Scenario: Completion source is logged
- **WHEN** an `ask-antigravity` request completes or times out
- **THEN** the server SHALL log the active wait source and any fallback transitions used during the request
