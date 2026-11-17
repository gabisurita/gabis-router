import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePolyline5, filterAndSortLibraryRoutes } from '../src/utils/route-library.ts';
import { TEMPLATE_PRESETS, generateBrfFromAxes } from '../src/utils/profile-editor.ts';
import {
  SAVED_ROUTE_ID_START,
  buildSavedRouteRecord,
  deriveSavedRouteSurface,
  encodePolyline5,
  loadSavedRoutesFromStorage,
  mergeImportedSavedRoutes,
  nextSavedRouteId,
  parseSavedRoutesBackup,
  rdpSimplifyLonLat,
  saveRoutesToStorage,
  savedRouteToGpx,
  savedRouteToLibraryRoute,
  serializeSavedRoutesBackup,
  suggestSavedRouteName,
} from '../src/utils/saved-routes.ts';

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

function sampleGeoJsonRoute(
  coords: number[][],
  lengthM = 42_600,
  ascendM = 540,
  segments: Array<{ from: number; to: number; surface: string; highway: string }> = [
    { from: 0, to: lengthM, surface: 'asphalt', highway: 'tertiary' },
  ],
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          'track-length': String(lengthM),
          'filtered ascend': String(ascendM),
          segments,
        },
        geometry: {
          type: 'LineString',
          coordinates: coords,
        },
      },
    ],
  };
}

test('encodePolyline5 matches Google reference vector and round-trips with decodePolyline5', () => {
  const refCoords: Array<[number, number]> = [
    [-120.2, 38.5],
    [-120.95, 40.7],
    [-126.453, 43.252],
  ];
  const encoded = encodePolyline5(refCoords);
  assert.equal(encoded, '_p~iF~ps|U_ulLnnqC_mqNvxq`@');

  const decoded = decodePolyline5(encoded);
  assert.equal(decoded.length, 3);
  for (let i = 0; i < refCoords.length; i++) {
    assert.ok(Math.abs(decoded[i][0] - refCoords[i][0]) < 1e-5);
    assert.ok(Math.abs(decoded[i][1] - refCoords[i][1]) < 1e-5);
  }
});

test('rdpSimplifyLonLat drops collinear points and preserves significant corners', () => {
  const raw: number[][] = [
    [-0.15, 51.45, 25],
    [-0.145, 51.45, 26],
    [-0.14, 51.45, 27],
    [-0.13, 51.45, 28],
    [-0.13, 51.49, 40],
  ];
  const simplified = rdpSimplifyLonLat(raw, 18.0);
  assert.deepEqual(simplified, [
    [-0.15, 51.45],
    [-0.13, 51.45],
    [-0.13, 51.49],
  ]);
});

test('deriveSavedRouteSurface classifies road, gravel, mixed, and traffic-free routes', () => {
  assert.equal(
    deriveSavedRouteSurface([
      { from: 0, to: 9500, surface: 'asphalt', highway: 'secondary' },
      { from: 9500, to: 10000, surface: 'compacted', highway: 'track' },
    ]),
    'road',
  );

  assert.equal(
    deriveSavedRouteSurface([
      { from: 0, to: 8000, surface: 'asphalt', highway: 'unclassified' },
      { from: 8000, to: 10000, surface: 'gravel', highway: 'track' },
    ]),
    'mixed',
  );

  assert.equal(
    deriveSavedRouteSurface([
      { from: 0, to: 5000, surface: 'asphalt', highway: 'unclassified' },
      { from: 5000, to: 10000, surface: 'fine_gravel', highway: 'bridleway' },
    ]),
    'gravel',
  );

  assert.equal(
    deriveSavedRouteSurface([
      { from: 0, to: 8500, surface: 'asphalt', highway: 'cycleway' },
      { from: 8500, to: 10000, surface: 'asphalt', highway: 'residential' },
    ]),
    'traffic-free',
  );
});

test('buildSavedRouteRecord, storage helpers, GPX export, and recent library sort work together', () => {
  const storage = createMemoryStorage();
  assert.deepEqual(loadSavedRoutesFromStorage(storage), []);

  const loopCoords = [
    [-0.14361, 51.46241, 22],
    [-0.3312, 51.2541, 175],
    [-0.1436, 51.46242, 22],
  ];
  const wps = [
    { lat: 51.46241, lon: -0.14361, name: 'Clapham Common, London' },
    { lat: 51.2541, lon: -0.3312, name: 'Box Hill, Surrey' },
    { lat: 51.46242, lon: -0.1436, name: 'Clapham Common, London' },
  ];

  assert.equal(suggestSavedRouteName(wps, true, 'Safe Road'), 'Clapham Common via Box Hill loop');

  const rec1 = buildSavedRouteRecord({
    id: SAVED_ROUTE_ID_START,
    now: 1_700_000_000_000,
    name: '',
    notes: 'Early Sunday club loop',
    profile: 'gabis-safe-road',
    profileLabel: 'Safe Road',
    waypoints: wps,
    avoidAreas: [{ lat: 51.35, lon: -0.2, radius: 100 }],
    alternativeIdx: 1,
    route: sampleGeoJsonRoute(loopCoords, 68_420, 792),
  });

  assert.equal(rec1.name, 'Clapham Common via Box Hill loop');
  assert.equal(rec1.loop, true);
  assert.equal(rec1.km, 68.4);
  assert.equal(rec1.asc, 792);
  assert.equal(rec1.alternativeIdx, 1);

  const rec2 = buildSavedRouteRecord({
    id: nextSavedRouteId([rec1]),
    now: 1_700_000_500_000,
    name: 'Richmond to Windsor',
    profile: 'gabis-lite-gravel',
    waypoints: [
      { lat: 51.4613, lon: -0.3037, name: 'Richmond' },
      { lat: 51.4839, lon: -0.6044, name: 'Windsor' },
    ],
    avoidAreas: [],
    alternativeIdx: 0,
    route: sampleGeoJsonRoute(
      [
        [-0.3037, 51.4613, 15],
        [-0.6044, 51.4839, 28],
      ],
      34_100,
      140,
      [{ from: 0, to: 34_100, surface: 'compacted', highway: 'track' }],
    ),
  });

  saveRoutesToStorage([rec1, rec2], storage);
  const loaded = loadSavedRoutesFromStorage(storage);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].id, rec2.id);
  assert.equal(loaded[1].id, rec1.id);

  const libRoutes = loaded.map((r) => savedRouteToLibraryRoute(r, r.profile));
  const sorted = filterAndSortLibraryRoutes(
    libRoutes,
    new Map([
      ['gabis-safe-road', 'Safe Road'],
      ['gabis-lite-gravel', 'Lite Gravel'],
    ]),
    {
      query: 'sunday',
      inMapView: false,
      surface: 'all',
      distance: 'all',
      shape: 'loop',
      source: 'gabis-safe-road',
      sort: 'recent',
    },
    null,
    { lat: 51.5, lon: -0.1 },
  );
  assert.deepEqual(
    sorted.map((r) => r.id),
    [rec1.id],
  );

  const gpx = savedRouteToGpx(rec1);
  assert.match(gpx, /<name>Clapham Common via Box Hill loop<\/name>/);
  assert.match(gpx, /Early Sunday club loop/);
  assert.match(gpx, /<wpt lat="51\.25410" lon="-0\.33120"><name>Box Hill, Surrey<\/name><\/wpt>/);
});

test('backup export, import validation, custom profile preservation, and ID collision resolution work', () => {
  const axes = { ...TEMPLATE_PRESETS['gabis-safe-road'].axes, gravelPenalty: 2.5 };
  const customProfile = {
    id: 'custom:winter-lanes',
    name: 'Winter Lanes',
    summary: 'Holds paved lanes in winter.',
    baseTemplate: 'gabis-safe-road' as const,
    mode: 'detailed' as const,
    axes,
    dsl: generateBrfFromAxes(axes, { name: 'Winter Lanes' }),
    updatedAt: 1_700_001_000_000,
  };

  const existing = buildSavedRouteRecord({
    id: SAVED_ROUTE_ID_START,
    now: 1_700_001_000_000,
    name: 'Kent Lanes',
    profile: 'gabis-safe-road',
    waypoints: [
      { lat: 51.4, lon: 0.05, name: 'Bromley' },
      { lat: 51.27, lon: 0.19, name: 'Sevenoaks' },
    ],
    avoidAreas: [],
    alternativeIdx: 0,
    route: sampleGeoJsonRoute([
      [0.05, 51.4],
      [0.19, 51.27],
    ]),
  });

  const collidingIncoming = buildSavedRouteRecord({
    id: SAVED_ROUTE_ID_START, // Collides with `existing.id`, but is a different route
    now: 1_700_002_000_000,
    name: 'Chilterns Winter',
    profile: customProfile.id,
    customProfile,
    waypoints: [
      { lat: 51.63, lon: -0.75, name: 'High Wycombe' },
      { lat: 51.75, lon: -0.98, name: 'Watlington' },
    ],
    avoidAreas: [],
    alternativeIdx: 0,
    route: sampleGeoJsonRoute([
      [-0.75, 51.63],
      [-0.98, 51.75],
    ]),
  });

  const updatedExisting = {
    ...existing,
    notes: 'Stop at Westerham bakery',
    updatedAt: existing.updatedAt + 5000,
  };

  const backupJson = serializeSavedRoutesBackup([collidingIncoming, updatedExisting]);
  const parsed = parseSavedRoutesBackup(backupJson);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].customProfile?.id, 'custom:winter-lanes');
  assert.equal(parsed[0].customProfile?.axes.gravelPenalty, 2.5);

  const { merged, addedCount, updatedCount } = mergeImportedSavedRoutes([existing], parsed);
  assert.equal(addedCount, 1);
  assert.equal(updatedCount, 1);
  assert.equal(merged.length, 2);
  assert.notEqual(merged[0].id, merged[1].id);
  const kent = merged.find((r) => r.name === 'Kent Lanes')!;
  assert.equal(kent.id, existing.id);
  assert.equal(kent.notes, 'Stop at Westerham bakery');

  // Re-importing identical backup adds 0 and updates 0
  const second = mergeImportedSavedRoutes(merged, parsed);
  assert.equal(second.addedCount, 0);
  assert.equal(second.updatedCount, 0);

  // Reject malformed files clearly
  assert.throws(() => parseSavedRoutesBackup('not json'), /not valid JSON/);
  assert.throws(
    () => parseSavedRoutesBackup(JSON.stringify({ format: 'wrong', version: 1, routes: [] })),
    /Unsupported backup format/,
  );
});
