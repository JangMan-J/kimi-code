import type { QuestionRequest as CoreQuestionRequest } from '@moonshot-ai/agent-core-v2/agent/interaction/question';
import type { ToolInputDisplay } from '@moonshot-ai/agent-core-v2/tool/toolInputDisplay';
import type { ContentPart } from '@moonshot-ai/kosong';

export type {
  ApprovalDecision,
  ApprovalResponse,
} from '@moonshot-ai/agent-core-v2/agent/interaction/approval';
export type {
  QuestionAnswerMethod,
  QuestionAnswers,
  QuestionItem,
  QuestionOption,
  QuestionResponse,
  QuestionResult,
} from '@moonshot-ai/agent-core-v2/agent/interaction/question';

export type ApprovalScope = 'session';

export interface ApprovalRequest {
  readonly turnId?: number | undefined;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ToolInputDisplay;
  /** The agent whose tool call needs approval: `main` or a subagent id. */
  readonly agentId?: string;
}

export interface QuestionRequest extends CoreQuestionRequest {
  /** The agent asking the question: `main` or a subagent id. */
  readonly agentId?: string;
}

export interface ToolCallRequest {
  readonly turnId?: number | undefined;
  readonly toolCallId: string;
  readonly args: unknown;
}

export interface ToolCallResponse {
  readonly output: string | ContentPart[];
  readonly isError?: boolean | undefined;
}
