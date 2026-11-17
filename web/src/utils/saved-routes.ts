import type { AvoidArea, LatLon, ProfileName } from '../types.ts';
import { classifyRoadGroup, classifySurface, type SegmentData } from './classification.ts';
import { haversine } from './geo.ts';
import {
  generateBrfFromAxes,
  normalizeProfileAxes,
  TEMPLATE_PRESETS,
  type BaseTemplateId,
  type CustomProfileRecord,
} from './profile-editor.ts';
import {
  decodePolyline5,
  type LibraryRoute,
  type LibraryStop,
  type LibrarySurface,
} from './route-library.ts';

export const SAVED_ROUTES_STORAGE_KEY = 'rsrouter_saved_routes';
export const SAVED_ROUTE_ID_START = 1_000_001;
export const SAVED_ROUTES_BACKUP_FORMAT = 'rsrouter-saved-routes';
export const SAVED_ROUTES_BACKUP_VERSION = 1;
export const RDP_SIMPLIFY_TOLERANCE_M = 18.0;

const VALID_SURFACES = new Set<LibrarySurface>(['road', 'mixed', 'gravel', 'traffic-free']);

export interface SavedRouteRecord {
  id: number;
  name: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
  profile: ProfileName;
  customProfile?: CustomProfileRecord;
  waypoints: LatLon[];
  avoidAreas: AvoidArea[];
  alternativeIdx: number;
  km: number;
  asc: number;
  surf: LibrarySurface;
  loop: boolean;
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
  /** [lon, lat] */
  start: [number, number];
  reg: string;
  polyline5: string;
}

export interface SavedRoutesBackup {
  format: typeof SAVED_ROUTES_BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  routes: SavedRouteRecord[];
}

function encodeSigned(num: number): string {
  let s = num < 0 ? ~(num << 1) : num << 1;
  let out = '';
  while (s >= 0x20) {
    out += String.fromCharCode((0x20 | (s & 0x1f)) + 63);
    s >>>= 5;
  }
  out += String.fromCharCode(s + 63);
  return out;
}

/**
 * Encodes GeoJSON `[lon, lat][]` coordinates into Google Polyline5 (`lat, lon` scaled by 1e5).
 */
export function encodePolyline5(coords: ReadonlyArray<readonly [number, number]>): string {
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  for (const [lon, lat] of coords) {
    const ilat = Math.round(lat * 1e5);
    const ilon = Math.round(lon * 1e5);
    out += encodeSigned(ilat - prevLat);
    out += encodeSigned(ilon - prevLon);
    prevLat = ilat;
    prevLon = ilon;
  }
  return out;
}

/**
 * Simplifies `[lon, lat, ...][]` coordinates using iterative Ramer-Douglas-Peucker in local metres.
 */
export function rdpSimplifyLonLat(
  coords: ReadonlyArray<readonly number[]>,
  epsilonM = RDP_SIMPLIFY_TOLERANCE_M,
): [number, number][] {
  const n = coords.length;
  if (n <= 2) {
    return coords.map((pt) => [pt[0], pt[1]]);
  }

  const midLat = coords[Math.floor(n / 2)][1];
  const mPerDegLat = 111_320.0;
  const mPerDegLon = 111_320.0 * Math.cos((midLat * Math.PI) / 180);

  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = coords[i][0] * mPerDegLon;
    ys[i] = coords[i][1] * mPerDegLat;
  }

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const epsSq = epsilonM * epsilonM;
  const stack: Array<[number, number]> = [[0, n - 1]];

  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    if (end - start <= 1) continue;

    const x0 = xs[start];
    const y0 = ys[start];
    const dx = xs[end] - x0;
    const dy = ys[end] - y0;
    const segLenSq = dx * dx + dy * dy;

    let maxDistSq = -1;
    let maxIdx = -1;

    for (let i = start + 1; i < end; i++) {
      let t = 0;
      if (segLenSq > 1e-9) {
        t = ((xs[i] - x0) * dx + (ys[i] - y0) * dy) / segLenSq;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
      }
      const px = x0 + t * dx - xs[i];
      const py = y0 + t * dy - ys[i];
      const distSq = px * px + py * py;
      if (distSq > maxDistSq) {
        maxDistSq = distSq;
        maxIdx = i;
      }
    }

    if (maxDistSq > epsSq && maxIdx !== -1) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }

  const simplified: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i] === 1) {
      simplified.push([coords[i][0], coords[i][1]]);
    }
  }
  return simplified;
}

export function deriveSavedRouteSurface(segments: ReadonlyArray<SegmentData>): LibrarySurface {
  let totalLen = 0;
  let unpavedLen = 0;
  let pathLen = 0;

  for (const s of segments) {
    const len = Math.max(0, s.to - s.from);
    if (len <= 0) continue;
    totalLen += len;
    if (classifySurface(s.surface, s.highway) === 'unpaved') {
      unpavedLen += len;
    }
    if (classifyRoadGroup(s.highway) === 'cycleway_path') {
      pathLen += len;
    }
  }

  if (totalLen <= 0) return 'road';
  const unpavedShare = unpavedLen / totalLen;
  if (unpavedShare >= 0.35) return 'gravel';
  if (unpavedShare >= 0.1) return 'mixed';
  if (pathLen / totalLen >= 0.7) return 'traffic-free';
  return 'road';
}

export function isLoopCoordinates(
  coords: ReadonlyArray<readonly number[]>,
  distanceM: number,
): boolean {
  if (coords.length < 3 || distanceM < 1500) return false;
  const first = coords[0];
  const last = coords[coords.length - 1];
  return haversine(first[1], first[0], last[1], last[0]) <= 300;
}

function shortPlaceLabel(name?: string): string {
  if (!name) return '';
  const first = name.split(',')[0].trim();
  return first;
}

export function suggestSavedRouteName(
  waypoints: ReadonlyArray<LatLon>,
  isLoop: boolean,
  profileLabel: string,
): string {
  const startLabel = shortPlaceLabel(waypoints[0]?.name);
  const endLabel = shortPlaceLabel(waypoints[waypoints.length - 1]?.name);

  if (isLoop && startLabel) {
    const midVia = waypoints
      .slice(1, -1)
      .map((w) => shortPlaceLabel(w.name))
      .find((lbl) => lbl && lbl.toLowerCase() !== startLabel.toLowerCase());
    return midVia ? `${startLabel} via ${midVia} loop` : `${startLabel} loop`;
  }
  if (startLabel && endLabel && startLabel.toLowerCase() !== endLabel.toLowerCase()) {
    return `${startLabel} to ${endLabel}`;
  }
  if (startLabel) return `${startLabel} route`;
  if (endLabel) return `Route to ${endLabel}`;
  return `${profileLabel || 'Planned'} route`;
}

export function computeBoundsBox(
  coords: ReadonlyArray<readonly number[]>,
): [number, number, number, number] {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [
    Number(minLon.toFixed(5)),
    Number(minLat.toFixed(5)),
    Number(maxLon.toFixed(5)),
    Number(maxLat.toFixed(5)),
  ];
}

export function nextSavedRouteId(existing: ReadonlyArray<{ id: number }>): number {
  let maxId = SAVED_ROUTE_ID_START - 1;
  for (const r of existing) {
    if (Number.isInteger(r.id) && r.id > maxId) {
      maxId = r.id;
    }
  }
  return maxId + 1;
}

export interface BuildSavedRouteParams {
  id: number;
  createdAt?: number;
  now?: number;
  name: string;
  notes?: string;
  profile: ProfileName;
  profileLabel?: string;
  customProfile?: CustomProfileRecord;
  waypoints: ReadonlyArray<LatLon>;
  avoidAreas: ReadonlyArray<AvoidArea>;
  alternativeIdx: number;
  route: GeoJSON.FeatureCollection;
}

export function buildSavedRouteRecord(params: BuildSavedRouteParams): SavedRouteRecord {
  const feat = params.route.features?.[0];
  const geom = feat?.geometry as GeoJSON.LineString | undefined;
  const coords = geom?.coordinates;
  if (!coords || coords.length < 2) {
    throw new Error('Cannot save route: geometry has fewer than 2 coordinates');
  }
  if (params.waypoints.length < 2) {
    throw new Error('Cannot save route: at least 2 waypoints are required');
  }

  const props = (feat.properties || {}) as Record<string, unknown>;
  const distanceM = Number(props['track-length']) || 0;
  const ascendM = Math.max(0, Math.round(Number(props['filtered ascend']) || 0));
  const segments = (Array.isArray(props.segments) ? props.segments : []) as SegmentData[];

  const loop = isLoopCoordinates(coords, distanceM);
  const surf = deriveSavedRouteSurface(segments);
  const simplified = rdpSimplifyLonLat(coords, RDP_SIMPLIFY_TOLERANCE_M);
  const polyline5 = encodePolyline5(simplified);
  const bbox = computeBoundsBox(coords);
  const start: [number, number] = [
    Number(coords[0][0].toFixed(5)),
    Number(coords[0][1].toFixed(5)),
  ];

  const startPlace = shortPlaceLabel(params.waypoints[0]?.name);
  const reg = startPlace || `${start[1].toFixed(2)}, ${start[0].toFixed(2)}`;
  const trimmedName =
    params.name.trim() ||
    suggestSavedRouteName(params.waypoints, loop, params.profileLabel || params.profile);
  const trimmedNotes = params.notes?.trim() || undefined;
  const now = params.now ?? Date.now();

  return {
    id: params.id,
    name: trimmedName,
    notes: trimmedNotes,
    createdAt: params.createdAt ?? now,
    updatedAt: now,
    profile: params.profile,
    customProfile: params.customProfile ? { ...params.customProfile } : undefined,
    waypoints: params.waypoints.map((w) =>
      w.name ? { lat: w.lat, lon: w.lon, name: w.name } : { lat: w.lat, lon: w.lon },
    ),
    avoidAreas: params.avoidAreas.map((a) =>
      a.weight !== undefined
        ? { lat: a.lat, lon: a.lon, radius: a.radius, weight: a.weight }
        : { lat: a.lat, lon: a.lon, radius: a.radius },
    ),
    alternativeIdx: Math.max(0, Math.min(3, Math.trunc(params.alternativeIdx || 0))),
    km: Math.max(0.1, Math.round((distanceM / 1000) * 10) / 10),
    asc: ascendM,
    surf,
    loop,
    bbox,
    start,
    reg,
    polyline5,
  };
}

export function savedRouteToLibraryRoute(
  rec: SavedRouteRecord,
  profileLabel?: string,
): LibraryRoute {
  const stops: LibraryStop[] = [];
  rec.waypoints.forEach((w, idx) => {
    const label = shortPlaceLabel(w.name);
    if (!label) return;
    const role =
      idx === 0 ? 'start' : idx === rec.waypoints.length - 1 ? 'end' : `via ${idx}`;
    stops.push({
      name: label,
      role,
      pos: [w.lon, w.lat],
    });
  });

  return {
    id: rec.id,
    src: profileLabel || rec.profile,
    name: rec.name,
    km: rec.km,
    asc: rec.asc,
    loop: rec.loop,
    surf: rec.surf,
    reg: rec.reg,
    bbox: rec.bbox,
    start: rec.start,
    desc: rec.notes,
    stops: stops.length > 0 ? stops : undefined,
    updatedAt: rec.updatedAt,
  };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function savedRouteToGpx(rec: SavedRouteRecord): string {
  const coordinates = decodePolyline5(rec.polyline5);
  const nameXml = escapeXml(rec.name);
  const summary = `Distance: ${rec.km.toFixed(1)} km, Ascend: ${rec.asc} m`;
  const descText = rec.notes ? `${summary} | ${rec.notes}` : summary;

  const wptsXml = rec.waypoints
    .filter((w) => Boolean(w.name))
    .map(
      (w) =>
        `  <wpt lat="${w.lat.toFixed(5)}" lon="${w.lon.toFixed(5)}"><name>${escapeXml(w.name!)}</name></wpt>`,
    )
    .join('\n');

  const trkpts = coordinates
    .map(([lon, lat]) => `      <trkpt lat="${lat.toFixed(5)}" lon="${lon.toFixed(5)}"></trkpt>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="gabis-router"
  xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${nameXml}</name>
    <desc>${escapeXml(descText)}</desc>
  </metadata>${wptsXml ? `\n${wptsXml}` : ''}
  <trk>
    <name>${nameXml}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

function validLatLon(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

function normalizeCustomProfileSnapshot(raw: unknown): CustomProfileRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.id !== 'string' ||
    typeof obj.name !== 'string' ||
    typeof obj.dsl !== 'string' ||
    !obj.axes ||
    typeof obj.axes !== 'object'
  ) {
    throw new Error('Invalid customProfile in saved route');
  }
  const baseTemplate: BaseTemplateId =
    typeof obj.baseTemplate === 'string' && obj.baseTemplate in TEMPLATE_PRESETS
      ? (obj.baseTemplate as BaseTemplateId)
      : 'gabis-fast-city';
  const axes = normalizeProfileAxes(obj.axes as Partial<CustomProfileRecord['axes']>, baseTemplate);
  const mode = obj.mode === 'dsl' ? 'dsl' : 'detailed';
  const summary = typeof obj.summary === 'string' ? obj.summary : 'Custom cycling profile.';
  return {
    id: obj.id,
    name: obj.name,
    summary,
    baseTemplate,
    mode,
    axes,
    dsl: mode === 'dsl' ? obj.dsl : generateBrfFromAxes(axes, { name: obj.name, summary }),
    updatedAt: typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) ? obj.updatedAt : Date.now(),
  };
}

export function validateSavedRouteRecord(raw: unknown): SavedRouteRecord {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Saved route entry must be an object');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || !r.name.trim()) {
    throw new Error('Saved route is missing a valid name');
  }
  if (typeof r.profile !== 'string' || !r.profile.trim()) {
    throw new Error(`Saved route "${r.name}" is missing a profile`);
  }
  if (!Array.isArray(r.waypoints) || r.waypoints.length < 2) {
    throw new Error(`Saved route "${r.name}" must contain at least 2 waypoints`);
  }
  const waypoints: LatLon[] = r.waypoints.map((w: unknown) => {
    const wp = w as Record<string, unknown>;
    if (!wp || !validLatLon(wp.lat, wp.lon)) {
      throw new Error(`Saved route "${r.name}" contains an invalid waypoint coordinate`);
    }
    const name = typeof wp.name === 'string' && wp.name.trim() ? wp.name.trim() : undefined;
    return name ? { lat: wp.lat as number, lon: wp.lon as number, name } : { lat: wp.lat as number, lon: wp.lon as number };
  });

  const avoidAreas: AvoidArea[] = Array.isArray(r.avoidAreas)
    ? r.avoidAreas.map((a: unknown) => {
        const av = a as Record<string, unknown>;
        if (!av || !validLatLon(av.lat, av.lon) || typeof av.radius !== 'number' || av.radius <= 0) {
          throw new Error(`Saved route "${r.name}" contains an invalid avoid area`);
        }
        const weight =
          typeof av.weight === 'number' && Number.isFinite(av.weight) ? av.weight : undefined;
        return weight !== undefined
          ? { lat: av.lat as number, lon: av.lon as number, radius: av.radius, weight }
          : { lat: av.lat as number, lon: av.lon as number, radius: av.radius };
      })
    : [];

  if (typeof r.polyline5 !== 'string' || !r.polyline5) {
    throw new Error(`Saved route "${r.name}" is missing polyline5 track data`);
  }
  const decoded = decodePolyline5(r.polyline5);
  if (decoded.length < 2) {
    throw new Error(`Saved route "${r.name}" has fewer than 2 preview coordinates`);
  }

  const bbox =
    Array.isArray(r.bbox) &&
    r.bbox.length === 4 &&
    r.bbox.every((v) => typeof v === 'number' && Number.isFinite(v))
      ? (r.bbox as [number, number, number, number])
      : computeBoundsBox(decoded);

  const start: [number, number] =
    Array.isArray(r.start) &&
    r.start.length === 2 &&
    validLatLon(r.start[1], r.start[0])
      ? [r.start[0] as number, r.start[1] as number]
      : [decoded[0][0], decoded[0][1]];

  const surf: LibrarySurface =
    typeof r.surf === 'string' && VALID_SURFACES.has(r.surf as LibrarySurface)
      ? (r.surf as LibrarySurface)
      : 'road';

  const id =
    typeof r.id === 'number' && Number.isInteger(r.id) && r.id >= SAVED_ROUTE_ID_START
      ? r.id
      : SAVED_ROUTE_ID_START;

  const createdAt =
    typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : Date.now();
  const updatedAt =
    typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : createdAt;

  return {
    id,
    name: r.name.trim(),
    notes: typeof r.notes === 'string' && r.notes.trim() ? r.notes.trim() : undefined,
    createdAt,
    updatedAt,
    profile: r.profile as ProfileName,
    customProfile: normalizeCustomProfileSnapshot(r.customProfile),
    waypoints,
    avoidAreas,
    alternativeIdx:
      typeof r.alternativeIdx === 'number' && Number.isFinite(r.alternativeIdx)
        ? Math.max(0, Math.min(3, Math.trunc(r.alternativeIdx)))
        : 0,
    km: typeof r.km === 'number' && Number.isFinite(r.km) && r.km > 0 ? r.km : 0.1,
    asc: typeof r.asc === 'number' && Number.isFinite(r.asc) && r.asc >= 0 ? Math.round(r.asc) : 0,
    surf,
    loop: Boolean(r.loop),
    bbox,
    start,
    reg:
      typeof r.reg === 'string' && r.reg.trim()
        ? r.reg.trim()
        : shortPlaceLabel(waypoints[0]?.name) || `${start[1].toFixed(2)}, ${start[0].toFixed(2)}`,
    polyline5: r.polyline5,
  };
}

export function loadSavedRoutesFromStorage(
  storage: Pick<Storage, 'getItem'> | undefined = typeof localStorage !== 'undefined'
    ? localStorage
    : undefined,
): SavedRouteRecord[] {
  if (!storage) return [];
  const raw = storage.getItem(SAVED_ROUTES_STORAGE_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const valid: SavedRouteRecord[] = [];
  const usedIds = new Set<number>();
  let nextId = SAVED_ROUTE_ID_START;

  for (const item of parsed) {
    try {
      const rec = validateSavedRouteRecord(item);
      let id = rec.id;
      if (usedIds.has(id)) {
        while (usedIds.has(nextId)) nextId++;
        id = nextId;
      }
      usedIds.add(id);
      if (id >= nextId) nextId = id + 1;
      valid.push(id === rec.id ? rec : { ...rec, id });
    } catch {
      // Skip corrupted individual localStorage entries while preserving valid routes
    }
  }

  valid.sort((a, b) => b.updatedAt - a.updatedAt);
  return valid;
}

export function saveRoutesToStorage(
  routes: ReadonlyArray<SavedRouteRecord>,
  storage: Pick<Storage, 'setItem'> | undefined = typeof localStorage !== 'undefined'
    ? localStorage
    : undefined,
): void {
  if (!storage) return;
  storage.setItem(SAVED_ROUTES_STORAGE_KEY, JSON.stringify(routes));
}

export function serializeSavedRoutesBackup(
  routes: ReadonlyArray<SavedRouteRecord>,
  now = new Date(),
): string {
  const payload: SavedRoutesBackup = {
    format: SAVED_ROUTES_BACKUP_FORMAT,
    version: SAVED_ROUTES_BACKUP_VERSION,
    exportedAt: now.toISOString(),
    routes: [...routes],
  };
  return JSON.stringify(payload, null, 2);
}

export function parseSavedRoutesBackup(jsonText: string): SavedRouteRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('Backup file is not valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid backup format: expected a JSON backup object.');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.format !== SAVED_ROUTES_BACKUP_FORMAT) {
    throw new Error(`Unsupported backup format: expected "${SAVED_ROUTES_BACKUP_FORMAT}".`);
  }
  if (obj.version !== SAVED_ROUTES_BACKUP_VERSION) {
    throw new Error(`Unsupported backup version: ${String(obj.version)}.`);
  }
  if (!Array.isArray(obj.routes)) {
    throw new Error('Invalid backup file: "routes" must be an array.');
  }

  return obj.routes.map((entry) => validateSavedRouteRecord(entry));
}

export function mergeImportedSavedRoutes(
  existing: ReadonlyArray<SavedRouteRecord>,
  incoming: ReadonlyArray<SavedRouteRecord>,
): { merged: SavedRouteRecord[]; addedCount: number; updatedCount: number } {
  const result = existing.map((r) => ({ ...r }));
  const usedIds = new Set<number>(result.map((r) => r.id));
  let nextId = nextSavedRouteId(result);
  let addedCount = 0;
  let updatedCount = 0;

  for (const item of incoming) {
    const matchIdx = result.findIndex(
      (r) =>
        r.createdAt === item.createdAt &&
        r.name === item.name &&
        r.polyline5 === item.polyline5,
    );
    if (matchIdx !== -1) {
      if (item.updatedAt > result[matchIdx].updatedAt) {
        result[matchIdx] = { ...item, id: result[matchIdx].id };
        updatedCount++;
      }
      continue;
    }

    let assignedId = item.id;
    if (assignedId < SAVED_ROUTE_ID_START || usedIds.has(assignedId)) {
      while (usedIds.has(nextId)) nextId++;
      assignedId = nextId++;
    }
    usedIds.add(assignedId);
    result.push(assignedId === item.id ? { ...item } : { ...item, id: assignedId });
    addedCount++;
  }

  result.sort((a, b) => b.updatedAt - a.updatedAt);
  return { merged: result, addedCount, updatedCount };
}

export async function downloadJsonFile(content: string, filename: string): Promise<void> {
  const safeName = filename.endsWith('.json') ? filename : `${filename}.json`;
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
