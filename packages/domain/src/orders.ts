import type { OrderStatus } from "@fitmarket/types";

/** Mirrors app.validate_order_transition() in migration 0006. Keep in sync. */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  created: ["awaiting_payment", "canceled", "expired", "failed"],
  awaiting_payment: ["paid", "canceled", "expired", "failed"],
  failed: ["awaiting_payment", "canceled", "expired"],
  paid: ["refunded", "partially_refunded"],
  partially_refunded: ["refunded"],
  refunded: [],
  canceled: [],
  expired: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransitionOrder(from, to)) {
    throw new Error(`invalid order transition ${from} -> ${to}`);
  }
}
