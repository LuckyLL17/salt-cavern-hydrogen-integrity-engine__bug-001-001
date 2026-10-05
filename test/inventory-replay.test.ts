import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLedger, applyTransfer, replayTransfers, type Transfer } from '../src/domain/inventory/ledger.ts';
import { summarizeInventory } from '../src/domain/inventory/reconciliation.ts';
import { assessmentService } from '../src/application/assessment-service.ts';

const H2 = { H2: 1 };

test('late-arriving transfers replay in deterministic event-time and sequence order', () => {
  const arrivals: Transfer[] = [
    { id: 'w-1', direction: 'withdraw', amount: 40, unit: 'mol', composition: H2, recordedAt: '2026-01-01T00:00:00Z', sequence: 1 },
    { id: 'i-1', direction: 'inject', amount: 100, unit: 'mol', composition: H2, recordedAt: '2026-01-01T00:00:00Z', sequence: 0 },
    { id: 'i-0', direction: 'inject', amount: 10, unit: 'mol', composition: H2, recordedAt: '2025-12-31T00:00:00Z', sequence: 0 },
  ];
  const forward = replayTransfers(arrivals);
  const shuffled = replayTransfers([arrivals[2], arrivals[0], arrivals[1]]);
  assert.deepEqual(shuffled, forward);
  assert.deepEqual(forward.appliedTransferIds, ['i-0', 'i-1', 'w-1']);
  assert.equal(summarizeInventory(forward).totalMoles, 70);
});

test('same-time events are ordered by sequence, not arrival order', () => {
  const injectLeads = replayTransfers([
    { id: 'w', direction: 'withdraw', amount: 60, unit: 'mol', composition: H2, recordedAt: '2026-01-01T00:00:00Z', sequence: 2 },
    { id: 'i', direction: 'inject', amount: 100, unit: 'mol', composition: H2, recordedAt: '2026-01-01T00:00:00Z', sequence: 1 },
  ]);
  assert.deepEqual(injectLeads.appliedTransferIds, ['i', 'w']);
  assert.equal(summarizeInventory(injectLeads).totalMoles, 40);
  // Reversing the sequence numbers makes the same batch infeasible: the withdrawal leads.
  assert.throws(() => replayTransfers([
    { id: 'i', direction: 'inject', amount: 100, unit: 'mol', composition: H2, recordedAt: '2026-01-01T00:00:00Z', sequence: 2 },
    { id: 'w', direction: 'withdraw', amount: 60, unit: 'mol', composition: H2, recordedAt: '2026-01-01T00:00:00Z', sequence: 1 },
  ]), (error: any) => error.code === 'INSUFFICIENT_COMPONENT_INVENTORY');
});

test('timestamp-less batches keep arrival order with sequence as the tie-break', () => {
  const byArrival = replayTransfers([
    { id: 'b', direction: 'inject', amount: 2, unit: 'mol', composition: H2 },
    { id: 'a', direction: 'inject', amount: 1, unit: 'mol', composition: H2 },
  ]);
  assert.deepEqual(byArrival.appliedTransferIds, ['b', 'a']);
  const bySequence = replayTransfers([
    { id: 'b', direction: 'inject', amount: 2, unit: 'mol', composition: H2, sequence: 7 },
    { id: 'a', direction: 'inject', amount: 1, unit: 'mol', composition: H2, sequence: 3 },
  ]);
  assert.deepEqual(bySequence.appliedTransferIds, ['a', 'b']);
});

test('identical payloads under one transfer id replay idempotently', () => {
  const transfer: Transfer = { id: 't-1', direction: 'inject', amount: 25, unit: 'mol', composition: H2, recordedAt: '2026-01-01T00:00:00Z', sequence: 0 };
  const state = replayTransfers([transfer, { ...transfer }, { ...transfer }]);
  assert.equal(state.revision, 1);
  assert.equal(state.journal.length, 1);
  assert.equal(summarizeInventory(state).totalMoles, 25);
  const once = applyTransfer(emptyLedger(), { id: 't-2', direction: 'inject', amount: 5, unit: 'mol', composition: H2 });
  const twice = applyTransfer(once, { id: 't-2', direction: 'inject', amount: 5, unit: 'mol', composition: H2 });
  assert.equal(twice.revision, 1);
  assert.equal(summarizeInventory(twice).totalMoles, 5);
});

test('a reused transfer id with a different payload is an explicit conflict', () => {
  assert.throws(() => replayTransfers([
    { id: 't-1', direction: 'inject', amount: 25, unit: 'mol', composition: H2, recordedAt: '2026-01-01T00:00:00Z' },
    { id: 't-1', direction: 'inject', amount: 30, unit: 'mol', composition: H2, recordedAt: '2026-01-01T00:00:00Z' },
  ]), (error: any) => error.code === 'TRANSFER_ID_CONFLICT' && error.status === 409);
  const state = applyTransfer(emptyLedger(), { id: 't-9', direction: 'inject', amount: 5, unit: 'mol', composition: H2 });
  assert.throws(
    () => applyTransfer(state, { id: 't-9', direction: 'inject', amount: 6, unit: 'mol', composition: H2 }),
    (error: any) => error.code === 'TRANSFER_ID_CONFLICT',
  );
});

test('a rejected batch is atomic and a failed apply never mutates the given state', () => {
  assert.throws(() => replayTransfers([
    { id: 'a', direction: 'inject', amount: 10, unit: 'mol', composition: H2, recordedAt: '2026-01-01T00:00:00Z' },
    { id: 'b', direction: 'inject', amount: 10, unit: 'mol', composition: H2 },
  ]), (error: any) => error.code === 'MIXED_EVENT_TIME_REPLAY');
  assert.throws(
    () => replayTransfers([{ id: 's', direction: 'inject', amount: 1, unit: 'mol', composition: H2, sequence: -1 }]),
    (error: any) => error.code === 'INVALID_TRANSFER_SEQUENCE',
  );
  assert.throws(
    () => replayTransfers([{ id: 's', direction: 'inject', amount: 1, unit: 'mol', composition: H2, sequence: 1.5 }]),
    (error: any) => error.code === 'INVALID_TRANSFER_SEQUENCE',
  );
  assert.throws(
    () => replayTransfers([{ id: 't', direction: 'inject', amount: 1, unit: 'mol', composition: H2, recordedAt: 'not-a-date' }]),
    (error: any) => error.code === 'INVALID_TRANSFER_TIME',
  );
  // A shortage deep inside an otherwise valid batch rejects the whole batch.
  assert.throws(() => replayTransfers([
    { id: 'i-1', direction: 'inject', amount: 50, unit: 'mol', composition: H2, recordedAt: '2026-01-01T00:00:00Z', sequence: 0 },
    { id: 'w-1', direction: 'withdraw', amount: 80, unit: 'mol', composition: H2, recordedAt: '2026-01-01T00:00:00Z', sequence: 1 },
  ]), (error: any) => error.code === 'INSUFFICIENT_COMPONENT_INVENTORY');
  const before = applyTransfer(emptyLedger(), { id: 'keep', direction: 'inject', amount: 5, unit: 'mol', composition: H2 });
  const snapshot = structuredClone(before);
  assert.throws(
    () => applyTransfer(before, { id: 'drain', direction: 'withdraw', amount: 50, unit: 'mol', composition: H2 }),
    (error: any) => error.code === 'INSUFFICIENT_COMPONENT_INVENTORY',
  );
  assert.deepEqual(before, snapshot);
});

test('replayed balances, audit journal and reconciliation summary agree', () => {
  const state = replayTransfers([
    { id: 'i-2', direction: 'inject', amount: 40, unit: 'mol', composition: { H2: 3, CH4: 1 }, recordedAt: '2026-01-02T00:00:00Z', sequence: 0 },
    { id: 'i-1', direction: 'inject', amount: 60, unit: 'mol', composition: { H2: 1, N2: 1 }, recordedAt: '2026-01-01T00:00:00Z', sequence: 0 },
    { id: 'w-1', direction: 'withdraw', amount: 20, unit: 'mol', composition: H2, recordedAt: '2026-01-03T00:00:00Z', sequence: 0 },
  ]);
  const summary = summarizeInventory(state);
  assert.equal(summary.revision, 3);
  assert.deepEqual(summary.appliedTransferIds, ['i-1', 'i-2', 'w-1']);
  assert.deepEqual(summary.journal.map((entry) => entry.id), summary.appliedTransferIds);
  const folded = { H2: 0, CH4: 0, N2: 0, CO2: 0 };
  for (const entry of summary.journal) {
    const sign = entry.direction === 'inject' ? 1 : -1;
    for (const key of Object.keys(folded) as Array<keyof typeof folded>) folded[key] += sign * entry.componentMoles[key];
  }
  for (const key of Object.keys(folded) as Array<keyof typeof folded>) assert.ok(Math.abs(folded[key] - summary.componentMoles[key]) < 1e-9, `${key} balance matches the journal fold`);
  assert.equal(summary.totalMoles, 80);
  assert.ok(Math.abs(Object.values(summary.composition).reduce((a, b) => a + b, 0) - 1) < 1e-12);
});

test('inventory service summary exposes the audit journal with event ordering metadata', () => {
  const summary = assessmentService.inventory([
    { id: 'x', direction: 'inject', amount: 3, unit: 'mol', composition: H2, recordedAt: '2026-01-01T00:00:00Z', sequence: 4 },
  ]);
  assert.deepEqual(summary.appliedTransferIds, ['x']);
  assert.equal(summary.journal.length, 1);
  assert.equal(summary.journal[0].sequence, 4);
  assert.equal(summary.journal[0].recordedAt, '2026-01-01T00:00:00Z');
});
