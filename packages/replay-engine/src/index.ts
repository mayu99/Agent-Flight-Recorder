// @afr/replay-engine — deterministic replay, fork mode, divergence, diff.
export { detectDivergence } from "./divergence.js";
export type { Divergence, DivergenceReason, LiveStep } from "./divergence.js";
export { DivergenceError, Replayer } from "./replayer.js";
export type { ReplayRequest, ReplayResult, ReplayerOptions } from "./replayer.js";
export { loadRunEvents, makeClient } from "./loader.js";
export type { LoaderOptions } from "./loader.js";
export { ForkSession } from "./fork.js";
export type { ForkSessionOptions, LiveExecutor, LiveResult } from "./fork.js";
export { diffRuns } from "./diff.js";
export type { RunDiff, StepDiff, StepDiffKind } from "./diff.js";
