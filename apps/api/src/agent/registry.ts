import type { AgentTool } from './tool.js';
import { calculateQuantityTool } from './tools/calculate-quantity.js';
import { createCheckoutLinkTool } from './tools/create-checkout-link.js';
import { getProductTool } from './tools/get-product.js';
import { searchProductsTool } from './tools/search-products.js';
import { showProductsTool } from './tools/show-products.js';

/**
 * Tools a client can enable by name in its config (`tools:`). offer_choices and request_human
 * are always on and live in the responder.
 */
export const agentTools: AgentTool[] = [
  calculateQuantityTool,
  createCheckoutLinkTool,
  getProductTool,
  searchProductsTool,
  showProductsTool,
];
