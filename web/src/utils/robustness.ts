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
  | 'Directness'
  | 'Hills'
  | 'Surface'
  | 'Cycleways'
  | 'Scenery';

export type ProbeKind = 'directional' | 'jitter';

export type ScenarioPresetCount = 20 | 40 | 80 | 160 | 320;

export const DEFAULT_SCENARIO_COUNT: ScenarioPresetCount = 160;

export interface RobustnessProbeSpec {
  id: string;
  kind: ProbeKind;
  label: string;
  dimension: PerturbationDimension;
  description: string;
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
  color: { line: string; casing: string };
  distanceM: number;
  timeS: number;
  ascentM: number;
  deltaDistanceM: number;
  deltaTimeS: number;
  deltaAscentM: number;
  overlapWithBase: number;
  fullDsl: string;
  axes?: ProfileAxes;
  baseTemplate?: BaseTemplateId;
}

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

const MAX_DISPLAY_CORRIDORS = 10;
const MAX_DISPLAY_BRANCHES = 48;
const MAX_SINGLE_JITTER_BRANCHES = 6;
const MIN_BRANCH_DIST_M = 180;
const MAX_ON_BASE_BRIDGE_M = 100;
const BRANCH_MERGE_OVERLAP = 0.72;

const DIMENSION_ORDER: PerturbationDimension[] = [
  'Traffic',
  'Hills',
  'Surface',
  'Directness',
  'Cycleways',
  'Scenery',
];

const HALTON_PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23] as const;

// Balanced 20-probe core covering all 6 dimensions when scenarioCount < directionalDefs.length.
const CORE_DIRECTIONAL_IDS = new Set([
  'traffic-mild-quiet',
  'traffic-strong-quiet',
  'traffic-noise-sanctuary',
  'traffic-relaxed',
  'cycle-strict-network',
  'cycle-max-adhesion',
  'cycle-quiet-network-noise',
  'cycle-arterial-lanes',
  'surface-strict-asphalt',
  'surface-adventure-gravel',
  'surface-offroad-trails',
  'scenery-low-noise',
  'scenery-green-quiet',
  'scenery-parks-commons',
  'hills-mild-flat',
  'hills-strong-flat',
  'hills-climb-ok',
  'hills-high-power',
  'direct-high-flow',
  'direct-agile',
  'direct-pure-shortest',
]);

function selectDirectionalDefs<T extends { id: string }>(defs: T[], scenarioCount: number): T[] {
  if (scenarioCount >= defs.length) return defs;
  const core = defs.filter((d) => CORE_DIRECTIONAL_IDS.has(d.id));
  const extra = defs.filter((d) => !CORE_DIRECTIONAL_IDS.has(d.id));
  return [...core, ...extra].slice(0, scenarioCount);
}

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

function buildAxesProbes(
  baseAxes: ProfileAxes,
  baseTemplate: BaseTemplateId,
  profileLabel: string,
  scenarioCount: number,
): RobustnessProbeSpec[] {
  const directionalDefs: Array<{
    id: string;
    label: string;
    dimension: PerturbationDimension;
    description: string;
    patch: Partial<ProfileAxes>;
  }> = [
    // Traffic & road hierarchy (6)
    {
      id: 'traffic-mild-quiet',
      label: 'Mildly quieter roads',
      dimension: 'Traffic',
      description: 'Moderately higher penalties on primary, secondary, and busy roads.',
      patch: {
        enableTrafficPenalties: true,
        primaryCost: scaleFinite(baseAxes.primaryCost, 1.4, 0.5, 20),
        secondaryCost: scaleFinite(baseAxes.secondaryCost, 1.4, 0.35, 10),
        tertiaryCost: scaleFinite(baseAxes.tertiaryCost, 1.3, 0.15, 10),
        trafficClass3Penalty: scaleFinite(baseAxes.trafficClass3Penalty, 1.4, 0.25, 10),
        trafficClass4Penalty: scaleFinite(baseAxes.trafficClass4Penalty, 1.5, 0.55, 10),
        trafficClass5Penalty: scaleFinite(baseAxes.trafficClass5Penalty, 1.5, 0.85, 10),
        trafficClass6Penalty: scaleFinite(baseAxes.trafficClass6Penalty, 1.5, 1.2, 10),
        trafficClass7Penalty: scaleFinite(baseAxes.trafficClass7Penalty, 1.5, 1.4, 10),
      },
    },
    {
      id: 'traffic-strong-quiet',
      label: 'Quiet backroads only',
      dimension: 'Traffic',
      description: 'Strong avoidance of main roads and moderate-to-heavy traffic.',
      patch: {
        enableTrafficPenalties: true,
        enableEnvironmentPenalties: true,
        allowUrbanTrunks: false,
        primaryCost: scaleFinite(baseAxes.primaryCost, 2.5, 2.5, 20),
        secondaryCost: scaleFinite(baseAxes.secondaryCost, 2.5, 1.5, 10),
        tertiaryCost: scaleFinite(baseAxes.tertiaryCost, 2.0, 0.6, 10),
        trafficClass2Penalty: scaleFinite(baseAxes.trafficClass2Penalty, 1.5, 0.25, 10),
        trafficClass3Penalty: scaleFinite(baseAxes.trafficClass3Penalty, 2.2, 0.8, 10),
        trafficClass4Penalty: scaleFinite(baseAxes.trafficClass4Penalty, 2.5, 1.8, 10),
        trafficClass5Penalty: scaleFinite(baseAxes.trafficClass5Penalty, 2.8, 2.8, 10),
        trafficClass6Penalty: scaleFinite(baseAxes.trafficClass6Penalty, 3.0, 4.0, 10),
        trafficClass7Penalty: scaleFinite(baseAxes.trafficClass7Penalty, 3.0, 4.5, 10),
        multiLanePenalty: scaleFinite(baseAxes.multiLanePenalty, 1.5, 0.8, 10),
      },
    },
    {
      id: 'traffic-noise-sanctuary',
      label: 'Strict low traffic and noise',
      dimension: 'Traffic',
      description: 'Heavy avoidance of busy traffic classes and loud streets.',
      patch: {
        enableTrafficPenalties: true,
        enableNoisePenalties: true,
        enableEnvironmentPenalties: true,
        allowUrbanTrunks: false,
        primaryCost: scaleFinite(baseAxes.primaryCost, 3.0, 4.0, 20),
        secondaryCost: scaleFinite(baseAxes.secondaryCost, 3.0, 2.5, 10),
        tertiaryCost: scaleFinite(baseAxes.tertiaryCost, 2.2, 1.0, 10),
        trafficClass2Penalty: scaleFinite(baseAxes.trafficClass2Penalty, 1.8, 0.4, 10),
        trafficClass3Penalty: scaleFinite(baseAxes.trafficClass3Penalty, 2.6, 1.3, 10),
        trafficClass4Penalty: scaleFinite(baseAxes.trafficClass4Penalty, 3.0, 2.8, 10),
        trafficClass5Penalty: scaleFinite(baseAxes.trafficClass5Penalty, 3.5, 4.2, 10),
        trafficClass6Penalty: scaleFinite(baseAxes.trafficClass6Penalty, 3.8, 5.5, 10),
        trafficClass7Penalty: scaleFinite(baseAxes.trafficClass7Penalty, 4.0, 6.0, 10),
        noiseClass3Penalty: scaleFinite(baseAxes.noiseClass3Penalty, 2.0, 0.7, 10),
        noiseClass4Penalty: scaleFinite(baseAxes.noiseClass4Penalty, 2.6, 1.6, 10),
        noiseClass5Penalty: scaleFinite(baseAxes.noiseClass5Penalty, 3.0, 2.8, 10),
        noiseClass6Penalty: scaleFinite(baseAxes.noiseClass6Penalty, 3.4, 4.2, 10),
        multiLanePenalty: scaleFinite(baseAxes.multiLanePenalty, 2.0, 1.2, 10),
      },
    },
    {
      id: 'traffic-relaxed',
      label: 'Main-road tolerant',
      dimension: 'Traffic',
      description: 'Relaxes penalties on A roads, urban trunks, and heavy traffic classes.',
      patch: {
        allowUrbanTrunks: true,
        allowBusLanes: true,
        trunkCost: Math.min(baseAxes.trunkCost, 1.5),
        primaryCost:
          baseAxes.primaryCost >= 9999 ? 0.8 : Number((baseAxes.primaryCost * 0.25).toFixed(2)),
        secondaryCost:
          baseAxes.secondaryCost >= 9999 ? 0.5 : Number((baseAxes.secondaryCost * 0.25).toFixed(2)),
        tertiaryCost: Number((baseAxes.tertiaryCost * 0.25).toFixed(2)),
        trafficClass3Penalty: Number((baseAxes.trafficClass3Penalty * 0.25).toFixed(2)),
        trafficClass4Penalty: Number((baseAxes.trafficClass4Penalty * 0.25).toFixed(2)),
        trafficClass5Penalty: Number((baseAxes.trafficClass5Penalty * 0.25).toFixed(2)),
        trafficClass6Penalty: Number((baseAxes.trafficClass6Penalty * 0.25).toFixed(2)),
        trafficClass7Penalty: Number((baseAxes.trafficClass7Penalty * 0.2).toFixed(2)),
      },
    },
    {
      id: 'traffic-no-multilane',
      label: 'Avoid multi-lane and tunnels',
      dimension: 'Traffic',
      description: 'Penalizes multi-lane roads and motor-road tunnels.',
      patch: {
        enableEnvironmentPenalties: true,
        multiLanePenalty: scaleFinite(baseAxes.multiLanePenalty, 2.0, 1.5, 10),
        roadTunnelPenalty: scaleFinite(baseAxes.roadTunnelPenalty, 2.0, 4.0, 20),
      },
    },
    {
      id: 'junction-safe',
      label: 'Strict junction safety',
      dimension: 'Traffic',
      description: 'Heavy penalties on uncontrolled busy crossings and turns across traffic.',
      patch: {
        enableTurnPenalties: true,
        crossingClass3Cost: scaleIntFinite(baseAxes.crossingClass3Cost, 1.8, 50, 500),
        crossingClass4Cost: scaleIntFinite(baseAxes.crossingClass4Cost, 2.0, 90, 500),
        crossingClass5Cost: scaleIntFinite(baseAxes.crossingClass5Cost, 2.0, 140, 500),
        turnAcrossTrafficClass3Cost: scaleIntFinite(baseAxes.turnAcrossTrafficClass3Cost, 1.8, 50, 500),
        turnAcrossTrafficClass4Cost: scaleIntFinite(baseAxes.turnAcrossTrafficClass4Cost, 2.0, 90, 500),
        turnAcrossTrafficClass5Cost: scaleIntFinite(baseAxes.turnAcrossTrafficClass5Cost, 2.0, 130, 500),
      },
    },

    // Directness & turns (3)
    {
      id: 'direct-high-flow',
      label: 'Fast and direct',
      dimension: 'Directness',
      description: 'Fewer turns and traffic lights, willing to stay on direct arterial roads.',
      patch: {
        allowUrbanTrunks: true,
        allowBusLanes: true,
        primaryCost:
          baseAxes.primaryCost >= 9999 ? 1.0 : Number((baseAxes.primaryCost * 0.3).toFixed(2)),
        secondaryCost:
          baseAxes.secondaryCost >= 9999 ? 0.5 : Number((baseAxes.secondaryCost * 0.3).toFixed(2)),
        trafficClass5Penalty: Number((baseAxes.trafficClass5Penalty * 0.35).toFixed(2)),
        trafficClass6Penalty: Number((baseAxes.trafficClass6Penalty * 0.35).toFixed(2)),
        trafficClass7Penalty: Number((baseAxes.trafficClass7Penalty * 0.3).toFixed(2)),
        nonCycleRouteRoadPenalty: 0,
        enableTurnPenalties: true,
        turnCostGeneric: clamp(Math.round(Math.max(200, baseAxes.turnCostGeneric * 1.7)), 0, 300),
        trafficSignalCost: clamp(Math.round(Math.max(130, baseAxes.trafficSignalCost * 1.8)), 0, 300),
        stopGiveWayCost: clamp(Math.round(Math.max(130, baseAxes.stopGiveWayCost * 1.6)), 0, 300),
      },
    },
    {
      id: 'direct-low-turn',
      label: 'Minimal turns',
      dimension: 'Directness',
      description: 'Penalizes sharp turns, stop signs, and road-class transitions.',
      patch: {
        enableTurnPenalties: true,
        turnCostGeneric: clamp(Math.round(Math.max(220, baseAxes.turnCostGeneric * 1.9)), 0, 300),
        turnCostCycleRoute: clamp(Math.round(Math.max(170, baseAxes.turnCostCycleRoute * 1.8)), 0, 300),
        roadTransitionCost: clamp(Math.round(Math.max(90, baseAxes.roadTransitionCost * 2.0 + 40)), 0, 300),
      },
    },
    {
      id: 'direct-agile',
      label: 'Agile backstreets',
      dimension: 'Directness',
      description: 'Low turn and stop penalties so quiet backstreet shortcuts open up.',
      patch: {
        enableTurnPenalties: true,
        turnCostGeneric: Math.round(baseAxes.turnCostGeneric * 0.25),
        turnCostCycleRoute: Math.round(baseAxes.turnCostCycleRoute * 0.25),
        trafficSignalCost: Math.round(baseAxes.trafficSignalCost * 0.35),
        stopGiveWayCost: Math.round(baseAxes.stopGiveWayCost * 0.25),
        roadTransitionCost: 0,
      },
    },
    {
      id: 'direct-pure-shortest',
      label: 'Shortest legal distance',
      dimension: 'Directness',
      description: 'Minimizes distance by stripping soft comfort, turn, and climb biases.',
      patch: {
        stickToCycleRoutes: false,
        nonCycleRouteRoadPenalty: 0,
        considerElevation: false,
        uphillCost: 0,
        downhillCost: 0,
        enableTurnPenalties: true,
        turnCostGeneric: 15,
        turnCostCycleRoute: 10,
        trafficSignalCost: 10,
        stopGiveWayCost: 5,
        roadTransitionCost: 0,
        forestUntaggedPenalty: 0,
        noiseClass4Penalty: 0,
        noiseClass5Penalty: 0,
        noiseClass6Penalty: 0,
        trafficClass3Penalty: Math.min(baseAxes.trafficClass3Penalty, 0.1),
        trafficClass4Penalty: Math.min(baseAxes.trafficClass4Penalty, 0.2),
      },
    },

    // Hills & climbing (4)
    {
      id: 'hills-mild-flat',
      label: 'Mildly flatter',
      dimension: 'Hills',
      description: 'Moderately higher climb penalty.',
      patch: {
        considerElevation: true,
        uphillCost: clamp(Math.round(baseAxes.uphillCost * 1.6 + 40), 0, 200),
        uphillCutoff: Number(Math.min(baseAxes.uphillCutoff, 1.3).toFixed(1)),
        downhillCost: clamp(Math.round(baseAxes.downhillCost * 1.3 + 20), 0, 200),
      },
    },
    {
      id: 'hills-strong-flat',
      label: 'Flattest route',
      dimension: 'Hills',
      description: 'Strong climb avoidance with a low gradient threshold.',
      patch: {
        considerElevation: true,
        uphillCost: clamp(Math.round(Math.max(150, baseAxes.uphillCost * 2.5 + 90)), 0, 200),
        uphillCutoff: Number(Math.min(baseAxes.uphillCutoff, 0.8).toFixed(1)),
        downhillCost: clamp(Math.round(Math.max(75, baseAxes.downhillCost * 1.8 + 40)), 0, 200),
      },
    },
    baseAxes.uphillCost >= 20
      ? {
          id: 'hills-climb-ok',
          label: 'Climb-tolerant',
          dimension: 'Hills',
          description: 'Accepts steeper hills whenever they shorten the ride.',
          patch: {
            considerElevation: true,
            uphillCost: Math.round(baseAxes.uphillCost * 0.15),
            uphillCutoff: 3.8,
            downhillCost: Math.round(baseAxes.downhillCost * 0.25),
          },
        }
      : {
          id: 'hills-high-power',
          label: 'Strong climber',
          dimension: 'Hills',
          description: 'Higher rider power and relaxed slope cutoffs.',
          patch: {
            considerElevation: false,
            uphillCost: 0,
            downhillCost: 0,
            bikerPower: clamp(Math.round(baseAxes.bikerPower * 1.7), 50, 350),
          },
        },
    {
      id: 'hills-gentle-descents',
      label: 'Cautious descents',
      dimension: 'Hills',
      description: 'Avoids steep descents and fast downhill braking zones.',
      patch: {
        considerElevation: true,
        downhillCost: clamp(Math.round(Math.max(120, baseAxes.downhillCost * 2.5 + 80)), 0, 200),
        downhillCutoff: 1.0,
      },
    },

    // Surface quality & off-road trails (4)
    {
      id: 'surface-strict-asphalt',
      label: 'Strict smooth asphalt',
      dimension: 'Surface',
      description: 'Avoids gravel, cobbles, sett, paving stones, and untagged paths.',
      patch: {
        enableSurfacePenalties: true,
        pavingStonesPenalty: scaleFinite(baseAxes.pavingStonesPenalty, 2.0, 1.5, 15),
        settPenalty: scaleFinite(baseAxes.settPenalty, 2.0, 3.0, 15),
        cobblestonePenalty: scaleFinite(baseAxes.cobblestonePenalty, 2.0, 5.0, 15),
        compactedPenalty: scaleFinite(baseAxes.compactedPenalty, 2.5, 3.5, 15),
        fineGravelPenalty: scaleFinite(baseAxes.fineGravelPenalty, 2.5, 4.5, 15),
        gravelPenalty: scaleFinite(baseAxes.gravelPenalty, 2.5, 7.0, 15),
        unpavedPenalty: scaleFinite(baseAxes.unpavedPenalty, 2.0, 7.0, 15),
        untaggedPathSurfacePenalty: scaleFinite(baseAxes.untaggedPathSurfacePenalty, 2.0, 3.0, 15),
      },
    },
    {
      id: 'surface-light-gravel',
      label: 'Towpaths and compacted',
      dimension: 'Surface',
      description: 'Welcomes compacted gravel, canal towpaths, park gates, and smooth tracks.',
      patch: {
        enableSurfacePenalties: true,
        compactedPenalty: Math.min(baseAxes.compactedPenalty, 0.08),
        fineGravelPenalty: Math.min(baseAxes.fineGravelPenalty, 0.18),
        untaggedPathSurfacePenalty: Math.min(baseAxes.untaggedPathSurfacePenalty, 0.3),
        cyclewaySharedCost: Math.min(baseAxes.cyclewaySharedCost, 0.15),
        pathCost: Math.min(baseAxes.pathCost, 0.45),
        footwayCost: Math.min(baseAxes.footwayCost, 0.5),
        pedestrianCost: Math.min(baseAxes.pedestrianCost, 0.55),
        bridlewayCost: Math.min(baseAxes.bridlewayCost, 0.3),
        trackGrade1Cost: Math.min(baseAxes.trackGrade1Cost, 0.1),
        trackGrade2Cost: Math.min(baseAxes.trackGrade2Cost, 0.25),
        trackUntaggedCost: Math.min(baseAxes.trackUntaggedCost, 0.25),
      },
    },
    {
      id: 'surface-adventure-gravel',
      label: 'Gravel and bridleways',
      dimension: 'Surface',
      description: 'Opens up gravel tracks, bridleways, commons, and unpaved trails.',
      patch: {
        enableSurfacePenalties: true,
        compactedPenalty: 0.0,
        fineGravelPenalty: 0.0,
        gravelPenalty: Math.min(baseAxes.gravelPenalty, 0.15),
        pebblestonePenalty: Math.min(baseAxes.pebblestonePenalty, 0.3),
        unpavedPenalty: Math.min(baseAxes.unpavedPenalty, 0.15),
        grassPenalty: Math.min(baseAxes.grassPenalty, 0.8),
        untaggedPathSurfacePenalty: Math.min(baseAxes.untaggedPathSurfacePenalty, 0.15),
        cyclewaySharedCost: Math.min(baseAxes.cyclewaySharedCost, 0.1),
        bridlewayCost: Math.min(baseAxes.bridlewayCost, 0.05),
        pathCost: Math.min(baseAxes.pathCost, 0.2),
        footwayCost: Math.min(baseAxes.footwayCost, 0.45),
        pedestrianCost: Math.min(baseAxes.pedestrianCost, 0.45),
        trackGrade1Cost: 0.0,
        trackGrade2Cost: 0.05,
        trackGrade3Cost: Math.min(baseAxes.trackGrade3Cost, 0.25),
        trackGrade4Cost: Math.min(baseAxes.trackGrade4Cost, 1.2),
        trackUntaggedCost: Math.min(baseAxes.trackUntaggedCost, 0.1),
      },
    },
    {
      id: 'surface-offroad-trails',
      label: 'Off-road gravel and commons',
      dimension: 'Surface',
      description: 'Actively prefers gravel, commons, and bridleways over tarmac streets.',
      patch: {
        enableSurfacePenalties: true,
        asphaltPenalty: Math.max(baseAxes.asphaltPenalty, 0.65),
        pavedPenalty: Math.max(baseAxes.pavedPenalty, 0.55),
        concretePenalty: Math.max(baseAxes.concretePenalty, 0.55),
        untaggedRoadSurfacePenalty: Math.max(baseAxes.untaggedRoadSurfacePenalty, 0.55),
        residentialCost: Math.max(baseAxes.residentialCost, 0.75),
        unclassifiedCost: Math.max(baseAxes.unclassifiedCost, 0.65),
        tertiaryCost: Math.max(baseAxes.tertiaryCost, 0.75),
        secondaryCost: scaleFinite(baseAxes.secondaryCost, 1.4, 0.8, 10),
        primaryCost: scaleFinite(baseAxes.primaryCost, 1.5, 1.2, 20),
        compactedPenalty: 0.0,
        fineGravelPenalty: 0.0,
        gravelPenalty: 0.05,
        pebblestonePenalty: 0.2,
        unpavedPenalty: 0.05,
        grassPenalty: 0.45,
        untaggedPathSurfacePenalty: 0.05,
        cyclewayCost: 0.0,
        cyclewaySharedCost: 0.0,
        bridlewayCost: 0.0,
        pathCost: 0.1,
        footwayCost: Math.min(baseAxes.footwayCost, 0.35),
        pedestrianCost: Math.min(baseAxes.pedestrianCost, 0.35),
        trackGrade1Cost: 0.0,
        trackGrade2Cost: 0.0,
        trackGrade3Cost: 0.15,
        trackGrade4Cost: 0.75,
        trackUntaggedCost: 0.05,
      },
    },

    // Cycleways & networks (6)
    {
      id: 'cycle-strict-network',
      label: 'Quiet cycle networks',
      dimension: 'Cycleways',
      description: 'Strong pull toward signed cycle routes and protected cycleways.',
      patch: {
        stickToCycleRoutes: true,
        nonCycleRouteRoadPenalty: clamp(
          Number(Math.max(1.8, baseAxes.nonCycleRouteRoadPenalty * 3.0 + 1.2).toFixed(2)),
          0,
          5,
        ),
        cyclewayCost: 0.0,
        cyclewaySharedCost: Math.min(baseAxes.cyclewaySharedCost, 0.1),
        turnCostCycleRoute: Math.min(baseAxes.turnCostCycleRoute, 30),
      },
    },
    {
      id: 'cycle-max-adhesion',
      label: 'Strict bike-route adhesion',
      dimension: 'Cycleways',
      description: 'Very strong pull to stay on signed LCN, RCN, NCN, and dedicated cycleways.',
      patch: {
        stickToCycleRoutes: true,
        nonCycleRouteRoadPenalty: clamp(
          Number(Math.max(3.2, baseAxes.nonCycleRouteRoadPenalty * 5.0 + 2.0).toFixed(2)),
          0,
          5,
        ),
        cyclewayCost: 0.0,
        cyclewaySharedCost: 0.0,
        turnCostCycleRoute: Math.min(baseAxes.turnCostCycleRoute, 20),
      },
    },
    {
      id: 'cycle-quiet-network-noise',
      label: 'Quiet signed bike routes',
      dimension: 'Cycleways',
      description: 'Combines high bike-route adhesion with strong traffic and noise avoidance.',
      patch: {
        stickToCycleRoutes: true,
        allowUrbanTrunks: false,
        nonCycleRouteRoadPenalty: clamp(
          Number(Math.max(2.4, baseAxes.nonCycleRouteRoadPenalty * 4.0 + 1.4).toFixed(2)),
          0,
          5,
        ),
        cyclewayCost: 0.0,
        cyclewaySharedCost: Math.min(baseAxes.cyclewaySharedCost, 0.1),
        turnCostCycleRoute: Math.min(baseAxes.turnCostCycleRoute, 25),
        enableTrafficPenalties: true,
        trafficClass3Penalty: scaleFinite(baseAxes.trafficClass3Penalty, 1.8, 0.6, 10),
        trafficClass4Penalty: scaleFinite(baseAxes.trafficClass4Penalty, 2.2, 1.4, 10),
        trafficClass5Penalty: scaleFinite(baseAxes.trafficClass5Penalty, 2.4, 2.2, 10),
        trafficClass6Penalty: scaleFinite(baseAxes.trafficClass6Penalty, 2.6, 3.2, 10),
        trafficClass7Penalty: scaleFinite(baseAxes.trafficClass7Penalty, 2.6, 3.6, 10),
        enableNoisePenalties: true,
        noiseClass3Penalty: scaleFinite(baseAxes.noiseClass3Penalty, 1.6, 0.4, 10),
        noiseClass4Penalty: scaleFinite(baseAxes.noiseClass4Penalty, 2.2, 1.2, 10),
        noiseClass5Penalty: scaleFinite(baseAxes.noiseClass5Penalty, 2.5, 2.0, 10),
        noiseClass6Penalty: scaleFinite(baseAxes.noiseClass6Penalty, 2.8, 3.0, 10),
      },
    },
    {
      id: 'cycle-arterial-lanes',
      label: 'Arterial cycle superhighways',
      dimension: 'Cycleways',
      description: 'Follows direct signed cycle superhighways, urban trunks, and bus lanes.',
      patch: {
        stickToCycleRoutes: true,
        nonCycleRouteRoadPenalty: clamp(
          Number(Math.max(1.8, baseAxes.nonCycleRouteRoadPenalty + 1.4).toFixed(2)),
          0,
          5,
        ),
        allowUrbanTrunks: true,
        allowBusLanes: true,
        useProposedCycleRoutes: true,
        trunkCost: Math.min(baseAxes.trunkCost, 1.0),
        primaryCost: Math.min(baseAxes.primaryCost, 0.1),
        secondaryCost: Math.min(baseAxes.secondaryCost, 0.1),
        cyclewayCost: 0.0,
        trafficClass4Penalty: Math.min(baseAxes.trafficClass4Penalty, 0.1),
        trafficClass5Penalty: Math.min(baseAxes.trafficClass5Penalty, 0.15),
        trafficClass6Penalty: Math.min(baseAxes.trafficClass6Penalty, 0.2),
        trafficClass7Penalty: Math.min(baseAxes.trafficClass7Penalty, 0.2),
      },
    },
    {
      id: 'cycle-shared-paths',
      label: 'Shared paths and plazas',
      dimension: 'Cycleways',
      description: 'Welcomes shared-use cycleways, pedestrian plazas, park gates, and proposed routes.',
      patch: {
        stickToCycleRoutes: true,
        useProposedCycleRoutes: true,
        cyclewayCost: 0.0,
        cyclewaySharedCost: 0.0,
        pedestrianCost: Math.min(baseAxes.pedestrianCost, 0.2),
        footwayCost: Math.min(baseAxes.footwayCost, 0.35),
        pathCost: Math.min(baseAxes.pathCost, 0.35),
        dismountNodeCost: Math.round(baseAxes.dismountNodeCost * 0.25),
      },
    },
    {
      id: 'cycle-unbiased',
      label: 'Unbiased road choice',
      dimension: 'Cycleways',
      description: 'Evaluates streets purely on road, traffic, and surface tags without cycle-route bias.',
      patch: {
        stickToCycleRoutes: false,
        nonCycleRouteRoadPenalty: 0.0,
        useProposedCycleRoutes: true,
        allowBusLanes: true,
      },
    },

    // Scenery, noise & lighting (4)
    {
      id: 'scenery-low-noise',
      label: 'Lowest noise streets',
      dimension: 'Scenery',
      description: 'Strong avoidance of moderate-to-extreme traffic noise independent of parks.',
      patch: {
        enableNoisePenalties: true,
        noiseClass2Penalty: scaleFinite(baseAxes.noiseClass2Penalty, 1.5, 0.2, 10),
        noiseClass3Penalty: scaleFinite(baseAxes.noiseClass3Penalty, 2.0, 0.7, 10),
        noiseClass4Penalty: scaleFinite(baseAxes.noiseClass4Penalty, 2.6, 1.6, 10),
        noiseClass5Penalty: scaleFinite(baseAxes.noiseClass5Penalty, 3.0, 2.8, 10),
        noiseClass6Penalty: scaleFinite(baseAxes.noiseClass6Penalty, 3.4, 4.2, 10),
      },
    },
    {
      id: 'scenery-green-quiet',
      label: 'Green streets and low noise',
      dimension: 'Scenery',
      description: 'Prefers tree-lined streets, low traffic noise, and wooded corridors.',
      patch: {
        enableForestPenalties: true,
        forestUntaggedPenalty: Math.max(baseAxes.forestUntaggedPenalty, 0.9),
        forestClass1Penalty: Math.max(baseAxes.forestClass1Penalty, 0.6),
        forestClass2Penalty: Math.max(baseAxes.forestClass2Penalty, 0.35),
        enableNoisePenalties: true,
        noiseClass3Penalty: scaleFinite(baseAxes.noiseClass3Penalty, 1.6, 0.35, 10),
        noiseClass4Penalty: scaleFinite(baseAxes.noiseClass4Penalty, 2.2, 1.1, 10),
        noiseClass5Penalty: scaleFinite(baseAxes.noiseClass5Penalty, 2.5, 1.9, 10),
        noiseClass6Penalty: scaleFinite(baseAxes.noiseClass6Penalty, 2.8, 2.8, 10),
      },
    },
    {
      id: 'scenery-parks-commons',
      label: 'Parks, commons, and greenways',
      dimension: 'Scenery',
      description: 'Seeks parks, commons, heaths, and wooded trails even on unpaved park paths.',
      patch: {
        enableForestPenalties: true,
        forestUntaggedPenalty: Math.max(baseAxes.forestUntaggedPenalty, 1.4),
        forestClass1Penalty: Math.max(baseAxes.forestClass1Penalty, 1.0),
        forestClass2Penalty: Math.max(baseAxes.forestClass2Penalty, 0.6),
        forestClass3Penalty: Math.max(baseAxes.forestClass3Penalty, 0.25),
        enableNoisePenalties: true,
        noiseClass4Penalty: scaleFinite(baseAxes.noiseClass4Penalty, 1.8, 0.6, 10),
        noiseClass5Penalty: scaleFinite(baseAxes.noiseClass5Penalty, 2.0, 1.1, 10),
        noiseClass6Penalty: scaleFinite(baseAxes.noiseClass6Penalty, 2.2, 1.6, 10),
        enableSurfacePenalties: true,
        compactedPenalty: Math.min(baseAxes.compactedPenalty, 0.0),
        fineGravelPenalty: Math.min(baseAxes.fineGravelPenalty, 0.05),
        gravelPenalty: Math.min(baseAxes.gravelPenalty, 0.15),
        unpavedPenalty: Math.min(baseAxes.unpavedPenalty, 0.15),
        grassPenalty: Math.min(baseAxes.grassPenalty, 0.6),
        untaggedPathSurfacePenalty: Math.min(baseAxes.untaggedPathSurfacePenalty, 0.15),
        cyclewayCost: 0.0,
        cyclewaySharedCost: Math.min(baseAxes.cyclewaySharedCost, 0.05),
        bridlewayCost: Math.min(baseAxes.bridlewayCost, 0.05),
        pathCost: Math.min(baseAxes.pathCost, 0.2),
        footwayCost: Math.min(baseAxes.footwayCost, 0.4),
        pedestrianCost: Math.min(baseAxes.pedestrianCost, 0.4),
        trackGrade1Cost: 0.0,
        trackGrade2Cost: Math.min(baseAxes.trackGrade2Cost, 0.1),
        trackUntaggedCost: Math.min(baseAxes.trackUntaggedCost, 0.1),
      },
    },
    {
      id: 'scenery-well-lit',
      label: 'Well-lit streets',
      dimension: 'Scenery',
      description: 'Avoids unlit paths and dark rural lanes.',
      patch: {
        enableEnvironmentPenalties: true,
        unlitPenalty: scaleFinite(baseAxes.unlitPenalty, 2.0, 1.6, 10),
        untaggedLitPenalty: scaleFinite(baseAxes.untaggedLitPenalty, 1.8, 0.45, 10),
      },
    },
  ];

  const probes: RobustnessProbeSpec[] = selectDirectionalDefs(directionalDefs, scenarioCount).map(
    (s) => {
      const nextAxes: ProfileAxes = { ...baseAxes, ...s.patch };
      const fullDsl = generateBrfFromAxes(nextAxes, {
        name: `${profileLabel} (${s.label})`,
        summary: s.description,
      });
      return {
        id: s.id,
        kind: 'directional',
        label: s.label,
        dimension: s.dimension,
        description: s.description,
        fullDsl,
        screeningDsl: injectScreeningPass2(fullDsl),
        axes: nextAxes,
        baseTemplate,
      };
    });

  // Deterministic Halton quasi-Monte-Carlo multi-axis perturbations
  const jitterCount = Math.max(0, scenarioCount - probes.length);
  const lnSpan = Math.log(2.6); // ~[0.38x, 2.60x] standard multiplicative span
  const lnHighUp = Math.log(4.5); // stronger upward sweep (up to 4.5x) on traffic, noise, and cycle adhesion
  const lnRoughDown = Math.log(6.5); // stronger relaxation toward 0.15x on unpaved/trail axes when uSurface < 0

  for (let m = 1; m <= jitterCount; m++) {
    const uTraffic = halton(m, HALTON_PRIMES[0]) * 2 - 1; // [-1, 1]
    const uHills = halton(m, HALTON_PRIMES[1]) * 2 - 1;
    const uSurface = halton(m, HALTON_PRIMES[2]) * 2 - 1;
    const uTurns = halton(m, HALTON_PRIMES[3]) * 2 - 1;
    const uCross = halton(m, HALTON_PRIMES[4]) * 2 - 1;
    const uCycle = halton(m, HALTON_PRIMES[5]) * 2 - 1;
    const uScenery = halton(m, HALTON_PRIMES[6]) * 2 - 1;
    const uNoise = halton(m, HALTON_PRIMES[7]) * 2 - 1;
    const uEnv = halton(m, HALTON_PRIMES[8]) * 2 - 1;

    const kTraffic = uTraffic >= 0 ? Math.exp(uTraffic * lnHighUp) : Math.exp(uTraffic * lnSpan);
    const kHills = Math.exp(uHills * lnSpan);
    const kSurface = uSurface >= 0 ? Math.exp(uSurface * lnSpan) : Math.exp(uSurface * lnRoughDown);
    const kPathGate = uSurface >= 0 ? kSurface : kSurface * 0.6;
    const kTurns = Math.exp(uTurns * lnSpan);
    const kCross = Math.exp(uCross * lnSpan);
    const kCycle = uCycle >= 0 ? Math.exp(uCycle * lnHighUp) : Math.exp(uCycle * lnSpan);
    const kScenery = Math.exp(uScenery * lnSpan);
    const kNoise = uNoise >= 0 ? Math.exp(uNoise * lnHighUp) : Math.exp(uNoise * lnSpan);
    const kEnv = Math.exp(uEnv * lnSpan);

    const tPos = Math.max(0, uTraffic);
    const nPos = Math.max(0, uNoise);
    const cPos = Math.max(0, uCycle);

    const hillAdd = uHills > 0.2 && baseAxes.uphillCost < 20 ? Math.round(uHills * 55) : 0;
    const greenAdd = uScenery > 0.2 ? Number(((uScenery - 0.2) * 1.05).toFixed(2)) : 0;
    const tarmacBias = uSurface < -0.35 ? Number(((-uSurface - 0.35) * 0.85).toFixed(2)) : 0;
    const roughAdd = uSurface > 0.35 ? Number(((uSurface - 0.35) * 0.8).toFixed(2)) : 0;

    const baseTurnCycle = scaleIntFinite(baseAxes.turnCostCycleRoute, kTurns, 0, 300);

    const nextAxes: ProfileAxes = {
      ...baseAxes,
      enableTrafficPenalties: baseAxes.enableTrafficPenalties || tPos > 0.15,
      allowUrbanTrunks: uTraffic < -0.15 ? true : uTraffic > 0.25 ? false : baseAxes.allowUrbanTrunks,
      allowBusLanes: uCycle > 0.2 || uTraffic < -0.15 ? true : baseAxes.allowBusLanes,
      useProposedCycleRoutes: uCycle > 0.2 ? true : baseAxes.useProposedCycleRoutes,
      stickToCycleRoutes:
        uCycle < -0.55 ? false : uCycle > 0.1 ? true : baseAxes.stickToCycleRoutes,

      primaryCost: scaleFinite(
        baseAxes.primaryCost,
        kTraffic,
        tPos > 0.15 ? (tPos - 0.15) * 2.4 : tarmacBias * 0.5,
        20,
      ),
      secondaryCost: scaleFinite(
        baseAxes.secondaryCost,
        kTraffic,
        tPos > 0.15 ? (tPos - 0.15) * 1.5 : tarmacBias * 0.4,
        10,
      ),
      tertiaryCost: scaleFinite(
        baseAxes.tertiaryCost,
        kTraffic,
        tPos > 0.25 ? (tPos - 0.25) * 0.7 : tarmacBias * 0.5,
        10,
      ),
      unclassifiedCost: scaleFinite(baseAxes.unclassifiedCost, 1, tarmacBias * 0.6, 10),
      residentialCost: scaleFinite(baseAxes.residentialCost, 1, tarmacBias * 0.7, 10),
      trafficClass2Penalty: scaleFinite(
        baseAxes.trafficClass2Penalty,
        kTraffic,
        tPos > 0.45 ? (tPos - 0.45) * 0.45 : 0,
        10,
      ),
      trafficClass3Penalty: scaleFinite(
        baseAxes.trafficClass3Penalty,
        kTraffic,
        tPos > 0.2 ? (tPos - 0.2) * 1.1 : 0,
        10,
      ),
      trafficClass4Penalty: scaleFinite(
        baseAxes.trafficClass4Penalty,
        kTraffic,
        tPos > 0.15 ? (tPos - 0.15) * 2.2 : 0,
        10,
      ),
      trafficClass5Penalty: scaleFinite(
        baseAxes.trafficClass5Penalty,
        kTraffic,
        tPos > 0.15 ? (tPos - 0.15) * 3.2 : 0,
        10,
      ),
      trafficClass6Penalty: scaleFinite(
        baseAxes.trafficClass6Penalty,
        kTraffic,
        tPos > 0.15 ? (tPos - 0.15) * 4.2 : 0,
        10,
      ),
      trafficClass7Penalty: scaleFinite(
        baseAxes.trafficClass7Penalty,
        kTraffic,
        tPos > 0.15 ? (tPos - 0.15) * 4.5 : 0,
        10,
      ),

      considerElevation: baseAxes.considerElevation || hillAdd > 0,
      uphillCost: clamp(Math.round(baseAxes.uphillCost * kHills + hillAdd), 0, 200),
      uphillCutoff: Number(clamp(baseAxes.uphillCutoff * (1 - uHills * 0.38), 0.7, 3.8).toFixed(1)),
      downhillCost: clamp(Math.round(baseAxes.downhillCost * kHills), 0, 200),

      asphaltPenalty: scaleFinite(baseAxes.asphaltPenalty, 1, tarmacBias, 15),
      pavedPenalty: scaleFinite(baseAxes.pavedPenalty, 1, tarmacBias * 0.85, 15),
      concretePenalty: scaleFinite(baseAxes.concretePenalty, 1, tarmacBias * 0.85, 15),
      untaggedRoadSurfacePenalty: scaleFinite(baseAxes.untaggedRoadSurfacePenalty, 1, tarmacBias * 0.85, 15),
      compactedPenalty: scaleFinite(baseAxes.compactedPenalty, kSurface, roughAdd * 0.6, 15),
      fineGravelPenalty: scaleFinite(baseAxes.fineGravelPenalty, kSurface, roughAdd * 0.8, 15),
      gravelPenalty: scaleFinite(baseAxes.gravelPenalty, kSurface, roughAdd * 1.2, 15),
      pebblestonePenalty: scaleFinite(baseAxes.pebblestonePenalty, kSurface, roughAdd * 1.2, 15),
      unpavedPenalty: scaleFinite(baseAxes.unpavedPenalty, kSurface, roughAdd * 1.5, 15),
      grassPenalty: scaleFinite(baseAxes.grassPenalty, kSurface, roughAdd * 1.5, 15),
      pavingStonesPenalty: scaleFinite(baseAxes.pavingStonesPenalty, kSurface, 0, 15),
      settPenalty: scaleFinite(baseAxes.settPenalty, kSurface, 0, 15),
      cobblestonePenalty: scaleFinite(baseAxes.cobblestonePenalty, kSurface, 0, 15),
      untaggedPathSurfacePenalty: scaleFinite(baseAxes.untaggedPathSurfacePenalty, kPathGate, roughAdd, 15),

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
        cPos > 0.25 ? Math.min(baseTurnCycle, Math.round(baseAxes.turnCostCycleRoute / Math.sqrt(kCycle))) : baseTurnCycle,
      trafficSignalCost: scaleIntFinite(baseAxes.trafficSignalCost, kTurns, 0, 300),
      stopGiveWayCost: scaleIntFinite(baseAxes.stopGiveWayCost, kTurns, 0, 300),
      roadTransitionCost: scaleIntFinite(baseAxes.roadTransitionCost, kTurns, 0, 300),

      crossingClass3Cost: scaleIntFinite(baseAxes.crossingClass3Cost, kCross, tPos > 0.4 ? Math.round((tPos - 0.4) * 80) : 0, 500),
      crossingClass4Cost: scaleIntFinite(baseAxes.crossingClass4Cost, kCross, 0, 500),
      crossingClass5Cost: scaleIntFinite(baseAxes.crossingClass5Cost, kCross, 0, 500),
      turnAcrossTrafficClass3Cost: scaleIntFinite(baseAxes.turnAcrossTrafficClass3Cost, kCross, 0, 500),
      turnAcrossTrafficClass4Cost: scaleIntFinite(baseAxes.turnAcrossTrafficClass4Cost, kCross, 0, 500),
      turnAcrossTrafficClass5Cost: scaleIntFinite(baseAxes.turnAcrossTrafficClass5Cost, kCross, 0, 500),

      nonCycleRouteRoadPenalty: clamp(
        Number((baseAxes.nonCycleRouteRoadPenalty * kCycle + (cPos > 0.1 ? (cPos - 0.1) * 2.6 : 0)).toFixed(2)),
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
        nPos > 0.15 ? (nPos - 0.15) * 1.9 : 0,
        10,
      ),
      noiseClass5Penalty: scaleFinite(
        baseAxes.noiseClass5Penalty,
        kNoise,
        nPos > 0.15 ? (nPos - 0.15) * 3.0 : 0,
        10,
      ),
      noiseClass6Penalty: scaleFinite(
        baseAxes.noiseClass6Penalty,
        kNoise,
        nPos > 0.15 ? (nPos - 0.15) * 4.2 : 0,
        10,
      ),

      enableEnvironmentPenalties: baseAxes.enableEnvironmentPenalties || uEnv > 0.35 || tPos > 0.4,
      multiLanePenalty: scaleFinite(
        baseAxes.multiLanePenalty,
        kEnv,
        uEnv > 0.45 ? 0.5 : tPos > 0.4 ? (tPos - 0.4) * 1.2 : 0,
        10,
      ),
      unlitPenalty: scaleFinite(baseAxes.unlitPenalty, kEnv, uEnv > 0.5 ? 0.5 : 0, 10),
    };

    const axisPulls: Array<{ dim: PerturbationDimension; mag: number; tag: string }> = [
      { dim: 'Traffic', mag: Math.max(Math.abs(uTraffic), Math.abs(uCross)), tag: uTraffic >= 0 ? 'quieter traffic' : 'main roads' },
      { dim: 'Hills', mag: Math.abs(uHills), tag: uHills >= 0 ? 'flatter' : 'climb-tolerant' },
      { dim: 'Surface', mag: Math.abs(uSurface), tag: uSurface >= 0 ? 'smoother tarmac' : tarmacBias > 0 ? 'off-road trails' : 'gravel-tolerant' },
      { dim: 'Directness', mag: Math.abs(uTurns), tag: uTurns >= 0 ? 'fewer turns' : 'agile turns' },
      { dim: 'Cycleways', mag: Math.abs(uCycle), tag: uCycle >= 0 ? 'stronger bike-route adhesion' : 'less cycleway bias' },
      {
        dim: 'Scenery',
        mag: Math.max(Math.abs(uNoise), Math.abs(uScenery), Math.abs(uEnv) * 0.7),
        tag: Math.abs(uNoise) >= Math.abs(uScenery)
          ? (uNoise >= 0 ? 'lower noise' : 'noise-tolerant')
          : (uScenery >= 0 ? 'greener corridors' : 'urban-tolerant'),
      },
    ];
    axisPulls.sort((a, b) => b.mag - a.mag);
    const top1 = axisPulls[0];
    const top2 = axisPulls[1];

    const label = `Combined mix #${m}`;
    const description = `Simultaneous multi-axis jitter led by ${top1.tag} and ${top2.tag}.`;
    const fullDsl = generateBrfFromAxes(nextAxes, {
      name: `${profileLabel} (${label})`,
      summary: description,
    });

    probes.push({
      id: `jitter-${m}`,
      kind: 'jitter',
      label,
      dimension: top1.dim,
      description,
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

  const mildFlat = elevOverrides([
    ['uphillcost', 75],
    ['uphillcutoff', 1.2],
    ['downhillcost', 45],
  ]);
  const strongFlat = elevOverrides([
    ['uphillcost', 150],
    ['uphillcutoff', 0.8],
    ['downhillcost', 80],
  ]);
  const climbOk = elevOverrides([
    ['uphillcost', 0],
    ['uphillcutoff', 3.8],
    ['downhillcost', 5],
  ]);
  const gentleDesc = elevOverrides([
    ['downhillcost', 140],
    ['downhillcutoff', 1.0],
  ]);

  const directionalDefs: Array<{
    id: string;
    label: string;
    dimension: PerturbationDimension;
    description: string;
    globalLines?: string[];
    wayLines?: string[];
    nodeLines?: string[];
  }> = [
    {
      id: 'traffic-mild-quiet',
      label: 'Mildly quieter roads',
      dimension: 'Traffic',
      description: 'Moderately higher penalties on main roads and busy traffic.',
      wayLines: [
        safeAddWayCost(
          'add ( switch highway=primary|primary_link 0.6 switch highway=secondary|secondary_link 0.35 0 ) ( switch estimated_traffic_class=5|6|7 0.6 switch estimated_traffic_class=4 0.35 0 )',
        ),
      ],
    },
    {
      id: 'traffic-strong-quiet',
      label: 'Quiet backroads only',
      dimension: 'Traffic',
      description: 'Strong avoidance of main roads and heavy traffic.',
      wayLines: [
        safeAddWayCost(
          'add ( switch highway=primary|primary_link 2.6 switch highway=secondary|secondary_link 1.6 switch highway=tertiary|tertiary_link 0.65 0 ) ( switch estimated_traffic_class=6|7 3.8 switch estimated_traffic_class=5 2.6 switch estimated_traffic_class=4 1.6 switch estimated_traffic_class=3 0.75 0 )',
        ),
      ],
    },
    {
      id: 'traffic-noise-sanctuary',
      label: 'Strict low traffic and noise',
      dimension: 'Traffic',
      description: 'Heavy avoidance of busy traffic classes and loud streets.',
      wayLines: [
        safeAddWayCost(
          'add ( switch highway=primary|primary_link 4.0 switch highway=secondary|secondary_link 2.4 switch highway=tertiary|tertiary_link 1.0 0 ) ( add ( switch estimated_traffic_class=6|7 5.2 switch estimated_traffic_class=5 3.8 switch estimated_traffic_class=4 2.4 switch estimated_traffic_class=3 1.2 0 ) ( switch estimated_noise_class=6 4.0 switch estimated_noise_class=5 2.6 switch estimated_noise_class=4 1.5 switch estimated_noise_class=3 0.6 0 ) )',
        ),
      ],
    },
    {
      id: 'traffic-relaxed',
      label: 'Main-road tolerant',
      dimension: 'Traffic',
      description: 'Lowers penalties on primary, secondary, and tertiary roads.',
      wayLines: [
        safeAddWayCost(
          'switch highway=primary|primary_link|secondary|secondary_link|tertiary|tertiary_link -0.45 0.1',
        ),
      ],
    },
    {
      id: 'traffic-no-multilane',
      label: 'Avoid multi-lane and tunnels',
      dimension: 'Traffic',
      description: 'Penalizes multi-lane roads and tunnels.',
      wayLines: [
        safeAddWayCost('add ( switch lanes=3|4|5|6|7|8 1.5 0 ) ( switch tunnel=yes 3.0 0 )'),
      ],
    },
    {
      id: 'junction-safe',
      label: 'Strict junction safety',
      dimension: 'Traffic',
      description: 'Adds extra stop and signal crossing penalties.',
      nodeLines: hasNodeInitialcost
        ? ['assign initialcost = add initialcost switch highway=traffic_signals|crossing 120 switch highway=stop|give_way 90 0']
        : ['assign initialcost = switch highway=traffic_signals|crossing 120 switch highway=stop|give_way 90 0'],
    },
    {
      id: 'direct-high-flow',
      label: 'Fast and direct',
      dimension: 'Directness',
      description: 'Fewer turns and stops, lower penalties on direct main roads.',
      wayLines: [
        safeAddWayCost(
          'switch highway=primary|primary_link|secondary|secondary_link|tertiary|tertiary_link -0.35 0.15',
        ),
        ...(hasWayTurncost ? ['assign turncost = add turncost 110'] : []),
      ],
      nodeLines: hasNodeInitialcost
        ? ['assign initialcost = add initialcost switch highway=traffic_signals|stop|give_way 100 0']
        : ['assign initialcost = switch highway=traffic_signals|stop|give_way 100 0'],
    },
    {
      id: 'direct-low-turn',
      label: 'Minimal turns',
      dimension: 'Directness',
      description: 'High turn penalty while preserving road preferences.',
      wayLines: hasWayTurncost ? ['assign turncost = add turncost 140'] : [safeAddWayCost('switch highway=residential|service 0.25 0')],
    },
    {
      id: 'direct-agile',
      label: 'Agile backstreets',
      dimension: 'Directness',
      description: 'Reduces turn penalties so backstreet shortcuts open up.',
      wayLines: hasWayTurncost
        ? ['assign turncost = multiply turncost 0.25']
        : [safeAddWayCost('switch highway=residential|living_street -0.2 0')],
    },
    {
      id: 'direct-pure-shortest',
      label: 'Shortest legal distance',
      dimension: 'Directness',
      description: 'Minimizes distance by stripping soft climb, turn, and comfort biases.',
      globalLines: climbOk.globalLines,
      wayLines: [
        ...climbOk.wayLines,
        safeAddWayCost('switch highway=primary|secondary|tertiary|unclassified|residential -0.35 0'),
        ...(hasWayTurncost ? ['assign turncost = min turncost 15'] : []),
      ],
    },
    {
      id: 'hills-mild-flat',
      label: 'Mildly flatter',
      dimension: 'Hills',
      description: 'Moderately higher climb avoidance.',
      globalLines: mildFlat.globalLines,
      wayLines: mildFlat.wayLines,
    },
    {
      id: 'hills-strong-flat',
      label: 'Flattest route',
      dimension: 'Hills',
      description: 'Strong climb avoidance and low slope threshold.',
      globalLines: strongFlat.globalLines,
      wayLines: strongFlat.wayLines,
    },
    {
      id: 'hills-climb-ok',
      label: 'Climb-tolerant',
      dimension: 'Hills',
      description: 'Accepts steeper climbs when they shorten the route.',
      globalLines: climbOk.globalLines,
      wayLines: climbOk.wayLines,
    },
    {
      id: 'hills-gentle-descents',
      label: 'Cautious descents',
      dimension: 'Hills',
      description: 'Avoids steep descents.',
      globalLines: gentleDesc.globalLines,
      wayLines: gentleDesc.wayLines,
    },
    {
      id: 'surface-strict-asphalt',
      label: 'Strict smooth asphalt',
      dimension: 'Surface',
      description: 'Avoids gravel, cobbles, unpaved tracks, and rough paths.',
      wayLines: [
        safeAddWayCost(
          'switch surface=gravel|unpaved|dirt|ground|earth|mud|sand|cobblestone 6.0 switch surface=compacted|fine_gravel|sett|paving_stones 2.8 switch highway=track|bridleway|path 2.2 0',
        ),
      ],
    },
    {
      id: 'surface-light-gravel',
      label: 'Towpaths and compacted',
      dimension: 'Surface',
      description: 'Lowers penalties on compacted gravel, towpaths, park gates, and smooth tracks.',
      wayLines: [
        safeAddWayCost(
          'switch surface=compacted|fine_gravel -0.65 switch highway=cycleway|bridleway|pedestrian -0.35 0.1',
        ),
      ],
    },
    {
      id: 'surface-adventure-gravel',
      label: 'Gravel and bridleways',
      dimension: 'Surface',
      description: 'Welcomes gravel tracks, bridleways, commons, and unpaved trails.',
      wayLines: [
        safeAddWayCost(
          'switch surface=gravel|compacted|fine_gravel|unpaved|ground|dirt|earth -1.5 switch highway=track|bridleway|path|pedestrian -1.0 0.25',
        ),
      ],
    },
    {
      id: 'surface-offroad-trails',
      label: 'Off-road gravel and commons',
      dimension: 'Surface',
      description: 'Actively prefers gravel, commons, and bridleways over tarmac streets.',
      wayLines: [
        safeAddWayCost(
          'add ( switch surface=gravel|compacted|fine_gravel|unpaved|ground|dirt|earth|grass -2.2 switch highway=track|bridleway|path -1.6 0 ) ( switch highway=primary|secondary|tertiary|unclassified|residential 1.1 switch surface=asphalt|paved|concrete 0.7 0 )',
        ),
      ],
    },
    {
      id: 'cycle-strict-network',
      label: 'Quiet cycle networks',
      dimension: 'Cycleways',
      description: 'Strong pull toward signed cycle routes and cycleways.',
      wayLines: [
        safeAddWayCost(
          'switch or route_bicycle_icn=yes or route_bicycle_ncn=yes or route_bicycle_rcn=yes or route_bicycle_lcn=yes highway=cycleway -0.45 1.8',
        ),
      ],
    },
    {
      id: 'cycle-max-adhesion',
      label: 'Strict bike-route adhesion',
      dimension: 'Cycleways',
      description: 'Very strong pull to stay on signed LCN, RCN, NCN, and dedicated cycleways.',
      wayLines: [
        safeAddWayCost(
          'switch or route_bicycle_icn=yes or route_bicycle_ncn=yes or route_bicycle_rcn=yes or route_bicycle_lcn=yes highway=cycleway -0.6 3.4',
        ),
      ],
    },
    {
      id: 'cycle-quiet-network-noise',
      label: 'Quiet signed bike routes',
      dimension: 'Cycleways',
      description: 'Combines high bike-route adhesion with strong traffic and noise avoidance.',
      wayLines: [
        safeAddWayCost(
          'add ( switch or route_bicycle_icn=yes or route_bicycle_ncn=yes or route_bicycle_rcn=yes or route_bicycle_lcn=yes highway=cycleway -0.5 2.4 ) ( add ( switch estimated_traffic_class=5|6|7 2.4 switch estimated_traffic_class=4 1.3 0 ) ( switch estimated_noise_class=5|6 2.0 switch estimated_noise_class=4 1.0 0 ) )',
        ),
      ],
    },
    {
      id: 'cycle-arterial-lanes',
      label: 'Arterial cycle superhighways',
      dimension: 'Cycleways',
      description: 'Follows direct signed cycle superhighways, urban trunks, and bus lanes.',
      wayLines: [
        safeAddWayCost(
          'switch and ( or highway=trunk|primary|secondary highway=cycleway ) ( or route_bicycle_rcn=yes or route_bicycle_ncn=yes or route_bicycle_lcn=yes or cycleway=lane|track|share_busway busway=lane ) -1.4 1.2',
        ),
      ],
    },
    {
      id: 'cycle-shared-paths',
      label: 'Shared paths and plazas',
      dimension: 'Cycleways',
      description: 'Welcomes shared-use cycleways, pedestrian plazas, and signed park connectors.',
      wayLines: [
        safeAddWayCost(
          'switch and highway=cycleway|pedestrian|footway|path ( or bicycle=yes|designated route_bicycle_lcn=yes ) -1.2 0.15',
        ),
      ],
    },
    {
      id: 'cycle-unbiased',
      label: 'Unbiased road choice',
      dimension: 'Cycleways',
      description: 'Reduces cycle-network bonus in favor of direct quiet streets.',
      wayLines: [
        safeAddWayCost(
          'switch or route_bicycle_icn=yes or route_bicycle_ncn=yes or route_bicycle_rcn=yes route_bicycle_lcn=yes 0.35 -0.1',
        ),
      ],
    },
    {
      id: 'scenery-low-noise',
      label: 'Lowest noise streets',
      dimension: 'Scenery',
      description: 'Strong avoidance of moderate-to-extreme traffic noise independent of parks.',
      wayLines: [
        safeAddWayCost(
          'switch estimated_noise_class=6 4.2 switch estimated_noise_class=5 2.8 switch estimated_noise_class=4 1.6 switch estimated_noise_class=3 0.7 0',
        ),
      ],
    },
    {
      id: 'scenery-green-quiet',
      label: 'Green streets and low noise',
      dimension: 'Scenery',
      description: 'Prefers green corridors, tree-lined streets, and low traffic noise.',
      wayLines: [
        safeAddWayCost(
          'add ( switch estimated_forest_class=3|4|5|6 -0.25 0.6 ) ( switch estimated_noise_class=6 2.8 switch estimated_noise_class=5 1.8 switch estimated_noise_class=4 1.0 switch estimated_noise_class=3 0.35 0 )',
        ),
      ],
    },
    {
      id: 'scenery-parks-commons',
      label: 'Parks, commons, and greenways',
      dimension: 'Scenery',
      description: 'Seeks parks, commons, heaths, and wooded trails even on unpaved park paths.',
      wayLines: [
        safeAddWayCost(
          'add ( switch estimated_forest_class=3|4|5|6 -0.6 switch estimated_forest_class=1|2 0.1 1.1 ) ( add ( switch surface=compacted|fine_gravel|gravel|unpaved|ground|dirt -1.4 0 ) ( switch highway=bridleway|track|cycleway|pedestrian -0.8 0 ) )',
        ),
      ],
    },
    {
      id: 'scenery-well-lit',
      label: 'Well-lit streets',
      dimension: 'Scenery',
      description: 'Avoids unlit paths and dark lanes.',
      wayLines: [safeAddWayCost('switch lit=no 1.6 switch lit=yes -0.15 0.35')],
    },
  ];

  const probes: RobustnessProbeSpec[] = selectDirectionalDefs(directionalDefs, scenarioCount).map(
    (s) => {
      const fullDsl = injectDslOverrides(baseDsl, {
        globalLines: s.globalLines,
        wayLines: s.wayLines,
        nodeLines: s.nodeLines,
      });
      return {
        id: s.id,
        kind: 'directional',
        label: s.label,
        dimension: s.dimension,
        description: s.description,
        fullDsl,
        screeningDsl: injectScreeningPass2(fullDsl),
      };
    });

  const jitterCount = Math.max(0, scenarioCount - probes.length);
  for (let m = 1; m <= jitterCount; m++) {
    const uTraffic = halton(m, HALTON_PRIMES[0]) * 2 - 1;
    const uHills = halton(m, HALTON_PRIMES[1]) * 2 - 1;
    const uSurface = halton(m, HALTON_PRIMES[2]) * 2 - 1;
    const uTurns = halton(m, HALTON_PRIMES[3]) * 2 - 1;
    const uCycle = halton(m, HALTON_PRIMES[5]) * 2 - 1;
    const uScenery = halton(m, HALTON_PRIMES[6]) * 2 - 1;
    const uNoise = halton(m, HALTON_PRIMES[7]) * 2 - 1;

    const dTraffic = Number((uTraffic >= 0 ? uTraffic * 2.8 : uTraffic * 0.9).toFixed(2));
    const dTrafficMed = Number((uTraffic >= 0.2 ? (uTraffic - 0.2) * 1.4 : 0).toFixed(2));
    const dSurface = Number((uSurface * 1.9).toFixed(2));
    const dTarmac = uSurface < -0.35 ? Number(((-uSurface - 0.35) * 0.9).toFixed(2)) : 0;
    const dCycleOff = Number((uCycle >= 0 ? uCycle * 2.8 : 0).toFixed(2));
    const dCycleOn = Number((uCycle >= 0 ? -Math.min(0.5, uCycle * 0.45) : -uCycle * 0.4).toFixed(2));
    const dNoiseHi = Number((uNoise >= 0 ? uNoise * 3.0 : uNoise * 0.5).toFixed(2));
    const dNoiseMed = Number((uNoise >= 0.2 ? (uNoise - 0.2) * 1.4 : 0).toFixed(2));
    const dForest = uScenery > 0.25 ? Number(((uScenery - 0.25) * 0.9).toFixed(2)) : 0;
    const upCost = Math.round(clamp(55 + uHills * 75, 0, 175));
    const upCut = Number(clamp(1.6 - uHills * 0.75, 0.8, 3.4).toFixed(1));
    const downCost = Math.round(clamp(35 + uHills * 40, 0, 110));
    const turnMul = Number(clamp(Math.exp(uTurns * 0.75), 0.3, 2.3).toFixed(2));

    const elev = elevOverrides([
      ['uphillcost', upCost],
      ['uphillcutoff', upCut],
      ['downhillcost', downCost],
    ]);

    const wayLines: string[] = [
      ...elev.wayLines,
      safeAddWayCost(
        `add ( switch highway=primary|primary_link|secondary|secondary_link ${dTraffic} 0 ) ( add ( switch estimated_traffic_class=5|6|7 ${dTraffic} switch estimated_traffic_class=3|4 ${dTrafficMed} 0 ) ( add ( switch surface=compacted|fine_gravel|gravel|unpaved|ground|dirt|earth ${dSurface} switch highway=residential|tertiary ${dTarmac} 0 ) ( add ( switch or route_bicycle_ncn=yes or route_bicycle_rcn=yes or route_bicycle_lcn=yes highway=cycleway ${dCycleOn} ${dCycleOff} ) ( add ( switch estimated_noise_class=5|6 ${dNoiseHi} switch estimated_noise_class=3|4 ${dNoiseMed} 0 ) ( switch estimated_forest_class=3|4|5|6 0 ${dForest} ) ) ) ) )`,
      ),
    ];
    if (hasWayTurncost) {
      wayLines.push(`assign turncost = multiply turncost ${turnMul}`);
    }

    const pulls: Array<{ dim: PerturbationDimension; mag: number; tag: string }> = [
      { dim: 'Traffic', mag: Math.abs(uTraffic), tag: uTraffic >= 0 ? 'quieter traffic' : 'main roads' },
      { dim: 'Hills', mag: Math.abs(uHills), tag: uHills >= 0 ? 'flatter' : 'climb-tolerant' },
      { dim: 'Surface', mag: Math.abs(uSurface), tag: uSurface >= 0 ? 'smoother tarmac' : dTarmac > 0 ? 'off-road trails' : 'gravel-tolerant' },
      { dim: 'Directness', mag: Math.abs(uTurns), tag: uTurns >= 0 ? 'fewer turns' : 'agile turns' },
      { dim: 'Cycleways', mag: Math.abs(uCycle), tag: uCycle >= 0 ? 'stronger bike-route adhesion' : 'less cycleway bias' },
      {
        dim: 'Scenery',
        mag: Math.max(Math.abs(uNoise), Math.abs(uScenery)),
        tag: Math.abs(uNoise) >= Math.abs(uScenery)
          ? (uNoise >= 0 ? 'lower noise' : 'noise-tolerant')
          : (uScenery >= 0 ? 'greener corridors' : 'urban-tolerant'),
      },
    ];
    pulls.sort((a, b) => b.mag - a.mag);

    const label = `Combined mix #${m}`;
    const description = `Simultaneous multi-axis jitter led by ${pulls[0].tag} and ${pulls[1].tag}.`;
    const fullDsl = injectDslOverrides(baseDsl, {
      globalLines: elev.globalLines,
      wayLines,
    });

    probes.push({
      id: `jitter-${m}`,
      kind: 'jitter',
      label,
      dimension: pulls[0].dim,
      description,
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

function nearestCoordIndex(
  coords: [number, number][],
  target: [number, number],
  startIdx = 0,
): { idx: number; distSq: number } {
  const cosLat = Math.cos((target[1] * Math.PI) / 180);
  let bestIdx = startIdx;
  let bestDistSq = Number.POSITIVE_INFINITY;
  for (let i = startIdx; i < coords.length; i++) {
    const dx = (coords[i][0] - target[0]) * cosLat;
    const dy = coords[i][1] - target[1];
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDistSq) {
      bestDistSq = d2;
      bestIdx = i;
    }
  }
  return { idx: bestIdx, distSq: bestDistSq };
}

function extractDetourBranches(
  base: PreparedRouteCacheEntry,
  probe: PreparedRouteCacheEntry,
): ExtractedBranch[] {
  const edgeCount = probe.edgeMidKeys.length;
  if (edgeCount === 0 || base.coords.length < 2) return [];

  const baseGrid = base.dilatedGrid;
  const offBase = new Uint8Array(edgeCount);
  let anyOff = false;
  for (let i = 0; i < edgeCount; i++) {
    if (!baseGrid.has(probe.edgeMidKeys[i])) {
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

    // Midpoint at 50% cumulative distance along this branch
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

    // Match branch endpoints back to the base route
    const startMatch = nearestCoordIndex(base.coords, coords[0], 0);
    const baseStartIdx = startMatch.idx;
    let endMatch = nearestCoordIndex(base.coords, coords[coords.length - 1], baseStartIdx);
    // Allow fallback to full base scan only if forward search failed (> ~250 m away)
    if (endMatch.distSq > 0.0025 * 0.0025) {
      const fullEnd = nearestCoordIndex(base.coords, coords[coords.length - 1], 0);
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

    // Build branch-local dilated grid for fast branch-to-branch clustering
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

function fallbackJitterLabel(
  deltaDistanceM: number,
  deltaAscentM: number,
  deltaTimeS: number,
  dimension: PerturbationDimension,
): string {
  if (deltaAscentM <= -15) return 'Lower-climb variant';
  if (deltaTimeS <= -60) return 'Faster variant';
  if (deltaDistanceM <= -250) return 'Shorter variant';
  return `${dimension} mix variant`;
}

function fallbackBranchLabel(
  deltaDistanceM: number,
  deltaAscentM: number,
  branchMix: SpanProfileMix,
  dimension: PerturbationDimension,
): string {
  if (branchMix.hasData) {
    if (branchMix.unpavedPct >= 40) return 'Unpaved trail branch';
    if (branchMix.pathTrackPct >= 55) return 'Cycleway and path branch';
    if (branchMix.mainRoadPct >= 55 && deltaDistanceM <= -100) return 'Direct main-road branch';
  }
  if (deltaAscentM <= -12) return 'Flatter detour';
  if (deltaDistanceM <= -150) return 'Shorter detour';
  return `${dimension} detour`;
}

export interface RobustnessSession {
  addProbe(probe: RobustnessProbeResult): void;
  snapshot(): RobustnessAnalysis;
}

/**
 * Incremental robustness accumulator. Each arriving probe updates edge support counts,
 * whole-route clusters, and local detour branches in O(edges + clusters) time.
 */
export function createRobustnessSession(
  baseRoute: RouteResponse,
  totalCount: number,
): RobustnessSession {
  const base = prepareRoute(baseRoute);
  const baseKeys = base.edgeMidKeys;
  const baseDists = base.edgeDists;
  const baseFromIdx = base.edgeFromIdx;
  const baseEdgeSupport = new Uint32Array(baseKeys.length);

  let completedCount = 0;
  let baseMatchingProbes = 0;
  let hasDirectional = false;
  let nextBranchSeq = 1;

  const dirDimMap = new Map<PerturbationDimension, number>();
  const allDimMap = new Map<PerturbationDimension, number>();

  interface PreparedProbeItem {
    probe: RobustnessProbeResult;
    prepared: PreparedRouteCacheEntry;
    overlapWithBase: number;
  }

  const clusters: Array<{
    primary: PreparedProbeItem;
    directionalLabels: string[];
    allLabels: string[];
    probeCount: number;
  }> = [];

  const branchClusters: Array<{
    stableId: string;
    color: { line: string; casing: string };
    branch: ExtractedBranch;
    primaryProbe: RobustnessProbeResult;
    primarySegments: SegmentData[];
    probeIds: Set<string>;
    directionalLabels: string[];
    allLabels: string[];
    dimCounts: Map<PerturbationDimension, number>;
  }> = [];

  return {
    addProbe(probe: RobustnessProbeResult): void {
      completedCount++;
      const prepared = prepareRoute(probe.route);
      const probeGrid = prepared.dilatedGrid;

      for (let i = 0; i < baseKeys.length; i++) {
        if (probeGrid.has(baseKeys[i])) {
          baseEdgeSupport[i]++;
        }
      }

      const overlapWithBase = symmetricOverlap(base, prepared);
      const divPct = Math.round((1 - overlapWithBase) * 100);
      const prevAll = allDimMap.get(probe.dimension) ?? 0;
      if (divPct > prevAll) {
        allDimMap.set(probe.dimension, divPct);
      }
      if (probe.kind === 'directional') {
        hasDirectional = true;
        const prevDir = dirDimMap.get(probe.dimension) ?? 0;
        if (divPct > prevDir) {
          dirDimMap.set(probe.dimension, divPct);
        }
      }

      // Extract and cluster local off-base detour branches regardless of whole-route overlap
      const extracted = extractDetourBranches(base, prepared);
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
            matched.dimCounts.set(
              probe.dimension,
              (matched.dimCounts.get(probe.dimension) ?? 0) + 1,
            );
          }
          if (!matched.allLabels.includes(probe.label)) {
            matched.allLabels.push(probe.label);
          }
          if (probe.kind === 'directional') {
            if (!matched.directionalLabels.includes(probe.label)) {
              matched.directionalLabels.push(probe.label);
            }
            if (matched.primaryProbe.kind === 'jitter') {
              matched.primaryProbe = probe;
              matched.primarySegments = prepared.segments;
              matched.branch = b;
            }
          }
        } else {
          const seq = nextBranchSeq++;
          const dimCounts = new Map<PerturbationDimension, number>();
          dimCounts.set(probe.dimension, 1);
          branchClusters.push({
            stableId: `branch-${seq}`,
            color: ROBUSTNESS_CORRIDOR_COLORS[(seq - 1) % ROBUSTNESS_CORRIDOR_COLORS.length],
            branch: b,
            primaryProbe: probe,
            primarySegments: prepared.segments,
            probeIds: new Set([probe.id]),
            directionalLabels: probe.kind === 'directional' ? [probe.label] : [],
            allLabels: [probe.label],
            dimCounts,
          });
        }
      }

      if (overlapWithBase >= 0.88) {
        baseMatchingProbes++;
        return;
      }

      const item: PreparedProbeItem = { probe, prepared, overlapWithBase };
      const existing = clusters.find(
        (c) => symmetricOverlap(c.primary.prepared, prepared) >= 0.78,
      );
      if (existing) {
        existing.probeCount++;
        if (!existing.allLabels.includes(probe.label)) {
          existing.allLabels.push(probe.label);
        }
        if (probe.kind === 'directional') {
          if (!existing.directionalLabels.includes(probe.label)) {
            existing.directionalLabels.push(probe.label);
          }
          if (existing.primary.probe.kind === 'jitter') {
            existing.primary = item;
          }
        }
      } else {
        clusters.push({
          primary: item,
          directionalLabels: probe.kind === 'directional' ? [probe.label] : [],
          allLabels: [probe.label],
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

      const sortedClusters = [...clusters].sort((a, b) => {
        if (b.probeCount !== a.probeCount) return b.probeCount - a.probeCount;
        const aDir = a.directionalLabels.length > 0 ? 1 : 0;
        const bDir = b.directionalLabels.length > 0 ? 1 : 0;
        if (bDir !== aDir) return bDir - aDir;
        return a.primary.overlapWithBase - b.primary.overlapWithBase;
      });

      const corridors: AlternativeCorridor[] = sortedClusters
        .slice(0, MAX_DISPLAY_CORRIDORS)
        .map((c, idx) => {
          const { probe, prepared, overlapWithBase } = c.primary;
          const color = ROBUSTNESS_CORRIDOR_COLORS[idx % ROBUSTNESS_CORRIDOR_COLORS.length];
          const deltaDistanceM = prepared.distanceM - base.distanceM;
          const deltaTimeS = prepared.timeS - base.timeS;
          const deltaAscentM = prepared.ascentM - base.ascentM;

          const displayLabel =
            c.directionalLabels.length > 0
              ? c.directionalLabels[0]
              : probe.kind === 'directional'
                ? probe.label
                : fallbackJitterLabel(deltaDistanceM, deltaAscentM, deltaTimeS, probe.dimension);

          const probeLabels =
            c.directionalLabels.length > 0 ? c.directionalLabels : c.allLabels.slice(0, 4);

          return {
            id: probe.id,
            label: displayLabel,
            probeLabels,
            description: probe.description,
            dimension: probe.dimension,
            probeCount: c.probeCount,
            sharePct: completedCount > 0 ? Math.round((c.probeCount / completedCount) * 100) : 0,
            route: probe.route,
            coordinates: prepared.coords,
            color,
            distanceM: prepared.distanceM,
            timeS: prepared.timeS,
            ascentM: prepared.ascentM,
            deltaDistanceM,
            deltaTimeS,
            deltaAscentM,
            overlapWithBase,
            fullDsl: probe.fullDsl,
            axes: probe.axes,
            baseTemplate: probe.baseTemplate,
          };
        });

      const sortedBranches = [...branchClusters].sort((a, b) => {
        const countDiff = b.probeIds.size - a.probeIds.size;
        if (countDiff !== 0) return countDiff;
        const aDir = a.directionalLabels.length > 0 ? 1 : 0;
        const bDir = b.directionalLabels.length > 0 ? 1 : 0;
        if (bDir !== aDir) return bDir - aDir;
        return b.branch.distanceM - a.branch.distanceM;
      });

      // Keep all directional branches and all multi-scenario branches so discovered routes never
      // vanish mid-sweep; cap only single-hit jitter-only micro-detours.
      const keptBranches: typeof sortedBranches = [];
      let singleJitterCount = 0;
      for (const bc of sortedBranches) {
        if (keptBranches.length >= MAX_DISPLAY_BRANCHES) break;
        const isPersistent = bc.directionalLabels.length > 0 || bc.probeIds.size >= 2;
        if (isPersistent) {
          keptBranches.push(bc);
        } else if (singleJitterCount < MAX_SINGLE_JITTER_BRANCHES) {
          singleJitterCount++;
          keptBranches.push(bc);
        }
      }

      const branches: AlternativeBranch[] = keptBranches.map((bc) => {
          const b = bc.branch;
          const probe = bc.primaryProbe;
          const color = bc.color;
          const probeCount = bc.probeIds.size;
          const deltaDistanceM = b.distanceM - b.replacedBaseDistM;
          const deltaAscentM = Math.round(b.ascentM - b.replacedBaseAscentM);
          const branchMix = summarizeSpanMix(bc.primarySegments, b.probeFromM, b.probeToM);
          const baseMix = summarizeSpanMix(base.segments, b.baseStartM, b.baseEndM);

          let topDim: PerturbationDimension = probe.dimension;
          let topDimCount = -1;
          for (const [dim, count] of bc.dimCounts.entries()) {
            if (count > topDimCount) {
              topDimCount = count;
              topDim = dim;
            }
          }

          const displayLabel =
            bc.directionalLabels.length > 0
              ? bc.directionalLabels[0]
              : probe.kind === 'directional'
                ? probe.label
                : fallbackBranchLabel(deltaDistanceM, deltaAscentM, branchMix, topDim);

          const probeLabels =
            bc.directionalLabels.length > 0 ? bc.directionalLabels : bc.allLabels.slice(0, 4);

          const replacedBaseCoords =
            b.baseEndIdx > b.baseStartIdx
              ? base.coords.slice(b.baseStartIdx, b.baseEndIdx + 1)
              : [];

          return {
            id: bc.stableId,
            label: displayLabel,
            probeLabels,
            description: probe.description,
            dimension: topDim,
            probeCount,
            sharePct: completedCount > 0 ? Math.round((probeCount / completedCount) * 100) : 0,
            coordinates: b.coords,
            midpoint: b.midpoint,
            replacedBaseCoords,
            color,
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

      const activeDimMap = hasDirectional ? dirDimMap : allDimMap;
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
