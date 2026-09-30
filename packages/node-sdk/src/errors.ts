export const ErrorCodes = {
  CONFIG_INVALID: 'config.invalid',

  SESSION_TITLE_EMPTY: 'session.title_empty',
  SESSION_EXPORT_NOT_FOUND: 'session.export_not_found',
  SESSION_EXPORT_MISSING_VERSION: 'session.export_missing_version',
  SESSION_INIT_FAILED: 'session.init_failed',

  AGENT_NOT_FOUND: 'agent.not_found',
  TURN_AGENT_BUSY: 'turn.agent_busy',

  GOAL_ALREADY_EXISTS: 'goal.already_exists',
  GOAL_NOT_FOUND: 'goal.not_found',
  GOAL_OBJECTIVE_EMPTY: 'goal.objective_empty',
  GOAL_OBJECTIVE_TOO_LONG: 'goal.objective_too_long',
  GOAL_STATUS_INVALID: 'goal.status_invalid',
  GOAL_NOT_RESUMABLE: 'goal.not_resumable',

  MODEL_NOT_CONFIGURED: 'model.not_configured',
  AUTH_LOGIN_REQUIRED: 'auth.login_required',

  LOOP_MAX_STEPS_EXCEEDED: 'loop.max_steps_exceeded',
  PROVIDER_CONNECTION_ERROR: 'provider.connection_error',

  MCP_SERVER_NOT_FOUND: 'mcp.server_not_found',
  MCP_OAUTH_FAILED: 'mcp.oauth_failed',

  PLUGIN_NOT_FOUND: 'plugin.not_found',
  PLUGIN_LOAD_FAILED: 'plugin.load_failed',

  SHELL_GIT_BASH_NOT_FOUND: 'shell.git_bash_not_found',
} as const;

export type KimiErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface KimiErrorInfo {
  readonly title: string;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action?: string;
}

export const KIMI_ERROR_INFO = {
  'config.invalid': {
    title: 'Invalid configuration',
    retryable: false,
    public: true,
    action: 'Check config.toml and provider/model settings.',
  },

  'session.title_empty': {
    title: 'Session title is empty',
    retryable: false,
    public: true,
    action: 'Provide a non-empty session title.',
  },
  'session.export_not_found': {
    title: 'Session export directory missing',
    retryable: false,
    public: true,
    action: 'The session has not been persisted to disk yet.',
  },
  'session.export_missing_version': {
    title: 'Export version is missing',
    retryable: false,
    public: true,
    action: 'Provide a version when exporting the session.',
  },
  'session.init_failed': {
    title: 'Session init failed',
    retryable: false,
    public: false,
    action: 'Review the init failure details and try again.',
  },

  'agent.not_found': {
    title: 'Agent not found',
    retryable: false,
    public: true,
    action: 'Check the agent id or list available agents.',
  },
  'turn.agent_busy': {
    title: 'Agent is busy',
    retryable: true,
    public: true,
    action: 'Wait for the current turn to finish or steer it.',
  },

  'goal.already_exists': {
    title: 'A goal is already active',
    retryable: false,
    public: true,
    action: 'Use `/goal replace <objective>` to replace the current goal.',
  },
  'goal.not_found': {
    title: 'No goal found',
    retryable: false,
    public: true,
    action: 'Start a goal with `/goal <objective>` first.',
  },
  'goal.objective_empty': {
    title: 'Goal objective is empty',
    retryable: false,
    public: true,
    action: 'Provide a non-empty objective.',
  },
  'goal.objective_too_long': {
    title: 'Goal objective is too long',
    retryable: false,
    public: true,
    action: 'Keep the objective under 4000 characters; reference long details by file path.',
  },
  'goal.status_invalid': {
    title: 'Invalid goal status transition',
    retryable: false,
    public: true,
    action: 'Use a status allowed for this actor (complete, blocked, or impossible).',
  },
  'goal.not_resumable': {
    title: 'Goal is not resumable',
    retryable: false,
    public: true,
    action: 'Only paused goals can be resumed.',
  },

  'model.not_configured': {
    title: 'No model configured',
    retryable: false,
    public: true,
    action: 'Set a default model in config.toml or via setModel.',
  },
  'auth.login_required': {
    title: 'Login required',
    retryable: false,
    public: true,
    action: 'Run the login flow for the provider before retrying.',
  },

  'loop.max_steps_exceeded': {
    title: 'Turn exceeded max steps',
    retryable: false,
    public: true,
    action: 'Increase loop_control.max_steps_per_turn in config.toml or split the task.',
  },
  'provider.connection_error': {
    title: 'Provider connection error',
    retryable: true,
    public: true,
    action: 'Check network connectivity and retry.',
  },

  'mcp.server_not_found': {
    title: 'MCP server not found',
    retryable: false,
    public: true,
    action: 'List configured MCP servers and check the requested name.',
  },
  'mcp.oauth_failed': {
    title: 'MCP OAuth authorization failed',
    retryable: true,
    public: true,
    action: 'Begin the authorization flow again; inspect the error details if it keeps failing.',
  },

  'plugin.not_found': {
    title: 'Plugin not found',
    retryable: false,
    public: true,
    action: 'List installed plugins via /plugins and check the requested id.',
  },
  'plugin.load_failed': {
    title: 'Plugin state failed to load',
    retryable: true,
    public: true,
    action: 'Fix the installed.json file under $KIMI_CODE_HOME/plugins/ and run /plugins reload.',
  },

  'shell.git_bash_not_found': {
    title: 'Git Bash not found',
    retryable: false,
    public: true,
    action: 'Install Git for Windows from https://gitforwindows.org/ or set KIMI_SHELL_PATH to a bash.exe.',
  },
} as const satisfies Record<KimiErrorCode, KimiErrorInfo>;

export function isKimiErrorCode(code: unknown): code is KimiErrorCode {
  return typeof code === 'string' && Object.hasOwn(KIMI_ERROR_INFO, code);
}

export interface KimiErrorOptions {
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export class KimiError extends Error {
  readonly code: KimiErrorCode;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(code: KimiErrorCode, message: string, options: KimiErrorOptions = {}) {
    super(message);
    this.name = 'KimiError';
    this.code = code;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export function isKimiError(error: unknown): error is KimiError {
  return error instanceof KimiError;
}
