import { createHash } from 'node:crypto';
import { DomainError } from '../errors.ts';
import { COMPONENTS, type Composition, type CompositionBasis, type Inventory } from '../types.ts';
import { componentMoles } from './composition.ts';
import { amountToMoles, type GasAmountUnit } from './units.ts';

export type Transfer = { id: string; direction: 'inject' | 'withdraw'; amount: number; unit: GasAmountUnit; composition: Partial<Composition>; compositionBasis?: CompositionBasis; recordedAt?: string; sequence?: number };
export type AppliedTransfer = { id: string; fingerprint: string; direction: Transfer['direction']; componentMoles: Composition; recordedAt?: string; sequence?: number };
export type LedgerState = Inventory & { transferFingerprints: Record<string, string>; journal: AppliedTransfer[] };

export function emptyLedger(): LedgerState { return { componentMoles: { H2: 0, CH4: 0, N2: 0, CO2: 0 }, revision: 0, appliedTransferIds: [], transferFingerprints: {}, journal: [] }; }

const NEGATIVE_BALANCE_TOLERANCE_MOL = 1e-8;

function fingerprint(transfer: Transfer): string {
  const canonical = { id: transfer.id, direction: transfer.direction, amount: transfer.amount, unit: transfer.unit, composition: Object.fromEntries(COMPONENTS.map((key) => [key, transfer.composition[key] ?? 0])), compositionBasis: transfer.compositionBasis ?? 'mole', recordedAt: transfer.recordedAt ?? null, sequence: transfer.sequence ?? null };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function validateState(state: LedgerState): void {
  for (const key of COMPONENTS) {
    if (!Number.isFinite(state.componentMoles[key]) || state.componentMoles[key] < -1e-9) {
      throw new DomainError('CORRUPT_INVENTORY_STATE', `Inventory has an invalid ${key} balance`, 500, { key, value: state.componentMoles[key] });
    }
  }
}

/**
 * Apply a single already-validated transfer. The function is atomic: it works
 * on a cloned state and never mutates `current`, so a rejected withdrawal
 * (component shortage, id conflict) cannot leak partial balances or journal
 * entries into the caller's ledger.
 */
export function applyTransfer(current: LedgerState, transfer: Transfer): LedgerState {
  validateState(current);
  if (typeof transfer.id !== 'string' || !transfer.id.trim()) throw new DomainError('TRANSFER_ID_REQUIRED', 'Transfer id is required', 422);
  if (transfer.direction !== 'inject' && transfer.direction !== 'withdraw') throw new DomainError('INVALID_TRANSFER_DIRECTION', 'Transfer direction must be inject or withdraw', 422);
  if (!['mol', 'kmol', 'Nm3'].includes(transfer.unit)) throw new DomainError('UNSUPPORTED_AMOUNT_UNIT', 'Transfer unit is not supported', 422, { unit: transfer.unit });

  const digest = fingerprint(transfer);
  const prior = current.transferFingerprints[transfer.id];
  if (prior) {
    if (prior !== digest) throw new DomainError('TRANSFER_ID_CONFLICT', 'A transfer id cannot be reused for different material', 409, { transferId: transfer.id });
    return structuredClone(current);
  }

  const totalMoles = amountToMoles(transfer.amount, transfer.unit);
  const moles = componentMoles(totalMoles, transfer.composition, transfer.compositionBasis ?? 'mole');
  const sign = transfer.direction === 'inject' ? 1 : -1;

  const next = structuredClone(current);
  const shortages: Array<{ component: string; availableMol: number; requestedMol: number }> = [];
  for (const key of COMPONENTS) {
    const balance = current.componentMoles[key] + sign * moles[key];
    if (balance < -NEGATIVE_BALANCE_TOLERANCE_MOL) shortages.push({ component: key, availableMol: current.componentMoles[key], requestedMol: moles[key] });
    next.componentMoles[key] = Math.max(0, balance);
  }
  if (shortages.length) throw new DomainError('INSUFFICIENT_COMPONENT_INVENTORY', 'Withdrawal would make one or more component balances negative', 409, { shortages, transferId: transfer.id });

  next.revision += 1;
  next.appliedTransferIds.push(transfer.id);
  next.transferFingerprints[transfer.id] = digest;
  next.journal.push({ id: transfer.id, fingerprint: digest, direction: transfer.direction, componentMoles: moles, recordedAt: transfer.recordedAt, sequence: transfer.sequence });
  verifyLedgerInvariants(next);
  return next;
}

type OrderedEntry = {
  transfer: Transfer;
  fingerprint: string;
  eventTime: number;
  sequenced: boolean;
  sequence: number;
  arrivalIndex: number;
};

/**
 * Batch-level structural validation. Every entry is parsed up front so that a
 * malformed event late in the batch fails the whole replay before any material
 * movement is staged.
 */
function parseReplayEntry(transfer: Transfer, arrivalIndex: number): OrderedEntry {
  if (transfer === null || typeof transfer !== 'object') {
    throw new DomainError('INVALID_TRANSFER', 'Each replay entry must be a transfer object', 422, { arrivalIndex });
  }
  if (typeof transfer.id !== 'string' || !transfer.id.trim()) {
    throw new DomainError('TRANSFER_ID_REQUIRED', 'Transfer id is required', 422, { arrivalIndex });
  }
  if (transfer.direction !== 'inject' && transfer.direction !== 'withdraw') {
    throw new DomainError('INVALID_TRANSFER_DIRECTION', 'Transfer direction must be inject or withdraw', 422, { transferId: transfer.id });
  }
  if (!['mol', 'kmol', 'Nm3'].includes(transfer.unit)) {
    throw new DomainError('UNSUPPORTED_AMOUNT_UNIT', 'Transfer unit is not supported', 422, { transferId: transfer.id, unit: transfer.unit });
  }
  if (transfer.sequence !== undefined && (!Number.isSafeInteger(transfer.sequence) || transfer.sequence < 0)) {
    throw new DomainError('INVALID_TRANSFER_SEQUENCE', 'Event sequence must be a non-negative safe integer', 422, { transferId: transfer.id, sequence: transfer.sequence });
  }

  let eventTime = Number.POSITIVE_INFINITY;
  if (transfer.recordedAt !== undefined) {
    if (typeof transfer.recordedAt !== 'string') {
      throw new DomainError('INVALID_TRANSFER_TIME', 'Transfer event time must be an ISO compatible string', 422, { transferId: transfer.id, recordedAt: transfer.recordedAt });
    }
    eventTime = Date.parse(transfer.recordedAt);
    if (!Number.isFinite(eventTime)) {
      throw new DomainError('INVALID_TRANSFER_TIME', 'Transfer event time must be ISO compatible', 422, { transferId: transfer.id, recordedAt: transfer.recordedAt });
    }
  }

  // Material validation: amounts, composition basis and component closure are
  // verified before anything is staged, so an illegal payload can never abort a
  // replay halfway through.
  const totalMoles = amountToMoles(transfer.amount, transfer.unit);
  componentMoles(totalMoles, transfer.composition, transfer.compositionBasis ?? 'mole');

  return { transfer, fingerprint: fingerprint(transfer), eventTime, sequenced: transfer.sequence !== undefined, sequence: transfer.sequence ?? 0, arrivalIndex };
}

/**
 * Cross-check the four views of a ledger: balances, revision, id list/fingerprint
 * map and the audit journal must describe exactly the same history, and the
 * signed journal movements must reproduce the component balances.
 */
export function verifyLedgerInvariants(state: LedgerState): void {
  validateState(state);
  if (state.revision !== state.journal.length) {
    throw new DomainError('CORRUPT_INVENTORY_STATE', 'Ledger revision does not match journal length', 500, { revision: state.revision, journalLength: state.journal.length });
  }
  if (state.revision !== state.appliedTransferIds.length) {
    throw new DomainError('CORRUPT_INVENTORY_STATE', 'Ledger revision does not match applied transfer ids', 500, { revision: state.revision, appliedIdsLength: state.appliedTransferIds.length });
  }
  if (Object.keys(state.transferFingerprints).length !== state.revision) {
    throw new DomainError('CORRUPT_INVENTORY_STATE', 'Fingerprint index does not match ledger revision', 500);
  }
  const replayed = { H2: 0, CH4: 0, N2: 0, CO2: 0 } as Composition;
  for (let index = 0; index < state.journal.length; index += 1) {
    const entry = state.journal[index];
    if (entry.id !== state.appliedTransferIds[index]) {
      throw new DomainError('CORRUPT_INVENTORY_STATE', 'Journal order diverges from applied transfer ids', 500, { index });
    }
    if (state.transferFingerprints[entry.id] !== entry.fingerprint) {
      throw new DomainError('CORRUPT_INVENTORY_STATE', 'Journal fingerprint diverges from fingerprint index', 500, { transferId: entry.id });
    }
    const sign = entry.direction === 'inject' ? 1 : -1;
    for (const key of COMPONENTS) replayed[key] += sign * entry.componentMoles[key];
  }
  for (const key of COMPONENTS) {
    const tolerance = 1e-9 * Math.max(1, Math.abs(state.componentMoles[key]), Math.abs(replayed[key]));
    if (Math.abs(replayed[key] - state.componentMoles[key]) > tolerance) {
      throw new DomainError('CORRUPT_INVENTORY_STATE', `Journal movements do not reproduce the ${key} balance`, 500, { key, ledgerMol: state.componentMoles[key], journalMol: replayed[key] });
    }
  }
}

/**
 * Replay a batch of late-arriving injection/withdrawal events.
 *
 * Ordering is deterministic and independent of arrival order: when event times
 * are present, events sort by (recordedAt, sequence); several events sharing a
 * timestamp must each carry a unique explicit sequence. A batch either carries
 * event times on every entry or on none (untimed batches keep arrival order).
 *
 * Replayed payloads with the same id and identical body collapse idempotently;
 * the same id with a different body raises TRANSFER_ID_CONFLICT. Validation and
 * material staging run on a scratch ledger, so mixed timestamps, illegal
 * sequences, payload conflicts or component shortages reject the whole batch
 * without leaving partial balances, revision bumps or journal entries behind.
 */
export function replayTransfers(transfers: Transfer[]): LedgerState {
  if (!Array.isArray(transfers)) throw new DomainError('INVALID_TRANSFER_BATCH', 'Replay input must be an array of transfers', 422);

  // Phase 1 — parse and structurally validate every arrival.
  const entries = transfers.map((transfer, arrivalIndex) => parseReplayEntry(transfer, arrivalIndex));

  const timed = entries.some((entry) => entry.eventTime !== Number.POSITIVE_INFINITY);
  const untimed = entries.some((entry) => entry.eventTime === Number.POSITIVE_INFINITY);
  if (timed && untimed) {
    const transferIds = entries.filter((entry) => entry.eventTime === Number.POSITIVE_INFINITY).map((entry) => entry.transfer.id);
    throw new DomainError('MIXED_EVENT_TIME_REPLAY', 'A replay must use event timestamps for every transfer or none of them', 422, { transferIds });
  }

  // Phase 2 — collapse identical redeliveries and reject same-id/different-body
  // conflicts up front, independent of where they sit in the arrival order.
  const canonical = new Map<string, OrderedEntry>();
  for (const entry of entries) {
    const existing = canonical.get(entry.transfer.id);
    if (existing === undefined) {
      canonical.set(entry.transfer.id, entry);
      continue;
    }
    if (existing.fingerprint !== entry.fingerprint) {
      throw new DomainError('TRANSFER_ID_CONFLICT', 'A transfer id cannot be reused for different material', 409, { transferId: entry.transfer.id });
    }
  }

  let ordered: OrderedEntry[];
  if (!timed) {
    ordered = [...canonical.values()].sort((left, right) => left.arrivalIndex - right.arrivalIndex);
  } else {
    // Same-timestamp events must be fully ordered by explicit unique sequences;
    // arrival order must never silently decide material movements.
    const groups = new Map<number, OrderedEntry[]>();
    for (const entry of canonical.values()) {
      const group = groups.get(entry.eventTime);
      if (group) group.push(entry);
      else groups.set(entry.eventTime, [entry]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const recordedAt = group[0].transfer.recordedAt as string;
      for (const entry of group) {
        if (!entry.sequenced) {
          throw new DomainError('INVALID_TRANSFER_SEQUENCE', 'Events sharing an event time require an explicit non-negative sequence', 422, { recordedAt, transferId: entry.transfer.id });
        }
      }
      const usedSequences = new Map<number, string[]>();
      for (const entry of group) {
        const ids = usedSequences.get(entry.sequence);
        if (ids) {
          ids.push(entry.transfer.id);
        } else {
          usedSequences.set(entry.sequence, [entry.transfer.id]);
        }
      }
      for (const [sequence, transferIds] of usedSequences) {
        if (transferIds.length > 1) {
          throw new DomainError('INVALID_TRANSFER_SEQUENCE', 'Sequence numbers at the same event time must be unique', 422, { recordedAt, sequence, transferIds });
        }
      }
    }
    ordered = [...canonical.values()].sort((left, right) =>
      left.eventTime - right.eventTime
      || left.sequence - right.sequence
      || left.arrivalIndex - right.arrivalIndex);
  }

  // Phase 3 — stage the entire history on a scratch ledger. Shortages surface
  // here; nothing is returned until every event has applied cleanly.
  let state = emptyLedger();
  for (const entry of ordered) {
    state = applyTransfer(state, entry.transfer);
  }
  verifyLedgerInvariants(state);
  return state;
}
