/**
 * Server-safe prompt builder. Uses @openuidev/lang-core only (no React) so
 * route handlers can generate the system prompt without dragging client
 * context into the server bundle. The renderers attach in primitives.tsx.
 */
import { createLibrary, defineComponent } from "@openuidev/lang-core";
import { TIMELINE_COMPONENT_GROUPS, TIMELINE_PROMPT_OPTIONS, TIMELINE_SPECS } from "./spec";

const promptLibrary = createLibrary({
  components: TIMELINE_SPECS.map((spec) => defineComponent({ ...spec, component: null })),
  componentGroups: TIMELINE_COMPONENT_GROUPS,
});

export function timelinePrompt(): string {
  return promptLibrary.prompt(TIMELINE_PROMPT_OPTIONS);
}
