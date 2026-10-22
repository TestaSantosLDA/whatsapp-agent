import type { AgentTool } from './tool.js';
import { calculateQuantityTool } from './tools/calculate-quantity.js';
import { createCheckoutLinkTool } from './tools/create-checkout-link.js';
import { getProductTool } from './tools/get-product.js';
import { saveLeadTool } from './tools/save-lead.js';
import { searchProductsTool } from './tools/search-products.js';
import { sendOrderDraftTool } from './tools/send-order-draft.js';
import { showProductsTool } from './tools/show-products.js';

/**
 * Tools a client can enable by name in its config (`tools:`). offer_choices and
 * handoff_to_human are always on and live in the responder.
 */
export const agentTools: AgentTool[] = [
  calculateQuantityTool,
  createCheckoutLinkTool,
  getProductTool,
  saveLeadTool,
  searchProductsTool,
  sendOrderDraftTool,
  showProductsTool,
];
