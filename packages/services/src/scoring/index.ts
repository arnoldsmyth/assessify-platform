export {
  noopScoringDispatcher,
  type ScoringDispatcher,
  type ScoringDispatchReceipt,
} from './dispatcher';
export {
  buildScoringAnswers,
  createScoringService,
  type ScoringApplyReceipt,
  type ScoringProcessOutcome,
  type ScoringService,
  type ScoringServiceAdapters,
  type ScoringServiceDeps,
} from './scoring-service';
export { getScoringService, type ScoringServiceComposition } from './default';
