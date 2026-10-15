import { DefaultWorkspaceUnavailableError } from '@moonshot-ai/agent-core-v2';

import { ErrorCode } from '../protocol/error-codes';

export function defaultWorkspaceErrorEnvelope(
  error: unknown,
  requestId: string,
):
  | {
      code: number;
      msg: string;
      data: { path: string | null; reason: string };
      request_id: string;
    }
  | undefined {
  if (!(error instanceof DefaultWorkspaceUnavailableError)) return undefined;
  return {
    code: ErrorCode.DEFAULT_WORKSPACE_UNAVAILABLE,
    msg: error.message,
    data: { path: error.details.path ?? null, reason: error.details.reason },
    request_id: requestId,
  };
}
