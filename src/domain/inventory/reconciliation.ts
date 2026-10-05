import { DomainError } from '../errors.ts';
import { COMPONENTS, type Composition } from '../types.ts';
import type { AppliedTransfer, LedgerState } from './ledger.ts';
import { molesToAmount } from './units.ts';

export type Reconciliation = {
  balanced: boolean; totalMoles: number; normalVolumeNm3: number;
  composition: Composition; componentVarianceMol: Composition;
  largestVarianceComponent: string | null; varianceNormMol: number;
};

export type InventorySummary = {
  totalMoles: number; normalVolumeNm3: number; composition: Composition; componentMoles: Composition;
  revision: number; appliedTransferIds: string[]; journal: AppliedTransfer[];
};

export function summarizeInventory(state: LedgerState): InventorySummary {
  const total = COMPONENTS.reduce((sum, key) => sum + state.componentMoles[key], 0);
  const composition = total === 0
    ? { H2: 0, CH4: 0, N2: 0, CO2: 0 }
    : Object.fromEntries(COMPONENTS.map((key) => [key, state.componentMoles[key] / total])) as Composition;
  return {
    totalMoles: total,
    normalVolumeNm3: molesToAmount(total, 'Nm3'),
    composition,
    componentMoles: { ...state.componentMoles },
    revision: state.revision,
    appliedTransferIds: [...state.appliedTransferIds],
    journal: state.journal.map((entry) => ({ ...entry, componentMoles: { ...entry.componentMoles } })),
  };
}

export function reconcileComponents(expected: Composition, observed: Composition, absoluteToleranceMol = 1e-6, relativeTolerance = 1e-9): Reconciliation {
  if (absoluteToleranceMol < 0 || relativeTolerance < 0) throw new DomainError('INVALID_RECONCILIATION_TOLERANCE', 'Reconciliation tolerances must be non-negative', 422);
  const componentVarianceMol = Object.fromEntries(COMPONENTS.map((key) => [key, observed[key] - expected[key]])) as Composition;
  const totalMoles = COMPONENTS.reduce((sum, key) => sum + observed[key], 0);
  const composition = totalMoles > 0
    ? Object.fromEntries(COMPONENTS.map((key) => [key, observed[key] / totalMoles])) as Composition
    : { H2: 0, CH4: 0, N2: 0, CO2: 0 };
  const normalizedVariance = COMPONENTS.map((key) => Math.abs(componentVarianceMol[key]) / Math.max(Math.abs(expected[key]), 1));
  const balanced = COMPONENTS.every((key) => Math.abs(componentVarianceMol[key]) <= absoluteToleranceMol + relativeTolerance * Math.abs(expected[key]));
  const norm = Math.sqrt(COMPONENTS.reduce((sum, key) => sum + componentVarianceMol[key] ** 2, 0));
  const largestIndex = normalizedVariance.indexOf(Math.max(...normalizedVariance));
  return {
    balanced, totalMoles, normalVolumeNm3: molesToAmount(totalMoles, 'Nm3'), composition,
    componentVarianceMol, largestVarianceComponent: balanced ? null : COMPONENTS[largestIndex], varianceNormMol: norm,
  };
}
