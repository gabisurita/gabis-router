import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import initWasm, { WasmRouter } from '../src/pkg/rsrouter_wasm.js';
import { PROFILE_ORDER, type RouteResponse } from '../src/types.ts';
import {
  analyzeRobustness,
  buildRobustnessProbes,
  createRobustnessSession,
  halton,
  type RobustnessProbeResult,
} from '../src/utils/robustness.ts';

const PROFILES_DIR = path.resolve(import.meta.dirname, '../public/profiles');
const WASM_PATH = path.resolve(import.meta.dirname, '../src/pkg/rsrouter_wasm_bg.wasm');
const SEGMENTS_DIR = path.resolve(import.meta.dirname, '../../data/segments4');
const HAS_RD5_DATA = fs.existsSync(path.join(SEGMENTS_DIR, 'W5_N50.rd5'));

function makeMockRoute(
  coords: [number, number][],
  distanceM: number,
  timeS: number,
  ascentM: number,
): RouteResponse {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          'track-length': String(distanceM),
          'total-time': String(timeS),
          cost: String(Math.round(distanceM * 1.2)),
          'filtered ascend': String(ascentM),
        },
        geometry: {
          type: 'LineString',
          coordinates: coords.map(([lon, lat]) => [lon, lat, 20]),
        },
      },
    ],
  };
}

test('halton low-discrepancy sequence is deterministic and bounded in (0, 1)', () => {
  for (let i = 1; i <= 80; i++) {
    const v2 = halton(i, 2);
    const v3 = halton(i, 3);
    assert.ok(v2 > 0 && v2 < 1);
    assert.ok(v3 > 0 && v3 < 1);
    assert.equal(v2, halton(i, 2));
  }
});

test('20-run preset covers all 6 perturbation dimensions evenly', () => {
  const probes = buildRobustnessProbes({ baseProfile: 'gabis-lite-gravel', scenarioCount: 20 });
  assert.equal(probes.length, 20);
  const dims = new Set(probes.map((p) => p.dimension));
  assert.equal(dims.size, 6, 'Expected 20-run sweep to span all 6 dimensions');
});

test('buildRobustnessProbes compiles all 160 scenarios cleanly in WasmRouter for all 8 built-in profiles', async () => {
  await initWasm({ module_or_path: fs.readFileSync(WASM_PATH) });
  const router = new WasmRouter();
  router.load_lookups(fs.readFileSync(path.join(PROFILES_DIR, 'lookups.dat'), 'utf8'));

  for (const profileId of PROFILE_ORDER) {
    const brfPath = path.join(PROFILES_DIR, `${profileId}.brf`);
    const baseDsl = fs.readFileSync(brfPath, 'utf8');
    const probes = buildRobustnessProbes({
      baseProfile: profileId,
      baseDsl,
      scenarioCount: 160,
    });
    assert.equal(probes.length, 160, `Expected 160 probes for ${profileId}`);
    assert.equal(probes.filter((p) => p.kind === 'directional').length, 28);
    assert.equal(probes.filter((p) => p.kind === 'jitter').length, 132);

    for (const probe of probes) {
      assert.doesNotThrow(
        () => {
          router.load_profile(`custom:${profileId}-${probe.id}-full`, probe.fullDsl);
          router.load_profile(`custom:${profileId}-${probe.id}-screen`, probe.screeningDsl);
        },
        `Failed compiling probe ${probe.id} for ${profileId}`,
      );
      router.remove_profile(`custom:${profileId}-${probe.id}-full`);
      router.remove_profile(`custom:${profileId}-${probe.id}-screen`);
    }
  }
});

test('analyzeRobustness reports 100% stability and zero alternatives when all probes match base', () => {
  const baseCoords: [number, number][] = [
    [-0.14, 51.46],
    [-0.13, 51.47],
    [-0.12, 51.48],
  ];
  const baseRoute = makeMockRoute(baseCoords, 3000, 600, 25);

  const probes: RobustnessProbeResult[] = [
    {
      id: 'hills-strong-flat',
      kind: 'directional',
      label: 'Flattest route',
      dimension: 'Hills',
      description: 'Flatter test',
      fullDsl: '',
      route: makeMockRoute(baseCoords, 3000, 605, 25),
    },
    {
      id: 'jitter-1',
      kind: 'jitter',
      label: 'Combined mix #1',
      dimension: 'Traffic',
      description: 'Jitter test',
      fullDsl: '',
      route: makeMockRoute(baseCoords, 3000, 610, 25),
    },
  ];

  const res = analyzeRobustness(baseRoute, probes, 40);
  assert.equal(res.completedCount, 2);
  assert.equal(res.totalCount, 40);
  assert.equal(res.overallStability, 1);
  assert.equal(res.spineShare, 1);
  assert.equal(res.fragileShare, 0);
  assert.equal(res.corridors.length, 0);
  assert.equal(res.baseMatchingProbes, 2);
});

test('analyzeRobustness prefers directional labels over jitter labels and auto-names pure jitter clusters', () => {
  const baseRoute = makeMockRoute(
    [
      [-0.20, 51.50],
      [-0.15, 51.50],
      [-0.12, 51.53],
      [-0.10, 51.50],
    ],
    9000,
    1800,
    120,
  );

  const southernCoords: [number, number][] = [
    [-0.20, 51.50],
    [-0.15, 51.50],
    [-0.12, 51.47],
    [-0.10, 51.50],
  ];

  const pureJitterCoords: [number, number][] = [
    [-0.20, 51.50],
    [-0.16, 51.55],
    [-0.10, 51.50],
  ];

  const probes: RobustnessProbeResult[] = [
    // Jitter arrives BEFORE directional on the southern corridor
    {
      id: 'jitter-3',
      kind: 'jitter',
      label: 'Combined mix #3',
      dimension: 'Hills',
      description: 'Combined hill jitter',
      fullDsl: 'dsl-jitter-3',
      route: makeMockRoute(southernCoords, 9620, 1750, 42),
    },
    {
      id: 'hills-strong-flat',
      kind: 'directional',
      label: 'Flattest route',
      dimension: 'Hills',
      description: 'Strong climb avoidance',
      fullDsl: 'dsl-flat',
      route: makeMockRoute(southernCoords, 9600, 1740, 40),
    },
    // Pure jitter corridor with lower climb
    {
      id: 'jitter-9',
      kind: 'jitter',
      label: 'Combined mix #9',
      dimension: 'Surface',
      description: 'Combined surface and hill shift',
      fullDsl: 'dsl-jitter-9',
      route: makeMockRoute(pureJitterCoords, 9800, 1790, 65),
    },
    {
      id: 'direct-high-flow',
      kind: 'directional',
      label: 'Fast and direct',
      dimension: 'Directness',
      description: 'Matches base',
      fullDsl: 'dsl-fast',
      route: baseRoute,
    },
  ];

  const res = analyzeRobustness(baseRoute, probes, 4);
  const session = createRobustnessSession(baseRoute, 4);
  for (const p of probes) {
    session.addProbe(p);
  }
  const streamed = session.snapshot();
  assert.deepEqual(streamed, res);
  assert.equal(res.corridors.length, 2);

  // Cluster 0 has 2 probes and upgrades its primary label to 'Flattest route'
  assert.equal(res.corridors[0].probeCount, 2);
  assert.equal(res.corridors[0].sharePct, 50);
  assert.equal(res.corridors[0].label, 'Flattest route');
  assert.equal(res.corridors[0].fullDsl, 'dsl-flat');

  // Cluster 1 is pure jitter with -55m climb -> 'Lower-climb variant'
  assert.equal(res.corridors[1].probeCount, 1);
  assert.equal(res.corridors[1].label, 'Lower-climb variant');
});

test(
  'end-to-end 40-scenario WASM robustness sweep on Whitebushes to Leith Hill',
  { skip: !HAS_RD5_DATA },
  async () => {
    await initWasm({ module_or_path: fs.readFileSync(WASM_PATH) });
    const router = new WasmRouter();
    router.set_segment_reader(
      (name: string) => {
        const p = path.join(SEGMENTS_DIR, `${name}.rd5`);
        return fs.existsSync(p) ? fs.statSync(p).size : 0;
      },
      (name: string, start: number, end: number) => {
        const p = path.join(SEGMENTS_DIR, `${name}.rd5`);
        const len = end - start;
        const buf = Buffer.allocUnsafe(len);
        const fd = fs.openSync(p, 'r');
        try {
          fs.readSync(fd, buf, 0, len, start);
        } finally {
          fs.closeSync(fd);
        }
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      },
    );
    router.load_lookups(fs.readFileSync(path.join(PROFILES_DIR, 'lookups.dat'), 'utf8'));

    const baseDsl = fs.readFileSync(path.join(PROFILES_DIR, 'gabis-safe-road.brf'), 'utf8');
    router.load_profile('gabis-safe-road', baseDsl);
    const wpStr = '-0.16652,51.2182|-0.36885,51.17533';
    const baseRoute = JSON.parse(router.route(wpStr, 'gabis-safe-road', 0, undefined)) as RouteResponse;

    const probes = buildRobustnessProbes({ baseProfile: 'gabis-safe-road', scenarioCount: 40 });
    assert.equal(probes.length, 40);

    const results: RobustnessProbeResult[] = [];
    for (const p of probes) {
      router.load_profile('custom:__probe__', p.screeningDsl);
      const r = JSON.parse(router.route(wpStr, 'custom:__probe__', 0, undefined)) as RouteResponse;
      results.push({
        id: p.id,
        kind: p.kind,
        label: p.label,
        dimension: p.dimension,
        description: p.description,
        fullDsl: p.fullDsl,
        axes: p.axes,
        baseTemplate: p.baseTemplate,
        route: r,
      });
    }
    router.remove_profile('custom:__probe__');

    const analysis = analyzeRobustness(baseRoute, results, probes.length);
    assert.equal(analysis.completedCount, 40);
    assert.ok(analysis.overallStability > 0.3 && analysis.overallStability < 1.0);
    assert.ok(analysis.segments.length >= 2);
    assert.ok(analysis.corridors.length >= 2, 'Expected multiple distinct alternative corridors across 40 scenarios');
  },
);

test(
  '80-scenario sweep on Tooting to Roehampton Gate (gabis-lite-gravel) discovers Wimbledon Common corridor',
  { skip: !HAS_RD5_DATA },
  async () => {
    await initWasm({ module_or_path: fs.readFileSync(WASM_PATH) });
    const router = new WasmRouter();
    router.set_segment_reader(
      (name: string) => {
        const p = path.join(SEGMENTS_DIR, `${name}.rd5`);
        return fs.existsSync(p) ? fs.statSync(p).size : 0;
      },
      (name: string, start: number, end: number) => {
        const p = path.join(SEGMENTS_DIR, `${name}.rd5`);
        const len = end - start;
        const buf = Buffer.allocUnsafe(len);
        const fd = fs.openSync(p, 'r');
        try {
          fs.readSync(fd, buf, 0, len, start);
        } finally {
          fs.closeSync(fd);
        }
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      },
    );
    router.load_lookups(fs.readFileSync(path.join(PROFILES_DIR, 'lookups.dat'), 'utf8'));

    const baseDsl = fs.readFileSync(path.join(PROFILES_DIR, 'gabis-lite-gravel.brf'), 'utf8');
    router.load_profile('gabis-lite-gravel', baseDsl);
    const wpStr = '-0.15851,51.41563|-0.2557098353836409,51.45249087368441';
    const baseRoute = JSON.parse(router.route(wpStr, 'gabis-lite-gravel', 0, undefined)) as RouteResponse;

    const probes = buildRobustnessProbes({ baseProfile: 'gabis-lite-gravel', scenarioCount: 80 });
    assert.equal(probes.length, 80);

    const results: RobustnessProbeResult[] = [];
    for (const p of probes) {
      router.load_profile('custom:__probe__', p.screeningDsl);
      const r = JSON.parse(router.route(wpStr, 'custom:__probe__', 0, undefined)) as RouteResponse;
      results.push({
        id: p.id,
        kind: p.kind,
        label: p.label,
        dimension: p.dimension,
        description: p.description,
        fullDsl: p.fullDsl,
        axes: p.axes,
        baseTemplate: p.baseTemplate,
        route: r,
      });
    }
    router.remove_profile('custom:__probe__');

    const analysis = analyzeRobustness(baseRoute, results, probes.length);
    assert.equal(analysis.completedCount, 80);

    const crossesWimbledonCommon = (coords: [number, number][]) =>
      coords.some(([lon, lat]) => lon >= -0.252 && lon <= -0.236 && lat >= 51.425 && lat <= 51.438);

    assert.equal(
      crossesWimbledonCommon(
        baseRoute.features[0].geometry.coordinates.map((c) => [c[0], c[1]]),
      ),
      false,
      'Base gabis-lite-gravel route skirts north around Wimbledon Common',
    );
    const commonCorridors = analysis.corridors.filter((c) => crossesWimbledonCommon(c.coordinates));
    assert.ok(
      commonCorridors.length >= 1,
      'Expected at least one discovered corridor crossing Wimbledon Common',
    );
    const commonBranches = analysis.branches.filter((b) => crossesWimbledonCommon(b.coordinates));
    assert.ok(
      commonBranches.length >= 1,
      'Expected at least one discovered detour branch crossing Wimbledon Common',
    );
    assert.ok(
      commonBranches[0].branchMix.hasData && commonBranches[0].branchMix.unpavedPct > 0,
      'Expected Wimbledon Common branch to carry unpaved surface mix metadata',
    );
    assert.ok(
      commonBranches[0].replacedBaseCoords.length >= 2,
      'Expected replaced base route span coordinates on Wimbledon Common branch',
    );
  },
);

test('createRobustnessSession aggregates independent local forks into separate branches without losing directional branches', () => {
  const baseRoute = makeMockRoute(
    [
      [-0.20, 51.50],
      [-0.18, 51.50],
      [-0.16, 51.50],
      [-0.14, 51.50],
      [-0.12, 51.50],
      [-0.10, 51.50],
      [-0.08, 51.50],
    ],
    8400,
    1600,
    50,
  );

  // Fork A around west half (-0.18 to -0.14), Fork B around east half (-0.12 to -0.08)
  const forkAOnly: [number, number][] = [
    [-0.20, 51.50],
    [-0.18, 51.50],
    [-0.16, 51.51],
    [-0.14, 51.50],
    [-0.12, 51.50],
    [-0.10, 51.50],
    [-0.08, 51.50],
  ];
  const forkBOnly: [number, number][] = [
    [-0.20, 51.50],
    [-0.18, 51.50],
    [-0.16, 51.50],
    [-0.14, 51.50],
    [-0.12, 51.50],
    [-0.10, 51.49],
    [-0.08, 51.50],
  ];
  const bothForks: [number, number][] = [
    [-0.20, 51.50],
    [-0.18, 51.50],
    [-0.16, 51.51],
    [-0.14, 51.50],
    [-0.12, 51.50],
    [-0.10, 51.49],
    [-0.08, 51.50],
  ];

  const session = createRobustnessSession(baseRoute, 3);
  session.addProbe({
    id: 'surface-offroad-trails',
    kind: 'directional',
    label: 'Off-road gravel and commons',
    dimension: 'Surface',
    description: 'Fork A directional',
    fullDsl: 'dsl-a',
    route: makeMockRoute(forkAOnly, 8800, 1650, 55),
  });
  session.addProbe({
    id: 'traffic-strong-quiet',
    kind: 'directional',
    label: 'Quiet backroads only',
    dimension: 'Traffic',
    description: 'Fork B directional',
    fullDsl: 'dsl-b',
    route: makeMockRoute(forkBOnly, 8900, 1680, 52),
  });
  session.addProbe({
    id: 'jitter-1',
    kind: 'jitter',
    label: 'Combined mix #1',
    dimension: 'Surface',
    description: 'Both forks',
    fullDsl: 'dsl-ab',
    route: makeMockRoute(bothForks, 9300, 1730, 57),
  });

  const snap = session.snapshot();
  assert.equal(snap.branches.length, 2, 'Expected exactly 2 distinct local detour branches');
  assert.equal(snap.branches[0].probeCount, 2, 'Each fork should accumulate count from both single-fork and combined probes');
  assert.equal(snap.branches[1].probeCount, 2);
});
