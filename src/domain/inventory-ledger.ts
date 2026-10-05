import { emptyLedger, applyTransfer as apply, type Transfer, type LedgerState } from './inventory/ledger.ts';
import { summarizeInventory } from './inventory/reconciliation.ts';
export type { Transfer };
export type { AppliedTransfer, LedgerState } from './inventory/ledger.ts';
export function emptyInventory(): LedgerState { return emptyLedger(); }
export function applyTransfer(state: LedgerState, transfer: Transfer): LedgerState { return apply(state, transfer); }
export { replayTransfers } from './inventory/ledger.ts';
export function inventorySummary(state: LedgerState) { return summarizeInventory(state); }
export { totalMoles } from './inventory/reconciliation-compat.ts';
