// @afr/auto-eval — LLM-as-judge over completed runs (milestone 12).
export const AUTO_EVAL_VERSION = "0.1.0";

export { RUBRICS, compactTrace, rubricMessages } from "./rubrics";
export type { RubricId, JudgeMessages } from "./rubrics";
export { judgeRubric, judgeTrace, evalRun } from "./judge";
export type { Verdict, RubricVerdict, JudgeOptions, EvalRunOptions } from "./judge";
