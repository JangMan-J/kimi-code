export {
  KimiHarness,
  createKimiHarness,
  type KimiConfigFacade,
  type KimiHarnessOptions,
} from '#/kimi-harness';
export { KimiSession } from '#/session';
export {
  createWorkspaceTrustStore,
  type WorkspaceTrustStore,
} from '#/trust';
export { createTomlConfigPersist } from '#/config-persist';
export {
  createKimiAuthConfigAccessor,
  createKimiConfigStore,
  createStandaloneKimiAuthConfigAccessor,
  ensureConfigFile,
  readKimiConfigSnapshot,
  type KimiAuthConfig,
  type KimiAuthConfigAccessor,
  type KimiAuthConfigStoreView,
  type KimiConfigSnapshot,
} from '#/config-accessor';
export {
  resolveConfigPath,
  resolveKimiHome,
  sanitizeWorkDirKey,
} from '#/paths';
export { KimiAuthFacade } from '#/auth';
export type {
  KimiAuthCompleteFeedbackUploadInput,
  KimiAuthCompleteFeedbackUploadPart,
  KimiAuthCreateFeedbackUploadUrlInput,
  KimiAuthCreateFeedbackUploadUrlOk,
  KimiAuthCreateFeedbackUploadUrlResult,
  KimiAuthFeedbackUploadPart,
  KimiAuthLoginOptions,
  KimiAuthLoginResult,
  KimiAuthLogoutResult,
  KimiAuthSubmitFeedbackInput,
  OAuthRef,
} from '#/auth';
export { mapOAuthTokenError } from '#/oauth-error';
export {
  ErrorCodes,
  KIMI_ERROR_INFO,
  KimiError,
  isKimiError,
  isKimiErrorCode,
  type KimiErrorCode,
  type KimiErrorInfo,
  type KimiErrorOptions,
} from '#/errors';
export {
  flushDiagnosticLogs,
  flushDiagnosticLogsSync,
  log,
  redact,
  resolveGlobalLogPath,
} from '#/logging/index';
export type { LogContext, LogLevel, LogPayload, Logger } from '#/logging/index';
export {
  noopTelemetryClient,
  withTelemetryContext,
  type TelemetryClient,
  type TelemetryContextPatch,
  type TelemetryProperties,
  type TelemetryPropertyValue,
} from '#/telemetry';
export { installGlobalProxyDispatcher } from '#/proxy';
export {
  ImageLimits,
  compressBase64ForModel,
  compressImageForModel,
} from '#/image';
export type {
  CompressBase64Result,
  CompressImageOptions,
  CompressImageResult,
  ImageCompressionCaptionInput,
} from '#/image';
