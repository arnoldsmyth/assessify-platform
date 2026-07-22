export {
  CLIENT_NOTICE_LANGUAGE,
  COMPLETION_NOTICE_TEMPLATE,
  createCompletionNotificationService,
  REPORT_READY_TEMPLATE,
  type ClientSendSkipReason,
  type CompletionNotificationConfig,
  type CompletionNotificationService,
  type CompletionNotificationServiceDeps,
  type CompletionNotificationSummary,
  type RespondentSendOutcome,
} from './completion-notification-service';
export {
  getCompletionNotificationService,
  type CompletionNotificationServiceAdapters,
} from './default';
