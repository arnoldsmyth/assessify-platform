import { pgSequence } from 'drizzle-orm/pg-core';

// Human-reference sequences (04 — Identifier conventions). References are always
// generated inside the insert transaction from these sequences, never client-side.

/** `orders.reference` = 'ORD-' || lpad(nextval('order_ref_seq')::text, 5, '0') */
export const orderRefSeq = pgSequence('order_ref_seq');

/** `clients.client_number` — used as the 5-digit suffix of invoice references. */
export const clientNumberSeq = pgSequence('client_number_seq');

/** Invoice reference sequence (INV-YYMM-#####). */
export const invoiceRefSeq = pgSequence('invoice_ref_seq');
