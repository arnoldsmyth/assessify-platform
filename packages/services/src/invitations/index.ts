export {
  buildRespondentEntryUrl,
  resolveInvitationHost,
  type InvitationCustomDomain,
  type ResolveInvitationHostInput,
} from './invitation-link';
export {
  createInvitationService,
  invitationBounceSchema,
  requestInvitationDispatchSchema,
  requestInvitationResendSchema,
  ERROR_ALERT_TEMPLATE,
  INVITATION_TEMPLATE,
  type InvitationBounceInput,
  type InvitationBounceOutcome,
  type InvitationConfig,
  type InvitationDispatchSummary,
  type InvitationJobReceipt,
  type InvitationService,
  type InvitationServiceDeps,
  type RequestInvitationDispatchInput,
  type RequestInvitationResendInput,
} from './invitation-service';
export { getInvitationService, type InvitationServiceAdapters } from './default';
