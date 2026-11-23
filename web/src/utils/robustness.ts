import type { RouteResponse } from '../types.ts';
import {
  classifyNoise,
  classifyRoadGroup,
  classifySurface,
  classifyTraffic,
  type SegmentData,
} from './classification.ts';
import { distanceMeters } from './geo.ts';
import {
  generateBrfFromAxes,
  TEMPLATE_PRESETS,
  type BaseTemplateId,
  type ProfileAxes,
} from './profile-editor.ts';

export type PerturbationDimension =
  | 'Traffic'
  | 'Noise'
  | 'Cycleways'
  | 'Surface'
  | 'Hills'
  | 'Directness'
  | 'Scenery';

export type PerturbationAxisKey =
  | 'traffic'
  | 'hills'
  | 'surface'
  | 'turns'
  | 'crossings'
  | 'cycleways'
  | 'greenery'
  | 'noise'
  | 'lighting';

export type PerturbationVector = Record<PerturbationAxisKey, number>;

export type ProbeKind = 'sample';

export type ScenarioPresetCount = 20 | 40 | 80 | 160 | 320;

export const DEFAULT_SCENARIO_COUNT: ScenarioPresetCount = 20;

export interface RobustnessProbeSpec {
  id: string;
  kind: ProbeKind;
  label: string;
  dimension: PerturbationDimension;
  description: string;
  u: PerturbationVector;
  norm: number;
  fullDsl: string;
  screeningDsl: string;
  axes?: ProfileAxes;
  baseTemplate?: BaseTemplateId;
}

export interface RobustnessProbeResult {
  id: string;
  kind: ProbeKind;
  label: string;
  dimension: PerturbationDimension;
  description: string;
  u?: PerturbationVector;
  norm?: number;
  fullDsl: string;
  axes?: ProfileAxes;
  baseTemplate?: BaseTemplateId;
  route: RouteResponse;
}

export type StabilityBand = 'high' | 'medium' | 'low';

export interface StabilitySegmentSpan {
  coordinates: [number, number][];
  stability: number;
  band: StabilityBand;
  color: string;
  distanceM: number;
}

export type RobustnessViewMode = 'segments' | 'variants';
export type RobustnessFilterMode = 'frequent' | 'all';

export interface SpanProfileMix {
  hasData: boolean;
  pavedPct: number;
  cobblePct: number;
  unpavedPct: number;
  unknownSurfacePct: number;
  pathTrackPct: number;
  smallRoadPct: number;
  mainRoadPct: number;
  quietTrafficPct: number;
  busyTrafficPct: number;
  heavyTrafficPct: number;
  veryQuietNoisePct: number;
  moderateNoisePct: number;
  loudNoisePct: number;
  dominantSurface: string;
  dominantRoad: string;
  dominantTraffic: string;
  dominantNoise: string;
}

export interface AlternativeCorridor {
  id: string;
  label: string;
  probeLabels: string[];
  description: string;
  dimension: PerturbationDimension;
  probeCount: number;
  sharePct: number;
  route: RouteResponse;
  coordinates: [number, number][];
  midpoint: [number, number];
  color: { line: string; casing: string };
  distanceM: number;
  timeS: number;
  ascentM: number;
  deltaDistanceM: number;
  deltaTimeS: number;
  deltaAscentM: number;
  overlapWithBase: number;
  routeMix: SpanProfileMix;
  baseMix: SpanProfileMix;
  fullDsl: string;
  axes?: ProfileAxes;
  baseTemplate?: BaseTemplateId;
}

export interface AlternativeBranch {
  id: string;
  label: string;
  probeLabels: string[];
  description: string;
  dimension: PerturbationDimension;
  probeCount: number;
  sharePct: number;
  coordinates: [number, number][];
  midpoint: [number, number];
  replacedBaseCoords: [number, number][];
  color: { line: string; casing: string };
  baseStartM: number;
  baseEndM: number;
  distanceM: number;
  replacedBaseDistM: number;
  deltaDistanceM: number;
  ascentM: number;
  replacedBaseAscentM: number;
  deltaAscentM: number;
  branchMix: SpanProfileMix;
  baseMix: SpanProfileMix;
  fullDsl: string;
  axes?: ProfileAxes;
  baseTemplate?: BaseTemplateId;
}

export interface DimensionSensitivity {
  dimension: PerturbationDimension;
  maxDivergencePct: number;
}

export interface RobustnessAnalysis {
  completedCount: number;
  totalCount: number;
  overallStability: number;
  spineShare: number;
  fragileShare: number;
  baseMatchingProbes: number;
  segments: StabilitySegmentSpan[];
  corridors: AlternativeCorridor[];
  branches: AlternativeBranch[];
  dimensions: DimensionSensitivity[];
}

export const STABILITY_COLORS: Record<StabilityBand, string> = {
  high: '#059669',
  medium: '#d97706',
  low: '#dc2626',
};

export const ROBUSTNESS_CORRIDOR_COLORS: ReadonlyArray<{ line: string; casing: string }> = [
  { line: '#a855f7', casing: '#3b0764' },
  { line: '#06b6d4', casing: '#083344' },
  { line: '#ec4899', casing: '#500724' },
  { line: '#f97316', casing: '#431407' },
  { line: '#3b82f6', casing: '#172554' },
  { line: '#14b8a6', casing: '#042f2e' },
  { line: '#eab308', casing: '#422006' },
  { line: '#f43f5e', casing: '#4c0519' },
  { line: '#8b5cf6', casing: '#2e1065' },
  { line: '#84cc16', casing: '#1a2e05' },
  { line: '#0ea5e9', casing: '#0c4a6e' },
  { line: '#d946ef', casing: '#4a044e' },
];

const MAX_DISPLAY_CORRIDORS = 24;
const MAX_DISPLAY_BRANCHES = 48;
const MAX_SINGLE_HIT_CORRIDORS = 6;
const MAX_SINGLE_HIT_BRANCHES = 8;
const MIN_BRANCH_DIST_M = 180;
const MAX_ON_BASE_BRIDGE_M = 100;
const BRANCH_MERGE_OVERLAP = 0.72;

const AXIS_KEYS: readonly PerturbationAxisKey[] = [
  'traffic',
  'hills',
  'surface',
  'turns',
  'crossings',
  'cycleways',
  'greenery',
  'noise',
  'lighting',
] as const;

const AXIS_META: Record<
  PerturbationAxisKey,
  { dimension: PerturbationDimension; posTag: string; negTag: string }
> = {
  traffic: { dimension: 'Traffic', posTag: 'Quieter traffic', negTag: 'Main roads ok' },
  noise: { dimension: 'Noise', posTag: 'Lower noise', negTag: 'Noise tolerant' },
  cycleways: { dimension: 'Cycleways', posTag: 'Bike routes', negTag: 'Free road choice' },
  surface: { dimension: 'Surface', posTag: 'Smoother tarmac', negTag: 'Off-road / gravel' },
  hills: { dimension: 'Hills', posTag: 'Flatter', negTag: 'Climbs ok' },
  turns: { dimension: 'Directness', posTag: 'Fewer turns', negTag: 'Agile turns' },
  crossings: { dimension: 'Traffic', posTag: 'Safer junctions', negTag: 'Direct crossings' },
  greenery: { dimension: 'Scenery', posTag: 'Greener / parks', negTag: 'Urban direct' },
  lighting: { dimension: 'Scenery', posTag: 'Well-lit', negTag: 'Unlit ok' },
};

const DIMENSION_ORDER: PerturbationDimension[] = [
  'Traffic',
  'Noise',
  'Cycleways',
  'Surface',
  'Hills',
  'Directness',
  'Scenery',
];

// 9 axis primes + 10th prime for radial perturbation scale, with Cranley-Patterson shifts
// and a skip offset to avoid initial Halton prime correlation on small sweeps.
const HALTON_PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29] as const;
const HALTON_SHIFTS = [
  0.6180339887,
  0.2360679775,
  0.8541019662,
  0.472135955,
  0.0901699437,
  0.7082039325,
  0.3262379212,
  0.94427191,
  0.5623058987,
  0.1803398875,
] as const;
const HALTON_SKIP = 37;

/** Low-discrepancy Halton sequence in (0, 1) for deterministic quasi-Monte-Carlo sampling. */
export function halton(index: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let i = index;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

/**
 * Draws sample m >= 1 from a 9D Cranley-Patterson shifted Halton cube scaled by a 10th-prime
 * radial magnitude in [0.35, 1.0], covering both tight local perturbations and wide exploration.
 */
export function samplePerturbationVector(m: number): { u: PerturbationVector; norm: number } {
  const idx = m + HALTON_SKIP;
  const radius = 0.35 + 0.65 * ((halton(idx, HALTON_PRIMES[9]) + HALTON_SHIFTS[9]) % 1);
  const draw = (dim: number) =>
    (((halton(idx, HALTON_PRIMES[dim]) + HALTON_SHIFTS[dim]) % 1) * 2 - 1) * radius;

  const u: PerturbationVector = {
    traffic: draw(0),
    hills: draw(1),
    surface: draw(2),
    turns: draw(3),
    crossings: draw(4),
    cycleways: draw(5),
    greenery: draw(6),
    noise: draw(7),
    lighting: draw(8),
  };

  let sumSq = 0;
  for (const key of AXIS_KEYS) {
    sumSq += u[key] * u[key];
  }
  return { u, norm: Math.sqrt(sumSq) };
}

function splitBrfContexts(dsl: string): {
  headerAndGlobal: string;
  wayHeader: string;
  wayBody: string;
  nodeHeader: string;
  nodeBody: string;
} {
  const wayMatch = /^---context:way\b.*$/m.exec(dsl);
  const nodeMatch = /^---context:node\b.*$/m.exec(dsl);
  if (!wayMatch || !nodeMatch || wayMatch.index === undefined || nodeMatch.index === undefined) {
    throw new Error('BRF profile must contain ---context:global, ---context:way, and ---context:node');
  }
  const wayStart = wayMatch.index;
  const wayEnd = wayStart + wayMatch[0].length;
  const nodeStart = nodeMatch.index;
  const nodeEnd = nodeStart + nodeMatch[0].length;

  return {
    headerAndGlobal: dsl.slice(0, wayStart).trimEnd(),
    wayHeader: wayMatch[0],
    wayBody: dsl.slice(wayEnd, nodeStart).trimEnd(),
    nodeHeader: nodeMatch[0],
    nodeBody: dsl.slice(nodeEnd).trimEnd(),
  };
}

export function injectDslOverrides(
  baseDsl: string,
  overrides: {
    globalLines?: string[];
    wayLines?: string[];
    nodeLines?: string[];
  },
): string {
  const parts = splitBrfContexts(baseDsl);
  const gExtra = overrides.globalLines?.length ? '\n' + overrides.globalLines.join('\n') : '';
  const wExtra = overrides.wayLines?.length ? '\n' + overrides.wayLines.join('\n') : '';
  const nExtra = overrides.nodeLines?.length ? '\n' + overrides.nodeLines.join('\n') : '';

  return [
    parts.headerAndGlobal + gExtra,
    '',
    parts.wayHeader,
    parts.wayBody + wExtra,
    '',
    parts.nodeHeader,
    parts.nodeBody + nExtra,
    '',
  ].join('\n');
}

/**
 * Sets pass2coefficient = -1 at the end of ---context:global so BRouter runs single-pass
 * heuristic A* screening followed by full geometry and elevation re-tracking.
 */
export function injectScreeningPass2(dsl: string): string {
  return injectDslOverrides(dsl, {
    globalLines: ['assign pass2coefficient = -1'],
  });
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function scaleFinite(val: number, factor: number, add = 0, max = 20): number {
  if (val >= 9999) return val;
  return Number(clamp(val * factor + add, 0, max).toFixed(2));
}

function scaleIntFinite(val: number, factor: number, add = 0, max = 500): number {
  if (val >= 9999) return val;
  return Math.round(clamp(val * factor + add, 0, max));
}

function dominantAxisOf(u: PerturbationVector): {
  key: PerturbationAxisKey;
  dimension: PerturbationDimension;
  topTag: string;
  secondTag: string;
} {
  const ranked = AXIS_KEYS.map((key) => ({
    key,
    val: u[key],
    mag: Math.abs(u[key]),
  })).sort((a, b) => b.mag - a.mag);

  const first = ranked[0];
  const second = ranked[1];
  const m1 = AXIS_META[first.key];
  const m2 = AXIS_META[second.key];
  return {
    key: first.key,
    dimension: m1.dimension,
    topTag: first.val >= 0 ? m1.posTag : m1.negTag,
    secondTag: second.val >= 0 ? m2.posTag : m2.negTag,
  };
}

function buildAxesProbes(
  baseAxes: ProfileAxes,
  baseTemplate: BaseTemplateId,
  profileLabel: string,
  scenarioCount: number,
): RobustnessProbeSpec[] {
  const probes: RobustnessProbeSpec[] = [];
  const lnSpan = Math.log(2.8); // ~[0.36x, 2.80x] standard multiplicative span
  const lnHighUp = Math.log(4.8); // stronger upward sweep on traffic, noise, and cycle adhesion
  const lnRoughDown = Math.log(7.5); // strong relaxation on unpaved/trail axes when u.surface < 0

  for (let m = 1; m <= scenarioCount; m++) {
    const { u, norm } = samplePerturbationVector(m);

    const kTraffic = u.traffic >= 0 ? Math.exp(u.traffic * lnHighUp) : Math.exp(u.traffic * lnSpan);
    const kHills = Math.exp(u.hills * lnSpan);
    const kSurface =
      u.surface >= 0 ? Math.exp(u.surface * lnSpan) : Math.exp(u.surface * lnRoughDown);
    const kPathGate = u.surface >= 0 ? kSurface : kSurface * 0.5;
    const kTurns = Math.exp(u.turns * lnSpan);
    const kCross = Math.exp(u.crossings * lnSpan);
    const kCycle = u.cycleways >= 0 ? Math.exp(u.cycleways * lnHighUp) : Math.exp(u.cycleways * lnSpan);
    const kScenery = Math.exp(u.greenery * lnSpan);
    const kNoise = u.noise >= 0 ? Math.exp(u.noise * lnHighUp) : Math.exp(u.noise * lnSpan);
    const kEnv = Math.exp(u.lighting * lnSpan);

    const tPos = Math.max(0, u.traffic);
    const nPos = Math.max(0, u.noise);
    const cPos = Math.max(0, u.cycleways);

    const hillAdd = u.hills > 0.15 && baseAxes.uphillCost < 25 ? Math.round(u.hills * 75) : 0;
    const greenAdd = u.greenery > 0.15 ? Number(((u.greenery - 0.15) * 1.25).toFixed(2)) : 0;
    const tarmacBias = u.surface < -0.3 ? Number(((-u.surface - 0.3) * 0.95).toFixed(2)) : 0;
    const roughAdd = u.surface > 0.3 ? Number(((u.surface - 0.3) * 0.9).toFixed(2)) : 0;

    const baseTurnCycle = scaleIntFinite(baseAxes.turnCostCycleRoute, kTurns, 0, 300);

    const nextAxes: ProfileAxes = {
      ...baseAxes,
      enableTrafficPenalties: baseAxes.enableTrafficPenalties || tPos > 0.15,
      allowUrbanTrunks:
        u.traffic < -0.15 ? true : u.traffic > 0.25 ? false : baseAxes.allowUrbanTrunks,
      allowBusLanes: u.cycleways > 0.2 || u.traffic < -0.15 ? true : baseAxes.allowBusLanes,
      useProposedCycleRoutes: u.cycleways > 0.2 ? true : baseAxes.useProposedCycleRoutes,
      stickToCycleRoutes:
        u.cycleways < -0.5 ? false : u.cycleways > 0.1 ? true : baseAxes.stickToCycleRoutes,

      trunkCost:
        u.traffic < -0.35
          ? Math.min(baseAxes.trunkCost, 1.5)
          : baseAxes.trunkCost,
      primaryCost: scaleFinite(
        baseAxes.primaryCost,
        kTraffic,
        tPos > 0.15 ? (tPos - 0.15) * 2.6 : tarmacBias * 0.5,
        20,
      ),
      secondaryCost: scaleFinite(
        baseAxes.secondaryCost,
        kTraffic,
        tPos > 0.15 ? (tPos - 0.15) * 1.6 : tarmacBias * 0.4,
        10,
      ),
      tertiaryCost: scaleFinite(
        baseAxes.tertiaryCost,
        kTraffic,
        tPos > 0.25 ? (tPos - 0.25) * 0.8 : tarmacBias * 0.5,
        10,
      ),
      unclassifiedCost: scaleFinite(baseAxes.unclassifiedCost, 1, tarmacBias * 0.6, 10),
      residentialCost: scaleFinite(baseAxes.residentialCost, 1, tarmacBias * 0.75, 10),
      trafficClass2Penalty: scaleFinite(
        baseAxes.trafficClass2Penalty,
        kTraffic,
        tPos > 0.45 ? (tPos - 0.45) * 0.5 : 0,
        10,
      ),
      trafficClass3Penalty: scaleFinite(
        baseAxes.trafficClass3Penalty,
        kTraffic,
        tPos > 0.2 ? (tPos - 0.2) * 1.2 : 0,
        10,
      ),
      trafficClass4Penalty: scaleFinite(
        baseAxes.trafficClass4Penalty,
        kTraffic,
        tPos > 0.15 ? (tPos - 0.15) * 2.4 : 0,
        10,
      ),
      trafficClass5Penalty: scaleFinite(
        baseAxes.trafficClass5Penalty,
        kTraffic,
        tPos > 0.15 ? (tPos - 0.15) * 3.4 : 0,
        10,
      ),
      trafficClass6Penalty: scaleFinite(
        baseAxes.trafficClass6Penalty,
        kTraffic,
        tPos > 0.15 ? (tPos - 0.15) * 4.4 : 0,
        10,
      ),
      trafficClass7Penalty: scaleFinite(
        baseAxes.trafficClass7Penalty,
        kTraffic,
        tPos > 0.15 ? (tPos - 0.15) * 4.8 : 0,
        10,
      ),

      considerElevation: baseAxes.considerElevation || hillAdd > 0,
      uphillCost: clamp(Math.round(baseAxes.uphillCost * kHills + hillAdd), 0, 200),
      uphillCutoff: Number(clamp(baseAxes.uphillCutoff * (1 - u.hills * 0.4), 0.7, 3.8).toFixed(1)),
      downhillCost: clamp(Math.round(baseAxes.downhillCost * kHills), 0, 200),

      asphaltPenalty: scaleFinite(baseAxes.asphaltPenalty, 1, tarmacBias, 15),
      pavedPenalty: scaleFinite(baseAxes.pavedPenalty, 1, tarmacBias * 0.85, 15),
      concretePenalty: scaleFinite(baseAxes.concretePenalty, 1, tarmacBias * 0.85, 15),
      untaggedRoadSurfacePenalty: scaleFinite(
        baseAxes.untaggedRoadSurfacePenalty,
        1,
        tarmacBias * 0.85,
        15,
      ),
      compactedPenalty: scaleFinite(baseAxes.compactedPenalty, kSurface, roughAdd * 0.6, 15),
      fineGravelPenalty: scaleFinite(baseAxes.fineGravelPenalty, kSurface, roughAdd * 0.8, 15),
      gravelPenalty: scaleFinite(baseAxes.gravelPenalty, kSurface, roughAdd * 1.2, 15),
      pebblestonePenalty: scaleFinite(baseAxes.pebblestonePenalty, kSurface, roughAdd * 1.2, 15),
      unpavedPenalty: scaleFinite(baseAxes.unpavedPenalty, kSurface, roughAdd * 1.5, 15),
      grassPenalty: scaleFinite(baseAxes.grassPenalty, kSurface, roughAdd * 1.5, 15),
      pavingStonesPenalty: scaleFinite(baseAxes.pavingStonesPenalty, kSurface, 0, 15),
      settPenalty: scaleFinite(baseAxes.settPenalty, kSurface, 0, 15),
      cobblestonePenalty: scaleFinite(baseAxes.cobblestonePenalty, kSurface, 0, 15),
      untaggedPathSurfacePenalty: scaleFinite(
        baseAxes.untaggedPathSurfacePenalty,
        kPathGate,
        roughAdd,
        15,
      ),

      trackGrade1Cost: scaleFinite(baseAxes.trackGrade1Cost, kSurface, 0, 20),
      trackGrade2Cost: scaleFinite(baseAxes.trackGrade2Cost, kSurface, 0, 20),
      trackGrade3Cost: scaleFinite(baseAxes.trackGrade3Cost, kSurface, 0, 20),
      trackGrade4Cost: scaleFinite(baseAxes.trackGrade4Cost, kSurface, 0, 20),
      trackUntaggedCost: scaleFinite(baseAxes.trackUntaggedCost, kPathGate, 0, 20),
      pathCost: scaleFinite(baseAxes.pathCost, kSurface, 0, 20),
      bridlewayCost: scaleFinite(baseAxes.bridlewayCost, kSurface, 0, 20),
      footwayCost: scaleFinite(baseAxes.footwayCost, kPathGate, 0, 20),
      pedestrianCost: scaleFinite(baseAxes.pedestrianCost, kPathGate, 0, 20),

      turnCostGeneric: scaleIntFinite(baseAxes.turnCostGeneric, kTurns, 0, 300),
      turnCostCycleRoute:
        cPos > 0.25
          ? Math.min(baseTurnCycle, Math.round(baseAxes.turnCostCycleRoute / Math.sqrt(kCycle)))
          : baseTurnCycle,
      trafficSignalCost: scaleIntFinite(baseAxes.trafficSignalCost, kTurns, 0, 300),
      stopGiveWayCost: scaleIntFinite(baseAxes.stopGiveWayCost, kTurns, 0, 300),
      roadTransitionCost: scaleIntFinite(baseAxes.roadTransitionCost, kTurns, 0, 300),

      crossingClass3Cost: scaleIntFinite(
        baseAxes.crossingClass3Cost,
        kCross,
        tPos > 0.4 ? Math.round((tPos - 0.4) * 80) : 0,
        500,
      ),
      crossingClass4Cost: scaleIntFinite(baseAxes.crossingClass4Cost, kCross, 0, 500),
      crossingClass5Cost: scaleIntFinite(baseAxes.crossingClass5Cost, kCross, 0, 500),
      turnAcrossTrafficClass3Cost: scaleIntFinite(baseAxes.turnAcrossTrafficClass3Cost, kCross, 0, 500),
      turnAcrossTrafficClass4Cost: scaleIntFinite(baseAxes.turnAcrossTrafficClass4Cost, kCross, 0, 500),
      turnAcrossTrafficClass5Cost: scaleIntFinite(baseAxes.turnAcrossTrafficClass5Cost, kCross, 0, 500),

      nonCycleRouteRoadPenalty: clamp(
        Number((baseAxes.nonCycleRouteRoadPenalty * kCycle + (cPos > 0.1 ? (cPos - 0.1) * 2.8 : 0)).toFixed(2)),
        0,
        5,
      ),
      cyclewayCost: scaleFinite(baseAxes.cyclewayCost, 1 / kCycle, 0, 20),
      cyclewaySharedCost: scaleFinite(baseAxes.cyclewaySharedCost, 1 / kCycle, 0, 20),

      enableForestPenalties: baseAxes.enableForestPenalties || greenAdd > 0,
      forestUntaggedPenalty: scaleFinite(baseAxes.forestUntaggedPenalty, kScenery, greenAdd, 10),
      forestClass1Penalty: scaleFinite(baseAxes.forestClass1Penalty, kScenery, greenAdd * 0.7, 10),
      forestClass2Penalty: scaleFinite(baseAxes.forestClass2Penalty, kScenery, greenAdd * 0.4, 10),
      forestClass3Penalty: scaleFinite(baseAxes.forestClass3Penalty, kScenery, greenAdd * 0.2, 10),

      enableNoisePenalties: baseAxes.enableNoisePenalties || nPos > 0.15,
      noiseClass3Penalty: scaleFinite(
        baseAxes.noiseClass3Penalty,
        kNoise,
        nPos > 0.3 ? (nPos - 0.3) * 0.9 : 0,
        10,
      ),
      noiseClass4Penalty: scaleFinite(
        baseAxes.noiseClass4Penalty,
        kNoise,
        nPos > 0.15 ? (nPos - 0.15) * 2.0 : 0,
        10,
      ),
      noiseClass5Penalty: scaleFinite(
        baseAxes.noiseClass5Penalty,
        kNoise,
        nPos > 0.15 ? (nPos - 0.15) * 3.2 : 0,
        10,
      ),
      noiseClass6Penalty: scaleFinite(
        baseAxes.noiseClass6Penalty,
        kNoise,
        nPos > 0.15 ? (nPos - 0.15) * 4.4 : 0,
        10,
      ),

      enableEnvironmentPenalties: baseAxes.enableEnvironmentPenalties || u.lighting > 0.35 || tPos > 0.4,
      multiLanePenalty: scaleFinite(
        baseAxes.multiLanePenalty,
        kEnv,
        u.lighting > 0.45 ? 0.5 : tPos > 0.4 ? (tPos - 0.4) * 1.2 : 0,
        10,
      ),
      unlitPenalty: scaleFinite(baseAxes.unlitPenalty, kEnv, u.lighting > 0.4 ? (u.lighting - 0.4) * 1.6 : 0, 10),
    };

    const dom = dominantAxisOf(u);
    const label = `Sample #${m}`;
    const description = `Perturbation led by ${dom.topTag.toLowerCase()} and ${dom.secondTag.toLowerCase()}.`;
    const fullDsl = generateBrfFromAxes(nextAxes, {
      name: `${profileLabel} (${label})`,
      summary: description,
    });

    probes.push({
      id: `sample-${m}`,
      kind: 'sample',
      label,
      dimension: dom.dimension,
      description,
      u,
      norm,
      fullDsl,
      screeningDsl: injectScreeningPass2(fullDsl),
      axes: nextAxes,
      baseTemplate,
    });
  }

  return probes;
}

function buildDslProbes(baseDsl: string, scenarioCount: number): RobustnessProbeSpec[] {
  const parts = splitBrfContexts(baseDsl);
  const isGlobalVar = (name: string) =>
    new RegExp(`\\bassign\\s+${name}\\b`).test(parts.headerAndGlobal);
  const hasWayTurncost =
    /\bassign\s+turncost\b/.test(parts.wayBody) && !isGlobalVar('turncost');
  const hasNodeInitialcost =
    /\bassign\s+initialcost\b/.test(parts.nodeBody) && !isGlobalVar('initialcost');

  const elevOverrides = (vars: Array<[string, number]>) => {
    const globalLines: string[] = [];
    const wayLines: string[] = [];
    for (const [name, val] of vars) {
      if (isGlobalVar(name)) {
        globalLines.push(`assign ${name} = ${val}`);
      } else {
        wayLines.push(`assign ${name} = ${val}`);
      }
    }
    return { globalLines, wayLines };
  };

  const safeAddWayCost = (expr: string) =>
    `assign costfactor = if greater costfactor 9998 then costfactor else max 1.0 ( add costfactor ( ${expr} ) )`;

  const probes: RobustnessProbeSpec[] = [];
  for (let m = 1; m <= scenarioCount; m++) {
    const { u, norm } = samplePerturbationVector(m);

    const dTraffic = Number((u.traffic >= 0 ? u.traffic * 3.0 : u.traffic * 0.95).toFixed(2));
    const dTrafficMed = Number((u.traffic >= 0.2 ? (u.traffic - 0.2) * 1.5 : 0).toFixed(2));
    const dSurface = Number((u.surface * 2.0).toFixed(2));
    const dTarmac = u.surface < -0.3 ? Number(((-u.surface - 0.3) * 0.95).toFixed(2)) : 0;
    const dCycleOff = Number((u.cycleways >= 0 ? u.cycleways * 2.9 : 0).toFixed(2));
    const dCycleOn = Number(
      (u.cycleways >= 0 ? -Math.min(0.55, u.cycleways * 0.45) : -u.cycleways * 0.4).toFixed(2),
    );
    const dNoiseHi = Number((u.noise >= 0 ? u.noise * 3.2 : u.noise * 0.5).toFixed(2));
    const dNoiseMed = Number((u.noise >= 0.2 ? (u.noise - 0.2) * 1.5 : 0).toFixed(2));
    const dForest = u.greenery > 0.2 ? Number(((u.greenery - 0.2) * 1.0).toFixed(2)) : 0;
    const dUnlit = u.lighting > 0.35 ? Number(((u.lighting - 0.35) * 1.6).toFixed(2)) : 0;
    const upCost = Math.round(clamp(55 + u.hills * 80, 0, 180));
    const upCut = Number(clamp(1.6 - u.hills * 0.8, 0.8, 3.5).toFixed(1));
    const downCost = Math.round(clamp(35 + u.hills * 40, 0, 110));
    const turnMul = Number(clamp(Math.exp(u.turns * 0.8), 0.3, 2.4).toFixed(2));
    const crossAdd = u.crossings > 0.2 ? Math.round((u.crossings - 0.2) * 140) : 0;

    const elev = elevOverrides([
      ['uphillcost', upCost],
      ['uphillcutoff', upCut],
      ['downhillcost', downCost],
    ]);

    const wayLines: string[] = [
      ...elev.wayLines,
      safeAddWayCost(
        `add ( switch highway=primary|primary_link|secondary|secondary_link ${dTraffic} 0 ) ( add ( switch estimated_traffic_class=5|6|7 ${dTraffic} switch estimated_traffic_class=3|4 ${dTrafficMed} 0 ) ( add ( switch surface=compacted|fine_gravel|gravel|unpaved|ground|dirt|earth ${dSurface} switch highway=residential|tertiary ${dTarmac} 0 ) ( add ( switch or route_bicycle_ncn=yes or route_bicycle_rcn=yes or route_bicycle_lcn=yes highway=cycleway ${dCycleOn} ${dCycleOff} ) ( add ( switch estimated_noise_class=5|6 ${dNoiseHi} switch estimated_noise_class=3|4 ${dNoiseMed} 0 ) ( add ( switch estimated_forest_class=3|4|5|6 0 ${dForest} ) ( switch lit=no ${dUnlit} 0 ) ) ) ) ) )`,
      ),
    ];
    if (hasWayTurncost) {
      wayLines.push(`assign turncost = multiply turncost ${turnMul}`);
    }

    const nodeLines =
      crossAdd > 0
        ? [
            hasNodeInitialcost
              ? `assign initialcost = add initialcost switch highway=traffic_signals|crossing|stop|give_way ${crossAdd} 0`
              : `assign initialcost = switch highway=traffic_signals|crossing|stop|give_way ${crossAdd} 0`,
          ]
        : undefined;

    const dom = dominantAxisOf(u);
    const label = `Sample #${m}`;
    const description = `Perturbation led by ${dom.topTag.toLowerCase()} and ${dom.secondTag.toLowerCase()}.`;
    const fullDsl = injectDslOverrides(baseDsl, {
      globalLines: elev.globalLines,
      wayLines,
      nodeLines,
    });

    probes.push({
      id: `sample-${m}`,
      kind: 'sample',
      label,
      dimension: dom.dimension,
      description,
      u,
      norm,
      fullDsl,
      screeningDsl: injectScreeningPass2(fullDsl),
    });
  }

  return probes;
}

export function buildRobustnessProbes(params: {
  baseProfile: string;
  profileLabel?: string;
  axes?: ProfileAxes;
  baseTemplate?: BaseTemplateId;
  baseDsl?: string;
  scenarioCount?: number;
}): RobustnessProbeSpec[] {
  const count = params.scenarioCount ?? DEFAULT_SCENARIO_COUNT;
  const label = params.profileLabel || params.baseProfile;
  if (params.axes) {
    const tpl: BaseTemplateId = params.baseTemplate || 'gabis-fast-city';
    return buildAxesProbes(params.axes, tpl, label, count);
  }
  if (params.baseProfile in TEMPLATE_PRESETS) {
    const tpl = params.baseProfile as BaseTemplateId;
    return buildAxesProbes(TEMPLATE_PRESETS[tpl].axes, tpl, TEMPLATE_PRESETS[tpl].shortLabel, count);
  }
  if (!params.baseDsl) {
    throw new Error(`Missing BRF source for profile ${params.baseProfile}`);
  }
  return buildDslProbes(params.baseDsl, count);
}

// Quantize coordinates onto a ~25 m grid for fast corridor overlap and segment support checks.
const LON_GRID_SCALE = 2600;
const LAT_GRID_SCALE = 4200;
const GRID_OFFSET = 1_000_000;
const GRID_STRIDE = 2_097_152; // 2^21 (> 2 * GRID_OFFSET); max key < 2^43 << Number.MAX_SAFE_INTEGER

function cellKey(gx: number, gy: number): number {
  return (gx + GRID_OFFSET) * GRID_STRIDE + (gy + GRID_OFFSET);
}

function addDilatedCell(grid: Set<number>, gx: number, gy: number): void {
  for (let dx = -1; dx <= 1; dx++) {
    const rowBase = (gx + dx + GRID_OFFSET) * GRID_STRIDE + GRID_OFFSET;
    grid.add(rowBase + (gy - 1));
    grid.add(rowBase + gy);
    grid.add(rowBase + (gy + 1));
  }
}

interface PreparedGeometry {
  dilatedGrid: Set<number>;
  edgeMidKeys: number[];
  edgeDists: Float64Array;
  totalEdgeDistM: number;
}

interface PreparedRouteCacheEntry extends PreparedGeometry {
  coords: [number, number][];
  cumDistM: Float64Array;
  cumAscentM: Float64Array;
  segments: SegmentData[];
  distanceM: number;
  timeS: number;
  ascentM: number;
  edgeFromIdx: Uint32Array;
}

const routeGridCache = new WeakMap<RouteResponse, PreparedRouteCacheEntry>();

function prepareRoute(route: RouteResponse): PreparedRouteCacheEntry {
  const cached = routeGridCache.get(route);
  if (cached) return cached;

  const feat = route.features[0];
  const props = feat?.properties || ({} as Record<string, unknown>);
  const rawCoords = feat?.geometry?.coordinates || [];
  const n = rawCoords.length;
  const coords: [number, number][] = new Array(n);
  const cumDistM = new Float64Array(n);
  const cumAscentM = new Float64Array(n);
  const dilatedGrid = new Set<number>();
  const edgeMidKeys: number[] = [];
  const edgeDistList: number[] = [];
  const edgeFromList: number[] = [];
  let totalEdgeDistM = 0;

  let prevGx = Number.NaN;
  let prevGy = Number.NaN;
  const markPoint = (lon: number, lat: number) => {
    const gx = Math.round(lon * LON_GRID_SCALE);
    const gy = Math.round(lat * LAT_GRID_SCALE);
    if (gx === prevGx && gy === prevGy) return;
    prevGx = gx;
    prevGy = gy;
    addDilatedCell(dilatedGrid, gx, gy);
  };

  let filteredEle = n > 0 ? Number(rawCoords[0][2] || 0) : 0;
  let runningAscent = 0;

  for (let i = 0; i < n; i++) {
    coords[i] = [rawCoords[i][0], rawCoords[i][1]];
  }

  for (let i = 0; i < n; i++) {
    const [lon1, lat1] = coords[i];
    markPoint(lon1, lat1);

    if (i > 0) {
      const ele = Number(rawCoords[i][2] || 0);
      const diff = ele - filteredEle;
      if (diff >= 2.0) {
        runningAscent += diff;
        filteredEle = ele;
      } else if (diff <= -2.0) {
        filteredEle = ele;
      }
      cumAscentM[i] = runningAscent;
    }

    if (i + 1 < n) {
      const [lon2, lat2] = coords[i + 1];
      const segM = distanceMeters({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 });
      cumDistM[i + 1] = cumDistM[i] + segM;
      if (segM > 0) {
        totalEdgeDistM += segM;
        const midGx = Math.round((lon1 + lon2) * 0.5 * LON_GRID_SCALE);
        const midGy = Math.round((lat1 + lat2) * 0.5 * LAT_GRID_SCALE);
        edgeMidKeys.push(cellKey(midGx, midGy));
        edgeDistList.push(segM);
        edgeFromList.push(i);
      }
      if (segM > 18) {
        const steps = Math.min(200, Math.ceil(segM / 15));
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          markPoint(lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t);
        }
      }
    }
  }

  const rawSegments = Array.isArray((props as Record<string, unknown>).segments)
    ? ((props as Record<string, unknown>).segments as SegmentData[])
    : [];

  const entry: PreparedRouteCacheEntry = {
    coords,
    cumDistM,
    cumAscentM,
    segments: rawSegments,
    distanceM: Number(props['track-length'] || 0),
    timeS: Number(props['total-time'] || 0),
    ascentM: Number(props['filtered ascend'] || 0),
    dilatedGrid,
    edgeMidKeys,
    edgeDists: Float64Array.from(edgeDistList),
    edgeFromIdx: Uint32Array.from(edgeFromList),
    totalEdgeDistM,
  };
  routeGridCache.set(route, entry);
  return entry;
}

function computeRouteCoverage(a: PreparedGeometry, b: PreparedGeometry): number {
  const keys = a.edgeMidKeys;
  const dists = a.edgeDists;
  if (keys.length === 0 || a.totalEdgeDistM <= 0) return 1;
  const grid = b.dilatedGrid;
  let matchedM = 0;
  for (let i = 0; i < keys.length; i++) {
    if (grid.has(keys[i])) {
      matchedM += dists[i];
    }
  }
  return matchedM / a.totalEdgeDistM;
}

function symmetricOverlap(a: PreparedGeometry, b: PreparedGeometry): number {
  return 0.5 * (computeRouteCoverage(a, b) + computeRouteCoverage(b, a));
}

function emptySpanMix(): SpanProfileMix {
  return {
    hasData: false,
    pavedPct: 0,
    cobblePct: 0,
    unpavedPct: 0,
    unknownSurfacePct: 0,
    pathTrackPct: 0,
    smallRoadPct: 0,
    mainRoadPct: 0,
    quietTrafficPct: 0,
    busyTrafficPct: 0,
    heavyTrafficPct: 0,
    veryQuietNoisePct: 0,
    moderateNoisePct: 0,
    loudNoisePct: 0,
    dominantSurface: 'Unknown',
    dominantRoad: 'Mixed',
    dominantTraffic: 'Quiet',
    dominantNoise: 'Quiet',
  };
}

function summarizeSpanMix(segments: SegmentData[], fromM: number, toM: number): SpanProfileMix {
  if (!segments.length || toM <= fromM) return emptySpanMix();

  let total = 0;
  let paved = 0;
  let cobble = 0;
  let unpaved = 0;
  let unknownSurf = 0;
  let pathTrack = 0;
  let smallRoad = 0;
  let mainRoad = 0;
  let quietTraf = 0;
  let busyTraf = 0;
  let heavyTraf = 0;
  let quietNoise = 0;
  let modNoise = 0;
  let loudNoise = 0;

  for (const s of segments) {
    if (s.to <= fromM || s.from >= toM) continue;
    const len = Math.min(s.to, toM) - Math.max(s.from, fromM);
    if (len <= 0) continue;
    total += len;

    const surf = classifySurface(s.surface, s.highway);
    if (surf === 'paved') paved += len;
    else if (surf === 'cobblestone') cobble += len;
    else if (surf === 'unpaved') unpaved += len;
    else unknownSurf += len;

    const roadGrp = classifyRoadGroup(s.highway);
    if (roadGrp === 'cycleway_path' || roadGrp === 'track') pathTrack += len;
    else if (roadGrp === 'small_road') smallRoad += len;
    else if (roadGrp === 'b_road' || roadGrp === 'a_road' || roadGrp === 'motorway') mainRoad += len;

    const traf = classifyTraffic(s.traffic, s.highway);
    if (traf === 'quiet') quietTraf += len;
    else if (traf === 'busy') busyTraf += len;
    else heavyTraf += len;

    const noise = classifyNoise(s.noise);
    if (noise === 'very_quiet') quietNoise += len;
    else if (noise === 'moderate') modNoise += len;
    else loudNoise += len;
  }

  if (total <= 0) return emptySpanMix();

  const pct = (v: number) => Math.round((v / total) * 100);
  const pavedPct = pct(paved);
  const cobblePct = pct(cobble);
  const unpavedPct = pct(unpaved);
  const unknownSurfacePct = pct(unknownSurf);
  const pathTrackPct = pct(pathTrack);
  const smallRoadPct = pct(smallRoad);
  const mainRoadPct = pct(mainRoad);
  const quietTrafficPct = pct(quietTraf);
  const busyTrafficPct = pct(busyTraf);
  const heavyTrafficPct = pct(heavyTraf);
  const veryQuietNoisePct = pct(quietNoise);
  const moderateNoisePct = pct(modNoise);
  const loudNoisePct = pct(loudNoise);

  const dominantSurface =
    unpavedPct >= 25
      ? `${unpavedPct}% unpaved`
      : cobblePct >= 25
        ? `${cobblePct}% cobbles`
        : pavedPct >= 50
          ? `${pavedPct}% paved`
          : `${unknownSurfacePct}% untagged`;

  const dominantRoad =
    pathTrackPct >= smallRoadPct && pathTrackPct >= mainRoadPct
      ? `${pathTrackPct}% paths & cycleways`
      : mainRoadPct >= smallRoadPct
        ? `${mainRoadPct}% main roads`
        : `${smallRoadPct}% small streets`;

  const dominantTraffic =
    heavyTrafficPct >= 15
      ? `${heavyTrafficPct}% heavy traffic`
      : busyTrafficPct >= 20
        ? `${busyTrafficPct}% busy traffic`
        : `${quietTrafficPct}% quiet`;

  const dominantNoise =
    loudNoisePct >= 20
      ? `${loudNoisePct}% loud`
      : moderateNoisePct >= 30
        ? `${moderateNoisePct}% moderate`
        : `${veryQuietNoisePct}% quiet`;

  return {
    hasData: true,
    pavedPct,
    cobblePct,
    unpavedPct,
    unknownSurfacePct,
    pathTrackPct,
    smallRoadPct,
    mainRoadPct,
    quietTrafficPct,
    busyTrafficPct,
    heavyTrafficPct,
    veryQuietNoisePct,
    moderateNoisePct,
    loudNoisePct,
    dominantSurface,
    dominantRoad,
    dominantTraffic,
    dominantNoise,
  };
}

interface ExtractedBranch extends PreparedGeometry {
  coords: [number, number][];
  midpoint: [number, number];
  baseStartIdx: number;
  baseEndIdx: number;
  baseStartM: number;
  baseEndM: number;
  distanceM: number;
  replacedBaseDistM: number;
  ascentM: number;
  replacedBaseAscentM: number;
  probeFromM: number;
  probeToM: number;
}

const LOOP_SNAP_THRESHOLD_SQ = 0.001 * 0.001; // ~110 m in degrees

function nearestCoordIndex(
  coords: [number, number][],
  cumDistM: Float64Array,
  target: [number, number],
  expectedM: number,
  startIdx = 0,
): { idx: number; distSq: number } {
  const cosLat = Math.cos((target[1] * Math.PI) / 180);
  let bestIdx = startIdx;
  let bestDistSq = Number.POSITIVE_INFINITY;
  let bestNearIdx = -1;
  let bestNearScore = Number.POSITIVE_INFINITY;

  for (let i = startIdx; i < coords.length; i++) {
    const dx = (coords[i][0] - target[0]) * cosLat;
    const dy = coords[i][1] - target[1];
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDistSq) {
      bestDistSq = d2;
      bestIdx = i;
    }
    if (d2 <= LOOP_SNAP_THRESHOLD_SQ) {
      // Among points within ~110 m of the split/rejoin, prefer the leg closest to probe progress.
      const progressPenalty = Math.abs(cumDistM[i] - expectedM);
      if (progressPenalty < bestNearScore) {
        bestNearScore = progressPenalty;
        bestNearIdx = i;
      }
    }
  }
  if (bestNearIdx >= 0) {
    const dx = (coords[bestNearIdx][0] - target[0]) * cosLat;
    const dy = coords[bestNearIdx][1] - target[1];
    return { idx: bestNearIdx, distSq: dx * dx + dy * dy };
  }
  return { idx: bestIdx, distSq: bestDistSq };
}

function buildBaseCellDists(base: PreparedRouteCacheEntry): Map<number, number[]> {
  const cellDists = new Map<number, number[]>();
  const addKeyDist = (key: number, distM: number) => {
    const arr = cellDists.get(key);
    if (!arr) {
      cellDists.set(key, [distM]);
      return;
    }
    if (Math.abs(distM - arr[arr.length - 1]) >= 500) {
      arr.push(distM);
    }
  };
  let prevGx = Number.NaN;
  let prevGy = Number.NaN;
  const markDist = (lon: number, lat: number, distM: number) => {
    const gx = Math.round(lon * LON_GRID_SCALE);
    const gy = Math.round(lat * LAT_GRID_SCALE);
    if (gx === prevGx && gy === prevGy) return;
    prevGx = gx;
    prevGy = gy;
    for (let dx = -1; dx <= 1; dx++) {
      const rowBase = (gx + dx + GRID_OFFSET) * GRID_STRIDE + GRID_OFFSET;
      addKeyDist(rowBase + (gy - 1), distM);
      addKeyDist(rowBase + gy, distM);
      addKeyDist(rowBase + (gy + 1), distM);
    }
  };

  const coords = base.coords;
  for (let i = 0; i < coords.length; i++) {
    const [lon1, lat1] = coords[i];
    const d1 = base.cumDistM[i];
    markDist(lon1, lat1, d1);
    if (i + 1 < coords.length) {
      const [lon2, lat2] = coords[i + 1];
      const segM = base.cumDistM[i + 1] - d1;
      if (segM > 18) {
        const steps = Math.min(200, Math.ceil(segM / 15));
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          markDist(lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t, d1 + segM * t);
        }
      }
    }
  }
  return cellDists;
}

function extractDetourBranches(
  base: PreparedRouteCacheEntry,
  probe: PreparedRouteCacheEntry,
  baseCellDists: Map<number, number[]>,
): ExtractedBranch[] {
  const edgeCount = probe.edgeMidKeys.length;
  if (edgeCount === 0 || base.coords.length < 2) return [];

  const baseTotalM =
    base.cumDistM.length > 0 ? base.cumDistM[base.cumDistM.length - 1] : base.distanceM;
  const probeTotalM =
    probe.cumDistM.length > 0 ? probe.cumDistM[probe.cumDistM.length - 1] : probe.distanceM;
  const progressTolM = Math.max(4000, Math.abs(probeTotalM - baseTotalM) + 0.25 * baseTotalM);

  const offBase = new Uint8Array(edgeCount);
  let anyOff = false;
  for (let i = 0; i < edgeCount; i++) {
    const dists = baseCellDists.get(probe.edgeMidKeys[i]);
    if (!dists) {
      offBase[i] = 1;
      anyOff = true;
      continue;
    }
    const probeDist = probe.cumDistM[probe.edgeFromIdx[i]];
    const probeRem = probeTotalM - probeDist;
    let aligned = false;
    for (let d = 0; d < dists.length; d++) {
      const bd = dists[d];
      const baseRem = baseTotalM - bd;
      if (Math.min(Math.abs(bd - probeDist), Math.abs(baseRem - probeRem)) <= progressTolM) {
        aligned = true;
        break;
      }
    }
    if (!aligned) {
      offBase[i] = 1;
      anyOff = true;
    }
  }
  if (!anyOff) return [];

  // Bridge brief on-base flickers (< MAX_ON_BASE_BRIDGE_M) between two off-base spans.
  let idx = 0;
  while (idx < edgeCount) {
    if (offBase[idx] === 1) {
      idx++;
      continue;
    }
    const gapStart = idx;
    let gapDist = 0;
    while (idx < edgeCount && offBase[idx] === 0) {
      gapDist += probe.edgeDists[idx];
      idx++;
    }
    if (gapStart > 0 && idx < edgeCount && gapDist < MAX_ON_BASE_BRIDGE_M) {
      for (let k = gapStart; k < idx; k++) {
        offBase[k] = 1;
      }
    }
  }

  const branches: ExtractedBranch[] = [];
  let e = 0;
  while (e < edgeCount) {
    if (offBase[e] === 0) {
      e++;
      continue;
    }
    const eStart = e;
    let distM = 0;
    while (e < edgeCount && offBase[e] === 1) {
      distM += probe.edgeDists[e];
      e++;
    }
    const eEnd = e - 1;
    if (distM < MIN_BRANCH_DIST_M) continue;

    const coordStart = probe.edgeFromIdx[eStart];
    const coordEnd = Math.min(probe.coords.length - 1, probe.edgeFromIdx[eEnd] + 1);
    const coords = probe.coords.slice(coordStart, coordEnd + 1);
    if (coords.length < 2) continue;

    const probeFromM = probe.cumDistM[coordStart];
    const probeToM = probe.cumDistM[coordEnd];
    const halfTargetM = probeFromM + (probeToM - probeFromM) * 0.5;
    let midIdx = coordStart + Math.floor((coordEnd - coordStart) / 2);
    for (let c = coordStart; c <= coordEnd; c++) {
      if (probe.cumDistM[c] >= halfTargetM) {
        midIdx = c;
        break;
      }
    }
    const midpoint = probe.coords[midIdx];

    const baseTotalM =
      base.cumDistM.length > 0 ? base.cumDistM[base.cumDistM.length - 1] : base.distanceM;
    const probeTotalM =
      probe.cumDistM.length > 0 ? probe.cumDistM[probe.cumDistM.length - 1] : probe.distanceM;
    const scale = probeTotalM > 0 ? baseTotalM / probeTotalM : 1;
    const expectedStartM = probeFromM * scale;
    const expectedEndM = probeToM * scale;

    const startMatch = nearestCoordIndex(base.coords, base.cumDistM, coords[0], expectedStartM, 0);
    const baseStartIdx = startMatch.idx;
    let endMatch = nearestCoordIndex(
      base.coords,
      base.cumDistM,
      coords[coords.length - 1],
      expectedEndM,
      baseStartIdx,
    );
    if (endMatch.distSq > 0.0025 * 0.0025) {
      const fullEnd = nearestCoordIndex(
        base.coords,
        base.cumDistM,
        coords[coords.length - 1],
        expectedEndM,
        0,
      );
      if (fullEnd.distSq < endMatch.distSq * 0.25) {
        endMatch = fullEnd;
      }
    }
    const baseEndIdx = Math.max(baseStartIdx, endMatch.idx);
    const baseStartM = base.cumDistM[baseStartIdx];
    const baseEndM = base.cumDistM[baseEndIdx];
    const replacedBaseDistM = Math.max(0, baseEndM - baseStartM);
    const ascentM = Math.max(0, probe.cumAscentM[coordEnd] - probe.cumAscentM[coordStart]);
    const replacedBaseAscentM = Math.max(
      0,
      base.cumAscentM[baseEndIdx] - base.cumAscentM[baseStartIdx],
    );

    const dilatedGrid = new Set<number>();
    let prevGx = Number.NaN;
    let prevGy = Number.NaN;
    const markPt = (lon: number, lat: number) => {
      const gx = Math.round(lon * LON_GRID_SCALE);
      const gy = Math.round(lat * LAT_GRID_SCALE);
      if (gx === prevGx && gy === prevGy) return;
      prevGx = gx;
      prevGy = gy;
      addDilatedCell(dilatedGrid, gx, gy);
    };
    for (let c = 0; c < coords.length; c++) {
      const [lon1, lat1] = coords[c];
      markPt(lon1, lat1);
      if (c + 1 < coords.length) {
        const [lon2, lat2] = coords[c + 1];
        const segM = distanceMeters({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 });
        if (segM > 18) {
          const steps = Math.min(120, Math.ceil(segM / 15));
          for (let s = 1; s < steps; s++) {
            const t = s / steps;
            markPt(lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t);
          }
        }
      }
    }

    const edgeMidKeys = probe.edgeMidKeys.slice(eStart, eEnd + 1);
    const edgeDists = probe.edgeDists.subarray(eStart, eEnd + 1);

    branches.push({
      coords,
      midpoint,
      dilatedGrid,
      edgeMidKeys,
      edgeDists,
      totalEdgeDistM: distM,
      baseStartIdx,
      baseEndIdx,
      baseStartM,
      baseEndM,
      distanceM: distM,
      replacedBaseDistM,
      ascentM,
      replacedBaseAscentM,
      probeFromM,
      probeToM,
    });
  }

  return branches;
}

export function classifyStabilityBand(stability: number): StabilityBand {
  if (stability >= 0.75) return 'high';
  if (stability >= 0.35) return 'medium';
  return 'low';
}

interface StatisticalDrivers {
  chips: string[];
  topDimension: PerturbationDimension;
  topTag: string | null;
  secondTag: string | null;
  isNearTie: boolean;
}

/**
 * Infers which parameter shifts statistically drove a cluster of Monte Carlo scenarios
 * using empirical-Bayes shrinkage: sumU[axis] / (count + 2).
 */
function inferStatisticalDrivers(
  sumU: Float64Array,
  count: number,
  fallbackDim: PerturbationDimension,
): StatisticalDrivers {
  if (count <= 0) {
    return {
      chips: ['Near-tie with base'],
      topDimension: fallbackDim,
      topTag: null,
      secondTag: null,
      isNearTie: true,
    };
  }

  const denom = count + 2;
  const ranked: Array<{
    key: PerturbationAxisKey;
    shrunk: number;
    mag: number;
    tag: string;
    dimension: PerturbationDimension;
  }> = [];

  for (let i = 0; i < AXIS_KEYS.length; i++) {
    const key = AXIS_KEYS[i];
    const shrunk = sumU[i] / denom;
    const mag = Math.abs(shrunk);
    const meta = AXIS_META[key];
    ranked.push({
      key,
      shrunk,
      mag,
      tag: shrunk >= 0 ? meta.posTag : meta.negTag,
      dimension: meta.dimension,
    });
  }
  ranked.sort((a, b) => b.mag - a.mag);

  const significant = ranked.filter((r) => r.mag >= 0.12).slice(0, 3);
  if (significant.length === 0) {
    return {
      chips: ['Near-tie with base'],
      topDimension: ranked[0]?.dimension ?? fallbackDim,
      topTag: null,
      secondTag: null,
      isNearTie: true,
    };
  }

  return {
    chips: significant.map((s) => s.tag),
    topDimension: significant[0].dimension,
    topTag: significant[0].tag,
    secondTag: significant[1]?.tag ?? null,
    isNearTie: false,
  };
}

function formatKmSpanLabel(startM: number, endM: number): string {
  return `km ${(startM / 1000).toFixed(1)}-${(endM / 1000).toFixed(1)}`;
}

function addVectorToSum(sumU: Float64Array, u: PerturbationVector | undefined): void {
  if (!u) return;
  for (let i = 0; i < AXIS_KEYS.length; i++) {
    sumU[i] += u[AXIS_KEYS[i]];
  }
}

export interface RobustnessSession {
  addProbe(probe: RobustnessProbeResult): void;
  snapshot(): RobustnessAnalysis;
}

/**
 * Incremental pure quasi-Monte-Carlo robustness accumulator. Each arriving sample updates
 * edge stability, whole-route clusters, local detour branches, per-axis sums, and
 * minimum-perturbation cluster representatives in O(edges + clusters) time.
 */
export function createRobustnessSession(
  baseRoute: RouteResponse,
  totalCount: number,
): RobustnessSession {
  const base = prepareRoute(baseRoute);
  const baseCellDists = buildBaseCellDists(base);
  const baseKeys = base.edgeMidKeys;
  const baseDists = base.edgeDists;
  const baseFromIdx = base.edgeFromIdx;
  const baseEdgeSupport = new Uint32Array(baseKeys.length);

  let completedCount = 0;
  let baseMatchingProbes = 0;
  let nextCorridorSeq = 1;
  let nextBranchSeq = 1;

  const divergedSumU = new Float64Array(AXIS_KEYS.length);
  let divergedCount = 0;
  const fallbackDimMaxDiv = new Map<PerturbationDimension, number>();

  interface PreparedProbeItem {
    probe: RobustnessProbeResult;
    prepared: PreparedRouteCacheEntry;
    overlapWithBase: number;
    norm: number;
  }

  const clusters: Array<{
    stableId: string;
    color: { line: string; casing: string };
    primary: PreparedProbeItem;
    minNorm: number;
    sumU: Float64Array;
    hasVectors: boolean;
    probeCount: number;
  }> = [];

  const branchClusters: Array<{
    stableId: string;
    color: { line: string; casing: string };
    branch: ExtractedBranch;
    primaryProbe: RobustnessProbeResult;
    primarySegments: SegmentData[];
    minNorm: number;
    sumU: Float64Array;
    hasVectors: boolean;
    probeIds: Set<string>;
  }> = [];

  return {
    addProbe(probe: RobustnessProbeResult): void {
      completedCount++;
      const prepared = prepareRoute(probe.route);
      const probeGrid = prepared.dilatedGrid;
      const probeNorm = probe.norm ?? Number.POSITIVE_INFINITY;

      for (let i = 0; i < baseKeys.length; i++) {
        if (probeGrid.has(baseKeys[i])) {
          baseEdgeSupport[i]++;
        }
      }

      const overlapWithBase = symmetricOverlap(base, prepared);
      const divPct = Math.round((1 - overlapWithBase) * 100);
      const prevFallback = fallbackDimMaxDiv.get(probe.dimension) ?? 0;
      if (divPct > prevFallback) {
        fallbackDimMaxDiv.set(probe.dimension, divPct);
      }

      // Extract and cluster local off-base detour branches independently
      const extracted = extractDetourBranches(base, prepared, baseCellDists);
      for (const b of extracted) {
        let matched: (typeof branchClusters)[number] | undefined;
        let bestOverlap = 0;
        for (const existing of branchClusters) {
          const spanGap = Math.abs(existing.branch.baseStartM - b.baseStartM);
          if (spanGap > Math.max(existing.branch.distanceM, b.distanceM) + 600) continue;
          const ov = symmetricOverlap(existing.branch, b);
          if (ov >= BRANCH_MERGE_OVERLAP && ov > bestOverlap) {
            bestOverlap = ov;
            matched = existing;
          }
        }

        if (matched) {
          if (!matched.probeIds.has(probe.id)) {
            matched.probeIds.add(probe.id);
            if (probe.u) {
              addVectorToSum(matched.sumU, probe.u);
              matched.hasVectors = true;
            }
          }
          // Keep the minimum-perturbation sample as the cluster's representative for + Compare
          if (probeNorm < matched.minNorm) {
            matched.minNorm = probeNorm;
            matched.primaryProbe = probe;
            matched.primarySegments = prepared.segments;
            matched.branch = b;
          }
        } else {
          const seq = nextBranchSeq++;
          const sumU = new Float64Array(AXIS_KEYS.length);
          if (probe.u) addVectorToSum(sumU, probe.u);
          branchClusters.push({
            stableId: `branch-${seq}`,
            color: ROBUSTNESS_CORRIDOR_COLORS[(seq - 1) % ROBUSTNESS_CORRIDOR_COLORS.length],
            branch: b,
            primaryProbe: probe,
            primarySegments: prepared.segments,
            minNorm: probeNorm,
            sumU,
            hasVectors: Boolean(probe.u),
            probeIds: new Set([probe.id]),
          });
        }
      }

      if (overlapWithBase >= 0.88) {
        baseMatchingProbes++;
        return;
      }

      divergedCount++;
      if (probe.u) addVectorToSum(divergedSumU, probe.u);

      const item: PreparedProbeItem = { probe, prepared, overlapWithBase, norm: probeNorm };
      const existing = clusters.find(
        (c) => symmetricOverlap(c.primary.prepared, prepared) >= 0.78,
      );
      if (existing) {
        existing.probeCount++;
        if (probe.u) {
          addVectorToSum(existing.sumU, probe.u);
          existing.hasVectors = true;
        }
        if (probeNorm < existing.minNorm) {
          existing.minNorm = probeNorm;
          existing.primary = item;
        }
      } else {
        const seq = nextCorridorSeq++;
        const sumU = new Float64Array(AXIS_KEYS.length);
        if (probe.u) addVectorToSum(sumU, probe.u);
        clusters.push({
          stableId: `corridor-${seq}`,
          color: ROBUSTNESS_CORRIDOR_COLORS[(seq - 1) % ROBUSTNESS_CORRIDOR_COLORS.length],
          primary: item,
          minNorm: probeNorm,
          sumU,
          hasVectors: Boolean(probe.u),
          probeCount: 1,
        });
      }
    },

    snapshot(): RobustnessAnalysis {
      let totalDistM = 0;
      let weightedSupportSum = 0;
      let spineDistM = 0;
      let fragileDistM = 0;
      const segments: StabilitySegmentSpan[] = [];

      for (let i = 0; i < baseKeys.length; i++) {
        const distM = baseDists[i];
        const stability = completedCount > 0 ? baseEdgeSupport[i] / completedCount : 1;
        const band = classifyStabilityBand(stability);

        totalDistM += distM;
        weightedSupportSum += stability * distM;
        if (band === 'high') spineDistM += distM;
        if (band === 'low') fragileDistM += distM;

        const coordIdx = baseFromIdx[i];
        const p1 = base.coords[coordIdx];
        const p2 = base.coords[coordIdx + 1];
        const prev = segments[segments.length - 1];
        if (prev && prev.band === band) {
          prev.coordinates.push(p2);
          const nextDist = prev.distanceM + distM;
          prev.stability =
            nextDist > 0 ? (prev.stability * prev.distanceM + stability * distM) / nextDist : stability;
          prev.distanceM = nextDist;
        } else {
          segments.push({
            coordinates: [p1, p2],
            stability,
            band,
            color: STABILITY_COLORS[band],
            distanceM: distM,
          });
        }
      }

      const baseFullMix = summarizeSpanMix(
        base.segments,
        0,
        base.cumDistM.length > 0 ? base.cumDistM[base.cumDistM.length - 1] : base.distanceM,
      );

      // Whole-route variants (keep all multi-hit variants + up to MAX_SINGLE_HIT_CORRIDORS)
      const sortedClusters = [...clusters].sort((a, b) => {
        if (b.probeCount !== a.probeCount) return b.probeCount - a.probeCount;
        if (a.minNorm !== b.minNorm) return a.minNorm - b.minNorm;
        return a.primary.overlapWithBase - b.primary.overlapWithBase;
      });

      const keptClusters: typeof sortedClusters = [];
      let singleCorridors = 0;
      for (const c of sortedClusters) {
        if (keptClusters.length >= MAX_DISPLAY_CORRIDORS) break;
        if (c.probeCount >= 2) {
          keptClusters.push(c);
        } else if (singleCorridors < MAX_SINGLE_HIT_CORRIDORS) {
          singleCorridors++;
          keptClusters.push(c);
        }
      }

      const corridors: AlternativeCorridor[] = keptClusters.map((c, idx) => {
        const { probe, prepared, overlapWithBase } = c.primary;
        const deltaDistanceM = prepared.distanceM - base.distanceM;
        const deltaTimeS = prepared.timeS - base.timeS;
        const deltaAscentM = prepared.ascentM - base.ascentM;

        const totalLenM =
          prepared.cumDistM.length > 0
            ? prepared.cumDistM[prepared.cumDistM.length - 1]
            : prepared.distanceM;
        const routeMix = summarizeSpanMix(prepared.segments, 0, totalLenM);

        const midTarget = totalLenM * 0.5;
        let midIdx = Math.floor(prepared.coords.length / 2);
        for (let i = 0; i < prepared.cumDistM.length; i++) {
          if (prepared.cumDistM[i] >= midTarget) {
            midIdx = i;
            break;
          }
        }
        const midpoint: [number, number] = prepared.coords[midIdx] ?? prepared.coords[0] ?? [0, 0];

        const drivers = c.hasVectors
          ? inferStatisticalDrivers(c.sumU, c.probeCount, probe.dimension)
          : {
              chips: [probe.label],
              topDimension: probe.dimension,
              topTag: null,
              secondTag: null,
              isNearTie: true,
            };

        const displayLabel = `Variant ${idx + 1}`;
        const description = `Full route variant chosen by ${c.probeCount} of ${completedCount} runs.`;

        return {
          id: c.stableId,
          label: displayLabel,
          probeLabels: drivers.chips,
          description,
          dimension: drivers.topDimension,
          probeCount: c.probeCount,
          sharePct: completedCount > 0 ? Math.round((c.probeCount / completedCount) * 100) : 0,
          route: probe.route,
          coordinates: prepared.coords,
          midpoint,
          color: c.color,
          distanceM: prepared.distanceM,
          timeS: prepared.timeS,
          ascentM: prepared.ascentM,
          deltaDistanceM,
          deltaTimeS,
          deltaAscentM,
          overlapWithBase,
          routeMix,
          baseMix: baseFullMix,
          fullDsl: probe.fullDsl,
          axes: probe.axes,
          baseTemplate: probe.baseTemplate,
        };
      });

      // Detour branches (keep all multi-hit branches + up to MAX_SINGLE_HIT_BRANCHES)
      const sortedBranches = [...branchClusters].sort((a, b) => {
        const countDiff = b.probeIds.size - a.probeIds.size;
        if (countDiff !== 0) return countDiff;
        if (a.minNorm !== b.minNorm) return a.minNorm - b.minNorm;
        return b.branch.distanceM - a.branch.distanceM;
      });

      const keptBranches: typeof sortedBranches = [];
      let singleBranches = 0;
      for (const bc of sortedBranches) {
        if (keptBranches.length >= MAX_DISPLAY_BRANCHES) break;
        if (bc.probeIds.size >= 2) {
          keptBranches.push(bc);
        } else if (singleBranches < MAX_SINGLE_HIT_BRANCHES) {
          singleBranches++;
          keptBranches.push(bc);
        }
      }

      const branches: AlternativeBranch[] = keptBranches.map((bc) => {
        const b = bc.branch;
        const probe = bc.primaryProbe;
        const probeCount = bc.probeIds.size;
        const deltaDistanceM = b.distanceM - b.replacedBaseDistM;
        const deltaAscentM = Math.round(b.ascentM - b.replacedBaseAscentM);
        const branchMix = summarizeSpanMix(bc.primarySegments, b.probeFromM, b.probeToM);
        const baseMix = summarizeSpanMix(base.segments, b.baseStartM, b.baseEndM);

        const drivers = bc.hasVectors
          ? inferStatisticalDrivers(bc.sumU, probeCount, probe.dimension)
          : {
              chips: [probe.label],
              topDimension: probe.dimension,
              topTag: null,
              secondTag: null,
              isNearTie: true,
            };

        const displayLabel = formatKmSpanLabel(b.baseStartM, b.baseEndM);
        const description = `Detour segment at ${displayLabel}, chosen by ${probeCount} of ${completedCount} runs.`;

        const replacedBaseCoords =
          b.baseEndIdx > b.baseStartIdx
            ? base.coords.slice(b.baseStartIdx, b.baseEndIdx + 1)
            : [];

        return {
          id: bc.stableId,
          label: displayLabel,
          probeLabels: drivers.chips,
          description,
          dimension: drivers.topDimension,
          probeCount,
          sharePct: completedCount > 0 ? Math.round((probeCount / completedCount) * 100) : 0,
          coordinates: b.coords,
          midpoint: b.midpoint,
          replacedBaseCoords,
          color: bc.color,
          baseStartM: b.baseStartM,
          baseEndM: b.baseEndM,
          distanceM: b.distanceM,
          replacedBaseDistM: b.replacedBaseDistM,
          deltaDistanceM,
          ascentM: Math.round(b.ascentM),
          replacedBaseAscentM: Math.round(b.replacedBaseAscentM),
          deltaAscentM,
          branchMix,
          baseMix,
          fullDsl: probe.fullDsl,
          axes: probe.axes,
          baseTemplate: probe.baseTemplate,
        };
      });

      // Statistical per-dimension sensitivity: max empirical-Bayes shrunk shift across discovered
      // branches and diverging scenarios.
      const dimSens = new Map<PerturbationDimension, number>();
      let usedVectors = false;
      const recordSumU = (sumU: Float64Array, count: number) => {
        if (count < 2) return;
        usedVectors = true;
        const denom = count + 2;
        for (let i = 0; i < AXIS_KEYS.length; i++) {
          const pct = Math.min(100, Math.round((Math.abs(sumU[i]) / denom) * 100));
          const dim = AXIS_META[AXIS_KEYS[i]].dimension;
          if (pct > (dimSens.get(dim) ?? 0)) {
            dimSens.set(dim, pct);
          }
        }
      };

      for (const bc of branchClusters) {
        if (bc.hasVectors) recordSumU(bc.sumU, bc.probeIds.size);
      }
      if (divergedCount >= 2) {
        recordSumU(divergedSumU, divergedCount);
      }

      const activeDimMap = usedVectors ? dimSens : fallbackDimMaxDiv;
      const dimensions: DimensionSensitivity[] = DIMENSION_ORDER.filter((d) => activeDimMap.has(d))
        .map((dimension) => ({
          dimension,
          maxDivergencePct: activeDimMap.get(dimension) ?? 0,
        }))
        .sort((a, b) => b.maxDivergencePct - a.maxDivergencePct);

      return {
        completedCount,
        totalCount,
        overallStability: totalDistM > 0 ? weightedSupportSum / totalDistM : 1,
        spineShare: totalDistM > 0 ? spineDistM / totalDistM : 1,
        fragileShare: totalDistM > 0 ? fragileDistM / totalDistM : 0,
        baseMatchingProbes,
        segments,
        corridors,
        branches,
        dimensions,
      };
    },
  };
}

export function analyzeRobustness(
  baseRoute: RouteResponse,
  completedProbes: RobustnessProbeResult[],
  totalCount: number,
): RobustnessAnalysis {
  const session = createRobustnessSession(baseRoute, totalCount);
  for (const probe of completedProbes) {
    session.addProbe(probe);
  }
  return session.snapshot();
}

const VARIANT_MASS_TARGET = 0.7;
const VARIANT_MIN_RUN_SHARE = 0.05;
const VARIANT_ALWAYS_KEEP_SHARE = 0.15;
const BRANCH_PRIMARY_SHARE = 0.15;
const BRANCH_FALLBACK_SHARE = 0.1;

/**
 * Keeps whole-route variants carrying the top 70% of diverging probability mass
 * (filtering single-hit noise once multi-hit variants exist, and pruning <5% tail variants).
 */
export function filterFrequentCorridors(
  corridors: AlternativeCorridor[],
  completedCount: number,
): AlternativeCorridor[] {
  if (corridors.length <= 1 || completedCount <= 0) return corridors;

  const sorted = [...corridors].sort((a, b) => b.probeCount - a.probeCount);
  const totalAltRuns = sorted.reduce((acc, c) => acc + c.probeCount, 0);
  if (totalAltRuns <= 0) return sorted;

  const multiHit = sorted.filter((c) => c.probeCount >= 2);
  const pool = multiHit.length > 0 ? multiHit : sorted.slice(0, 3);
  const topCount = pool[0].probeCount;

  const kept: AlternativeCorridor[] = [];
  let cumRuns = 0;
  for (let i = 0; i < pool.length; i++) {
    const c = pool[i];
    const runShare = c.probeCount / completedCount;
    const isTopTie = i === 0 || c.probeCount === topCount;
    const withinNucleus = cumRuns / totalAltRuns < VARIANT_MASS_TARGET && runShare >= VARIANT_MIN_RUN_SHARE;
    if (isTopTie || runShare >= VARIANT_ALWAYS_KEEP_SHARE || withinNucleus) {
      kept.push(c);
      cumRuns += c.probeCount;
    } else {
      break;
    }
  }
  return kept;
}

/**
 * Keeps local detour branches with high marginal probability (>=15% of runs, relaxing to
 * >=10% or top-half of max support when all branches are rare).
 */
export function filterFrequentBranches(
  branches: AlternativeBranch[],
  completedCount: number,
): AlternativeBranch[] {
  if (branches.length <= 1 || completedCount <= 0) return branches;

  const sorted = [...branches].sort((a, b) => b.probeCount - a.probeCount);
  const multiHit = sorted.filter((b) => b.probeCount >= 2);
  const pool = multiHit.length > 0 ? multiHit : sorted.slice(0, 3);

  const primary = pool.filter((b) => b.probeCount / completedCount >= BRANCH_PRIMARY_SHARE);
  if (primary.length > 0) return primary;

  const fallback = pool.filter((b) => b.probeCount / completedCount >= BRANCH_FALLBACK_SHARE);
  if (fallback.length > 0) return fallback;

  const minCount = Math.max(2, Math.ceil(pool[0].probeCount * 0.5));
  return pool.filter((b) => b.probeCount >= minCount);
}

export function filterRobustnessAnalysis(
  analysis: RobustnessAnalysis,
  filterMode: RobustnessFilterMode,
): RobustnessAnalysis {
  if (filterMode === 'all') return analysis;
  return {
    ...analysis,
    branches: filterFrequentBranches(analysis.branches, analysis.completedCount),
    corridors: filterFrequentCorridors(analysis.corridors, analysis.completedCount),
  };
}

export interface BranchLegSplice {
  legIdx: number;
  coords: [number, number][];
}

function projectWaypointsMonotonic(
  coords: [number, number][],
  waypoints: ReadonlyArray<{ lat: number; lon: number }>,
): number[] {
  const n = waypoints.length;
  const result = new Array<number>(n);
  if (n === 0 || coords.length === 0) return result;
  result[0] = 0;
  result[n - 1] = coords.length - 1;

  for (let w = 1; w < n - 1; w++) {
    const start = result[w - 1];
    const target = waypoints[w];
    const cosLat = Math.cos((target.lat * Math.PI) / 180);
    let bestGlobalIdx = start;
    let bestGlobalD2 = Number.POSITIVE_INFINITY;
    let firstPassIdx = -1;
    let firstPassD2 = Number.POSITIVE_INFINITY;
    const passThresholdSq = 0.0006 * 0.0006; // ~65 m

    for (let i = start; i < coords.length; i++) {
      const dx = (coords[i][0] - target.lon) * cosLat;
      const dy = coords[i][1] - target.lat;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestGlobalD2) {
        bestGlobalD2 = d2;
        bestGlobalIdx = i;
      }
      if (d2 <= passThresholdSq) {
        if (d2 < firstPassD2) {
          firstPassD2 = d2;
          firstPassIdx = i;
        }
      } else if (firstPassIdx >= 0) {
        // Exited the first close pass around this waypoint; do not jump to a later loop leg.
        break;
      }
    }
    result[w] = firstPassIdx >= 0 ? firstPassIdx : bestGlobalIdx;
  }
  return result;
}

function nearestIdxInRange(
  coords: [number, number][],
  target: [number, number],
  startIdx: number,
  endIdx: number,
): number {
  const cosLat = Math.cos((target[1] * Math.PI) / 180);
  let best = startIdx;
  let bestD2 = Number.POSITIVE_INFINITY;
  const hi = Math.min(coords.length - 1, endIdx);
  for (let i = Math.max(0, startIdx); i <= hi; i++) {
    const dx = (coords[i][0] - target[0]) * cosLat;
    const dy = coords[i][1] - target[1];
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  return best;
}

function coordsDivergeFromBaseLeg(
  legTarget: [number, number][],
  baseLeg: [number, number][],
): boolean {
  if (legTarget.length < 2 || baseLeg.length < 2) return false;
  const grid = new Set<number>();
  for (let i = 0; i < baseLeg.length; i++) {
    const [lon1, lat1] = baseLeg[i];
    const gx = Math.round(lon1 * LON_GRID_SCALE);
    const gy = Math.round(lat1 * LAT_GRID_SCALE);
    addDilatedCell(grid, gx, gy);
    if (i + 1 < baseLeg.length) {
      const [lon2, lat2] = baseLeg[i + 1];
      const segM = distanceMeters({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 });
      if (segM > 18) {
        const steps = Math.min(120, Math.ceil(segM / 15));
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          addDilatedCell(
            grid,
            Math.round((lon1 + (lon2 - lon1) * t) * LON_GRID_SCALE),
            Math.round((lat1 + (lat2 - lat1) * t) * LAT_GRID_SCALE),
          );
        }
      }
    }
  }
  let offDistM = 0;
  for (let i = 0; i + 1 < legTarget.length; i++) {
    const [lon1, lat1] = legTarget[i];
    const [lon2, lat2] = legTarget[i + 1];
    const midKey = cellKey(
      Math.round((lon1 + lon2) * 0.5 * LON_GRID_SCALE),
      Math.round((lat1 + lat2) * 0.5 * LAT_GRID_SCALE),
    );
    if (!grid.has(midKey)) {
      offDistM += distanceMeters({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 });
      if (offDistM >= 80) return true;
    }
  }
  return false;
}

/**
 * Plans per-leg spliced coordinates for applying a detour segment or full-route variant
 * while strictly preserving every existing user waypoint.
 */
export function planBranchLegSplices(
  baseCoords: [number, number][],
  waypoints: ReadonlyArray<{ lat: number; lon: number }>,
  targetCoords: [number, number][],
  options: { kind?: 'segment' | 'variant'; baseStartM?: number; baseEndM?: number } = {},
): BranchLegSplice[] {
  const nWps = waypoints.length;
  if (nWps < 2 || baseCoords.length < 2 || targetCoords.length < 2) return [];

  const wpBaseIdx = projectWaypointsMonotonic(baseCoords, waypoints);

  if (options.kind === 'variant') {
    const wpTargetIdx = projectWaypointsMonotonic(targetCoords, waypoints);
    const splices: BranchLegSplice[] = [];
    for (let leg = 0; leg < nWps - 1; leg++) {
      const tStart = wpTargetIdx[leg];
      const tEnd = wpTargetIdx[leg + 1];
      if (tEnd <= tStart) continue;
      const legTarget = targetCoords.slice(tStart, tEnd + 1);
      const baseLeg = baseCoords.slice(wpBaseIdx[leg], wpBaseIdx[leg + 1] + 1);
      if (coordsDivergeFromBaseLeg(legTarget, baseLeg)) {
        splices.push({ legIdx: leg, coords: legTarget });
      }
    }
    return splices;
  }

  // Compute cumulative base distances so baseStartM maps unambiguously to the right leg on loops.
  const baseCumDistM = new Float64Array(baseCoords.length);
  for (let i = 0; i + 1 < baseCoords.length; i++) {
    baseCumDistM[i + 1] =
      baseCumDistM[i] +
      distanceMeters(
        { lat: baseCoords[i][1], lon: baseCoords[i][0] },
        { lat: baseCoords[i + 1][1], lon: baseCoords[i + 1][0] },
      );
  }

  let startLeg = 0;
  if (options.baseStartM !== undefined) {
    for (let w = 0; w < nWps - 1; w++) {
      if (baseCumDistM[wpBaseIdx[w]] <= options.baseStartM + 30) {
        startLeg = w;
      }
    }
  } else {
    const startIdx = nearestIdxInRange(baseCoords, targetCoords[0], 0, baseCoords.length - 1);
    for (let w = 0; w < nWps - 1; w++) {
      if (wpBaseIdx[w] <= startIdx) {
        startLeg = w;
      }
    }
  }

  const splices: BranchLegSplice[] = [];
  let remaining = targetCoords;
  let curLeg = startLeg;

  while (curLeg < nWps - 1 && remaining.length >= 2) {
    const legStart = wpBaseIdx[curLeg];
    const legEnd = wpBaseIdx[curLeg + 1];

    // Check if the branch genuinely passes through the next interior waypoint into the following leg.
    let splitIdx = -1;
    if (curLeg + 1 < nWps - 1) {
      const nextWp = waypoints[curLeg + 1];
      let bestDistM = 80;
      for (let i = 1; i < remaining.length - 1; i++) {
        const d = distanceMeters(
          { lat: remaining[i][1], lon: remaining[i][0] },
          { lat: nextWp.lat, lon: nextWp.lon },
        );
        if (d < bestDistM) {
          bestDistM = d;
          splitIdx = i;
        }
      }
    }

    const startInLeg = nearestIdxInRange(baseCoords, remaining[0], legStart, legEnd);
    if (splitIdx > 0) {
      const head = remaining.slice(0, splitIdx + 1);
      const spliced: [number, number][] = [
        ...baseCoords.slice(legStart, startInLeg),
        ...head,
      ];
      if (spliced.length >= 2) {
        splices.push({ legIdx: curLeg, coords: spliced });
      }
      remaining = remaining.slice(splitIdx);
      curLeg++;
      continue;
    }

    const endPt = remaining[remaining.length - 1];
    const endInLeg = nearestIdxInRange(baseCoords, endPt, startInLeg, legEnd);
    const rejoinDistM = distanceMeters(
      { lat: endPt[1], lon: endPt[0] },
      { lat: baseCoords[endInLeg][1], lon: baseCoords[endInLeg][0] },
    );

    const spliced: [number, number][] =
      rejoinDistM <= 250
        ? [
            ...baseCoords.slice(legStart, startInLeg),
            ...remaining,
            ...baseCoords.slice(endInLeg + 1, legEnd + 1),
          ]
        : [
            ...baseCoords.slice(legStart, startInLeg),
            ...remaining,
            [waypoints[curLeg + 1].lon, waypoints[curLeg + 1].lat],
          ];
    if (spliced.length >= 2) {
      splices.push({ legIdx: curLeg, coords: spliced });
    }
    break;
  }

  return splices;
}
