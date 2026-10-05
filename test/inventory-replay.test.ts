import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTransfer,
  emptyLedger,
  replayTransfers,
  verifyLedgerInvariants,
  type LedgerState,
  type Transfer,
} from '../src/domain/inventory/ledger.ts';
import { DomainError } from '../src/domain/errors.ts';
import { COMPONENTS } from '../src/domain/types.ts';
import { journalComponentMoles, reconcileComponents, summarizeInventory } from '../src/domain/inventory/reconciliation.ts';
import { assessmentService } from '../src/application/assessment-service.ts';

const inject = (id: string, amount: number, recordedAt: string | undefined, sequence: number | undefined, composition = { H2: 1 }): Transfer =>
  ({ id, direction: 'inject', amount, unit: 'mol', composition, recordedAt, sequence });
const withdraw = (id: string, amount: number, recordedAt: string | undefined, sequence: number | undefined, composition = { H2: 1 }): Transfer =>
  ({ id, direction: 'withdraw', amount, unit: 'mol', composition, recordedAt, sequence });

function expectCode(action: () => unknown, code: string, status?: number): DomainError {
  try {
    action();
    assert.fail(`expected ${code} but replay succeeded`);
  } catch (error) {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return error;
  }
}

function assertBalances(state: LedgerState, expected: Record<string, number>): void {
  for (const key of COMPONENTS) {
    assert.ok(Math.abs(state.componentMoles[key] - (expected[key] ?? 0)) < 1e-9, `${key} expected ${expected[key] ?? 0} got ${state.componentMoles[key]}`);
  }
}

test('late arrivals are ordered by event time and same-tick sequence regardless of arrival order', () => {
  const timeline = [
    inject('a', 100, '2026-01-01T00:00:00Z', 0),
    withdraw('b', 30, '2026-01-01T00:00:00Z', 1),
    inject('c', 50, '2026-01-02T00:00:00Z', 0),
  ];
  const shuffled = [timeline[2], timeline[1], timeline[0]];

  const inOrder = replayTransfers(timeline);
  const lateArrival = replayTransfers(shuffled);

  assert.deepEqual(lateArrival.componentMoles, inOrder.componentMoles);
  assert.deepEqual(lateArrival.appliedTransferIds, ['a', 'b', 'c']);
  assert.deepEqual(lateArrival.journal.map((entry) => entry.id), ['a', 'b', 'c']);
  assertBalances(lateArrival, { H2: 120 });
  assert.equal(lateArrival.revision, 3);
});

test('replay is deterministic for every arrival permutation', () => {
  const timeline = [
    inject('t0', 10, '2026-01-01T00:00:00Z', 0),
    inject('t1a', 20, '2026-01-01T01:00:00Z', 0),
    inject('t1b', 5, '2026-01-01T01:00:00Z', 1),
    inject('t2', 3, '2026-01-01T02:00:00Z', 0),
    withdraw('w2', 2, '2026-01-01T02:00:00Z', 1),
  ];
  const reference = replayTransfers(timeline);
  for (const permutation of [
    [...timeline].reverse(),
    [timeline[3], timeline[0], timeline[4], timeline[2], timeline[1]],
    [timeline[2], timeline[4], timeline[0], timeline[3], timeline[1]],
  ]) {
    const replayed = replayTransfers(permutation);
    assert.deepEqual(replayed.appliedTransferIds, reference.appliedTransferIds);
    assert.deepEqual(replayed.componentMoles, reference.componentMoles);
    assert.deepEqual(replayed.journal.map((entry) => entry.fingerprint), reference.journal.map((entry) => entry.fingerprint));
  }
});

test('identical payloads with the same id replay idempotently', () => {
  const event = inject('dup', 40, '2026-01-01T00:00:00Z', 0);
  const once = replayTransfers([event, { ...event }, { ...event }]);
  assert.equal(once.revision, 1);
  assert.equal(once.appliedTransferIds.length, 1);
  assertBalances(once, { H2: 40 });

  // Replaying the whole batch again must converge on the same ledger.
  assert.deepEqual(replayTransfers([{ ...event }]).componentMoles, once.componentMoles);

  // Single-entry application stays idempotent too.
  const again = applyTransfer(once, { ...event });
  assert.equal(again.revision, 1);
  assertBalances(again, { H2: 40 });
});

test('same id with different payloads conflicts explicitly', () => {
  const original = inject('x', 40, '2026-01-01T00:00:00Z', 0);
  const altered = inject('x', 41, '2026-01-01T00:00:00Z', 0);
  expectCode(() => replayTransfers([original, altered]), 'TRANSFER_ID_CONFLICT', 409);
  // Conflict must surface regardless of arrival position.
  expectCode(() => replayTransfers([altered, original]), 'TRANSFER_ID_CONFLICT', 409);

  const state = replayTransfers([original]);
  expectCode(() => applyTransfer(state, altered), 'TRANSFER_ID_CONFLICT', 409);
  // The rejected conflict leaves the prior state untouched.
  assertBalances(state, { H2: 40 });
  assert.equal(state.revision, 1);
});

test('different composition under the same id is a conflict', () => {
  const original = inject('x', 40, '2026-01-01T00:00:00Z', 0, { H2: 1 });
  const altered = inject('x', 40, '2026-01-01T00:00:00Z', 0, { H2: 0.9, CH4: 0.1 });
  expectCode(() => replayTransfers([original, altered]), 'TRANSFER_ID_CONFLICT', 409);
});

test('mixed timestamped and untimed events reject the whole batch', () => {
  const events = [
    inject('a', 100, '2026-01-01T00:00:00Z', 0),
    inject('b', 50, undefined, undefined),
  ];
  expectCode(() => replayTransfers(events), 'MIXED_EVENT_TIME_REPLAY', 422);
  // The defect must be caught even if the untimed event is followed by valid ones.
  expectCode(() => replayTransfers([events[1], events[0], inject('c', 1, '2026-01-02T00:00:00Z', 0)]), 'MIXED_EVENT_TIME_REPLAY', 422);
});

test('illegal sequences are rejected', () => {
  expectCode(() => replayTransfers([inject('neg', 1, '2026-01-01T00:00:00Z', -1)]), 'INVALID_TRANSFER_SEQUENCE', 422);
  expectCode(() => replayTransfers([inject('frac', 1, '2026-01-01T00:00:00Z', 1.5)]), 'INVALID_TRANSFER_SEQUENCE', 422);
  expectCode(() => replayTransfers([inject('nonnum', 1, '2026-01-01T00:00:00Z', Number.NaN)]), 'INVALID_TRANSFER_SEQUENCE', 422);
  // Two events at the same tick without an explicit tiebreaker.
  expectCode(
    () => replayTransfers([inject('a', 1, '2026-01-01T00:00:00Z', undefined), inject('b', 1, '2026-01-01T00:00:00Z', 0)]),
    'INVALID_TRANSFER_SEQUENCE', 422,
  );
  // Duplicate sequence at the same tick.
  expectCode(
    () => replayTransfers([inject('a', 1, '2026-01-01T00:00:00Z', 2), inject('b', 1, '2026-01-01T00:00:00Z', 2)]),
    'INVALID_TRANSFER_SEQUENCE', 422,
  );
});

test('a lone event at a timestamp needs no sequence', () => {
  const state = replayTransfers([inject('solo', 10, '2026-01-01T00:00:00Z', undefined)]);
  assertBalances(state, { H2: 10 });
});

test('untimed batches retain arrival order', () => {
  const state = replayTransfers([inject('first', 100, undefined, undefined), withdraw('second', 40, undefined, undefined)]);
  assert.deepEqual(state.appliedTransferIds, ['first', 'second']);
  assertBalances(state, { H2: 60 });
});

test('shortage is evaluated against event-time order, not arrival order', () => {
  // Injection for noon arrives first, but the early-morning withdrawal still
  // executes first under deterministic ordering and must fail on shortage.
  const lateInjection = inject('fill', 100, '2026-01-01T12:00:00Z', 0);
  const earlyWithdrawal = withdraw('drain', 50, '2026-01-01T06:00:00Z', 0);
  expectCode(() => replayTransfers([lateInjection, earlyWithdrawal]), 'INSUFFICIENT_COMPONENT_INVENTORY', 409);

  // A batch that fails mid-way leaves no observable state: the valid prefix can
  // still replay on its own, and replay is a pure function (no hidden ledger).
  const prefix = replayTransfers([inject('seed', 60, '2026-01-01T00:00:00Z', 0)]);
  assertBalances(prefix, { H2: 60 });
});

test('component shortage identifies the missing component and applies atomically', () => {
  const seeded = replayTransfers([inject('seed', 100, '2026-01-01T00:00:00Z', 0, { H2: 0.8, CH4: 0.2 })]);
  const error = expectCode(
    () => applyTransfer(seeded, withdraw('take', 50, '2026-01-02T00:00:00Z', 0, { H2: 0.5, CH4: 0.5 })),
    'INSUFFICIENT_COMPONENT_INVENTORY', 409,
  );
  const details = error.details as { shortages: Array<{ component: string }> };
  assert.ok(details.shortages.some((item) => item.component === 'CH4'));
  // No revision bump, no journal entry, no balance mutation.
  assert.equal(seeded.revision, 1);
  assert.equal(seeded.journal.length, 1);
  assertBalances(seeded, { H2: 80, CH4: 20 });
});

test('invalid event time fails the batch before staging', () => {
  expectCode(() => replayTransfers([inject('bad', 1, 'not-a-date', 0)]), 'INVALID_TRANSFER_TIME', 422);
});

test('invalid payload anywhere in the batch rejects the entire replay', () => {
  expectCode(
    () => replayTransfers([
      inject('good', 100, '2026-01-01T00:00:00Z', 0),
      { id: 'weird', direction: 'sideways' as unknown as 'inject', amount: 1, unit: 'mol', composition: { H2: 1 }, recordedAt: '2026-01-02T00:00:00Z', sequence: 0 },
    ]),
    'INVALID_TRANSFER_DIRECTION', 422,
  );
  expectCode(
    () => replayTransfers([
      inject('good', 100, '2026-01-01T00:00:00Z', 0),
      inject('negative', -5, '2026-01-02T00:00:00Z', 0),
    ]),
    'OUT_OF_RANGE', 422,
  );
  expectCode(
    () => replayTransfers([
      inject('good', 100, '2026-01-01T00:00:00Z', 0),
      inject('empty', 1, '2026-01-02T00:00:00Z', 0, { H2: 0 }),
    ]),
    'EMPTY_COMPOSITION', 422,
  );
});

test('balances, audit journal, revision and fingerprints stay mutually consistent', () => {
  const state = replayTransfers([
    inject('a', 100, '2026-01-01T00:00:00Z', 0, { H2: 0.7, CH4: 0.2, N2: 0.1 }),
    inject('b', 50, '2026-01-01T00:00:00Z', 1, { H2: 1 }),
    withdraw('c', 30, '2026-01-02T00:00:00Z', 0, { H2: 0.9, CH4: 0.1 }),
    inject('d', 20, '2026-01-03T00:00:00Z', 0, { H2: 0.5, CO2: 0.5 }),
  ]);
  verifyLedgerInvariants(state);
  assert.equal(state.journal.length, state.revision);
  assert.equal(state.appliedTransferIds.length, state.revision);
  assert.equal(Object.keys(state.transferFingerprints).length, state.revision);
  for (const entry of state.journal) assert.equal(state.transferFingerprints[entry.id], entry.fingerprint);

  const journalMoles = journalComponentMoles(state);
  for (const key of COMPONENTS) assert.ok(Math.abs(journalMoles[key] - state.componentMoles[key]) < 1e-9);
  assert.ok(reconcileComponents(journalMoles, state.componentMoles).balanced);

  const summary = summarizeInventory(state);
  assert.ok(Math.abs(summary.totalMoles - COMPONENTS.reduce((sum, key) => sum + state.componentMoles[key], 0)) < 1e-9);
});

test('empty replay is a balanced empty ledger', () => {
  const state = replayTransfers([]);
  assert.deepEqual(state, emptyLedger());
  verifyLedgerInvariants(state);
  assert.equal(reconcileComponents(journalComponentMoles(state), state.componentMoles).balanced, true);
});

test('service inventory response carries a journal-consistent reconciliation summary', () => {
  const result = assessmentService.inventory([
    inject('a', 100, '2026-01-01T00:00:00Z', 0),
    withdraw('b', 25, '2026-01-02T00:00:00Z', 0, { H2: 1 }),
  ]);
  assert.equal(result.revision, 2);
  assert.equal(result.totalMoles, 75);
  assert.equal(result.journal.length, 2);
  assert.equal(result.reconciliation.balanced, true);
  for (const key of COMPONENTS) {
    assert.ok(Math.abs(result.journalMoles[key] - result.componentMoles[key]) < 1e-9);
  }
});
