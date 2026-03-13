/**
 * Restart Semantic Model
 *
 * Defines explicit operation types and triggers for the restart lifecycle,
 * replacing the overloaded flag-based approach (--wait-exit, --cold-start, --clear-auth).
 */

const OPERATION_TYPES = {
    COLD_START: 'cold_start',
    RELAUNCH_IN_PLACE: 'relaunch_in_place',
    RELAUNCH_WITH_AUTH_CLEAR: 'relaunch_with_auth_clear',
    SWITCH_ACCOUNT_RELAUNCH: 'switch_account_relaunch',
    FORCE_RESTART: 'force_restart',
};

const TRIGGERS = {
    MANUAL_COMMAND: 'manual_command',
    ACCOUNT_ADD: 'account_add',
    ACCOUNT_SWITCH: 'account_switch',
    REMOTE_REQUEST: 'remote_request',
    AUTO_RECOVERY: 'auto_recovery',
};

/**
 * Infer operation type from legacy boolean flags.
 * Used during migration to map old-style flags to the new semantic model.
 */
function inferOperationType(flags = {}) {
    if (flags.coldStart) return OPERATION_TYPES.COLD_START;
    if (flags.clearAuth) return OPERATION_TYPES.RELAUNCH_WITH_AUTH_CLEAR;
    if (flags.waitExit) return OPERATION_TYPES.RELAUNCH_IN_PLACE;
    return OPERATION_TYPES.RELAUNCH_IN_PLACE;
}

module.exports = {
    OPERATION_TYPES,
    TRIGGERS,
    inferOperationType,
};
