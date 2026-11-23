import type { LatLon } from '../types.ts';
import { buildProfile, haversine, nearestIndex, type Profile } from './geo.ts';

export type RouteWarningKind =
  | 'dismount'
  | 'dangerous_road'
  | 'dangerous_junction'
  | 'road_tunnel'
  | 'rollback'
  | 'ferry_ford'
  | 'steps_barrier';

export interface RouteWarningMeta {
  label: string;
  shortLabel: string;
  color: string;
  badgeBg: string;
  description: string;
}

export const WARNING_COLOR_YELLOW = '#eab308';
export const WARNING_BG_YELLOW = 'rgba(234, 179, 8, 0.16)';
export const PROHIBITION_COLOR_RED = '#ef4444';
export const PROHIBITION_BG_RED = 'rgba(239, 68, 68, 0.16)';

export const WARNING_META: Record<RouteWarningKind, RouteWarningMeta> = {
  dismount: {
    label: 'Dismount / No Cycling',
    shortLabel: 'Dismount',
    color: PROHIBITION_COLOR_RED,
    badgeBg: PROHIBITION_BG_RED,
    description: 'Footways, pedestrian zones, wrong-way one-way streets, or ways where cycling is not permitted.',
  },
  dangerous_road: {
    label: 'Dangerous / High-Speed Road',
    shortLabel: 'High-Speed Road',
    color: WARNING_COLOR_YELLOW,
    badgeBg: WARNING_BG_YELLOW,
    description: 'Motorways, non-urban trunk A-roads, or high-speed roads with heavy traffic and no cycleway.',
  },
  dangerous_junction: {
    label: 'Dangerous / Busy Road Crossing',
    shortLabel: 'Dangerous Junction',
    color: WARNING_COLOR_YELLOW,
    badgeBg: WARNING_BG_YELLOW,
    description: 'Uncontrolled crossings or entries onto fast or heavy-traffic roads from a minor street, cycleway, or path.',
  },
  road_tunnel: {
    label: 'Road Tunnel',
    shortLabel: 'Road Tunnel',
    color: WARNING_COLOR_YELLOW,
    badgeBg: WARNING_BG_YELLOW,
    description: 'Motor road tunnels without separated cycle infrastructure.',
  },
  rollback: {
    label: 'Short Rollback / U-Turn',
    shortLabel: 'Rollback',
    color: WARNING_COLOR_YELLOW,
    badgeBg: WARNING_BG_YELLOW,
    description: 'Out-and-back retraced spurs, often caused by a waypoint placed slightly off the main road.',
  },
  ferry_ford: {
    label: 'Ferry / Ford Crossing',
    shortLabel: 'Ferry / Ford',
    color: WARNING_COLOR_YELLOW,
    badgeBg: WARNING_BG_YELLOW,
    description: 'Ferry boat crossings or water fords along the route.',
  },
  steps_barrier: {
    label: 'Steps / Barrier',
    shortLabel: 'Steps / Barrier',
    color: WARNING_COLOR_YELLOW,
    badgeBg: WARNING_BG_YELLOW,
    description: 'Stairs, stiles, kissing gates, or barriers requiring dismounting or carrying the bike.',
  },
};

export const WARNING_KIND_ORDER: RouteWarningKind[] = [
  'rollback',
  'dangerous_road',
  'dangerous_junction',
  'road_tunnel',
  'dismount',
  'steps_barrier',
  'ferry_ford',
];

export interface RouteWarningItem {
  id: string;
  kind: RouteWarningKind;
  label: string;
  detail: string;
  from: number;
  to: number;
  distanceM: number;
  lon: number;
  lat: number;
  coordinates: number[][];
  color: string;
  badgeBg: string;
  isProhibition: boolean;
  waypointIndex?: number;
}

function parseKv(kv: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!kv) return map;
  for (const token of kv.split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq > 0) {
      map.set(token.slice(0, eq), token.slice(eq + 1));
    }
  }
  return map;
}

function hasCycleOrBusInfra(way: Map<string, string>): boolean {
  for (const k of ['cycleway', 'cycleway:left', 'cycleway:right', 'cycleway:both']) {
    const v = way.get(k);
    if (v && v !== 'no' && v !== 'none' && v !== 'unknown') return true;
  }
  for (const k of ['busway', 'busway:left', 'busway:right']) {
    const v = way.get(k);
    if (v === 'lane' || v === 'yes') return true;
  }
  if (way.get('bicycle') === 'designated' || way.get('bicycle_road') === 'yes' || way.get('cyclestreet') === 'yes') {
    return true;
  }
  return false;
}

function hasSeparatedCycleTrack(way: Map<string, string>): boolean {
  for (const k of ['cycleway', 'cycleway:left', 'cycleway:right', 'cycleway:both']) {
    const v = way.get(k);
    if (v === 'track' || v === 'separate' || v === 'opposite_track') return true;
  }
  return false;
}

function isWrongWayOneway(way: Map<string, string>): boolean {
  const isRev = way.get('reversedirection') === 'yes';
  const oneway = way.get('oneway') || '';
  const onewayBike = way.get('oneway:bicycle') || '';

  let badOneway = false;
  if (isRev) {
    if (onewayBike === 'yes') {
      badOneway = true;
    } else if (!oneway) {
      badOneway = way.get('junction') === 'roundabout';
    } else {
      badOneway = oneway === 'yes' || oneway === 'true' || oneway === '1';
    }
  } else {
    badOneway = oneway === '-1';
  }

  if (!badOneway) return false;
  if (onewayBike === 'no') return false;
  if (isRev && ['yes', 'designated'].includes(way.get('bicycle:backward') || '')) return false;

  for (const k of ['cycleway', 'cycleway:left', 'cycleway:right']) {
    const v = way.get(k) || '';
    if (v === 'opposite' || v === 'opposite_lane' || v === 'opposite_track') return false;
  }
  if (
    ['no', '-1'].includes(way.get('cycleway:left:oneway') || '') ||
    ['no', '-1'].includes(way.get('cycleway:right:oneway') || '')
  ) {
    return false;
  }

  return true;
}

function parseMaxspeedKmh(way: Map<string, string>): number {
  const isRev = way.get('reversedirection') === 'yes';
  const raw =
    (isRev ? way.get('maxspeed:backward') : way.get('maxspeed:forward')) ||
    way.get('maxspeed') ||
    way.get('zone:maxspeed') ||
    '';
  if (raw === 'urban') return 50;
  if (raw === 'rural') return 100;
  const num = parseFloat(raw);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function sliceProfileCoords(profile: Profile, fromM: number, toM: number): number[][] {
  if (profile.coords.length < 2) return [];
  let i0 = nearestIndex(profile.dist, fromM);
  let i1 = nearestIndex(profile.dist, toM);
  if (i1 <= i0) {
    if (i0 < profile.coords.length - 1) {
      i1 = i0 + 1;
    } else {
      i0 = Math.max(0, profile.coords.length - 2);
      i1 = profile.coords.length - 1;
    }
  }
  return profile.coords.slice(i0, i1 + 1).map((pt) => [pt[0], pt[1]]);
}

function pointAtDistance(profile: Profile, distM: number): { lon: number; lat: number } {
  if (profile.coords.length === 0) return { lon: 0, lat: 0 };
  const idx = nearestIndex(profile.dist, distM);
  const pt = profile.coords[idx] || profile.coords[0];
  return { lon: pt[0], lat: pt[1] };
}

/**
 * Point-to-segment distance in meters using local equirectangular projection.
 */
function pointToSegmentDistMeters(
  pLon: number,
  pLat: number,
  aLon: number,
  aLat: number,
  bLon: number,
  bLat: number,
): number {
  const cosLat = Math.cos(((pLat + aLat) * 0.5 * Math.PI) / 180);
  const mPerDegLat = 111132.0;
  const mPerDegLon = 111319.5 * cosLat;

  const px = (pLon - aLon) * mPerDegLon;
  const py = (pLat - aLat) * mPerDegLat;
  const bx = (bLon - aLon) * mPerDegLon;
  const by = (bLat - aLat) * mPerDegLat;

  const lenSq = bx * bx + by * by;
  const t = lenSq > 1e-6 ? Math.max(0, Math.min(1, (px * bx + py * by) / lenSq)) : 0;
  const dx = px - t * bx;
  const dy = py - t * by;
  return Math.hypot(dx, dy);
}

/**
 * Detects short out-and-back retraced spurs (rollbacks) along the route polyline.
 */
function detectRollbacks(profile: Profile, waypoints?: LatLon[]): RouteWarningItem[] {
  const results: RouteWarningItem[] = [];
  const coords = profile.coords;
  const dist = profile.dist;
  const n = coords.length;
  if (n < 3) return results;

  const MAX_SPUR_M = 400;
  const MIN_SPUR_M = 15;
  const CORRIDOR_TOLERANCE_M = 7;

  let p = 1;
  while (p < n - 1) {
    // Check if vertex p is a sharp turnaround (coords[p-1] -> coords[p] -> coords[p+1])
    const prev = coords[p - 1];
    const curr = coords[p];
    const next = coords[p + 1];

    const cosLat = Math.cos((curr[1] * Math.PI) / 180);
    const v1x = (curr[0] - prev[0]) * cosLat;
    const v1y = curr[1] - prev[1];
    const v2x = (next[0] - curr[0]) * cosLat;
    const v2y = next[1] - curr[1];
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);

    let isSharpTurn = false;
    if (l1 > 1e-7 && l2 > 1e-7) {
      const dot = (v1x * v2x + v1y * v2y) / (l1 * l2);
      if (dot < -0.95) {
        // Turn angle > ~162° (true U-turn)
        isSharpTurn = true;
      }
    }
    if (!isSharpTurn && p < n - 2) {
      // Also check 2-step U-turn (e.g. across dual carriageway or small T-junction head)
      const next2 = coords[p + 2];
      const stepDist = haversine(curr[1], curr[0], next[1], next[0]);
      if (stepDist <= 10) {
        const v3x = (next2[0] - next[0]) * cosLat;
        const v3y = next2[1] - next[1];
        const l3 = Math.hypot(v3x, v3y);
        if (l1 > 1e-7 && l3 > 1e-7) {
          const dot2 = (v1x * v3x + v1y * v3y) / (l1 * l3);
          if (dot2 < -0.95) {
            isSharpTurn = true;
          }
        }
      }
    }

    if (!isSharpTurn) {
      p++;
      continue;
    }

    // Walk backward from p and forward from p while both arms stay within CORRIDOR_TOLERANCE_M
    let i = p - 1;
    let j = p + 1;
    let bestI = p;
    let bestJ = p;

    while (i >= 0 && j < n) {
      const backStepDist = dist[p] - dist[i];
      const foreStepDist = dist[j] - dist[p];
      if (backStepDist > MAX_SPUR_M || foreStepDist > MAX_SPUR_M) break;

      // Distance between coords[i] and segment (coords[j-1], coords[j]) or coords[j] and (coords[i], coords[i+1])
      const dBackToFore = pointToSegmentDistMeters(
        coords[i][0],
        coords[i][1],
        coords[j - 1][0],
        coords[j - 1][1],
        coords[j][0],
        coords[j][1],
      );
      const dForeToBack = pointToSegmentDistMeters(
        coords[j][0],
        coords[j][1],
        coords[i][0],
        coords[i][1],
        coords[i + 1][0],
        coords[i + 1][1],
      );
      const sep = Math.min(
        dBackToFore,
        dForeToBack,
        haversine(coords[i][1], coords[i][0], coords[j][1], coords[j][0]),
      );

      if (sep <= CORRIDOR_TOLERANCE_M) {
        bestI = i;
        bestJ = j;
        if (backStepDist <= foreStepDist && i > 0) {
          i--;
        } else if (j < n - 1) {
          j++;
        } else {
          break;
        }
      } else {
        // Try advancing the shorter arm by one vertex in case one side has an extra intermediate node
        if (backStepDist < foreStepDist && i > 0) {
          const sepNextI = pointToSegmentDistMeters(
            coords[i - 1][0],
            coords[i - 1][1],
            coords[j - 1][0],
            coords[j - 1][1],
            coords[j][0],
            coords[j][1],
          );
          if (sepNextI <= CORRIDOR_TOLERANCE_M) {
            i--;
            continue;
          }
        } else if (foreStepDist < backStepDist && j < n - 1) {
          const sepNextJ = pointToSegmentDistMeters(
            coords[j + 1][0],
            coords[j + 1][1],
            coords[i][0],
            coords[i][1],
            coords[i + 1][0],
            coords[i + 1][1],
          );
          if (sepNextJ <= CORRIDOR_TOLERANCE_M) {
            j++;
            continue;
          }
        }
        break;
      }
    }

    const spurIn = dist[p] - dist[bestI];
    const spurOut = dist[bestJ] - dist[p];
    const spurDepth = Math.min(spurIn, spurOut);

    if (spurDepth >= MIN_SPUR_M && spurDepth <= MAX_SPUR_M) {
      const fromM = dist[bestI];
      const toM = dist[bestJ];
      const totalRetracedM = Math.max(1, Math.round(toM - fromM));
      const tipLon = coords[p][0];
      const tipLat = coords[p][1];

      let matchedViaIdx: number | undefined;
      if (waypoints && waypoints.length > 2) {
        let bestWpDist = 65;
        for (let wIdx = 1; wIdx < waypoints.length - 1; wIdx++) {
          const d = haversine(tipLat, tipLon, waypoints[wIdx].lat, waypoints[wIdx].lon);
          if (d < bestWpDist) {
            bestWpDist = d;
            matchedViaIdx = wIdx;
          }
        }
      }

      results.push({
        id: `rollback-${Math.round(fromM)}`,
        kind: 'rollback',
        label: WARNING_META.rollback.shortLabel,
        detail:
          matchedViaIdx !== undefined
            ? `U-turn spur at Waypoint ${matchedViaIdx} (${Math.round(spurDepth)} m detour)`
            : `U-turn rollback (${Math.round(spurDepth)} m spur)`,
        from: fromM,
        to: toM,
        distanceM: totalRetracedM,
        lon: tipLon,
        lat: tipLat,
        coordinates: sliceProfileCoords(profile, fromM, toM),
        color: WARNING_COLOR_YELLOW,
        badgeBg: WARNING_BG_YELLOW,
        isProhibition: false,
        waypointIndex: matchedViaIdx,
      });

      p = bestJ + 1;
    } else {
      p++;
    }
  }

  return results;
}

const LOW_PRIO_HIGHWAYS = new Set([
  'residential',
  'living_street',
  'unclassified',
  'service',
  'cycleway',
  'path',
  'footway',
  'bridleway',
  'track',
  'pedestrian',
  'steps',
  'road',
]);

const MOTOR_ROAD_HIGHWAYS = new Set([
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service',
]);

interface RawTagWarning {
  kind: RouteWarningKind;
  detail: string;
  from: number;
  to: number;
  isProhibition: boolean;
  isCrossingFootway?: boolean;
}

/**
 * Analyses a computed BRouter GeoJSON route and returns all warnings along the route,
 * ordered by distance from start.
 */
export function extractRouteWarnings(
  route: GeoJSON.FeatureCollection | null,
  waypoints?: LatLon[],
): RouteWarningItem[] {
  if (!route || !route.features || route.features.length === 0) return [];
  const feat = route.features[0];
  const geom = feat.geometry as GeoJSON.LineString | undefined;
  if (!geom || !Array.isArray(geom.coordinates) || geom.coordinates.length < 2) return [];

  const profile = buildProfile(geom.coordinates);
  const props = (feat.properties || {}) as Record<string, any>;
  const messages: unknown[][] = Array.isArray(props.messages) ? props.messages : [];

  const rawWarnings: RawTagWarning[] = [];
  let cumDist = 0;

  // 1. Inspect BRouter per-way / per-node messages (row 0 is header)
  for (let i = 1; i < messages.length; i++) {
    const row = messages[i];
    if (!Array.isArray(row) || row.length < 11) continue;

    const segLen = Math.max(0, Number(row[3]) || 0);
    const fromM = cumDist;
    const toM = cumDist + segLen;
    cumDist = toM;

    const nodeCost = Number(row[7]) || 0;
    const wayKv = String(row[9] || '');
    const nodeKv = String(row[10] || '');

    const way = parseKv(wayKv);
    const node = parseKv(nodeKv);
    const hw = (way.get('highway') || '').toLowerCase();
    const bike = (way.get('bicycle') || '').toLowerCase();
    const access = (way.get('access') || '').toLowerCase();

    // Check node-level barrier / ford at the end of this segment
    const nodeBarrier = (node.get('barrier') || '').toLowerCase();
    const nodeBike = (node.get('bicycle') || '').toLowerCase();
    if (
      nodeBarrier &&
      ([
        'stile',
        'kissing_gate',
        'turnstile',
        'full-height_turnstile',
        'horse_stile',
        'log',
        'chain',
      ].includes(nodeBarrier) ||
        nodeCost >= 100 ||
        nodeBike === 'no' ||
        nodeBike === 'dismount')
    ) {
      const bFrom = Math.max(0, toM - Math.min(segLen, 10));
      rawWarnings.push({
        kind: 'steps_barrier',
        detail: `Barrier (${nodeBarrier.replace(/_/g, ' ')})`,
        from: bFrom,
        to: Math.max(bFrom + 5, toM),
        isProhibition: false,
      });
    } else if (node.get('ford') && node.get('ford') !== 'no') {
      const fFrom = Math.max(0, toM - Math.min(segLen, 10));
      rawWarnings.push({
        kind: 'ferry_ford',
        detail: 'Ford water crossing',
        from: fFrom,
        to: Math.max(fFrom + 5, toM),
        isProhibition: false,
      });
    }

    // Check uncontrolled high-risk road crossings (estimated_crossing_class >= 6) from a minor road or path
    const crossingClass = Number(node.get('estimated_crossing_class') || 0);
    const isLowPrioWay = LOW_PRIO_HIGHWAYS.has(hw) || way.get('living_street') === 'yes';
    if (
      crossingClass >= 6 &&
      isLowPrioWay &&
      node.get('highway') !== 'traffic_signals' &&
      node.get('crossing') !== 'traffic_signals'
    ) {
      const jFrom = Math.max(0, toM - Math.min(segLen, 10));
      rawWarnings.push({
        kind: 'dangerous_junction',
        detail: `Uncontrolled high-speed road crossing (Class ${crossingClass})`,
        from: jFrom,
        to: Math.max(jFrom + 5, toM),
        isProhibition: false,
      });
    }

    if (segLen <= 0) continue;

    // A. Ferry / Ford
    if (way.get('route') === 'ferry') {
      rawWarnings.push({
        kind: 'ferry_ford',
        detail: 'Ferry crossing',
        from: fromM,
        to: toM,
        isProhibition: false,
      });
      continue;
    }
    if (way.get('ford') && way.get('ford') !== 'no') {
      rawWarnings.push({
        kind: 'ferry_ford',
        detail: 'Ford water crossing',
        from: fromM,
        to: toM,
        isProhibition: false,
      });
      continue;
    }

    // B. Steps
    if (hw === 'steps') {
      rawWarnings.push({
        kind: 'steps_barrier',
        detail: 'Steps / stairs (carry bike)',
        from: fromM,
        to: toM,
        isProhibition: false,
      });
      continue;
    }

    // C. Road Tunnels & High-Speed Roads
    if (way.get('tunnel') === 'yes' && MOTOR_ROAD_HIGHWAYS.has(hw) && !hasSeparatedCycleTrack(way)) {
      rawWarnings.push({
        kind: 'road_tunnel',
        detail:
          bike === 'unknown'
            ? 'Road tunnel (cycling discouraged / no cycleway)'
            : 'Motor road tunnel without cycleway',
        from: fromM,
        to: toM,
        isProhibition: bike === 'unknown',
      });
      if (segLen >= 50 || bike === 'unknown') {
        continue;
      }
    }

    if (hw === 'motorway' || hw === 'motorway_link' || way.get('motorroad') === 'yes') {
      rawWarnings.push({
        kind: 'dangerous_road',
        detail: 'Motorway / motorroad (cycling prohibited)',
        from: fromM,
        to: toM,
        isProhibition: true,
      });
      continue;
    }

    const maxspeedKmh = parseMaxspeedKmh(way);
    const trafficClass = Number(way.get('estimated_traffic_class') || 0);

    if ((hw === 'trunk' || hw === 'trunk_link') && !hasSeparatedCycleTrack(way)) {
      const isLitUrban =
        way.get('lit') === 'yes' && maxspeedKmh > 0 && maxspeedKmh <= 50;
      if (!isLitUrban) {
        const mph = maxspeedKmh > 0 ? Math.round((maxspeedKmh * 0.621371) / 5) * 5 : 0;
        rawWarnings.push({
          kind: 'dangerous_road',
          detail: mph >= 40 ? `High-speed trunk A-road (${mph} mph)` : 'Non-urban trunk A-road',
          from: fromM,
          to: toM,
          isProhibition: false,
        });
        continue;
      }
    }

    if (
      (hw === 'primary' || hw === 'primary_link' || hw === 'secondary' || hw === 'secondary_link') &&
      !hasCycleOrBusInfra(way) &&
      ((maxspeedKmh >= 80 && trafficClass >= 5) || trafficClass >= 6)
    ) {
      const mph = maxspeedKmh > 0 ? Math.round((maxspeedKmh * 0.621371) / 5) * 5 : 0;
      rawWarnings.push({
        kind: 'dangerous_road',
        detail:
          mph >= 50
            ? `Fast busy road (${mph} mph, no cycleway)`
            : 'Heavy traffic road without cycleway',
        from: fromM,
        to: toM,
        isProhibition: false,
      });
      continue;
    }

    // D. Dismount / Cycling Not Allowed
    if (bike === 'dismount') {
      rawWarnings.push({
        kind: 'dismount',
        detail: 'Dismount required (bicycle=dismount)',
        from: fromM,
        to: toM,
        isProhibition: true,
      });
      continue;
    }
    if (bike === 'no' || bike === 'private' || bike === 'use_sidepath') {
      rawWarnings.push({
        kind: 'dismount',
        detail: `Cycling not allowed (bicycle=${bike})`,
        from: fromM,
        to: toM,
        isProhibition: true,
      });
      continue;
    }
    if (
      (access === 'no' || access === 'private') &&
      !['yes', 'designated', 'permissive', 'official'].includes(bike)
    ) {
      rawWarnings.push({
        kind: 'dismount',
        detail: `Restricted access (access=${access})`,
        from: fromM,
        to: toM,
        isProhibition: true,
      });
      continue;
    }
    if (isWrongWayOneway(way)) {
      rawWarnings.push({
        kind: 'dismount',
        detail: 'Wrong-way on one-way street (walk bike)',
        from: fromM,
        to: toM,
        isProhibition: true,
      });
      continue;
    }
    if (
      (hw === 'footway' || hw === 'pedestrian') &&
      !['yes', 'designated', 'permissive', 'official'].includes(bike) &&
      way.get('bicycle_road') !== 'yes'
    ) {
      rawWarnings.push({
        kind: 'dismount',
        detail: hw === 'pedestrian' ? 'Pedestrian zone (no cycling)' : 'Footway / sidewalk (dismount)',
        from: fromM,
        to: toM,
        isProhibition: true,
        isCrossingFootway: way.get('footway') === 'crossing',
      });
    }
  }

  // 1a. Merge immediately adjacent raw warnings (<= 15 m) of the same kind and prohibition status
  const mergedRaw: RawTagWarning[] = [];
  for (const w of rawWarnings) {
    const prev = mergedRaw[mergedRaw.length - 1];
    if (prev && prev.kind === w.kind && prev.isProhibition === w.isProhibition && w.from - prev.to <= 15) {
      prev.to = Math.max(prev.to, w.to);
      if (prev.isCrossingFootway && !w.isCrossingFootway) {
        prev.isCrossingFootway = false;
        prev.detail = w.detail;
      }
    } else {
      mergedRaw.push({ ...w });
    }
  }

  // 1b. Filter out short crossings/junctions before grouping longer road corridors
  const surviving: Array<RawTagWarning & { flaggedLen: number }> = [];
  for (const w of mergedRaw) {
    const len = Math.max(0, Math.round(w.to - w.from));
    // Skip short (< 20 m) footways/crossings so normal road crossings and kerb connectors do not spam warnings
    if (w.kind === 'dismount' && len < 20) {
      continue;
    }
    // Skip short (< 100 m) busy/trunk road segments (junctions, roundabouts, crossings) unless it is a motorway prohibition
    if (w.kind === 'dangerous_road' && !w.isProhibition && len < 100) {
      continue;
    }
    // Skip short (< 50 m) bridge underpasses on motor roads unless cycling is discouraged
    if (w.kind === 'road_tunnel' && !w.isProhibition && len < 50) {
      continue;
    }

    // 1c. Merge consecutive dangerous_road warnings of the same type across gaps up to 500 m
    // (e.g., short bus lanes or junctions interrupting the same busy arterial road).
    let mergedIntoExisting = false;
    if (w.kind === 'dangerous_road' && !w.isProhibition) {
      for (let k = surviving.length - 1; k >= 0; k--) {
        const prev = surviving[k];
        if (w.from - prev.to > 500) break;
        if (
          prev.kind === 'dangerous_road' &&
          !prev.isProhibition &&
          prev.detail === w.detail
        ) {
          prev.to = Math.max(prev.to, w.to);
          prev.flaggedLen += len;
          mergedIntoExisting = true;
          break;
        }
      }
    }
    if (!mergedIntoExisting) {
      surviving.push({ ...w, flaggedLen: len });
    }
  }

  const items: RouteWarningItem[] = [];
  for (const w of surviving) {
    const midDist = (w.from + w.to) * 0.5;
    const midPt = pointAtDistance(profile, midDist);
    items.push({
      id: `${w.kind}-${Math.round(w.from)}`,
      kind: w.kind,
      label: WARNING_META[w.kind].shortLabel,
      detail: w.detail,
      from: w.from,
      to: w.to,
      distanceM: Math.max(1, w.flaggedLen),
      lon: midPt.lon,
      lat: midPt.lat,
      coordinates: sliceProfileCoords(profile, w.from, w.to),
      color: w.isProhibition ? PROHIBITION_COLOR_RED : WARNING_COLOR_YELLOW,
      badgeBg: w.isProhibition ? PROHIBITION_BG_RED : WARNING_BG_YELLOW,
      isProhibition: w.isProhibition,
    });
  }

  // 2. Geometric Rollback Detection
  const rollbacks = detectRollbacks(profile, waypoints);
  items.push(...rollbacks);

  items.sort((a, b) => a.from - b.from);
  return items;
}

/**
 * Returns an inline SVG icon string for a route warning kind.
 */
export function warningKindSvg(kind: RouteWarningKind, size = 12): string {
  const attrs = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
  switch (kind) {
    case 'rollback':
      return `<svg ${attrs}><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>`;
    case 'dangerous_road':
      return `<svg ${attrs}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
    case 'dangerous_junction':
      return `<svg ${attrs}><path d="M12 3v18"/><path d="M3 12h18"/><path d="M8 7l4-4 4 4"/><path d="M17 8l4 4-4 4"/></svg>`;
    case 'road_tunnel':
      return `<svg ${attrs}><path d="M4 20V11a8 8 0 0 1 16 0v9"/><line x1="2" y1="20" x2="22" y2="20"/><line x1="12" y1="12" x2="12" y2="16"/></svg>`;
    case 'dismount':
      return `<svg ${attrs}><circle cx="12" cy="12" r="9"/><line x1="5.7" y1="5.7" x2="18.3" y2="18.3"/></svg>`;
    case 'steps_barrier':
      return `<svg ${attrs}><path d="M4 20h4v-4h4v-4h4V8h4"/></svg>`;
    case 'ferry_ford':
      return `<svg ${attrs}><path d="M2 18c2 0 3-2 5-2s3 2 5 2 3-2 5-2 3 2 5 2"/><path d="M4 13l2-6h12l2 6"/></svg>`;
  }
}
