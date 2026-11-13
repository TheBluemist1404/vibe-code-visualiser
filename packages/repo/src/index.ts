export { findWorkTreeRoot, GitRefusedError, parsePorcelainZ } from "./git/git.ts";
export type { GitObservation, GitOperation } from "./git/git.ts";
export {
  compareLines,
  initProject,
  ProjectError,
  projectStatus,
  RepositoryProject,
  resolveProjectRoot,
  VCV_DIR,
} from "./project.ts";
export type { ModelLineChange, ProjectDiagnostic, ProjectRefresh, ProjectState, ProjectStatus } from "./project.ts";
export { formatLocator, parseLocator } from "./bindings/locator.ts";
export type { PathResolution } from "./bindings/locator.ts";
export { fileFingerprint, resolveLocator } from "./bindings/resolver.ts";
export type { Match, Resolution } from "./bindings/resolver.ts";
export {
  BindingError,
  defaultBindingId,
  disputeBinding,
  listBindings,
  readBinding,
  recordBinding,
  removeBinding,
  verifyBinding,
  verifyBindings,
} from "./bindings/bindings.ts";
export type {
  BindingErrorCode,
  BindingHost,
  ClaimEntry,
  ModelFreshness,
  RecordInput,
  RecordResult,
  SourceFreshness,
  Verification,
  VerifyMemo,
  WriteHooks,
} from "./bindings/bindings.ts";
export {
  bindingEvidenceRequest,
  createEvidenceApi,
  EVIDENCE_LIMITS,
  evidenceOverviewRequest,
  objectEvidenceRequest,
  refreshEvidenceRequest,
} from "./bindings/evidence.ts";
export type {
  BindingEvidence,
  BindingEvidenceRequest,
  Counts,
  EvidenceApi,
  EvidenceContext,
  EvidenceError,
  EvidenceErrorCode,
  EvidenceHooks,
  EvidenceOverview,
  EvidenceOverviewRequest,
  EvidenceRefresh,
  EvidenceResult,
  EvidenceState,
  EvidenceSummary,
  LocatorText,
  ObjectEvidence,
  ObjectEvidenceRequest,
  RefreshEvidenceRequest,
} from "./bindings/evidence.ts";
export {
  createProposalReadApi,
  listProposals,
  listProposalsRequest,
  previewProposal,
  previewProposalRequest,
  PROPOSAL_LIMITS,
  submitProposal,
} from "./changes/proposals.ts";
export type {
  ApprovalState,
  HintedDiagnostic,
  ListProposalsRequest,
  PreviewProposalRequest,
  ProposalLifecycle,
  ProposalList,
  ProposalPreview,
  ProposalReadApi,
  ProposalSummary,
  SubmitResult,
} from "./changes/proposals.ts";
export {
  addTrustedReviewer,
  ApprovalError,
  createReviewerKey,
  loadTrust,
  reviewApprove,
  reviewFinalize,
} from "./changes/approval.ts";
export type {
  Attestation,
  LoadedTrust,
  ReviewApproveInput,
  ReviewApproveResult,
  ReviewFinalizeInput,
  TrustAuthority,
  TrustEntry,
  TrustList,
  TrustSource,
} from "./changes/approval.ts";
export { checkIntegrity } from "./changes/integrity.ts";
export type {
  ApprovalCheck,
  IntegrityOptions,
  IntegrityProblem,
  IntegrityReport,
  RevisionCheck,
} from "./changes/integrity.ts";
export { buildHandoff } from "./changes/handoff.ts";
export type { ApprovedChange, Handoff, HandoffBinding } from "./changes/handoff.ts";
export { globMatcher, implementationStatus, recordImplementation } from "./changes/implementation.ts";
export type {
  ImplementationObservation,
  ImplementationReport,
  ImplementationReportInput,
  ImplementationStatus,
  ImplementationWarning,
  RecordImplementationResult,
} from "./changes/implementation.ts";
export { worktreeStateDetail } from "./git/worktree.ts";
export type { WorktreeState } from "./git/worktree.ts";
export { reconcile, RECONCILE_LIMITS } from "./premerge/reconcile.ts";
export type {
  ChangedFile,
  ClaimAtBase,
  FileArea,
  FindingBasis,
  FindingCategory,
  ObjectInChange,
  ReconciledBinding,
  ReconcileFinding,
  ReconcileRequest,
  Reconciliation,
  SourceImpact,
} from "./premerge/reconcile.ts";
export { CRITERIA_LIMITS, criteriaEvidence } from "./premerge/criteria.ts";
export type {
  CriteriaReport,
  CriteriaRequest,
  CriterionEvidence,
  CriterionMapping,
  CriterionResult,
  MappingProblemCode,
  MappingResult,
  RunSummary,
  TestIdentity,
} from "./premerge/criteria.ts";
export { JUNIT_LIMITS, parseJUnit } from "./premerge/junit.ts";
export type { CaseStatus, JUnitCase, JUnitReport, JUnitResult } from "./premerge/junit.ts";
export { captureTestRun, TEST_RUN_LIMITS, testIdentity } from "./premerge/testruns.ts";
export type { CandidateIdentity, CaptureRequest, TestRunHost, TestRunRecord } from "./premerge/testruns.ts";
export { preMergeGate, REQUIRED_EVIDENCE } from "./premerge/gate.ts";
export type {
  GateDecision,
  GateJUnit,
  GateOptions,
  GatePolicy,
  GateReason,
  GateReport,
  GateRequest,
  GateSeverity,
  StoreBudget,
  VerifiedObservation,
} from "./premerge/gate.ts";
export type { InvalidRequest, RepoContext, RepoError, RepoErrorCode, RepoResult } from "./shared/result.ts";
export type { ObserveHooks } from "./shared/observation.ts";
export type { FieldChange, ModelImpact, ObjectChange } from "./shared/model-diff.ts";
export { readClaims } from "./shared/claims.ts";
export { readRevision } from "./shared/observation.ts";
