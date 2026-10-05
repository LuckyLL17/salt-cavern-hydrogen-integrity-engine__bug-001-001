import { createHash } from 'node:crypto';
import { DomainError } from '../errors.ts';
import { COMPONENTS, type Composition, type CompositionBasis, type Inventory } from '../types.ts';
import { componentMoles } from './composition.ts';
import { amountToMoles, type GasAmountUnit } from './units.ts';
export type Transfer = { id: string; direction: 'inject' | 'withdraw'; amount: number; unit: GasAmountUnit; composition: Partial<Composition>; compositionBasis?: CompositionBasis; recordedAt?: string; sequence?: number };
export type AppliedTransfer = { id: string; fingerprint: string; direction: Transfer['direction']; componentMoles: Composition; recordedAt?: string; sequence?: number };
export type LedgerState = Inventory & { transferFingerprints: Record<string, string>; journal: AppliedTransfer[] };
export function emptyLedger(): LedgerState { return { componentMoles: { H2: 0, CH4: 0, N2: 0, CO2: 0 }, revision: 0, appliedTransferIds: [], transferFingerprints: {}, journal: [] }; }
function fingerprint(transfer: Transfer): string {
  const canonical = { id: transfer.id, direction: transfer.direction, amount: transfer.amount, unit: transfer.unit, composition: Object.fromEntries(COMPONENTS.map((key) => [key, transfer.composition[key] ?? 0])), compositionBasis: transfer.compositionBasis ?? 'mole', recordedAt: transfer.recordedAt ?? null, sequence: transfer.sequence ?? null };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
function validateState(state: LedgerState): void { for (const key of COMPONENTS) if (!Number.isFinite(state.componentMoles[key]) || state.componentMoles[key] < -1e-9) throw new DomainError('CORRUPT_INVENTORY_STATE', `Inventory has an invalid ${key} balance`, 500, { key, value: state.componentMoles[key] }); }
function validateTransferShape(transfer: Transfer): void {
  if (typeof transfer.id !== 'string' || !transfer.id.trim()) throw new DomainError('TRANSFER_ID_REQUIRED', 'Transfer id is required', 422);
  if (transfer.direction !== 'inject' && transfer.direction !== 'withdraw') throw new DomainError('INVALID_TRANSFER_DIRECTION', 'Transfer direction must be inject or withdraw', 422);
  if (!['mol', 'kmol', 'Nm3'].includes(transfer.unit)) throw new DomainError('UNSUPPORTED_AMOUNT_UNIT', 'Transfer unit is not supported', 422, { unit: transfer.unit });
  if (!transfer.composition || typeof transfer.composition !== 'object' || Array.isArray(transfer.composition)) throw new DomainError('COMPOSITION_REQUIRED', 'Transfer composition must be an object of component fractions', 422, { transferId: transfer.id });
}
export function applyTransfer(current: LedgerState, transfer: Transfer): LedgerState {
  validateState(current);
  validateTransferShape(transfer);
  const digest = fingerprint(transfer);
  const prior = current.transferFingerprints[transfer.id];
  if (prior) { if (prior !== digest) throw new DomainError('TRANSFER_ID_CONFLICT', 'A transfer id cannot be reused for different material', 409, { transferId: transfer.id }); return structuredClone(current); }
  const totalMoles = amountToMoles(transfer.amount, transfer.unit);
  const moles = componentMoles(totalMoles, transfer.composition, transfer.compositionBasis ?? 'mole');
  const sign = transfer.direction === 'inject' ? 1 : -1;
  const next = structuredClone(current);
  const shortages: Array<{ component: string; availableMol: number; requestedMol: number }> = [];
  for (const key of COMPONENTS) { const balance = current.componentMoles[key] + sign * moles[key]; if (balance < -1e-8) shortages.push({ component: key, availableMol: current.componentMoles[key], requestedMol: moles[key] }); next.componentMoles[key] = Math.max(0, balance); }
  if (shortages.length) throw new DomainError('INSUFFICIENT_COMPONENT_INVENTORY', 'Withdrawal would make one or more component balances negative', 409, { shortages });
  next.revision += 1; next.appliedTransferIds.push(transfer.id); next.transferFingerprints[transfer.id] = digest; next.journal.push({ id: transfer.id, fingerprint: digest, direction: transfer.direction, componentMoles: moles, recordedAt: transfer.recordedAt, sequence: transfer.sequence });
  return next;
}
export function replayTransfers(transfers: Transfer[]): LedgerState {
  if (!Array.isArray(transfers)) throw new DomainError('INVALID_TRANSFER_BATCH', 'Transfers must be provided as an array', 422);
  // Validate the whole batch before any state transition, so a rejected replay can never leave partial inventory, revision or journal entries behind.
  const hasTimestamps = transfers.some((transfer) => transfer?.recordedAt !== undefined);
  const entries = transfers.map((transfer, arrivalIndex) => {
    if (!transfer || typeof transfer !== 'object') throw new DomainError('INVALID_TRANSFER_BATCH', 'Every transfer must be an object', 422, { arrivalIndex });
    validateTransferShape(transfer);
    if (transfer.recordedAt === undefined && hasTimestamps) throw new DomainError('MIXED_EVENT_TIME_REPLAY', 'A replay must use event timestamps for every transfer or none of them', 422, { transferId: transfer.id });
    const eventTime = transfer.recordedAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(transfer.recordedAt);
    if (transfer.recordedAt !== undefined && !Number.isFinite(eventTime)) throw new DomainError('INVALID_TRANSFER_TIME', 'Transfer event time must be ISO compatible', 422, { transferId: transfer.id, recordedAt: transfer.recordedAt });
    if (transfer.sequence !== undefined && (!Number.isInteger(transfer.sequence) || transfer.sequence < 0)) throw new DomainError('INVALID_TRANSFER_SEQUENCE', 'Event sequence must be a non-negative integer', 422, { transferId: transfer.id, sequence: transfer.sequence });
    return { transfer, eventTime, sequence: transfer.sequence ?? 0, arrivalIndex, digest: fingerprint(transfer) };
  });
  // A transfer id may repeat only for an identical payload; reusing an id for different material is an explicit conflict.
  const digestsById = new Map<string, string>();
  for (const entry of entries) {
    const prior = digestsById.get(entry.transfer.id);
    if (prior !== undefined && prior !== entry.digest) throw new DomainError('TRANSFER_ID_CONFLICT', 'A transfer id cannot be reused for different material', 409, { transferId: entry.transfer.id });
    digestsById.set(entry.transfer.id, entry.digest);
  }
  // Deterministic business order: event time, then the same-time sequence, then arrival order as the final tiebreaker.
  entries.sort((left, right) => left.eventTime - right.eventTime || left.sequence - right.sequence || left.arrivalIndex - right.arrivalIndex);
  // Identical replays no-op inside applyTransfer, and the new ledger is only returned once every entry has applied.
  let state = emptyLedger();
  for (const entry of entries) state = applyTransfer(state, entry.transfer);
  return state;
}
