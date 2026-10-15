import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';

export const DefaultWorkspaceErrors = {
  codes: {
    DEFAULT_WORKSPACE_UNAVAILABLE: 'default_workspace.unavailable',
  },
  info: {
    'default_workspace.unavailable': {
      title: 'Default workspace unavailable',
      retryable: false,
      public: true,
      action: 'Fix the folder or choose another default workspace location.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(DefaultWorkspaceErrors);

export type DefaultWorkspaceUnavailableReason =
  | 'blocked_by_file'
  | 'permission_denied'
  | 'missing_parent'
  | 'no_space'
  | 'read_only'
  | 'invalid_path'
  | 'documents_unavailable'
  | 'unknown';

export type DefaultWorkspaceUnavailableDetails = {
  readonly path: string | undefined;
  readonly reason: DefaultWorkspaceUnavailableReason;
};

export class DefaultWorkspaceUnavailableError extends Error2 {
  declare readonly details: DefaultWorkspaceUnavailableDetails;

  constructor(details: DefaultWorkspaceUnavailableDetails, message: string, cause?: unknown) {
    super(DefaultWorkspaceErrors.codes.DEFAULT_WORKSPACE_UNAVAILABLE, message, { details, cause });
    this.name = 'DefaultWorkspaceUnavailableError';
  }
}
