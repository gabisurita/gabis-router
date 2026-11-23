import type { RobustnessProbeResult, RobustnessProbeSpec } from './utils/robustness.ts';

export type BuiltinProfileName =
  | 'fastbike'
  | 'fastbike-lowtraffic'
  | 'fastbike-verylowtraffic'
  | 'gabis-fast-city'
  | 'gabis-lite-gravel'
  | 'gabis-safe-road'
  | 'gravel'
  | 'trekking';

export type ProfileName = BuiltinProfileName | (string & {});

export interface ProfileMeta {
  id: ProfileName;
  label: string;
  shortLabel: string;
  summary: string;
  isCustom?: boolean;
}

export const PROFILE_INFO: Record<string, ProfileMeta> = {
  'gabis-fast-city': {
    id: 'gabis-fast-city',
    label: "Gabi's Fast Bike",
    shortLabel: 'Fast Bike',
    summary: 'Direct urban cycle routes and bus/cycle lanes, avoids residential zig-zags.',
  },
  'gabis-safe-road': {
    id: 'gabis-safe-road',
    label: "Gabi's Safe Road",
    shortLabel: 'Safe Road',
    summary: 'Protected cycleways and quiet residential streets, avoids fast traffic.',
  },
  'gabis-lite-gravel': {
    id: 'gabis-lite-gravel',
    label: "Gabi's Lite Gravel",
    shortLabel: 'Lite Gravel',
    summary: 'Quiet lanes mixed with compact gravel tracks and towpaths.',
  },
  'fastbike-lowtraffic': {
    id: 'fastbike-lowtraffic',
    label: 'BRouter Fastbike Low Traffic',
    shortLabel: 'BRouter Low Traffic',
    summary: 'Paved roads, avoids heavy traffic, balanced climbing.',
  },
  'fastbike-verylowtraffic': {
    id: 'fastbike-verylowtraffic',
    label: 'BRouter Fastbike Very Low Traffic',
    shortLabel: 'BRouter Very Low Traffic',
    summary: 'Quiet country lanes and backroads, strong traffic avoidance.',
  },
  fastbike: {
    id: 'fastbike',
    label: 'BRouter Fastbike',
    shortLabel: 'BRouter Fastbike',
    summary: 'Direct paved road routing for speed, allows busier roads.',
  },
  gravel: {
    id: 'gravel',
    label: 'BRouter Gravel',
    shortLabel: 'BRouter Gravel',
    summary: 'Prefers unpaved tracks, bridleways, and off-road trails.',
  },
  trekking: {
    id: 'trekking',
    label: 'BRouter Trekking',
    shortLabel: 'BRouter Trekking',
    summary: 'Touring and utility cycling on cycle paths and gentle gradients.',
  },
};

export const PROFILE_ORDER: BuiltinProfileName[] = [
  'gabis-fast-city',
  'gabis-safe-road',
  'gabis-lite-gravel',
  'fastbike-lowtraffic',
  'fastbike-verylowtraffic',
  'fastbike',
  'gravel',
  'trekking',
];

export interface LatLon {
  lat: number;
  lon: number;
  name?: string;
}

export interface AvoidArea {
  lat: number;
  lon: number;
  radius: number;
  weight?: number;
}

export const MAX_ROUTE_SLOTS = 3;
export const MAX_ROUTES = 3;
export const MAX_TOTAL_SLOTS = MAX_ROUTES * MAX_ROUTE_SLOTS;

export interface RouteSlotColor {
  id: string;
  line: string;
  casing: string;
  soft: string;
  name: string;
}

export const ROUTE_COLOR_PALETTE: readonly RouteSlotColor[] = [
  { id: 'blue', line: '#2563eb', casing: '#1e3a8a', soft: 'rgba(37, 99, 235, 0.14)', name: 'Blue' },
  { id: 'magenta', line: '#db2777', casing: '#831843', soft: 'rgba(219, 39, 119, 0.14)', name: 'Magenta' },
  { id: 'orange', line: '#ea580c', casing: '#7c2d12', soft: 'rgba(234, 88, 12, 0.14)', name: 'Orange' },
  { id: 'red', line: '#dc2626', casing: '#7f1d1d', soft: 'rgba(220, 38, 38, 0.14)', name: 'Red' },
  { id: 'emerald', line: '#059669', casing: '#064e3b', soft: 'rgba(5, 150, 105, 0.14)', name: 'Emerald' },
  { id: 'cyan', line: '#0891b2', casing: '#164e63', soft: 'rgba(8, 145, 178, 0.14)', name: 'Cyan' },
  { id: 'violet', line: '#7c3aed', casing: '#4c1d95', soft: 'rgba(124, 58, 237, 0.14)', name: 'Violet' },
  { id: 'slate', line: '#1e293b', casing: '#0f172a', soft: 'rgba(30, 41, 59, 0.14)', name: 'Charcoal' },
] as const;

export const ROUTE_SLOT_COLORS = ROUTE_COLOR_PALETTE.slice(0, MAX_ROUTE_SLOTS);

export interface RouteSlotState {
  routeIdx?: number;
  profile: ProfileName;
  waypoints: LatLon[];
  avoidAreas: AvoidArea[];
  alternativeIdx: number;
  route: GeoJSON.FeatureCollection | null;
  isRouting: boolean;
  colorId?: string;
}

export function getSlotColor(
  slot: Pick<RouteSlotState, 'colorId'> | undefined,
  slotIdx: number,
): RouteSlotColor {
  if (slot?.colorId) {
    const found = ROUTE_COLOR_PALETTE.find((c) => c.id === slot.colorId);
    if (found) return found;
  }
  return ROUTE_COLOR_PALETTE[slotIdx % ROUTE_COLOR_PALETTE.length] || ROUTE_COLOR_PALETTE[0];
}

export interface RouteRequest {
  waypoints: LatLon[];
  profile: ProfileName;
  alternativeIdx?: number;
  nogos?: AvoidArea[];
}

export interface RouteResponse {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties: {
      'track-length': string;
      'total-time': string;
      cost: string;
      'filtered ascend': string;
      [key: string]: unknown;
    };
    geometry: {
      type: 'LineString';
      coordinates: number[][];
    };
  }>;
}

export interface ImportGpxRequest {
  gpxXml: string;
  profile: ProfileName;
  toleranceM?: number;
}

export interface ImportGpxResponse {
  waypoints: LatLon[];
  route: RouteResponse;
}

export interface PointWayInfo {
  distance_m: number;
  highway: string;
  surface: string;
  noise_class: number;
  traffic_class: number;
  maxspeed: number;
  town_class?: number;
  lit?: boolean;
  sidewalk?: boolean;
}

export interface RobustnessProbeWorkerRequest {
  waypoints: LatLon[];
  nogos?: AvoidArea[];
  probe: RobustnessProbeSpec;
}

export type WorkerPhase = 'idle' | 'downloading' | 'calculating';

export type WorkerMessage =
  | { type: 'INIT'; wasmModule?: WebAssembly.Module }
  | { type: 'WORKER_PHASE'; phase: WorkerPhase }
  | { type: 'LOAD_CUSTOM_PROFILE'; id?: string; name: string; content: string }
  | { type: 'REMOVE_CUSTOM_PROFILE'; name: string }
  | { type: 'CUSTOM_PROFILE_LOADED'; id?: string; name: string; ok: boolean; error?: string }
  | { type: 'ROUTE_REQUEST'; id: string; slotIdx?: number; payload: RouteRequest }
  | { type: 'ROUTE_SUCCESS'; id: string; slotIdx?: number; payload: RouteResponse }
  | { type: 'IMPORT_GPX_REQUEST'; id: string; payload: ImportGpxRequest }
  | { type: 'IMPORT_GPX_SUCCESS'; id: string; payload: ImportGpxResponse }
  | { type: 'MATCH_WAYPOINTS_REQUEST'; id: string; payload: ImportGpxRequest }
  | { type: 'MATCH_WAYPOINTS_SUCCESS'; id: string; waypoints: LatLon[] | null; error?: string }
  | { type: 'INSPECT_POINT_REQUEST'; id: string; lon: number; lat: number; maxDistanceM?: number }
  | { type: 'INSPECT_POINT_SUCCESS'; id: string; payload: PointWayInfo | null }
  | { type: 'ROBUSTNESS_PROBE_REQUEST'; id: string; payload: RobustnessProbeWorkerRequest }
  | {
      type: 'ROBUSTNESS_PROBE_RESULT';
      id: string;
      probeResult?: RobustnessProbeResult;
    }
  | { type: 'ROBUSTNESS_ERROR'; id: string; error: string }
  | { type: 'ROUTE_ERROR'; id: string; slotIdx?: number; error: string }
  | { type: 'STATUS'; message: string }
  | { type: 'CLEAR_GRAPH' }
  | { type: 'SET_OFFLINE_MODE'; offline: boolean };

export const AVOID_RADIUS_PRESETS = [50, 100, 250, 500];

export function waypointKind(i: number, n: number): 'start' | 'end' | 'via' {
  if (i === 0) return 'start';
  return i === n - 1 ? 'end' : 'via';
}

export function waypointLabel(i: number, n: number): string {
  const kind = waypointKind(i, n);
  return kind === 'start' ? 'A' : kind === 'end' ? 'B' : String(i);
}

