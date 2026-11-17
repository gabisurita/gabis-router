import { haversine } from './geo.ts';

export type LibrarySurface = 'road' | 'mixed' | 'gravel' | 'traffic-free';
export type LibraryTerrain = 'flat' | 'rolling' | 'hilly';

export interface LibrarySource {
  slug: string;
  name: string;
  category: string;
  region: string;
  url: string;
  license: string;
  count: number;
}

export interface LibraryStop {
  name: string;
  kind?: string;
  role?: string;
  /** [lon, lat] */
  pos?: [number, number];
}

export interface LibraryRoute {
  id: number;
  src: string;
  name: string;
  km: number;
  asc: number | null;
  loop: boolean;
  surf: LibrarySurface;
  ter?: LibraryTerrain;
  multi?: boolean;
  reg: string;
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
  /** [lon, lat] */
  start: [number, number];
  url?: string;
  desc?: string;
  stops?: LibraryStop[];
  updatedAt?: number;
}

export interface LibraryIndex {
  version: number;
  sources: LibrarySource[];
  routes: LibraryRoute[];
}

export interface SuggestionColor {
  id: string;
  line: string;
  casing: string;
  badge: string;
}

/**
 * High-contrast 5-colour palette for top map suggestions.
 * Avoids green (woods/parks), pale yellow (roads), purple #9333ea (LCN), and #2563eb (planner route).
 * Badge colours meet WCAG AA (>= 5.1:1) with #ffffff text.
 */
export const SUGGESTION_COLORS: readonly SuggestionColor[] = [
  { id: 'orange', line: '#ff5a00', casing: '#7c2d12', badge: '#c2410c' },
  { id: 'cyan', line: '#00b4d8', casing: '#083344', badge: '#0369a1' },
  { id: 'magenta', line: '#ec4899', casing: '#831843', badge: '#be185d' },
  { id: 'indigo', line: '#6366f1', casing: '#1e1b4b', badge: '#4338ca' },
  { id: 'crimson', line: '#f43f5e', casing: '#4c0519', badge: '#be123c' },
] as const;

export const HOVER_FALLBACK_COLOR: SuggestionColor = {
  id: 'highlight',
  line: '#ff5a00',
  casing: '#7c2d12',
  badge: '#c2410c',
};

export const TOP_SUGGESTION_COUNT = 5;

export interface PreviewLibraryRoute {
  route: LibraryRoute;
  source?: LibrarySource;
  /** [lon, lat][] */
  coordinates: [number, number][];
  color: SuggestionColor;
}

export interface SuggestedLibraryTrack {
  /** 1-based suggestion rank (1..5) */
  rank: number;
  route: LibraryRoute;
  /** [lon, lat][] */
  coordinates: [number, number][];
  color: SuggestionColor;
}

export interface MapBoundsBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export type DistanceBucket = 'all' | 'short' | 'medium' | 'long' | 'ultra';
export type ShapeFilter = 'all' | 'loop' | 'p2p';
export type LibrarySort = 'recent' | 'nearby' | 'shortest' | 'longest' | 'climbing';

export interface LibraryFilterState {
  query: string;
  inMapView: boolean;
  surface: 'all' | LibrarySurface;
  distance: DistanceBucket;
  shape: ShapeFilter;
  source: string;
  sort: LibrarySort;
}

let cachedIndexPromise: Promise<LibraryIndex> | null = null;
const cachedSourceTracks = new Map<string, Promise<Record<string, string>>>();
const decodedTrackMemo = new Map<number, [number, number][]>();

export function fetchLibraryIndex(): Promise<LibraryIndex> {
  if (!cachedIndexPromise) {
    cachedIndexPromise = fetch('/route-library/index.json')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<LibraryIndex>;
      })
      .catch((err) => {
        cachedIndexPromise = null;
        throw err;
      });
  }
  return cachedIndexPromise;
}

export function fetchSourceTracks(slug: string): Promise<Record<string, string>> {
  let pending = cachedSourceTracks.get(slug);
  if (!pending) {
    pending = fetch(`/route-library/tracks/${encodeURIComponent(slug)}.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<Record<string, string>>;
      })
      .catch((err) => {
        cachedSourceTracks.delete(slug);
        throw err;
      });
    cachedSourceTracks.set(slug, pending);
  }
  return pending;
}

export async function loadLibraryRouteCoordinates(route: LibraryRoute): Promise<[number, number][]> {
  const memo = decodedTrackMemo.get(route.id);
  if (memo) return memo;
  const shard = await fetchSourceTracks(route.src);
  const encoded = shard[String(route.id)];
  if (!encoded) {
    throw new Error(`Track data not found for route ${route.id}`);
  }
  const coords = decodePolyline5(encoded);
  decodedTrackMemo.set(route.id, coords);
  return coords;
}

/**
 * Decodes Google Polyline5 (`lat, lon` scaled by 1e5) into GeoJSON `[lon, lat][]` coordinates.
 */
export function decodePolyline5(encoded: string): [number, number][] {
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const len = encoded.length;

  while (index < len) {
    let shift = 0;
    let result = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < len);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < len);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lon * 1e-5, lat * 1e-5]);
  }
  return coords;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function libraryTrackToGpx(
  route: LibraryRoute,
  coordinates: [number, number][],
  sourceName?: string,
): string {
  const nameXml = escapeXml(route.name);
  const descParts: string[] = [];
  if (sourceName) descParts.push(`Source: ${sourceName}`);
  if (route.desc) descParts.push(route.desc);
  const descXml = descParts.length > 0 ? `\n    <desc>${escapeXml(descParts.join(' | '))}</desc>` : '';
  const linkXml = route.url
    ? `\n    <link href="${escapeXml(route.url)}"><text>${escapeXml(sourceName || route.name)}</text></link>`
    : '';

  const wptsXml = (route.stops || [])
    .filter((s): s is LibraryStop & { pos: [number, number] } => Array.isArray(s.pos) && s.pos.length === 2)
    .map(
      (s) =>
        `  <wpt lat="${s.pos[1].toFixed(5)}" lon="${s.pos[0].toFixed(5)}"><name>${escapeXml(s.name)}</name></wpt>`,
    )
    .join('\n');

  const trkpts = coordinates
    .map(([lon, lat]) => `      <trkpt lat="${lat.toFixed(5)}" lon="${lon.toFixed(5)}"></trkpt>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="gabis-router"
  xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${nameXml}</name>${descXml}${linkXml}
  </metadata>${wptsXml ? `\n${wptsXml}` : ''}
  <trk>
    <name>${nameXml}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

export function routeIntersectsBounds(route: LibraryRoute, bounds: MapBoundsBox): boolean {
  const [minLon, minLat, maxLon, maxLat] = route.bbox;
  return (
    maxLon >= bounds.west &&
    minLon <= bounds.east &&
    maxLat >= bounds.south &&
    minLat <= bounds.north
  );
}

export function routeContainedInBounds(route: LibraryRoute, bounds: MapBoundsBox): boolean {
  const [minLon, minLat, maxLon, maxLat] = route.bbox;
  return (
    minLon >= bounds.west &&
    maxLon <= bounds.east &&
    minLat >= bounds.south &&
    maxLat <= bounds.north
  );
}

export function matchesDistanceBucket(km: number, bucket: DistanceBucket): boolean {
  switch (bucket) {
    case 'short':
      return km < 50;
    case 'medium':
      return km >= 50 && km <= 100;
    case 'long':
      return km > 100 && km <= 200;
    case 'ultra':
      return km > 200;
    default:
      return true;
  }
}

export function filterAndSortLibraryRoutes(
  routes: LibraryRoute[],
  sourceNamesBySlug: ReadonlyMap<string, string>,
  filters: LibraryFilterState,
  mapBounds: MapBoundsBox | null,
  mapCenter: { lat: number; lon: number },
): LibraryRoute[] {
  const q = filters.query.trim().toLowerCase();
  const tokens = q ? q.split(/\s+/).filter(Boolean) : [];

  const matched = routes.filter((r) => {
    if (filters.inMapView && mapBounds && !routeIntersectsBounds(r, mapBounds)) {
      return false;
    }
    if (filters.surface !== 'all' && r.surf !== filters.surface) {
      return false;
    }
    if (!matchesDistanceBucket(r.km, filters.distance)) {
      return false;
    }
    if (filters.shape === 'loop' && !r.loop) {
      return false;
    }
    if (filters.shape === 'p2p' && r.loop) {
      return false;
    }
    if (filters.source !== 'all' && r.src !== filters.source) {
      return false;
    }
    if (tokens.length > 0) {
      const srcName = sourceNamesBySlug.get(r.src) || r.src;
      const stopNames = r.stops ? r.stops.map((s) => s.name).join(' ') : '';
      const haystack = `${r.name} ${r.reg} ${srcName} ${stopNames} ${r.desc || ''}`.toLowerCase();
      for (const tok of tokens) {
        if (!haystack.includes(tok)) return false;
      }
    }
    return true;
  });

  if (filters.sort === 'recent') {
    matched.sort((a, b) => (b.updatedAt ?? b.id) - (a.updatedAt ?? a.id));
  } else if (filters.sort === 'shortest') {
    matched.sort((a, b) => a.km - b.km);
  } else if (filters.sort === 'longest') {
    matched.sort((a, b) => b.km - a.km);
  } else if (filters.sort === 'climbing') {
    matched.sort((a, b) => (b.asc ?? -1) - (a.asc ?? -1));
  } else {
    const viewDiagM = mapBounds
      ? Math.hypot(
          haversine(mapCenter.lat, mapBounds.west, mapCenter.lat, mapBounds.east),
          haversine(mapBounds.south, mapCenter.lon, mapBounds.north, mapCenter.lon),
        )
      : 0;
    const targetSpanM = viewDiagM > 0 ? Math.max(4000, viewDiagM * 0.42) : 0;

    const scoreCache = new Map<number, number>();
    const rankScore = (r: LibraryRoute) => {
      let s = scoreCache.get(r.id);
      if (s === undefined) {
        const [minLon, minLat, maxLon, maxLat] = r.bbox;
        const midLon = (minLon + maxLon) * 0.5;
        const midLat = (minLat + maxLat) * 0.5;
        const dStart = haversine(mapCenter.lat, mapCenter.lon, r.start[1], r.start[0]);
        const dMid = haversine(mapCenter.lat, mapCenter.lon, midLat, midLon);
        const distM = Math.min(dStart, dMid);

        if (viewDiagM > 1000 && mapBounds) {
          const routeSpanM = Math.max(
            2000,
            Math.hypot(
              haversine(midLat, minLon, midLat, maxLon),
              haversine(minLat, midLon, maxLat, midLon),
            ),
          );
          const scalePenalty = Math.abs(Math.log(routeSpanM / targetSpanM));
          const containedBonus = routeContainedInBounds(r, mapBounds) ? -0.35 : 0;
          s = (distM / Math.max(viewDiagM, 5000)) * 2.2 + scalePenalty + containedBonus;
        } else {
          s = distM;
        }
        scoreCache.set(r.id, s);
      }
      return s;
    };
    matched.sort((a, b) => rankScore(a) - rankScore(b));
  }

  return matched;
}

export const SURFACE_LABELS: Record<LibrarySurface, string> = {
  road: 'Road',
  mixed: 'Mixed',
  gravel: 'Gravel',
  'traffic-free': 'Traffic-free',
};
