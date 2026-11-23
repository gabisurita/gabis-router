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
  filterFrequentBranches,
  filterFrequentCorridors,
  halton,
  planBranchLegSplices,
  samplePerturbationVector,
  type AlternativeBranch,
  type AlternativeCorridor,
  type PerturbationVector,
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

function zeroVec(overrides: Partial<PerturbationVector> = {}): PerturbationVector {
  return {
    traffic: 0,
    hills: 0,
    surface: 0,
    turns: 0,
    crossings: 0,
    cycleways: 0,
    greenery: 0,
    noise: 0,
    lighting: 0,
    ...overrides,
  };
}

test('halton sequence and pure QMC perturbation vectors are deterministic, bounded, and centered', () => {
  let trafficSum = 0;
  let noiseSum = 0;
  for (let i = 1; i <= 160; i++) {
    const v2 = halton(i, 2);
    assert.ok(v2 > 0 && v2 < 1);
    assert.equal(v2, halton(i, 2));

    const { u, norm } = samplePerturbationVector(i);
    assert.ok(norm > 0 && norm <= 3.01);
    for (const val of Object.values(u)) {
      assert.ok(val >= -1 && val <= 1);
    }
    trafficSum += u.traffic;
    noiseSum += u.noise;
  }
  assert.ok(Math.abs(trafficSum / 160) < 0.08, 'Expected traffic axis to be centered near 0');
  assert.ok(Math.abs(noiseSum / 160) < 0.08, 'Expected noise axis to be centered near 0');
});

test('20-run preset produces 20 pure QMC samples covering multiple dimensions', () => {
  const probes = buildRobustnessProbes({ baseProfile: 'gabis-lite-gravel', scenarioCount: 20 });
  assert.equal(probes.length, 20);
  assert.ok(probes.every((p) => p.kind === 'sample'));
  const dims = new Set(probes.map((p) => p.dimension));
  assert.ok(dims.size >= 4, 'Expected 20 pure QMC samples to span multiple dimensions');
});

test('buildRobustnessProbes compiles all 160 pure QMC scenarios cleanly in WasmRouter for all 8 built-in profiles', async () => {
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
    assert.ok(probes.every((p) => p.kind === 'sample'));

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

test('analyzeRobustness reports 100% stability and zero alternatives when all samples match base', () => {
  const baseCoords: [number, number][] = [
    [-0.14, 51.46],
    [-0.13, 51.47],
    [-0.12, 51.48],
  ];
  const baseRoute = makeMockRoute(baseCoords, 3000, 600, 25);

  const probes: RobustnessProbeResult[] = [
    {
      id: 'sample-1',
      kind: 'sample',
      label: 'Sample #1',
      dimension: 'Hills',
      description: 'Test',
      u: zeroVec({ hills: 0.4 }),
      norm: 0.4,
      fullDsl: '',
      route: makeMockRoute(baseCoords, 3000, 605, 25),
    },
    {
      id: 'sample-2',
      kind: 'sample',
      label: 'Sample #2',
      dimension: 'Traffic',
      description: 'Test',
      u: zeroVec({ traffic: -0.3 }),
      norm: 0.3,
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
  assert.equal(res.branches.length, 0);
  assert.equal(res.baseMatchingProbes, 2);
});

test('analyzeRobustness picks minimum-perturbation representative and infers statistical drivers', () => {
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

  const probes: RobustnessProbeResult[] = [
    // Large perturbation arrives FIRST
    {
      id: 'sample-1',
      kind: 'sample',
      label: 'Sample #1',
      dimension: 'Hills',
      description: 'Large hill shift',
      u: zeroVec({ hills: 0.9, traffic: 0.6 }),
      norm: Math.hypot(0.9, 0.6),
      fullDsl: 'dsl-large',
      route: makeMockRoute(southernCoords, 9620, 1750, 42),
    },
    // Smaller perturbation arrives SECOND and should become the cluster representative
    {
      id: 'sample-2',
      kind: 'sample',
      label: 'Sample #2',
      dimension: 'Hills',
      description: 'Small hill shift',
      u: zeroVec({ hills: 0.45 }),
      norm: 0.45,
      fullDsl: 'dsl-min-perturbation',
      route: makeMockRoute(southernCoords, 9600, 1740, 40),
    },
    {
      id: 'sample-3',
      kind: 'sample',
      label: 'Sample #3',
      dimension: 'Hills',
      description: 'Medium hill shift',
      u: zeroVec({ hills: 0.75, traffic: -0.2 }),
      norm: Math.hypot(0.75, 0.2),
      fullDsl: 'dsl-med',
      route: makeMockRoute(southernCoords, 9610, 1745, 41),
    },
  ];

  const res = analyzeRobustness(baseRoute, probes, 3);
  const session = createRobustnessSession(baseRoute, 3);
  for (const p of probes) session.addProbe(p);
  assert.deepEqual(session.snapshot(), res);

  assert.equal(res.corridors.length, 1);
  assert.equal(res.corridors[0].probeCount, 3);
  assert.equal(res.corridors[0].fullDsl, 'dsl-min-perturbation');
  assert.equal(res.corridors[0].label, 'Variant 1');
  assert.ok(res.corridors[0].probeLabels.includes('Flatter'));

  assert.equal(res.branches.length, 1);
  assert.equal(res.branches[0].fullDsl, 'dsl-min-perturbation');
  assert.match(res.branches[0].label, /^km \d+\.\d-\d+\.\d$/);
  assert.ok(res.branches[0].probeLabels.includes('Flatter'));
});

test('loud cycleway uses neutral labels and reports factual noise mix', () => {
  const baseRoute = makeMockRoute(
    [
      [-0.20, 51.40],
      [-0.20, 51.38],
      [-0.20, 51.36],
      [-0.20, 51.34],
    ],
    6600,
    1200,
    40,
  );
  (baseRoute.features[0].properties as Record<string, unknown>).segments = [
    { from: 0, to: 6600, surface: 'asphalt', highway: 'unclassified', noise: 1, traffic: 1 },
  ];

  const loudCyclewayRoute = makeMockRoute(
    [
      [-0.20, 51.40],
      [-0.18, 51.38],
      [-0.18, 51.36],
      [-0.20, 51.34],
    ],
    7100,
    1220,
    35,
  );
  (loudCyclewayRoute.features[0].properties as Record<string, unknown>).segments = [
    { from: 0, to: 7100, surface: 'asphalt', highway: 'cycleway', noise: 6, traffic: 0 },
  ];

  const probes: RobustnessProbeResult[] = [
    {
      id: 'sample-1',
      kind: 'sample',
      label: 'Sample #1',
      dimension: 'Cycleways',
      description: 'Test',
      u: zeroVec({ cycleways: 0.85, noise: -0.65 }),
      norm: Math.hypot(0.85, 0.65),
      fullDsl: 'dsl-1',
      route: loudCyclewayRoute,
    },
    {
      id: 'sample-2',
      kind: 'sample',
      label: 'Sample #2',
      dimension: 'Cycleways',
      description: 'Test',
      u: zeroVec({ cycleways: 0.7, noise: -0.5 }),
      norm: Math.hypot(0.7, 0.5),
      fullDsl: 'dsl-2',
      route: loudCyclewayRoute,
    },
  ];

  const res = analyzeRobustness(baseRoute, probes, 2);
  assert.equal(res.branches.length, 1);
  assert.match(res.branches[0].label, /^km \d+\.\d-\d+\.\d$/);
  assert.equal(res.branches[0].branchMix.loudNoisePct, 100);
  assert.equal(res.corridors.length, 1);
  assert.equal(res.corridors[0].label, 'Variant 1');
});

test('filterFrequentCorridors and filterFrequentBranches keep high probability mass options', () => {
  const makeCorridor = (id: string, probeCount: number) =>
    ({ id, probeCount }) as unknown as AlternativeCorridor;
  const makeBranch = (id: string, probeCount: number) =>
    ({ id, probeCount }) as unknown as AlternativeBranch;

  // Variants: 80 total runs, 75 diverging across 12 variants -> keep top 70% nucleus
  const variants = [
    makeCorridor('v1', 16),
    makeCorridor('v2', 12),
    makeCorridor('v3', 10),
    makeCorridor('v4', 8),
    makeCorridor('v5', 7),
    makeCorridor('v6', 5),
    makeCorridor('v7', 4),
    makeCorridor('v8', 3),
    makeCorridor('v9', 3),
    makeCorridor('v10', 3),
    makeCorridor('v11', 2),
    makeCorridor('v12', 2),
  ];
  const frequentVariants = filterFrequentCorridors(variants, 80);
  assert.deepEqual(
    frequentVariants.map((v) => v.id),
    ['v1', 'v2', 'v3', 'v4', 'v5'],
  );

  // Dominant single variant (40/50 diverging runs = 80% mass) -> keep only v1
  const dominant = filterFrequentCorridors(
    [makeCorridor('v1', 40), makeCorridor('v2', 5), makeCorridor('v3', 3), makeCorridor('v4', 2)],
    80,
  );
  assert.deepEqual(
    dominant.map((v) => v.id),
    ['v1'],
  );

  // Segments: keep >=15% marginal probability branches
  const branches = [
    makeBranch('b1', 50),
    makeBranch('b2', 42),
    makeBranch('b3', 16),
    makeBranch('b4', 10),
    makeBranch('b5', 4),
    makeBranch('b6', 1),
  ];
  const frequentBranches = filterFrequentBranches(branches, 80);
  assert.deepEqual(
    frequentBranches.map((b) => b.id),
    ['b1', 'b2', 'b3'],
  );

  // Rare segments fallback: all <15%, relax to >=10%
  const modestBranches = [makeBranch('b1', 10), makeBranch('b2', 8), makeBranch('b3', 3)];
  assert.deepEqual(
    filterFrequentBranches(modestBranches, 80).map((b) => b.id),
    ['b1', 'b2'],
  );
});

test('looped multi-waypoint routes do not clip leg-0 detours at finish or drop interior waypoints', () => {
  // Lollipop route A -> 1 -> 2 -> 3 -> B (~55 km), where B is geographically near the leg-0 detour
  const baseCoords: [number, number][] = [
    [-0.20, 51.42], // A (0 km)
    [-0.24, 51.35], // Epsom (~8.5 km)
    [-0.31, 51.30], // Leatherhead (~16 km)
    [-0.36, 51.23], // WP 1 (~24 km)
    [-0.36, 51.16], // WP 2 (~32 km)
    [-0.30, 51.20], // WP 3 (~39 km)
    [-0.27, 51.26], // B (~47 km, near the eastern Headley detour corridor)
  ];
  const waypoints = [
    { lat: 51.42, lon: -0.20 }, // A
    { lat: 51.23, lon: -0.36 }, // 1
    { lat: 51.16, lon: -0.36 }, // 2
    { lat: 51.20, lon: -0.30 }, // 3
    { lat: 51.26, lon: -0.27 }, // B
  ];
  const baseRoute = makeMockRoute(baseCoords, 47000, 9000, 600);

  // Probe takes an eastern leg-0 detour passing right through B's coordinates (-0.27, 51.26)
  // before continuing on to WP 1 -> WP 2 -> WP 3 -> B.
  const probeCoords: [number, number][] = [
    [-0.20, 51.42], // A
    [-0.24, 51.35], // Epsom (leaves base here)
    [-0.26, 51.30], // Headley
    [-0.27, 51.26], // Passes right past B on leg 0!
    [-0.31, 51.24], // Dorking
    [-0.36, 51.23], // Rejoins at WP 1
    [-0.36, 51.16], // WP 2
    [-0.30, 51.20], // WP 3
    [-0.27, 51.26], // B
  ];
  const probeRoute = makeMockRoute(probeCoords, 49000, 9300, 650);

  const res = analyzeRobustness(
    baseRoute,
    [
      {
        id: 'sample-1',
        kind: 'sample',
        label: 'Sample #1',
        dimension: 'Traffic',
        description: 'Test',
        u: zeroVec({ traffic: 0.6 }),
        norm: 0.6,
        fullDsl: 'dsl-1',
        route: probeRoute,
      },
    ],
    1,
  );

  // Detour should stay one continuous leg-0 branch (~8.5 km -> ~24 km), NOT clipped at B (~47 km)
  assert.equal(res.branches.length, 1);
  assert.ok(res.branches[0].baseStartM < 12000, `Unexpected baseStartM ${res.branches[0].baseStartM}`);
  assert.ok(res.branches[0].baseEndM < 28000, `Branch jumped across loop to ${res.branches[0].baseEndM}`);

  // Applying the segment splices ONLY leg 0 (A -> 1), preserving waypoints 1, 2, 3, B
  const segSplices = planBranchLegSplices(baseCoords, waypoints, res.branches[0].coordinates, {
    kind: 'segment',
    baseStartM: res.branches[0].baseStartM,
    baseEndM: res.branches[0].baseEndM,
  });
  assert.equal(segSplices.length, 1);
  assert.equal(segSplices[0].legIdx, 0);

  // Even if a clipped branch ended right on B's coordinates, planBranchLegSplices keeps it in leg 0
  const clippedBranch: [number, number][] = [
    [-0.24, 51.35],
    [-0.26, 51.30],
    [-0.27, 51.26],
  ];
  const safeSplices = planBranchLegSplices(baseCoords, waypoints, clippedBranch, {
    kind: 'segment',
    baseStartM: 8500,
    baseEndM: 47000,
  });
  assert.equal(safeSplices.length, 1);
  assert.equal(safeSplices[0].legIdx, 0);

  // Applying the full variant only splices leg 0 (the changed leg) and leaves legs 1, 2, 3 intact
  const varSplices = planBranchLegSplices(baseCoords, waypoints, probeCoords, {
    kind: 'variant',
  });
  assert.deepEqual(
    varSplices.map((s) => s.legIdx),
    [0],
  );
});

test('createRobustnessSession aggregates independent local forks into separate branches', () => {
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
    id: 'sample-1',
    kind: 'sample',
    label: 'Sample #1',
    dimension: 'Surface',
    description: 'Fork A',
    u: zeroVec({ surface: -0.8 }),
    norm: 0.8,
    fullDsl: 'dsl-a',
    route: makeMockRoute(forkAOnly, 8800, 1650, 55),
  });
  session.addProbe({
    id: 'sample-2',
    kind: 'sample',
    label: 'Sample #2',
    dimension: 'Traffic',
    description: 'Fork B',
    u: zeroVec({ traffic: 0.8 }),
    norm: 0.8,
    fullDsl: 'dsl-b',
    route: makeMockRoute(forkBOnly, 8900, 1680, 52),
  });
  session.addProbe({
    id: 'sample-3',
    kind: 'sample',
    label: 'Sample #3',
    dimension: 'Surface',
    description: 'Both forks',
    u: zeroVec({ surface: -0.7, traffic: 0.7 }),
    norm: Math.hypot(0.7, 0.7),
    fullDsl: 'dsl-ab',
    route: makeMockRoute(bothForks, 9300, 1730, 57),
  });

  const snap = session.snapshot();
  assert.equal(snap.branches.length, 2, 'Expected exactly 2 distinct local detour branches');
  assert.equal(snap.branches[0].probeCount, 2);
  assert.equal(snap.branches[1].probeCount, 2);
});

test(
  'end-to-end 40-scenario pure QMC WASM sweep on Whitebushes to Leith Hill',
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
        u: p.u,
        norm: p.norm,
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
    assert.ok(analysis.branches.length >= 2);
    assert.ok(analysis.corridors.length >= 2);
  },
);

test(
  '80-scenario pure QMC sweep on Tooting to Roehampton Gate (gabis-lite-gravel) discovers Wimbledon Common',
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
        u: p.u,
        norm: p.norm,
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

    const commonBranches = analysis.branches.filter((b) => crossesWimbledonCommon(b.coordinates));
    assert.ok(
      commonBranches.length >= 1,
      'Expected pure QMC sweep to discover Wimbledon Common detour branch',
    );
    assert.ok(
      commonBranches[0].branchMix.hasData && commonBranches[0].branchMix.unpavedPct > 0,
      'Expected Wimbledon Common branch to carry unpaved surface mix metadata',
    );
    assert.ok(
      commonBranches[0].probeLabels.some((lbl) => /off-road|gravel|green/i.test(lbl)),
      `Expected statistical driver chips to identify off-road/gravel, got: ${commonBranches[0].probeLabels.join(', ')}`,
    );
  },
);
