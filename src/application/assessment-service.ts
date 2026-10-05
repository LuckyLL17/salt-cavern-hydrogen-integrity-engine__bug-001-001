import { replayTransfers, verifyLedgerInvariants, type Transfer } from '../domain/inventory/ledger.ts';
import { summarizeInventory, reconcileComponents, journalComponentMoles } from '../domain/inventory/reconciliation.ts';
import { simulateDispatch, type DispatchLimits, type DispatchState } from '../domain/dispatch/simulator.ts';
import { evaluateWellbore, maximumWellboreStress, type WellSegment } from '../domain/wellbore/evaluator.ts';
import { correctSample } from '../domain/monitoring/correction.ts';
import { fuseLeakEvidence } from '../domain/leak/fusion.ts';
import { withdrawFromLayers, type InventoryLayer, type Withdrawal } from '../domain/purity/withdrawal.ts';
import { blendProducts } from '../domain/purity/blending.ts';
import { sampleParameters, type UncertaintyInput } from '../domain/uncertainty/sampler.ts';
import { cavernVolumeM3, cavernVolumeToDepth } from '../domain/geometry/interface-volume.ts';
import { depthAtCumulativeVolume } from '../domain/geometry/inversion.ts';
import { advanceGeoHistory, type GeoInterval, type GeoParameters, type GeoState } from '../domain/geomechanics/history.ts';
import { initialGeoState } from '../domain/geomechanics/damage-state.ts';
import { safetyPressureEnvelope } from '../domain/geomechanics/pressure-envelope.ts';
import { allocateSharedCapacity, type FacilityRequest } from '../domain/facility/allocator.ts';
import { solveGasState } from '../domain/dispatch/eos.ts';
import type { Calibration, LeakEvidence, GeometryPoint, Composition } from '../domain/types.ts';

export const assessmentService = {
  inventory(transfers: Transfer[]) {
    const state = replayTransfers(transfers);
    // Re-derive balances from signed audit-journal movements and reconcile them
    // against the ledger before returning, so balances, journal and the
    // reconciliation summary can never disagree after a replay.
    verifyLedgerInvariants(state);
    const summary = summarizeInventory(state);
    const journalMoles = journalComponentMoles(state);
    const reconciliation = reconcileComponents(journalMoles, state.componentMoles);
    return { ...summary, journal: state.journal, journalMoles, reconciliation };
  },
  reconcile(expected: Composition, observed: Composition, absoluteToleranceMol?: number, relativeTolerance?: number) { return reconcileComponents(expected, observed, absoluteToleranceMol, relativeTolerance); },
  dispatch(initial: DispatchState, steps: Parameters<typeof simulateDispatch>[1], limits: DispatchLimits) { return simulateDispatch(initial, steps, limits); },
  wellbore(segments: WellSegment[], surfacePressureKpa: number, ambientTemperatureK: number, shutInHours: number) {
    const loads = evaluateWellbore(segments, surfacePressureKpa, ambientTemperatureK, shutInHours);
    return { loads, maximumEquivalentStressMpa: maximumWellboreStress(loads), maximumUtilization: Math.max(...loads.map((load) => load.utilization)) };
  },
  monitoring(sample: Parameters<typeof correctSample>[0], calibrations: Calibration[], rawUncertainty?: number) { return correctSample(sample, calibrations, rawUncertainty); },
  leak(evidence: LeakEvidence[], priorProbability?: number) { return fuseLeakEvidence(evidence, priorProbability); },
  purity(layers: InventoryLayer[], withdrawals: Withdrawal[], minimumManifoldPurity = 0) {
    const result = withdrawFromLayers(layers, withdrawals);
    return { ...result, manifold: blendProducts(result.products, minimumManifoldPurity) };
  },
  uncertainty(input: UncertaintyInput) { return sampleParameters(input); },
  geometry(points: GeometryPoint[], depthM?: number, targetVolumeM3?: number) {
    const totalVolumeM3 = cavernVolumeM3(points);
    const evaluationDepthM = depthM ?? points.map((point) => point.depthM).sort((a, b) => a - b).at(-1)!;
    const volumeToDepthM3 = cavernVolumeToDepth(points, evaluationDepthM);
    return { totalVolumeM3, evaluationDepthM, volumeToDepthM3, depthAtTargetVolumeM: targetVolumeM3 === undefined ? null : depthAtCumulativeVolume(points, targetVolumeM3), remainingVolumeM3: totalVolumeM3 - volumeToDepthM3 };
  },
  geomechanics(intervals: GeoInterval[], parameters: GeoParameters, initial?: GeoState, baseMinKpa = 5_000, baseMaxKpa = parameters.referencePressureKpa) {
    const result = advanceGeoHistory(initial ?? initialGeoState(), intervals, parameters);
    return { ...result, pressureEnvelope: safetyPressureEnvelope(result.state, baseMinKpa, baseMaxKpa) };
  },
  facility(requests: FacilityRequest[], stationCapacityMolPerSecond: number, horizonHours = 1) {
    const allocations = allocateSharedCapacity(requests, stationCapacityMolPerSecond, horizonHours);
    return { allocations, requestedMolPerSecond: requests.reduce((sum, item) => sum + item.requestedMolPerSecond, 0), allocatedMolPerSecond: allocations.reduce((sum, item) => sum + item.allocatedMolPerSecond, 0), curtailedMolPerSecond: allocations.reduce((sum, item) => sum + item.curtailedMolPerSecond, 0) };
  },
  gasState(totalMoles: number, volumeM3: number, temperatureK: number, composition: Composition) {
    return solveGasState(totalMoles, volumeM3, temperatureK, composition);
  },
};
