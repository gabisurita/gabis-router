import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import initWasm, { WasmRouter } from '../src/pkg/rsrouter_wasm.js';
import type { LatLon } from '../src/types.ts';
import {
  generateBrfFromAxes,
  TEMPLATE_PRESETS,
  type BaseTemplateId,
  type ProfileAxes,
} from '../src/utils/profile-editor.ts';

export interface RouteStep {
  fromM: number;
  toM: number;
  distM: number;
  lat: number;
  lon: number;
  costfactor: number;
  turnCost: number;
  tags: Record<string, string>;
  nodeTags: Record<string, string>;
}

const SEGMENTS_DIR = path.resolve(import.meta.dirname, '../../data/segments4');
const LOOKUPS_PATH = path.resolve(import.meta.dirname, '../public/profiles/lookups.dat');
const WASM_PATH = path.resolve(import.meta.dirname, '../src/pkg/rsrouter_wasm_bg.wasm');
const HAS_RD5_DATA = fs.existsSync(path.join(SEGMENTS_DIR, 'W5_N50.rd5'));

let sharedRouter: WasmRouter | null = null;
let wasmMemory: WebAssembly.Memory | null = null;

async function getRouter(): Promise<WasmRouter> {
  if (sharedRouter) return sharedRouter;

  const wasmOut = await initWasm({ module_or_path: fs.readFileSync(WASM_PATH) });
  wasmMemory = wasmOut.memory;
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
  router.load_lookups(fs.readFileSync(LOOKUPS_PATH, 'utf8'));
  sharedRouter = router;
  return router;
}

function parseTagMap(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of raw.split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq > 0) out[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return out;
}

export interface NogoCircle {
  lat: number;
  lon: number;
  radiusM: number;
}

export async function computeRouteSteps(
  profile: BaseTemplateId,
  waypoints: LatLon[],
  axesOverride?: Partial<ProfileAxes>,
  nogos?: NogoCircle[],
): Promise<RouteStep[]> {
  const router = await getRouter();
  const axes: ProfileAxes = { ...TEMPLATE_PRESETS[profile].axes, ...axesOverride };
  const brf = generateBrfFromAxes(axes, { name: profile }).replace(
    'assign processUnusedTags            = false',
    'assign processUnusedTags            = true',
  );

  router.load_profile(profile, brf);
  const wpStr = waypoints.map((w) => `${w.lon},${w.lat}`).join('|');
  const nogoStr =
    nogos && nogos.length > 0
      ? nogos.map((n) => `${n.lon},${n.lat},${n.radiusM}`).join('|')
      : undefined;
  const geojson = JSON.parse(router.route(wpStr, profile, 0, nogoStr));
  const messages: string[][] = geojson.features[0].properties.messages || [];

  let cumDist = 0;
  return messages.slice(1).map((m) => {
    const distM = Number(m[3]);
    const fromM = cumDist;
    cumDist += distM;
    return {
      fromM,
      toM: cumDist,
      distM,
      lon: Number(m[0]) / 1e6,
      lat: Number(m[1]) / 1e6,
      costfactor: Number(m[4]) / 1000,
      turnCost: Number(m[6]),
      tags: parseTagMap(m[9] || ''),
      nodeTags: parseTagMap(m[10] || ''),
    };
  });
}

function sumMeters(steps: RouteStep[]): number {
  return steps.reduce((sum, s) => sum + s.distM, 0);
}

function formatSteps(steps: RouteStep[]): string {
  return steps
    .map(
      (s) =>
        `(${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}) ${s.distM}m cf=${s.costfactor} tc=${s.turnCost} ` +
        `highway=${s.tags.highway ?? '-'} surface=${s.tags.surface ?? '-'} ` +
        `maxspeed=${s.tags.maxspeed ?? '-'} barrier=${s.nodeTags.barrier ?? '-'}`,
    )
    .join('; ');
}

// Reusable step predicates across routes and locations
const SMOOTH_PAVED = new Set(['asphalt', 'paved', 'concrete']);
const MAJOR_ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const OFFROAD_HIGHWAYS = new Set(['bridleway', 'track', 'path', 'footway']);
const FARMLAND_BARRIERS = new Set(['gate', 'stile', 'kissing_gate']);

const isTrunkRoad = (s: RouteStep) =>
  s.tags.highway === 'trunk' || s.tags.highway === 'trunk_link';

const isHighSpeedLevelCrossing = (s: RouteStep) =>
  !MAJOR_ROADS.has(s.tags.highway) &&
  s.distM <= 30 &&
  Number(s.tags.estimated_noise_class || 0) >= 6 &&
  Number(s.tags.maxspeed || 0) >= 80 &&
  s.tags.bridge !== 'yes' &&
  s.tags.tunnel !== 'yes';

const isUnpavedOffroad = (s: RouteStep) =>
  OFFROAD_HIGHWAYS.has(s.tags.highway) && !SMOOTH_PAVED.has(s.tags.surface);

const hasFarmlandBarrier = (s: RouteStep) => FARMLAND_BARRIERS.has(s.nodeTags.barrier);

// BRouter reports turnCost = (1 - cos(angle)) * turncost (e.g. 90 for a 90 deg turn at turncost=90).
const isSharpTurn = (s: RouteStep) => s.turnCost >= 50;

const isFootway = (s: RouteStep) =>
  s.fromM >= 100 &&
  s.tags.highway === 'footway' &&
  s.tags.footway !== 'crossing' &&
  s.tags.bicycle !== 'yes' &&
  s.tags.bicycle !== 'designated';

const isMotorRoadTunnel = (s: RouteStep) =>
  s.tags.tunnel === 'yes' &&
  s.distM >= 100 &&
  MAJOR_ROADS.has(s.tags.highway) &&
  (!s.tags.cycleway || s.tags.cycleway === 'no' || s.tags.cycleway === 'none');

// Waypoints
const WHITEBUSHES: LatLon = { lat: 51.2182, lon: -0.16652 };
const HOLMWOOD: LatLon = { lat: 51.18163, lon: -0.33107 };
const LEITH_HILL: LatLon = { lat: 51.17533, lon: -0.36885 };
const TOOTING: LatLon = { lat: 51.41989, lon: -0.16161 };
const COAL_DROPS_YARD: LatLon = { lat: 51.53458, lon: -0.12522 };
const TOOTING_BROADWAY: LatLon = { lat: 51.41563, lon: -0.15851 };
const WIMBLEDON: LatLon = { lat: 51.42564, lon: -0.22042 };
const KINGSTON_VALE: LatLon = { lat: 51.43662, lon: -0.25692 };
const BRIXTON: LatLon = { lat: 51.46339, lon: -0.1148 };
const HACKNEY_WICK: LatLon = { lat: 51.5449, lon: -0.02036 };
const BLACKFRIARS_BRIDGE_NOGO: NogoCircle = { lat: 51.50988, lon: -0.1045, radiusM: 50 };
const LONDON_BRIDGE_NOGO: NogoCircle = { lat: 51.50834, lon: -0.08797, radiusM: 50 };

test(
  'Whitebushes to Leith Hill (gabis-fast-city)',
  { skip: !HAS_RD5_DATA },
  async (t) => {
    const steps = await computeRouteSteps('gabis-fast-city', [WHITEBUSHES, LEITH_HILL]);

    await t.test('avoids level crossings of high-speed trunk roads', () => {
      const crossings = steps.filter(isHighSpeedLevelCrossing);
      assert.equal(crossings.length, 0, formatSteps(crossings));
    });

    await t.test('avoids unpaved off-road segments', () => {
      const offroad = steps.filter(isUnpavedOffroad);
      assert.equal(sumMeters(offroad), 0, formatSteps(offroad));
    });
  },
);

test(
  'Whitebushes to Leith Hill via Holmwood (gabis-fast-city)',
  { skip: !HAS_RD5_DATA },
  async (t) => {
    const steps = await computeRouteSteps('gabis-fast-city', [WHITEBUSHES, HOLMWOOD, LEITH_HILL]);

    await t.test('avoids riding on trunk roads', () => {
      const trunk = steps.filter(isTrunkRoad);
      assert.equal(sumMeters(trunk), 0, formatSteps(trunk));
    });
  },
);

test(
  'Tooting to Coal Drops Yard (gabis-fast-city)',
  { skip: !HAS_RD5_DATA },
  async (t) => {
    const steps = await computeRouteSteps('gabis-fast-city', [TOOTING, COAL_DROPS_YARD]);

    await t.test('avoids zig-zagging between Vauxhall and Waterloo', () => {
      const vauxhallToWaterloo = steps.filter((s) => s.lat >= 51.482 && s.lat <= 51.502);
      const sharpTurns = vauxhallToWaterloo.filter(isSharpTurn);
      assert.ok(
        sharpTurns.length <= 6,
        `Expected <= 6 sharp turns in Vauxhall/Waterloo corridor, got ${sharpTurns.length}: ${formatSteps(sharpTurns)}`,
      );
    });
  },
);

test(
  'Tooting to Kingston Vale via Wimbledon (gabis-fast-city)',
  { skip: !HAS_RD5_DATA },
  async (t) => {
    const steps = await computeRouteSteps('gabis-fast-city', [
      TOOTING_BROADWAY,
      WIMBLEDON,
      KINGSTON_VALE,
    ]);

    await t.test('avoids footways', () => {
      const footways = steps.filter(isFootway);
      assert.equal(sumMeters(footways), 0, formatSteps(footways));
    });
  },
);

test(
  'Brixton to Hackney (gabis-fast-city)',
  { skip: !HAS_RD5_DATA },
  async (t) => {
    const steps = await computeRouteSteps(
      'gabis-fast-city',
      [BRIXTON, HACKNEY_WICK],
      undefined,
      [BLACKFRIARS_BRIDGE_NOGO, LONDON_BRIDGE_NOGO],
    );

    await t.test('avoids Rotherhithe Tunnel and motor road tunnels', () => {
      const tunnels = steps.filter(isMotorRoadTunnel);
      assert.equal(sumMeters(tunnels), 0, formatSteps(tunnels));
    });
  },
);

test(
  'Repeated custom profile edits evict stale cost tables and keep WASM memory bounded',
  { skip: !HAS_RD5_DATA },
  async () => {
    const router = await getRouter();
    const wpStr = `${TOOTING_BROADWAY.lon},${TOOTING_BROADWAY.lat}|${WIMBLEDON.lon},${WIMBLEDON.lat}`;

    const warmupBrf = generateBrfFromAxes(TEMPLATE_PRESETS['gabis-safe-road'].axes, {
      name: 'Safe Road Custom',
    });
    router.load_profile('custom:__draft__', warmupBrf);
    router.route(wpStr, 'custom:__draft__', 0, undefined);

    const baselineBytes = wasmMemory!.buffer.byteLength;
    assert.ok(router.description_count() > 1000, 'Expected interned way descriptions after routing');

    for (let i = 1; i <= 15; i++) {
      const axes: ProfileAxes = {
        ...TEMPLATE_PRESETS['gabis-safe-road'].axes,
        primaryCost: Number((0.2 + i * 0.1).toFixed(2)),
        forestUntaggedPenalty: Number((0.1 + i * 0.05).toFixed(2)),
      };
      const brf = generateBrfFromAxes(axes, { name: 'Safe Road Custom' });
      router.load_profile('custom:__draft__', brf);
      router.route(wpStr, 'custom:__draft__', 0, undefined);
    }

    const afterBytes = wasmMemory!.buffer.byteLength;
    const growthMb = (afterBytes - baselineBytes) / (1024 * 1024);
    assert.ok(
      growthMb <= 16,
      `Expected WASM memory growth <= 16 MB across 15 profile reloads, got ${growthMb.toFixed(2)} MB`,
    );
    router.remove_profile('custom:__draft__');
  },
);
