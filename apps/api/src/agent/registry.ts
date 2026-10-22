import type { AgentTool } from './tool.js';

/**
 * Tools a client can enable by name in its config (`tools:`). offer_choices and request_human
 * are always on and live in the responder.
 */
export const agentTools: AgentTool[] = [];
