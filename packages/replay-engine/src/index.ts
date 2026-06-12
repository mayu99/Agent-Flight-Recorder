// @afr/replay-engine — deterministic replay, fork mode, divergence, diff.
export { detectDivergence } from "./divergence";
export type { Divergence, DivergenceReason, LiveStep } from "./divergence";
export { DivergenceError, Replayer } from "./replayer";
export type { ReplayRequest, ReplayResult, ReplayerOptions } from "./replayer";
export { loadRunEvents, makeClient } from "./loader";
export type { LoaderOptions } from "./loader";
export { ForkSession } from "./fork";
export type { ForkSessionOptions, LiveExecutor, LiveResult } from "./fork";
export { diffRuns } from "./diff";
export type { RunDiff, StepDiff, StepDiffKind } from "./diff";
