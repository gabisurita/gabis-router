import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  decodePolyline5,
  filterAndSortLibraryRoutes,
  libraryTrackToGpx,
  routeIntersectsBounds,
  type LibraryFilterState,
  type LibraryIndex,
  type LibraryRoute,
} from '../src/utils/route-library.ts';

test('decodePolyline5 decodes standard Google polyline5 into [lon, lat] coordinates', () => {
  // Standard reference vector: (38.5, -120.2), (40.7, -120.95), (43.252, -126.453)
  const coords = decodePolyline5('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.equal(coords.length, 3);
  assert.ok(Math.abs(coords[0][0] - -120.2) < 1e-5);
  assert.ok(Math.abs(coords[0][1] - 38.5) < 1e-5);
  assert.ok(Math.abs(coords[1][0] - -120.95) < 1e-5);
  assert.ok(Math.abs(coords[1][1] - 40.7) < 1e-5);
  assert.ok(Math.abs(coords[2][0] - -126.453) < 1e-5);
  assert.ok(Math.abs(coords[2][1] - 43.252) < 1e-5);
});

test('libraryTrackToGpx escapes XML characters and emits valid trkpt and stop wpt elements', () => {
  const sample: LibraryRoute = {
    id: 42,
    src: 'peckham-cc',
    name: 'Box Hill & Leith <Loop>',
    km: 84.5,
    asc: 1120,
    loop: true,
    surf: 'road',
    reg: 'Surrey',
    bbox: [-0.35, 51.18, -0.1, 51.45],
    start: [-0.1, 51.45],
    url: 'https://example.com/route?a=1&b=2',
    stops: [{ name: 'Giro & Co', kind: 'cafe', pos: [-0.3312, 51.2541] }],
  };
  const gpx = libraryTrackToGpx(
    sample,
    [
      [-0.1, 51.45],
      [-0.3312, 51.2541],
    ],
    'Peckham CC',
  );
  assert.match(gpx, /<name>Box Hill &amp; Leith &lt;Loop&gt;<\/name>/);
  assert.match(gpx, /href="https:\/\/example\.com\/route\?a=1&amp;b=2"/);
  assert.match(gpx, /<wpt lat="51\.25410" lon="-0\.33120"><name>Giro &amp; Co<\/name><\/wpt>/);
  assert.match(gpx, /<trkpt lat="51\.45000" lon="-0\.10000"><\/trkpt>/);
});

test('filterAndSortLibraryRoutes filters by viewport, surface, distance, shape, and query', () => {
  const routes: LibraryRoute[] = [
    {
      id: 1,
      src: 'lost-lanes',
      name: 'South Downs Lanes',
      km: 62,
      asc: 850,
      loop: true,
      surf: 'road',
      reg: 'Sussex',
      bbox: [-0.4, 50.85, 0.1, 51.05],
      start: [-0.15, 50.9],
      stops: [{ name: 'Amberley Tea Room', kind: 'cafe' }],
    },
    {
      id: 2,
      src: 'bikepacking-scotland',
      name: 'Badger Divide',
      km: 330,
      asc: 4900,
      loop: false,
      surf: 'gravel',
      reg: 'Scotland',
      bbox: [-5.1, 55.85, -4.1, 57.48],
      start: [-4.22, 57.47],
    },
  ];
  const sources = new Map([
    ['lost-lanes', 'Lost Lanes'],
    ['bikepacking-scotland', 'Bikepacking Scotland'],
  ]);

  const baseFilter: LibraryFilterState = {
    query: '',
    inMapView: true,
    surface: 'all',
    distance: 'all',
    shape: 'all',
    source: 'all',
    sort: 'nearby',
  };

  // South England viewport only matches route 1
  const southBounds = { west: -1.0, south: 50.7, east: 0.5, north: 51.6 };
  assert.equal(routeIntersectsBounds(routes[0], southBounds), true);
  assert.equal(routeIntersectsBounds(routes[1], southBounds), false);

  const inSouth = filterAndSortLibraryRoutes(routes, sources, baseFilter, southBounds, {
    lat: 51.1,
    lon: -0.1,
  });
  assert.deepEqual(
    inSouth.map((r) => r.id),
    [1],
  );

  // Stop name search across all UK
  const stopSearch = filterAndSortLibraryRoutes(
    routes,
    sources,
    { ...baseFilter, inMapView: false, query: 'amberley' },
    southBounds,
    { lat: 51.1, lon: -0.1 },
  );
  assert.deepEqual(
    stopSearch.map((r) => r.id),
    [1],
  );

  // Gravel + p2p filter
  const gravelP2p = filterAndSortLibraryRoutes(
    routes,
    sources,
    { ...baseFilter, inMapView: false, surface: 'gravel', shape: 'p2p' },
    null,
    { lat: 56.0, lon: -4.0 },
  );
  assert.deepEqual(
    gravelP2p.map((r) => r.id),
    [2],
  );
});

test('filterAndSortLibraryRoutes ranks viewport-scale routes ahead of massive national routes when zoomed in', () => {
  const routes: LibraryRoute[] = [
    {
      id: 10,
      src: 'cycling-uk',
      name: 'Great North Trail (National)',
      km: 1280,
      asc: 16500,
      loop: false,
      surf: 'gravel',
      reg: 'Britain',
      bbox: [-5.2, 51.2, -0.1, 58.6],
      start: [-1.7, 53.35],
    },
    {
      id: 11,
      src: 'lost-lanes',
      name: 'Hope Valley & Mam Tor Loop',
      km: 48,
      asc: 920,
      loop: true,
      surf: 'road',
      reg: 'Peak District',
      bbox: [-1.85, 53.3, -1.62, 53.42],
      start: [-1.73, 53.35],
    },
  ];
  const sources = new Map([
    ['cycling-uk', 'Cycling UK'],
    ['lost-lanes', 'Lost Lanes'],
  ]);
  const filter: LibraryFilterState = {
    query: '',
    inMapView: true,
    surface: 'all',
    distance: 'all',
    shape: 'all',
    source: 'all',
    sort: 'nearby',
  };

  // Zoomed into Peak District (~30 km viewport)
  const peakBounds = { west: -1.95, south: 53.22, east: -1.5, north: 53.48 };
  const ranked = filterAndSortLibraryRoutes(routes, sources, filter, peakBounds, {
    lat: 53.35,
    lon: -1.72,
  });
  assert.deepEqual(
    ranked.map((r) => r.id),
    [11, 10],
  );
});

test('generated route-library index and sample shard decode cleanly', () => {
  const indexFile = path.resolve(import.meta.dirname, '../public/route-library/index.json');
  const raw = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as LibraryIndex;
  assert.equal(raw.version, 1);
  assert.ok(raw.sources.length >= 15);
  assert.ok(raw.routes.length >= 1000);

  const sample = raw.routes[0];
  const shardFile = path.resolve(
    import.meta.dirname,
    `../public/route-library/tracks/${sample.src}.json`,
  );
  const shard = JSON.parse(fs.readFileSync(shardFile, 'utf8')) as Record<string, string>;
  const coords = decodePolyline5(shard[String(sample.id)]);
  assert.ok(coords.length >= 2);
  assert.ok(Math.abs(coords[0][0] - sample.start[0]) < 0.001);
  assert.ok(Math.abs(coords[0][1] - sample.start[1]) < 0.001);
});
