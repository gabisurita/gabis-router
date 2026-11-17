import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getSlotColor,
  MAX_ROUTE_SLOTS,
  MAX_ROUTES,
  MAX_TOTAL_SLOTS,
  PROFILE_INFO,
  PROFILE_ORDER,
  ROUTE_COLOR_PALETTE,
  type AvoidArea,
  type LatLon,
  type PointWayInfo,
  type ProfileMeta,
  type ProfileName,
  type RouteSlotState,
  type WorkerMessage,
  type WorkerPhase,
} from '../types.ts';
import { HistoryStack } from '../history.ts';
import { legIndexAt } from '../utils/geo.ts';
import {
  loadSavedCustomProfiles,
  saveCustomProfilesToStorage,
  type CustomProfileRecord,
} from '../utils/profile-editor.ts';
import type { SavedRouteRecord } from '../utils/saved-routes.ts';

const STORAGE_KEY = 'rsrouter_route';
const MAX_UNDO = 50;
export const DEFAULT_AVOID_RADIUS_M = 50;

// Safeguard 2 (Shared WebAssembly.Module compilation):
// Compile rsrouter_wasm_bg.wasm once on the main thread and pass the resulting
// WebAssembly.Module to every spawned Worker via INIT. WebAssembly.Module is
// structured-cloneable across postMessage, so respawned Workers after an in-flight
// abort call WebAssembly.instantiate(module, imports) directly without re-fetching
// or recompiling .wasm JIT machine code pages.
let cachedWasmModule: WebAssembly.Module | undefined;
let wasmModulePromise: Promise<WebAssembly.Module | undefined> | null = null;

function getSharedWasmModule(): Promise<WebAssembly.Module | undefined> {
  if (cachedWasmModule) {
    return Promise.resolve(cachedWasmModule);
  }
  if (!wasmModulePromise) {
    const wasmUrl = new URL('../pkg/rsrouter_wasm_bg.wasm', import.meta.url);
    wasmModulePromise = (async () => {
      try {
        if (typeof WebAssembly.compileStreaming === 'function') {
          try {
            const mod = await WebAssembly.compileStreaming(fetch(wasmUrl));
            cachedWasmModule = mod;
            return mod;
          } catch {
            // Fall back to ArrayBuffer compilation if server MIME type is not application/wasm.
          }
        }
        const res = await fetch(wasmUrl);
        if (!res.ok) return undefined;
        const bytes = await res.arrayBuffer();
        const mod = await WebAssembly.compile(bytes);
        cachedWasmModule = mod;
        return mod;
      } catch {
        wasmModulePromise = null;
        return undefined;
      }
    })();
  }
  return wasmModulePromise;
}

interface RouteHistorySnapshot {
  waypoints: LatLon[];
  avoidAreas: AvoidArea[];
}

export interface ParsedSlotSeed {
  routeIdx: number;
  profile: ProfileName;
  waypoints: LatLon[];
  avoidAreas: AvoidArea[];
  colorId?: string;
}

export interface ParsedRouteState {
  slots: ParsedSlotSeed[];
  activeSlotIdx: number;
}

function getRouteCount(slots: Array<{ routeIdx?: number }>): number {
  if (slots.length === 0) return 1;
  let maxRouteIdx = 0;
  for (const s of slots) {
    if (typeof s.routeIdx === 'number' && s.routeIdx > maxRouteIdx) {
      maxRouteIdx = s.routeIdx;
    }
  }
  return maxRouteIdx + 1;
}

function validPoint(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function validProfile(p: string | undefined): p is ProfileName {
  if (!p) return false;
  if (p in PROFILE_INFO) return true;
  if (p.startsWith('custom:')) {
    return loadSavedCustomProfiles().some((c) => c.id === p);
  }
  return false;
}

function parseProfilesParam(raw: string | undefined): ProfileName[] | undefined {
  if (!raw) return undefined;
  const decoded = decodeURIComponent(raw);
  const list = decoded
    .split(',')
    .map((s) => s.trim())
    .filter(validProfile)
    .slice(0, MAX_ROUTE_SLOTS);
  return list.length > 0 ? list : undefined;
}

function parseWaypointsParam(raw: string | undefined): LatLon[] {
  const points: LatLon[] = [];
  if (!raw) return points;
  for (const pair of raw.split(';')) {
    if (!pair) continue;
    const [lat, lon] = pair.split(',').map(Number);
    if (validPoint(lat, lon)) {
      points.push({ lat, lon });
    }
  }
  return points;
}

function parseAvoidAreasParam(raw: string | undefined): AvoidArea[] {
  const parsedAvoidAreas: AvoidArea[] = [];
  if (!raw) return parsedAvoidAreas;
  for (const item of decodeURIComponent(raw).split(';')) {
    if (!item) continue;
    const parts = item.split(',').map(Number);
    if (parts.length >= 3 && validPoint(parts[1], parts[0])) {
      parsedAvoidAreas.push({
        lon: parts[0],
        lat: parts[1],
        radius: Math.max(10, parts[2] || DEFAULT_AVOID_RADIUS_M),
        weight: parts[3],
      });
    }
  }
  return parsedAvoidAreas;
}

export function parseRouteHash(hashStr = typeof location !== 'undefined' ? location.hash : ''): ParsedRouteState | null {
  const getParam = (key: string): string | undefined => {
    const m = new RegExp(`(?:^#|&)${key}=([^&]*)`).exec(hashStr);
    return m ? m[1] : undefined;
  };

  const rawR1 = getParam('r');
  const rawR2 = getParam('r2');
  const rawR3 = getParam('r3');
  const rawN1 = getParam('nogos');
  const rawN2 = getParam('nogos2');
  const rawN3 = getParam('nogos3');
  const rawP1 = getParam('p');
  const rawP2 = getParam('p2');
  const rawP3 = getParam('p3');
  const rawColors = getParam('c');
  const rawActive = getParam('a');

  if (
    rawR1 === undefined &&
    rawR2 === undefined &&
    rawR3 === undefined &&
    rawN1 === undefined &&
    rawN2 === undefined &&
    rawN3 === undefined &&
    rawP1 === undefined &&
    rawP2 === undefined &&
    rawP3 === undefined
  ) {
    return null;
  }

  let routeCount = 1;
  if (rawR3 !== undefined || rawN3 !== undefined || rawP3 !== undefined) {
    routeCount = 3;
  } else if (rawR2 !== undefined || rawN2 !== undefined || rawP2 !== undefined) {
    routeCount = 2;
  }

  const p1List = parseProfilesParam(rawP1);
  const p2List = parseProfilesParam(rawP2);
  const p3List = parseProfilesParam(rawP3);
  const colors = rawColors
    ? decodeURIComponent(rawColors)
        .split(',')
        .map((c) => c.trim())
    : [];

  const rawRs = [rawR1, rawR2, rawR3];
  const rawNs = [rawN1, rawN2, rawN3];
  const rawPs = [p1List, p2List, p3List];
  const legacyMultiRouteP = routeCount > 1 && rawP2 === undefined && rawP3 === undefined;

  const slots: ParsedSlotSeed[] = [];
  for (let rIdx = 0; rIdx < routeCount; rIdx++) {
    const waypoints = parseWaypointsParam(rawRs[rIdx]);
    const avoidAreas = parseAvoidAreasParam(rawNs[rIdx]);
    let routeProfiles: ProfileName[];
    if (legacyMultiRouteP) {
      routeProfiles = [p1List?.[rIdx] || PROFILE_ORDER[rIdx] || PROFILE_ORDER[0]];
    } else {
      routeProfiles = rawPs[rIdx] || [PROFILE_ORDER[rIdx] || PROFILE_ORDER[0]];
    }

    for (const prof of routeProfiles) {
      const flatIdx = slots.length;
      const colorId = colors[flatIdx] || ROUTE_COLOR_PALETTE[flatIdx % ROUTE_COLOR_PALETTE.length]?.id;
      slots.push({
        routeIdx: rIdx,
        profile: prof,
        waypoints: waypoints.map((w) => ({ ...w })),
        avoidAreas: avoidAreas.map((a) => ({ ...a })),
        colorId,
      });
    }
  }

  const parsedActiveRoute = rawActive ? Number(rawActive) - 1 : 0;
  let activeSlotIdx = 0;
  if (Number.isInteger(parsedActiveRoute) && parsedActiveRoute >= 0 && parsedActiveRoute < routeCount) {
    const foundIdx = slots.findIndex((s) => s.routeIdx === parsedActiveRoute);
    if (foundIdx !== -1) activeSlotIdx = foundIdx;
  }

  return { slots, activeSlotIdx };
}

export function formatRouteHash(
  slots: Array<Pick<RouteSlotState, 'routeIdx' | 'profile' | 'waypoints' | 'avoidAreas' | 'colorId'>>,
  activeSlotIdx = 0,
): string {
  const hasExplicitRouteIdx = slots.some((s) => s.routeIdx !== undefined);
  const normalized = slots.map((s, idx) => ({
    ...s,
    routeIdx: hasExplicitRouteIdx ? (s.routeIdx ?? 0) : idx,
  }));

  const routeCount = getRouteCount(normalized);
  const anyContent = normalized.some((s) => s.waypoints.length > 0 || s.avoidAreas.length > 0);
  if (!anyContent && normalized.length <= 1 && routeCount <= 1) {
    return '';
  }

  const parts: string[] = [];
  const multiRoute = routeCount > 1;

  for (let rIdx = 0; rIdx < routeCount; rIdx++) {
    const routeSlots = normalized.filter((s) => s.routeIdx === rIdx);
    const first = routeSlots[0];
    if (!first) continue;
    const rKey = rIdx === 0 ? 'r' : `r${rIdx + 1}`;
    if (multiRoute || first.waypoints.length > 0) {
      const rVal = first.waypoints.map((w) => `${w.lat.toFixed(5)},${w.lon.toFixed(5)}`).join(';');
      parts.push(`${rKey}=${rVal}`);
    }
  }

  for (let rIdx = 0; rIdx < routeCount; rIdx++) {
    const routeSlots = normalized.filter((s) => s.routeIdx === rIdx);
    if (routeSlots.length === 0) continue;
    const pKey = rIdx === 0 ? 'p' : `p${rIdx + 1}`;
    const profs = routeSlots.map((s) => s.profile);
    parts.push(`${pKey}=${profs.map(encodeURIComponent).join(',')}`);
  }

  for (let rIdx = 0; rIdx < routeCount; rIdx++) {
    const routeSlots = normalized.filter((s) => s.routeIdx === rIdx);
    const first = routeSlots[0];
    if (first && first.avoidAreas.length > 0) {
      const nKey = rIdx === 0 ? 'nogos' : `nogos${rIdx + 1}`;
      const nogos = first.avoidAreas
        .map(
          (a) =>
            `${a.lon.toFixed(5)},${a.lat.toFixed(5)},${Math.round(a.radius)}${
              a.weight !== undefined ? ',' + a.weight : ''
            }`,
        )
        .join(';');
      parts.push(`${nKey}=${encodeURIComponent(nogos)}`);
    }
  }

  const activeRouteIdx = normalized[activeSlotIdx]?.routeIdx ?? 0;
  if (activeRouteIdx > 0 && activeRouteIdx < routeCount) {
    parts.push(`a=${activeRouteIdx + 1}`);
  }

  return '#' + parts.join('&');
}

function loadSavedWorkspace(): ParsedRouteState | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    if (Array.isArray(parsed.slots) && parsed.slots.length > 0) {
      const slots: ParsedSlotSeed[] = parsed.slots
        .slice(0, MAX_TOTAL_SLOTS)
        .map((s: any, idx: number) => ({
          routeIdx: typeof s?.routeIdx === 'number' && s.routeIdx >= 0 && s.routeIdx < MAX_ROUTES ? s.routeIdx : 0,
          profile: validProfile(s?.profile) ? s.profile : PROFILE_ORDER[idx] || PROFILE_ORDER[0],
          colorId: typeof s?.colorId === 'string' ? s.colorId : ROUTE_COLOR_PALETTE[idx % ROUTE_COLOR_PALETTE.length]?.id,
          waypoints: Array.isArray(s?.waypoints)
            ? s.waypoints.filter((w: any) => w && validPoint(Number(w.lat), Number(w.lon)))
            : [],
          avoidAreas: Array.isArray(s?.avoidAreas)
            ? s.avoidAreas.filter((a: any) => a && validPoint(Number(a.lat), Number(a.lon)))
            : [],
        }));
      const activeSlotIdx =
        typeof parsed.activeSlotIdx === 'number' &&
        parsed.activeSlotIdx >= 0 &&
        parsed.activeSlotIdx < slots.length
          ? parsed.activeSlotIdx
          : 0;
      return { slots, activeSlotIdx };
    }

    let profiles: ProfileName[] = [PROFILE_ORDER[0]];
    if (Array.isArray(parsed.profiles)) {
      const filtered = parsed.profiles.filter(validProfile).slice(0, MAX_ROUTE_SLOTS);
      if (filtered.length > 0) profiles = filtered;
    } else if (validProfile(parsed.profile)) {
      profiles = [parsed.profile];
    }
    const colors = Array.isArray(parsed.colors)
      ? parsed.colors.filter((c: any) => typeof c === 'string')
      : [];
    const waypoints: LatLon[] = Array.isArray(parsed.waypoints)
      ? parsed.waypoints.filter((w: any) => w && validPoint(Number(w.lat), Number(w.lon)))
      : [];
    const avoidAreas: AvoidArea[] = Array.isArray(parsed.avoidAreas)
      ? parsed.avoidAreas.filter((a: any) => a && validPoint(Number(a.lat), Number(a.lon)))
      : [];

    return {
      slots: profiles.map((p, idx) => ({
        routeIdx: 0,
        profile: p,
        colorId: colors[idx] || ROUTE_COLOR_PALETTE[idx]?.id,
        waypoints: waypoints.map((w) => ({ ...w })),
        avoidAreas: avoidAreas.map((a) => ({ ...a })),
      })),
      activeSlotIdx: 0,
    };
  } catch {
    return null;
  }
}

function mergeSavedWaypointNames(waypoints: LatLon[], savedPool: LatLon[]): LatLon[] {
  if (!savedPool || savedPool.length === 0) return waypoints;
  return waypoints.map((w) => {
    if (w.name) return w;
    const match = savedPool.find(
      (s) => s.name && Math.abs(s.lat - w.lat) < 1e-5 && Math.abs(s.lon - w.lon) < 1e-5,
    );
    return match ? { ...w, name: match.name } : w;
  });
}

export function useRouting(isOfflineMode: boolean) {
  const [customProfiles, setCustomProfiles] = useState<CustomProfileRecord[]>(() =>
    loadSavedCustomProfiles(),
  );
  const [draftProfile, setDraftProfileState] = useState<CustomProfileRecord | null>(null);
  const [customProfileError, setCustomProfileError] = useState<string | null>(null);
  const [slots, setSlotsState] = useState<RouteSlotState[]>([
    {
      routeIdx: 0,
      profile: PROFILE_ORDER[0],
      waypoints: [],
      avoidAreas: [],
      alternativeIdx: 0,
      route: null,
      isRouting: false,
      colorId: ROUTE_COLOR_PALETTE[0].id,
    },
  ]);
  const [activeSlotIdx, setActiveSlotIdxState] = useState<number>(0);
  const [status, setStatus] = useState<string>(
    'Click on the map or search to set start and end points.',
  );
  const [isError, setIsError] = useState<boolean>(false);
  const [canUndo, setCanUndo] = useState<boolean>(false);
  const [canRedo, setCanRedo] = useState<boolean>(false);
  const [fitBoundsSeq, setFitBoundsSeq] = useState<number>(0);
  const [savedRouteIdsByRoute, setSavedRouteIdsByRoute] = useState<Array<number | null>>([null]);

  const historiesRef = useRef<Array<HistoryStack<RouteHistorySnapshot>>>([
    new HistoryStack<RouteHistorySnapshot>(MAX_UNDO),
  ]);
  const workerRef = useRef<Worker | null>(null);
  const workerPhaseRef = useRef<WorkerPhase>('idle');
  const isOfflineModeRef = useRef<boolean>(isOfflineMode);
  isOfflineModeRef.current = isOfflineMode;
  const activeSlotRouteIdRef = useRef<Array<string | null>>([null]);
  const activeImportRef = useRef<{ id: string; routeIdx: number } | null>(null);
  const pendingInspectCallbacksRef = useRef<Map<string, (info: PointWayInfo | null) => void>>(
    new Map(),
  );
  const initCompletedRef = useRef<boolean>(false);
  const routeCounterRef = useRef<number>(0);
  const requestedSlotAltRef = useRef<number[]>([0]);
  const shownSlotAltRef = useRef<number[]>([0]);

  const customProfilesRef = useRef<CustomProfileRecord[]>(customProfiles);
  customProfilesRef.current = customProfiles;
  const draftProfileRef = useRef<CustomProfileRecord | null>(draftProfile);
  draftProfileRef.current = draftProfile;
  const slotsRef = useRef<RouteSlotState[]>(slots);
  slotsRef.current = slots;
  const activeSlotIdxRef = useRef<number>(activeSlotIdx);
  activeSlotIdxRef.current = activeSlotIdx;
  const savedRouteIdsByRouteRef = useRef<Array<number | null>>(savedRouteIdsByRoute);
  savedRouteIdsByRouteRef.current = savedRouteIdsByRoute;

  const setRouteSavedId = useCallback((routeIdx: number, id: number | null) => {
    setSavedRouteIdsByRoute((prev) => {
      const next = [...prev];
      while (next.length <= routeIdx) next.push(null);
      if (next[routeIdx] === id) return prev;
      next[routeIdx] = id;
      savedRouteIdsByRouteRef.current = next;
      return next;
    });
  }, []);

  const clearDeletedSavedRouteId = useCallback((deletedId: number) => {
    setSavedRouteIdsByRoute((prev) => {
      if (!prev.includes(deletedId)) return prev;
      const next = prev.map((id) => (id === deletedId ? null : id));
      savedRouteIdsByRouteRef.current = next;
      return next;
    });
  }, []);

  const setDraftProfile = useCallback((next: CustomProfileRecord | null) => {
    draftProfileRef.current = next;
    setDraftProfileState(next);
  }, []);

  const getProfileMeta = useCallback(
    (profileId: ProfileName): ProfileMeta => {
      if (profileId in PROFILE_INFO) {
        return PROFILE_INFO[profileId];
      }
      if (draftProfile && draftProfile.id === profileId) {
        const name = draftProfile.name.trim() || 'Custom Profile';
        return {
          id: profileId,
          label: name,
          shortLabel: name,
          summary: draftProfile.summary || 'Custom routing profile.',
          isCustom: true,
        };
      }
      const found = customProfiles.find((c) => c.id === profileId);
      if (found) {
        return {
          id: found.id,
          label: found.name,
          shortLabel: found.name,
          summary: found.summary || 'Custom routing profile.',
          isCustom: true,
        };
      }
      if (profileId === 'custom:__draft__') {
        const name = draftProfile?.name?.trim() || 'Custom Profile';
        return {
          id: profileId,
          label: name,
          shortLabel: name,
          summary: draftProfile?.summary || 'Custom routing profile.',
          isCustom: true,
        };
      }
      const fallbackName = profileId.startsWith('custom:')
        ? profileId.slice('custom:'.length)
        : profileId;
      return {
        id: profileId,
        label: fallbackName,
        shortLabel: fallbackName,
        summary: 'Custom routing profile.',
        isCustom: true,
      };
    },
    [customProfiles, draftProfile],
  );

  const updateUndoRedo = useCallback((slotIdx = activeSlotIdxRef.current) => {
    const routeIdx = slotsRef.current[slotIdx]?.routeIdx ?? 0;
    const h = historiesRef.current[routeIdx];
    setCanUndo(Boolean(h?.canUndo()));
    setCanRedo(Boolean(h?.canRedo()));
  }, []);

  const setStatusMsg = useCallback((msg: string, error = false) => {
    setStatus(msg);
    setIsError(error);
  }, []);

  const saveToUrlAndStorage = useCallback(
    (currentSlots: RouteSlotState[], activeIdx = activeSlotIdxRef.current) => {
      const safeSlots =
        currentSlots.length > 0
          ? currentSlots
          : [
              {
                routeIdx: 0,
                profile: PROFILE_ORDER[0],
                waypoints: [],
                avoidAreas: [],
                alternativeIdx: 0,
                route: null,
                isRouting: false,
                colorId: ROUTE_COLOR_PALETTE[0].id,
              },
            ];
      const colors = safeSlots.map((s, idx) => getSlotColor(s, idx).id);
      const profs = safeSlots.map((s) => s.profile);
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            slots: safeSlots.map((s, idx) => ({
              routeIdx: s.routeIdx ?? 0,
              profile: s.profile,
              colorId: colors[idx],
              waypoints: s.waypoints,
              avoidAreas: s.avoidAreas,
            })),
            activeSlotIdx: activeIdx,
            waypoints: safeSlots[0].waypoints,
            profile: safeSlots[0].profile,
            profiles: profs,
            colors,
            avoidAreas: safeSlots[0].avoidAreas,
          }),
        );
      } catch {}

      const hash = formatRouteHash(safeSlots, activeIdx);
      if (!hash) {
        history.replaceState(null, '', location.pathname + location.search);
      } else {
        history.replaceState(null, '', location.pathname + location.search + hash);
      }
    },
    [],
  );

  const postSlotRouteRequest = useCallback(
    (slotIdx: number, wps: LatLon[], prof: ProfileName, avoids: AvoidArea[], altIdx = 0) => {
      if (!workerRef.current || wps.length < 2) return;
      const id = String(++routeCounterRef.current);
      activeSlotRouteIdRef.current[slotIdx] = id;
      requestedSlotAltRef.current[slotIdx] = altIdx;

      workerRef.current.postMessage({
        type: 'ROUTE_REQUEST',
        id,
        slotIdx,
        payload: {
          waypoints: wps,
          profile: prof,
          alternativeIdx: altIdx,
          nogos: avoids.length > 0 ? avoids : undefined,
        },
      } satisfies WorkerMessage);
    },
    [],
  );

  const requestSlotsRoutes = useCallback(
    (currentSlots: RouteSlotState[], slotIndicesToRoute?: number[], resetAlt = true) => {
      const indices =
        slotIndicesToRoute ?? currentSlots.map((_, idx) => idx);
      const indexSet = new Set(indices);

      let anyToCompute = false;
      const updated = currentSlots.map((s, idx) => {
        if (!indexSet.has(idx)) return s;
        if (s.waypoints.length < 2) {
          activeSlotRouteIdRef.current[idx] = null;
          requestedSlotAltRef.current[idx] = 0;
          shownSlotAltRef.current[idx] = 0;
          return {
            ...s,
            alternativeIdx: 0,
            route: null,
            isRouting: false,
          };
        }
        anyToCompute = true;
        const alt = resetAlt ? 0 : s.alternativeIdx;
        if (resetAlt) {
          requestedSlotAltRef.current[idx] = 0;
          shownSlotAltRef.current[idx] = 0;
        }
        return {
          ...s,
          alternativeIdx: alt,
          isRouting: Boolean(workerRef.current),
        };
      });

      slotsRef.current = updated;
      setSlotsState(updated);

      if (!anyToCompute) {
        const activeSlot = updated[activeSlotIdxRef.current] || updated[0];
        const anyStillRouting = updated.some((s) => s.isRouting);
        if (!anyStillRouting) {
          setIsError(false);
          setStatus(
            activeSlot.waypoints.length === 1
              ? 'Start point set. Click on the map or search to set destination.'
              : 'Click on the map or search to set start and end points.',
          );
        }
        return;
      }

      if (!workerRef.current) return;
      setStatus('Calculating route...');
      setIsError(false);

      updated.forEach((slot, idx) => {
        if (indexSet.has(idx) && slot.waypoints.length >= 2) {
          postSlotRouteRequest(idx, slot.waypoints, slot.profile, slot.avoidAreas, slot.alternativeIdx);
        }
      });
    },
    [postSlotRouteRequest],
  );

  const spawnRoutingWorker = useCallback((): Worker => {
    const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    workerPhaseRef.current = 'idle';
    initCompletedRef.current = false;

    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      if (workerRef.current !== worker) return;
      const msg = e.data;
      switch (msg.type) {
        case 'WORKER_PHASE': {
          workerPhaseRef.current = msg.phase;
          break;
        }
        case 'STATUS': {
          const anyActive =
            activeImportRef.current !== null ||
            activeSlotRouteIdRef.current.some((id) => id !== null);
          const anyWps = slotsRef.current.some((s) => s.waypoints.length > 0);
          if (!initCompletedRef.current) {
            if (
              msg.message.startsWith('Router ready') ||
              msg.message.startsWith('Initialization failed')
            ) {
              initCompletedRef.current = true;
            }
            if (!anyActive && !anyWps) {
              setStatus(msg.message);
              setIsError(msg.message.startsWith('Initialization failed'));
            }
          } else if (anyActive) {
            setStatus(msg.message);
            setIsError(false);
          }
          break;
        }
        case 'CUSTOM_PROFILE_LOADED': {
          if (msg.ok) {
            setCustomProfileError(null);
          } else {
            setCustomProfileError(msg.error || 'Failed to parse profile');
          }
          break;
        }
        case 'INSPECT_POINT_SUCCESS': {
          const cb = pendingInspectCallbacksRef.current.get(msg.id);
          if (cb) {
            pendingInspectCallbacksRef.current.delete(msg.id);
            cb(msg.payload);
          }
          break;
        }
        case 'ROUTE_SUCCESS': {
          const slotIdx = activeSlotRouteIdRef.current.indexOf(msg.id);
          if (slotIdx === -1) break;
          activeSlotRouteIdRef.current[slotIdx] = null;
          const altIdx = requestedSlotAltRef.current[slotIdx] ?? 0;
          shownSlotAltRef.current[slotIdx] = altIdx;

          const nextSlots = slotsRef.current.map((s, idx) =>
            idx === slotIdx
              ? { ...s, route: msg.payload, alternativeIdx: altIdx, isRouting: false }
              : s,
          );
          slotsRef.current = nextSlots;
          setSlotsState(nextSlots);

          const stillRouting = nextSlots.some((s) => s.isRouting);
          if (!stillRouting) {
            setIsError(false);
            setStatus('');
          }
          break;
        }
        case 'IMPORT_GPX_SUCCESS': {
          if (!activeImportRef.current || msg.id !== activeImportRef.current.id) break;
          const targetRouteIdx = activeImportRef.current.routeIdx;
          activeImportRef.current = null;

          const firstRouteSlotIdx = slotsRef.current.findIndex(
            (s) => (s.routeIdx ?? 0) === targetRouteIdx,
          );
          if (firstRouteSlotIdx === -1) break;
          const currentSlot = slotsRef.current[firstRouteSlotIdx];

          if (currentSlot.waypoints.length > 0 || currentSlot.avoidAreas.length > 0) {
            if (!historiesRef.current[targetRouteIdx]) {
              historiesRef.current[targetRouteIdx] = new HistoryStack(MAX_UNDO);
            }
            historiesRef.current[targetRouteIdx].record({
              waypoints: currentSlot.waypoints.map((w) => ({ ...w })),
              avoidAreas: currentSlot.avoidAreas.map((a) => ({ ...a })),
            });
            updateUndoRedo(activeSlotIdxRef.current);
          }

          const newWps = msg.payload.waypoints;
          const secondarySlotIndices: number[] = [];

          const nextSlots = slotsRef.current.map((s, idx) => {
            if ((s.routeIdx ?? 0) !== targetRouteIdx) return s;
            shownSlotAltRef.current[idx] = 0;
            requestedSlotAltRef.current[idx] = 0;
            activeSlotRouteIdRef.current[idx] = null;
            if (idx === firstRouteSlotIdx) {
              return {
                ...s,
                waypoints: newWps,
                avoidAreas: [],
                alternativeIdx: 0,
                route: msg.payload.route,
                isRouting: false,
              };
            }
            secondarySlotIndices.push(idx);
            return {
              ...s,
              waypoints: newWps.map((w) => ({ ...w })),
              avoidAreas: [],
              alternativeIdx: 0,
              isRouting: newWps.length >= 2,
            };
          });
          slotsRef.current = nextSlots;
          setSlotsState(nextSlots);
          setRouteSavedId(targetRouteIdx, null);

          saveToUrlAndStorage(nextSlots, activeSlotIdxRef.current);
          setFitBoundsSeq((s) => s + 1);

          for (const secIdx of secondarySlotIndices) {
            if (newWps.length >= 2) {
              postSlotRouteRequest(secIdx, newWps, nextSlots[secIdx].profile, [], 0);
            }
          }

          if (!nextSlots.some((s) => s.isRouting)) {
            setIsError(false);
            setStatus('');
          }
          break;
        }
        case 'ROUTE_ERROR': {
          if (activeImportRef.current && msg.id === activeImportRef.current.id) {
            const targetRouteIdx = activeImportRef.current.routeIdx;
            activeImportRef.current = null;
            const nextSlots = slotsRef.current.map((s) =>
              (s.routeIdx ?? 0) === targetRouteIdx ? { ...s, isRouting: false } : s,
            );
            slotsRef.current = nextSlots;
            setSlotsState(nextSlots);
            setStatus(`Routing error: ${msg.error}`);
            setIsError(true);
            break;
          }
          const slotIdx = activeSlotRouteIdRef.current.indexOf(msg.id);
          if (slotIdx === -1) break;
          activeSlotRouteIdRef.current[slotIdx] = null;

          const reqAlt = requestedSlotAltRef.current[slotIdx] ?? 0;
          const prevAlt = shownSlotAltRef.current[slotIdx] ?? 0;
          const currentSlot = slotsRef.current[slotIdx];

          if (reqAlt > 0 && currentSlot?.route) {
            const failedAlt = reqAlt + 1;
            requestedSlotAltRef.current[slotIdx] = prevAlt;
            const nextSlots = slotsRef.current.map((s, idx) =>
              idx === slotIdx ? { ...s, alternativeIdx: prevAlt, isRouting: false } : s,
            );
            slotsRef.current = nextSlots;
            setSlotsState(nextSlots);
            setStatus(
              `Alternative ${failedAlt} is not available for ${
                PROFILE_INFO[currentSlot.profile]?.shortLabel || currentSlot.profile
              }.`,
            );
            setIsError(true);
            break;
          }

          const nextSlots = slotsRef.current.map((s, idx) =>
            idx === slotIdx ? { ...s, route: null, isRouting: false } : s,
          );
          slotsRef.current = nextSlots;
          setSlotsState(nextSlots);
          setStatus(`Routing error: ${msg.error}`);
          setIsError(true);
          break;
        }
      }
    };

    worker.postMessage({
      type: 'SET_OFFLINE_MODE',
      offline: isOfflineModeRef.current,
    } satisfies WorkerMessage);

    // Register custom profile DSL strings without setting msg.id so the Worker stores them in JS
    // without instantiating WebAssembly.Memory until a route calculation actually begins.
    for (const cp of customProfilesRef.current) {
      worker.postMessage({
        type: 'LOAD_CUSTOM_PROFILE',
        name: cp.id,
        content: cp.dsl,
      } satisfies WorkerMessage);
    }
    const draft = draftProfileRef.current;
    if (draft && !customProfilesRef.current.some((cp) => cp.id === draft.id)) {
      worker.postMessage({
        type: 'LOAD_CUSTOM_PROFILE',
        name: draft.id,
        content: draft.dsl,
      } satisfies WorkerMessage);
    }

    if (cachedWasmModule) {
      worker.postMessage({ type: 'INIT', wasmModule: cachedWasmModule } satisfies WorkerMessage);
    } else {
      void getSharedWasmModule().then((wasmModule) => {
        if (workerRef.current === worker) {
          worker.postMessage({ type: 'INIT', wasmModule } satisfies WorkerMessage);
        }
      });
    }

    return worker;
  }, [postSlotRouteRequest, saveToUrlAndStorage, setRouteSavedId, updateUndoRedo]);

  /**
   * Aborts an in-flight route search for `profileId` by terminating the blocked Web Worker and
   * respawning a clean idle Worker.
   *
   * Why termination is required:
   * `WasmRouter::route()` runs synchronously inside the Worker. Cross-origin isolation headers
   * (COOP/COEP) are disabled so MapLibre can load external map tiles, which means `SharedArrayBuffer`
   * atomic cancellation flags are unavailable. `worker.terminate()` is the only way to stop an
   * expensive 6-19s A* search mid-flight instead of queueing stale searches behind it.
   *
   * Memory safeguards enforced here and in `ProfileEditorPanel`:
   * 1. Timing separation (no 2x WASM heap overlap): `oldWorker.terminate()` runs immediately at
   *    `t = 0 ms` when the user touches a control, while the respawned Worker stays idle (`0 bytes`
   *    of `WebAssembly.Memory`) until the `600 ms` editor pause debounce expires. This gives the
   *    browser and OS time to unmap the old 500-800 MB WASM linear heap before allocating a new one.
   * 2. Shared `WebAssembly.Module`: `spawnRoutingWorker()` passes `cachedWasmModule` via `INIT` so
   *    respawned Workers instantiate pre-compiled machine code without recompiling `.wasm` JIT pages.
   * 3. Download safety and listener cleanup: never terminates while `.rd5` segments are downloading
   *    (`workerPhase === 'downloading'`) or during GPX import (`activeImportRef !== null`). Detaches
   *    `onmessage`/`onerror` and resolves pending `inspectPoint` callbacks so closures cannot leak.
   */
  const abortInFlightProfileRoute = useCallback(
    (profileId: ProfileName): boolean => {
      const oldWorker = workerRef.current;
      if (!oldWorker) return false;

      const hasInFlightForProfile = slotsRef.current.some(
        (s, idx) => s.profile === profileId && activeSlotRouteIdRef.current[idx] !== null,
      );
      if (!hasInFlightForProfile) return false;

      // Safeguard 3: never interrupt an active .rd5 segment download or GPX track import.
      if (workerPhaseRef.current === 'downloading' || activeImportRef.current !== null) {
        return false;
      }

      const otherInFlightSlotIndices: number[] = [];
      slotsRef.current.forEach((s, idx) => {
        if (activeSlotRouteIdRef.current[idx] !== null) {
          if (s.profile === profileId) {
            activeSlotRouteIdRef.current[idx] = null;
          } else {
            otherInFlightSlotIndices.push(idx);
          }
        }
      });

      // Safeguard 3: detach main-thread closures and flush pending point-inspect Promises.
      oldWorker.onmessage = null;
      oldWorker.onerror = null;
      oldWorker.terminate();
      workerRef.current = null;
      workerPhaseRef.current = 'idle';

      if (pendingInspectCallbacksRef.current.size > 0) {
        for (const resolve of pendingInspectCallbacksRef.current.values()) {
          resolve(null);
        }
        pendingInspectCallbacksRef.current.clear();
      }

      const nextSlots = slotsRef.current.map((s) =>
        s.profile === profileId && s.isRouting ? { ...s, isRouting: false } : s,
      );
      slotsRef.current = nextSlots;
      setSlotsState(nextSlots);

      spawnRoutingWorker();

      if (otherInFlightSlotIndices.length > 0) {
        for (const idx of otherInFlightSlotIndices) {
          const slot = nextSlots[idx];
          if (slot && slot.waypoints.length >= 2) {
            postSlotRouteRequest(
              idx,
              slot.waypoints,
              slot.profile,
              slot.avoidAreas,
              requestedSlotAltRef.current[idx] ?? slot.alternativeIdx,
            );
          }
        }
      } else {
        setIsError(false);
        setStatus('');
      }

      return true;
    },
    [postSlotRouteRequest, spawnRoutingWorker],
  );

  // Worker initialization and initial route load
  useEffect(() => {
    spawnRoutingWorker();

    // Initial load from Hash or LocalStorage
    const fromLink = /(?:^#|&)(?:r|r2|r3|nogos|nogos2|nogos3|p|p2|p3)=/.test(location.hash);
    const saved = loadSavedWorkspace();
    const initial = fromLink ? parseRouteHash() : saved;
    if (initial && initial.slots.length > 0) {
      const savedNamePool: LatLon[] = saved
        ? saved.slots.flatMap((s) => s.waypoints)
        : [];
      const initSlots: RouteSlotState[] = initial.slots.map((seed, idx) => ({
        routeIdx: seed.routeIdx ?? 0,
        profile: seed.profile,
        waypoints: fromLink
          ? mergeSavedWaypointNames(seed.waypoints, savedNamePool)
          : seed.waypoints,
        avoidAreas: seed.avoidAreas,
        alternativeIdx: 0,
        route: null,
        isRouting: false,
        colorId:
          seed.colorId ||
          saved?.slots[idx]?.colorId ||
          ROUTE_COLOR_PALETTE[idx % ROUTE_COLOR_PALETTE.length]?.id,
      }));
      const initActive = Math.min(initSlots.length - 1, Math.max(0, initial.activeSlotIdx));
      const initRouteCount = getRouteCount(initSlots);

      historiesRef.current = Array.from(
        { length: initRouteCount },
        () => new HistoryStack<RouteHistorySnapshot>(MAX_UNDO),
      );
      const initSavedIds = Array.from({ length: initRouteCount }, () => null);
      savedRouteIdsByRouteRef.current = initSavedIds;
      setSavedRouteIdsByRoute(initSavedIds);
      activeSlotRouteIdRef.current = initSlots.map(() => null);
      requestedSlotAltRef.current = initSlots.map(() => 0);
      shownSlotAltRef.current = initSlots.map(() => 0);

      activeSlotIdxRef.current = initActive;
      slotsRef.current = initSlots;
      setActiveSlotIdxState(initActive);
      setSlotsState(initSlots);
      updateUndoRedo(initActive);
      saveToUrlAndStorage(initSlots, initActive);

      if (initSlots.some((s) => s.waypoints.length > 0)) {
        setFitBoundsSeq((s) => s + 1);
      }
      requestSlotsRoutes(initSlots, undefined, true);
    }

    const onHashChange = () => {
      const parsed = parseRouteHash();
      if (!parsed) return;
      const currentNamePool = slotsRef.current.flatMap((s) => s.waypoints);

      const sameCount = parsed.slots.length === slotsRef.current.length;
      const sameActive = parsed.activeSlotIdx === activeSlotIdxRef.current;
      const sameAll =
        sameCount &&
        sameActive &&
        parsed.slots.every((seed, idx) => {
          const cur = slotsRef.current[idx];
          if (!cur || seed.profile !== cur.profile || (seed.routeIdx ?? 0) !== (cur.routeIdx ?? 0)) {
            return false;
          }
          if (seed.waypoints.length !== cur.waypoints.length) return false;
          if (seed.avoidAreas.length !== cur.avoidAreas.length) return false;
          const wOk = seed.waypoints.every(
            (w, i) =>
              Math.abs(w.lat - cur.waypoints[i].lat) < 1e-5 &&
              Math.abs(w.lon - cur.waypoints[i].lon) < 1e-5,
          );
          const aOk = seed.avoidAreas.every(
            (a, i) =>
              Math.abs(a.lat - cur.avoidAreas[i].lat) < 1e-5 &&
              Math.abs(a.lon - cur.avoidAreas[i].lon) < 1e-5 &&
              Math.round(a.radius) === Math.round(cur.avoidAreas[i].radius) &&
              a.weight === cur.avoidAreas[i].weight,
          );
          return wOk && aOk;
        });

      if (sameAll) return;

      const nextSlots: RouteSlotState[] = parsed.slots.map((seed, idx) => ({
        routeIdx: seed.routeIdx ?? 0,
        profile: seed.profile,
        waypoints: mergeSavedWaypointNames(seed.waypoints, currentNamePool),
        avoidAreas: seed.avoidAreas,
        alternativeIdx: 0,
        route: null,
        isRouting: false,
        colorId:
          seed.colorId ||
          slotsRef.current[idx]?.colorId ||
          ROUTE_COLOR_PALETTE[idx % ROUTE_COLOR_PALETTE.length]?.id,
      }));
      const nextActive = Math.min(nextSlots.length - 1, Math.max(0, parsed.activeSlotIdx));
      const nextRouteCount = getRouteCount(nextSlots);

      while (historiesRef.current.length < nextRouteCount) {
        historiesRef.current.push(new HistoryStack<RouteHistorySnapshot>(MAX_UNDO));
      }
      activeSlotRouteIdRef.current = nextSlots.map(() => null);
      requestedSlotAltRef.current = nextSlots.map(() => 0);
      shownSlotAltRef.current = nextSlots.map(() => 0);

      activeSlotIdxRef.current = nextActive;
      slotsRef.current = nextSlots;
      setActiveSlotIdxState(nextActive);
      setSlotsState(nextSlots);
      updateUndoRedo(nextActive);
      requestSlotsRoutes(nextSlots, undefined, true);
    };

    window.addEventListener('hashchange', onHashChange);

    return () => {
      window.removeEventListener('hashchange', onHashChange);
      if (workerRef.current) {
        workerRef.current.onmessage = null;
        workerRef.current.onerror = null;
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  // Sync offline mode with worker
  useEffect(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({
        type: 'SET_OFFLINE_MODE',
        offline: isOfflineMode,
      } satisfies WorkerMessage);
    }
  }, [isOfflineMode]);

  const setActiveSlot = useCallback(
    (slotIdx: number) => {
      if (slotIdx < 0 || slotIdx >= slotsRef.current.length) return;
      activeSlotIdxRef.current = slotIdx;
      setActiveSlotIdxState(slotIdx);
      updateUndoRedo(slotIdx);
      saveToUrlAndStorage(slotsRef.current, slotIdx);
    },
    [saveToUrlAndStorage, updateUndoRedo],
  );

  const setActiveRoute = useCallback(
    (routeIdx: number) => {
      const firstSlotIdx = slotsRef.current.findIndex((s) => (s.routeIdx ?? 0) === routeIdx);
      if (firstSlotIdx !== -1) {
        setActiveSlot(firstSlotIdx);
      }
    },
    [setActiveSlot],
  );

  const updateRouteWaypoints = useCallback(
    (routeIdx: number, nextWps: LatLon[], recordUndo = true, fitMap = false) => {
      const routeSlotIndices: number[] = [];
      slotsRef.current.forEach((s, idx) => {
        if ((s.routeIdx ?? 0) === routeIdx) routeSlotIndices.push(idx);
      });
      if (routeSlotIndices.length === 0) return;
      const firstSlot = slotsRef.current[routeSlotIndices[0]];

      if (recordUndo) {
        if (!historiesRef.current[routeIdx]) {
          historiesRef.current[routeIdx] = new HistoryStack(MAX_UNDO);
        }
        historiesRef.current[routeIdx].record({
          waypoints: firstSlot.waypoints.map((w) => ({ ...w })),
          avoidAreas: firstSlot.avoidAreas.map((a) => ({ ...a })),
        });
        const currentActiveRoute = slotsRef.current[activeSlotIdxRef.current]?.routeIdx ?? 0;
        if (routeIdx === currentActiveRoute) {
          updateUndoRedo(activeSlotIdxRef.current);
        }
      }

      const nextSlots = slotsRef.current.map((s) =>
        (s.routeIdx ?? 0) === routeIdx ? { ...s, waypoints: nextWps.map((w) => ({ ...w })) } : s,
      );
      slotsRef.current = nextSlots;
      setSlotsState(nextSlots);
      saveToUrlAndStorage(nextSlots, activeSlotIdxRef.current);

      if (fitMap && nextWps.length > 0) {
        setFitBoundsSeq((s) => s + 1);
      }
      requestSlotsRoutes(nextSlots, routeSlotIndices, true);
    },
    [requestSlotsRoutes, saveToUrlAndStorage, updateUndoRedo],
  );

  const setWaypoints = useCallback(
    (next: LatLon[], recordUndo = true, fitMap = false) => {
      const activeRouteIdx = slotsRef.current[activeSlotIdxRef.current]?.routeIdx ?? 0;
      updateRouteWaypoints(activeRouteIdx, next, recordUndo, fitMap);
    },
    [updateRouteWaypoints],
  );

  const updateRouteAvoidAreas = useCallback(
    (routeIdx: number, nextAvoids: AvoidArea[], recordUndo = true) => {
      const routeSlotIndices: number[] = [];
      slotsRef.current.forEach((s, idx) => {
        if ((s.routeIdx ?? 0) === routeIdx) routeSlotIndices.push(idx);
      });
      if (routeSlotIndices.length === 0) return;
      const firstSlot = slotsRef.current[routeSlotIndices[0]];

      if (recordUndo) {
        if (!historiesRef.current[routeIdx]) {
          historiesRef.current[routeIdx] = new HistoryStack(MAX_UNDO);
        }
        historiesRef.current[routeIdx].record({
          waypoints: firstSlot.waypoints.map((w) => ({ ...w })),
          avoidAreas: firstSlot.avoidAreas.map((a) => ({ ...a })),
        });
        const currentActiveRoute = slotsRef.current[activeSlotIdxRef.current]?.routeIdx ?? 0;
        if (routeIdx === currentActiveRoute) {
          updateUndoRedo(activeSlotIdxRef.current);
        }
      }

      const nextSlots = slotsRef.current.map((s) =>
        (s.routeIdx ?? 0) === routeIdx ? { ...s, avoidAreas: nextAvoids.map((a) => ({ ...a })) } : s,
      );
      slotsRef.current = nextSlots;
      setSlotsState(nextSlots);
      saveToUrlAndStorage(nextSlots, activeSlotIdxRef.current);

      if (firstSlot.waypoints.length >= 2) {
        requestSlotsRoutes(nextSlots, routeSlotIndices, true);
      }
    },
    [requestSlotsRoutes, saveToUrlAndStorage, updateUndoRedo],
  );

  const setAvoidAreas = useCallback(
    (next: AvoidArea[], recordUndo = true) => {
      const activeRouteIdx = slotsRef.current[activeSlotIdxRef.current]?.routeIdx ?? 0;
      updateRouteAvoidAreas(activeRouteIdx, next, recordUndo);
    },
    [updateRouteAvoidAreas],
  );

  const setSlotProfile = useCallback(
    (slotIdx: number, nextProfile: ProfileName, recompute = true) => {
      if (slotIdx < 0 || slotIdx >= slotsRef.current.length) return;
      const targetSlot = slotsRef.current[slotIdx];
      const hasWps = targetSlot.waypoints.length >= 2;
      if (!recompute) {
        activeSlotRouteIdRef.current[slotIdx] = null;
        const nextSlots = slotsRef.current.map((s, idx) =>
          idx === slotIdx ? { ...s, profile: nextProfile, isRouting: false } : s,
        );
        slotsRef.current = nextSlots;
        setSlotsState(nextSlots);
        saveToUrlAndStorage(nextSlots, activeSlotIdxRef.current);
        return;
      }
      requestedSlotAltRef.current[slotIdx] = 0;
      shownSlotAltRef.current[slotIdx] = 0;
      const nextSlots = slotsRef.current.map((s, idx) =>
        idx === slotIdx
          ? { ...s, profile: nextProfile, alternativeIdx: 0, isRouting: hasWps }
          : s,
      );
      slotsRef.current = nextSlots;
      setSlotsState(nextSlots);
      saveToUrlAndStorage(nextSlots, activeSlotIdxRef.current);
      if (hasWps) {
        setStatus('Calculating route...');
        setIsError(false);
        postSlotRouteRequest(
          slotIdx,
          targetSlot.waypoints,
          nextProfile,
          targetSlot.avoidAreas,
          0,
        );
      }
    },
    [postSlotRouteRequest, saveToUrlAndStorage],
  );

  const setProfile = useCallback(
    (next: ProfileName) => {
      setSlotProfile(activeSlotIdxRef.current, next);
    },
    [setSlotProfile],
  );

  const setSlotColor = useCallback(
    (slotIdx: number, colorId: string) => {
      if (slotIdx < 0 || slotIdx >= slotsRef.current.length) return;
      const nextSlots = slotsRef.current.map((s, idx) =>
        idx === slotIdx ? { ...s, colorId } : s,
      );
      slotsRef.current = nextSlots;
      setSlotsState(nextSlots);
      saveToUrlAndStorage(nextSlots, activeSlotIdxRef.current);
    },
    [saveToUrlAndStorage],
  );

  const addRoute = useCallback(
    (mode: 'empty' | 'clone' = 'empty', initialProfile?: ProfileName) => {
      const currentRouteCount = getRouteCount(slotsRef.current);
      if (currentRouteCount >= MAX_ROUTES) return;

      const sourceSlot =
        slotsRef.current[activeSlotIdxRef.current] || slotsRef.current[0];
      const nextProfile =
        initialProfile && validProfile(initialProfile)
          ? initialProfile
          : sourceSlot?.profile || PROFILE_ORDER[0];

      const usedColors = new Set(slotsRef.current.map((s, idx) => getSlotColor(s, idx).id));
      const nextColor =
        ROUTE_COLOR_PALETTE.find((c) => !usedColors.has(c.id)) || ROUTE_COLOR_PALETTE[0];

      const newRouteIdx = currentRouteCount;
      const newWps =
        mode === 'clone' && sourceSlot ? sourceSlot.waypoints.map((w) => ({ ...w })) : [];
      const newAvoids =
        mode === 'clone' && sourceSlot ? sourceSlot.avoidAreas.map((a) => ({ ...a })) : [];
      const hasWps = newWps.length >= 2;
      const newSlotIdx = slotsRef.current.length;

      const nextSlots: RouteSlotState[] = [
        ...slotsRef.current,
        {
          routeIdx: newRouteIdx,
          profile: nextProfile,
          waypoints: newWps,
          avoidAreas: newAvoids,
          alternativeIdx: 0,
          route: null,
          isRouting: hasWps,
          colorId: nextColor.id,
        },
      ];
      historiesRef.current[newRouteIdx] = new HistoryStack<RouteHistorySnapshot>(MAX_UNDO);
      activeSlotRouteIdRef.current.push(null);
      requestedSlotAltRef.current.push(0);
      shownSlotAltRef.current.push(0);

      activeSlotIdxRef.current = newSlotIdx;
      slotsRef.current = nextSlots;
      setActiveSlotIdxState(newSlotIdx);
      setSlotsState(nextSlots);
      setRouteSavedId(newRouteIdx, null);
      updateUndoRedo(newSlotIdx);
      saveToUrlAndStorage(nextSlots, newSlotIdx);

      if (hasWps) {
        setStatus('Calculating route...');
        setIsError(false);
        postSlotRouteRequest(newSlotIdx, newWps, nextProfile, newAvoids, 0);
      } else {
        setIsError(false);
        setStatus('Click on the map or search to set start and end points.');
      }
    },
    [postSlotRouteRequest, saveToUrlAndStorage, setRouteSavedId, updateUndoRedo],
  );

  const removeRoute = useCallback(
    (routeIdx: number) => {
      const currentRouteCount = getRouteCount(slotsRef.current);
      if (currentRouteCount <= 1 || routeIdx < 0 || routeIdx >= currentRouteCount) return;

      const currentActiveSlot = slotsRef.current[activeSlotIdxRef.current];
      const currentActiveRoute = currentActiveSlot?.routeIdx ?? 0;

      const nextSlots: RouteSlotState[] = [];
      const nextRouteIds: Array<string | null> = [];
      const nextReqAlts: number[] = [];
      const nextShownAlts: number[] = [];

      slotsRef.current.forEach((s, idx) => {
        const sRoute = s.routeIdx ?? 0;
        if (sRoute === routeIdx) return;
        nextSlots.push({
          ...s,
          routeIdx: sRoute > routeIdx ? sRoute - 1 : sRoute,
        });
        nextRouteIds.push(activeSlotRouteIdRef.current[idx] ?? null);
        nextReqAlts.push(requestedSlotAltRef.current[idx] ?? 0);
        nextShownAlts.push(shownSlotAltRef.current[idx] ?? 0);
      });

      historiesRef.current.splice(routeIdx, 1);
      setSavedRouteIdsByRoute((prev) => {
        const next = [...prev];
        next.splice(routeIdx, 1);
        savedRouteIdsByRouteRef.current = next;
        return next;
      });
      activeSlotRouteIdRef.current = nextRouteIds;
      requestedSlotAltRef.current = nextReqAlts;
      shownSlotAltRef.current = nextShownAlts;

      let targetRouteIdx = currentActiveRoute;
      if (routeIdx < currentActiveRoute) {
        targetRouteIdx = currentActiveRoute - 1;
      } else if (routeIdx === currentActiveRoute) {
        targetRouteIdx = Math.min(currentRouteCount - 2, routeIdx);
      }
      const foundActiveIdx = nextSlots.findIndex((s) => (s.routeIdx ?? 0) === targetRouteIdx);
      const nextActiveIdx = foundActiveIdx !== -1 ? foundActiveIdx : 0;

      activeSlotIdxRef.current = nextActiveIdx;
      slotsRef.current = nextSlots;
      setActiveSlotIdxState(nextActiveIdx);
      setSlotsState(nextSlots);
      updateUndoRedo(nextActiveIdx);
      saveToUrlAndStorage(nextSlots, nextActiveIdx);
      if (!nextSlots.some((s) => s.isRouting)) {
        setStatus('');
      }
    },
    [saveToUrlAndStorage, updateUndoRedo],
  );

  const addProfileSlot = useCallback(
    (initialProfile?: ProfileName) => {
      const activeRouteIdx = slotsRef.current[activeSlotIdxRef.current]?.routeIdx ?? 0;
      const routeSlots = slotsRef.current.filter((s) => (s.routeIdx ?? 0) === activeRouteIdx);
      if (routeSlots.length >= MAX_ROUTE_SLOTS) return;

      const usedProfiles = new Set(routeSlots.map((s) => s.profile));
      const nextProfile =
        initialProfile && validProfile(initialProfile)
          ? initialProfile
          : PROFILE_ORDER.find((p) => !usedProfiles.has(p)) || PROFILE_ORDER[0];

      const usedColors = new Set(slotsRef.current.map((s, idx) => getSlotColor(s, idx).id));
      const nextColor =
        ROUTE_COLOR_PALETTE.find((c) => !usedColors.has(c.id)) || ROUTE_COLOR_PALETTE[0];

      const sourceSlot = routeSlots[0] || slotsRef.current[0];
      const sharedWps = sourceSlot ? sourceSlot.waypoints.map((w) => ({ ...w })) : [];
      const sharedAvoids = sourceSlot ? sourceSlot.avoidAreas.map((a) => ({ ...a })) : [];
      const hasWps = sharedWps.length >= 2;

      let insertIdx = slotsRef.current.length;
      for (let i = slotsRef.current.length - 1; i >= 0; i--) {
        if ((slotsRef.current[i].routeIdx ?? 0) === activeRouteIdx) {
          insertIdx = i + 1;
          break;
        }
      }

      const newSlot: RouteSlotState = {
        routeIdx: activeRouteIdx,
        profile: nextProfile,
        waypoints: sharedWps,
        avoidAreas: sharedAvoids,
        alternativeIdx: 0,
        route: null,
        isRouting: hasWps,
        colorId: nextColor.id,
      };

      const nextSlots = [...slotsRef.current];
      nextSlots.splice(insertIdx, 0, newSlot);
      activeSlotRouteIdRef.current.splice(insertIdx, 0, null);
      requestedSlotAltRef.current.splice(insertIdx, 0, 0);
      shownSlotAltRef.current.splice(insertIdx, 0, 0);

      let nextActiveIdx = activeSlotIdxRef.current;
      if (insertIdx <= nextActiveIdx) {
        nextActiveIdx += 1;
      }

      activeSlotIdxRef.current = nextActiveIdx;
      slotsRef.current = nextSlots;
      setActiveSlotIdxState(nextActiveIdx);
      setSlotsState(nextSlots);
      saveToUrlAndStorage(nextSlots, nextActiveIdx);

      if (hasWps) {
        setStatus('Calculating route...');
        setIsError(false);
        postSlotRouteRequest(insertIdx, sharedWps, nextProfile, sharedAvoids, 0);
      }
    },
    [postSlotRouteRequest, saveToUrlAndStorage],
  );

  const removeProfileSlot = useCallback(
    (slotIdx: number) => {
      if (slotIdx < 0 || slotIdx >= slotsRef.current.length) return;
      const targetRouteIdx = slotsRef.current[slotIdx]?.routeIdx ?? 0;
      const routeSlotsCount = slotsRef.current.filter(
        (s) => (s.routeIdx ?? 0) === targetRouteIdx,
      ).length;
      if (routeSlotsCount <= 1) return;

      const nextSlots = slotsRef.current.filter((_, idx) => idx !== slotIdx);
      activeSlotRouteIdRef.current.splice(slotIdx, 1);
      requestedSlotAltRef.current.splice(slotIdx, 1);
      shownSlotAltRef.current.splice(slotIdx, 1);

      let nextActive = activeSlotIdxRef.current;
      if (slotIdx < nextActive) {
        nextActive -= 1;
      } else if (slotIdx === nextActive) {
        const firstOfRoute = nextSlots.findIndex((s) => (s.routeIdx ?? 0) === targetRouteIdx);
        nextActive = firstOfRoute !== -1 ? firstOfRoute : Math.max(0, nextSlots.length - 1);
      }
      activeSlotIdxRef.current = nextActive;
      slotsRef.current = nextSlots;
      setActiveSlotIdxState(nextActive);
      setSlotsState(nextSlots);
      updateUndoRedo(nextActive);
      saveToUrlAndStorage(nextSlots, nextActive);
      if (!nextSlots.some((s) => s.isRouting)) {
        setStatus('');
      }
    },
    [saveToUrlAndStorage, updateUndoRedo],
  );

  const selectSlotAlternative = useCallback(
    (slotIdx: number, altIdx: number) => {
      const targetSlot = slotsRef.current[slotIdx];
      if (
        !targetSlot ||
        altIdx === shownSlotAltRef.current[slotIdx] ||
        targetSlot.waypoints.length < 2
      ) {
        return;
      }
      const nextSlots = slotsRef.current.map((s, idx) =>
        idx === slotIdx ? { ...s, alternativeIdx: altIdx, isRouting: true } : s,
      );
      slotsRef.current = nextSlots;
      setSlotsState(nextSlots);
      setStatus('Calculating route...');
      setIsError(false);
      postSlotRouteRequest(
        slotIdx,
        targetSlot.waypoints,
        targetSlot.profile,
        targetSlot.avoidAreas,
        altIdx,
      );
    },
    [postSlotRouteRequest],
  );

  const selectAlternative = useCallback(
    (idx: number) => {
      selectSlotAlternative(activeSlotIdxRef.current, idx);
    },
    [selectSlotAlternative],
  );

  const addWaypoint = useCallback(
    (p: LatLon, action?: 'start' | 'end' | 'via' | 'append') => {
      const activeIdx = activeSlotIdxRef.current;
      const activeSlot = slotsRef.current[activeIdx];
      if (!activeSlot) return;
      const activeRouteIdx = activeSlot.routeIdx ?? 0;
      const wps = activeSlot.waypoints;
      let next: LatLon[];
      if (action === 'start') {
        next = wps.length === 0 ? [p] : [p, ...wps.slice(1)];
      } else if (action === 'via') {
        if (wps.length < 2) {
          next = [...wps, p];
        } else {
          const coords = (
            activeSlot.route?.features[0]?.geometry as GeoJSON.LineString | undefined
          )?.coordinates;
          const leg = legIndexAt(coords, wps, p.lon, p.lat);
          next = [...wps];
          next.splice(Math.max(1, leg + 1), 0, p);
        }
      } else {
        next = [...wps, p];
      }
      updateRouteWaypoints(activeRouteIdx, next, true);
    },
    [updateRouteWaypoints],
  );

  const insertWaypointAtLeg = useCallback(
    (p: LatLon, insertIndex: number, targetSlotIdx?: number) => {
      const slotIdx =
        targetSlotIdx !== undefined && targetSlotIdx >= 0 && targetSlotIdx < slotsRef.current.length
          ? targetSlotIdx
          : activeSlotIdxRef.current;
      if (slotIdx !== activeSlotIdxRef.current) {
        activeSlotIdxRef.current = slotIdx;
        setActiveSlotIdxState(slotIdx);
        updateUndoRedo(slotIdx);
      }
      const targetRouteIdx = slotsRef.current[slotIdx]?.routeIdx ?? 0;
      const wps = slotsRef.current[slotIdx]?.waypoints || [];
      const next = [...wps];
      const clampedIndex = Math.max(0, Math.min(next.length, insertIndex));
      next.splice(clampedIndex, 0, p);
      updateRouteWaypoints(targetRouteIdx, next, true);
    },
    [updateRouteWaypoints, updateUndoRedo],
  );

  const moveWaypoint = useCallback(
    (index: number, p: LatLon) => {
      const activeIdx = activeSlotIdxRef.current;
      const activeRouteIdx = slotsRef.current[activeIdx]?.routeIdx ?? 0;
      const wps = slotsRef.current[activeIdx]?.waypoints || [];
      const next = wps.map((w, i) =>
        i === index ? (p.name ? { lat: p.lat, lon: p.lon, name: p.name } : { lat: p.lat, lon: p.lon }) : w,
      );
      updateRouteWaypoints(activeRouteIdx, next, true);
    },
    [updateRouteWaypoints],
  );

  const removeWaypoint = useCallback(
    (index: number) => {
      const activeIdx = activeSlotIdxRef.current;
      const activeRouteIdx = slotsRef.current[activeIdx]?.routeIdx ?? 0;
      const wps = slotsRef.current[activeIdx]?.waypoints || [];
      const next = wps.filter((_, i) => i !== index);
      updateRouteWaypoints(activeRouteIdx, next, true);
    },
    [updateRouteWaypoints],
  );

  const renameWaypoint = useCallback(
    (index: number, name: string, expectedCoords?: { lat: number; lon: number }) => {
      const targetSlotIdx = activeSlotIdxRef.current;
      const targetRouteIdx = slotsRef.current[targetSlotIdx]?.routeIdx ?? 0;
      setSlotsState((prevSlots) => {
        const slot = prevSlots[targetSlotIdx];
        if (!slot) return prevSlots;
        const current = slot.waypoints[index];
        if (!current) return prevSlots;
        if (expectedCoords) {
          if (
            current.name ||
            Math.abs(current.lat - expectedCoords.lat) > 1e-5 ||
            Math.abs(current.lon - expectedCoords.lon) > 1e-5
          ) {
            return prevSlots;
          }
        }
        const trimmed = name.trim() || undefined;
        if (current.name === trimmed) return prevSlots;
        const nextWps = slot.waypoints.map((w, i) => (i === index ? { ...w, name: trimmed } : w));
        const nextSlots = prevSlots.map((s) =>
          (s.routeIdx ?? 0) === targetRouteIdx ? { ...s, waypoints: nextWps.map((w) => ({ ...w })) } : s,
        );
        slotsRef.current = nextSlots;
        saveToUrlAndStorage(nextSlots, activeSlotIdxRef.current);
        return nextSlots;
      });
    },
    [saveToUrlAndStorage],
  );

  const reorderWaypoints = useCallback(
    (fromIndex: number, toIndex: number) => {
      const activeIdx = activeSlotIdxRef.current;
      const activeRouteIdx = slotsRef.current[activeIdx]?.routeIdx ?? 0;
      const wps = slotsRef.current[activeIdx]?.waypoints || [];
      const next = [...wps];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      updateRouteWaypoints(activeRouteIdx, next, true);
    },
    [updateRouteWaypoints],
  );

  const reverseRoute = useCallback(() => {
    const activeIdx = activeSlotIdxRef.current;
    const activeRouteIdx = slotsRef.current[activeIdx]?.routeIdx ?? 0;
    const wps = slotsRef.current[activeIdx]?.waypoints || [];
    if (wps.length < 2) return;
    const next = [...wps].reverse();
    updateRouteWaypoints(activeRouteIdx, next, true);
  }, [updateRouteWaypoints]);

  const addAvoidArea = useCallback(
    (p: LatLon, radius = DEFAULT_AVOID_RADIUS_M) => {
      const activeIdx = activeSlotIdxRef.current;
      const activeRouteIdx = slotsRef.current[activeIdx]?.routeIdx ?? 0;
      const avoids = slotsRef.current[activeIdx]?.avoidAreas || [];
      const next = [...avoids, { lat: p.lat, lon: p.lon, radius }];
      updateRouteAvoidAreas(activeRouteIdx, next, true);
    },
    [updateRouteAvoidAreas],
  );

  const updateAvoidAreaRadius = useCallback(
    (index: number, radius: number) => {
      const activeIdx = activeSlotIdxRef.current;
      const activeRouteIdx = slotsRef.current[activeIdx]?.routeIdx ?? 0;
      const avoids = slotsRef.current[activeIdx]?.avoidAreas || [];
      if (!avoids[index]) return;
      const next = avoids.map((a, i) =>
        i === index ? { ...a, radius: Math.max(10, radius) } : a,
      );
      updateRouteAvoidAreas(activeRouteIdx, next, true);
    },
    [updateRouteAvoidAreas],
  );

  const removeAvoidArea = useCallback(
    (index: number) => {
      const activeIdx = activeSlotIdxRef.current;
      const activeRouteIdx = slotsRef.current[activeIdx]?.routeIdx ?? 0;
      const avoids = slotsRef.current[activeIdx]?.avoidAreas || [];
      const next = avoids.filter((_, i) => i !== index);
      updateRouteAvoidAreas(activeRouteIdx, next, true);
    },
    [updateRouteAvoidAreas],
  );

  const clearAvoidAreas = useCallback(() => {
    const activeIdx = activeSlotIdxRef.current;
    const activeRouteIdx = slotsRef.current[activeIdx]?.routeIdx ?? 0;
    const avoids = slotsRef.current[activeIdx]?.avoidAreas || [];
    if (avoids.length === 0) return;
    updateRouteAvoidAreas(activeRouteIdx, [], true);
  }, [updateRouteAvoidAreas]);

  const clearRoute = useCallback(() => {
    const activeIdx = activeSlotIdxRef.current;
    const activeSlot = slotsRef.current[activeIdx];
    if (!activeSlot) return;
    const activeRouteIdx = activeSlot.routeIdx ?? 0;
    if (activeSlot.waypoints.length === 0 && activeSlot.avoidAreas.length === 0) return;

    if (!historiesRef.current[activeRouteIdx]) {
      historiesRef.current[activeRouteIdx] = new HistoryStack(MAX_UNDO);
    }
    historiesRef.current[activeRouteIdx].record({
      waypoints: activeSlot.waypoints.map((w) => ({ ...w })),
      avoidAreas: activeSlot.avoidAreas.map((a) => ({ ...a })),
    });
    updateUndoRedo(activeIdx);

    if (activeImportRef.current?.routeIdx === activeRouteIdx) {
      activeImportRef.current = null;
    }

    const nextSlots = slotsRef.current.map((s, idx) => {
      if ((s.routeIdx ?? 0) !== activeRouteIdx) return s;
      activeSlotRouteIdRef.current[idx] = null;
      requestedSlotAltRef.current[idx] = 0;
      shownSlotAltRef.current[idx] = 0;
      return {
        ...s,
        waypoints: [],
        avoidAreas: [],
        alternativeIdx: 0,
        route: null,
        isRouting: false,
      };
    });
    slotsRef.current = nextSlots;
    setSlotsState(nextSlots);
    setRouteSavedId(activeRouteIdx, null);
    setIsError(false);
    saveToUrlAndStorage(nextSlots, activeIdx);
    setStatus('Route cleared.');
  }, [saveToUrlAndStorage, setRouteSavedId, updateUndoRedo]);

  const undo = useCallback(() => {
    const activeIdx = activeSlotIdxRef.current;
    const activeSlot = slotsRef.current[activeIdx];
    if (!activeSlot) return;
    const activeRouteIdx = activeSlot.routeIdx ?? 0;
    const h = historiesRef.current[activeRouteIdx];
    if (!h) return;

    const currentSnap: RouteHistorySnapshot = {
      waypoints: activeSlot.waypoints.map((w) => ({ ...w })),
      avoidAreas: activeSlot.avoidAreas.map((a) => ({ ...a })),
    };
    const prev = h.undo(currentSnap);
    if (!prev) return;

    const routeSlotIndices: number[] = [];
    const nextSlots = slotsRef.current.map((s, idx) => {
      if ((s.routeIdx ?? 0) !== activeRouteIdx) return s;
      routeSlotIndices.push(idx);
      return {
        ...s,
        waypoints: prev.waypoints.map((w) => ({ ...w })),
        avoidAreas: prev.avoidAreas.map((a) => ({ ...a })),
      };
    });
    slotsRef.current = nextSlots;
    setSlotsState(nextSlots);
    saveToUrlAndStorage(nextSlots, activeIdx);
    requestSlotsRoutes(nextSlots, routeSlotIndices, true);
    updateUndoRedo(activeIdx);
  }, [requestSlotsRoutes, saveToUrlAndStorage, updateUndoRedo]);

  const redo = useCallback(() => {
    const activeIdx = activeSlotIdxRef.current;
    const activeSlot = slotsRef.current[activeIdx];
    if (!activeSlot) return;
    const activeRouteIdx = activeSlot.routeIdx ?? 0;
    const h = historiesRef.current[activeRouteIdx];
    if (!h) return;

    const currentSnap: RouteHistorySnapshot = {
      waypoints: activeSlot.waypoints.map((w) => ({ ...w })),
      avoidAreas: activeSlot.avoidAreas.map((a) => ({ ...a })),
    };
    const next = h.redo(currentSnap);
    if (!next) return;

    const routeSlotIndices: number[] = [];
    const nextSlots = slotsRef.current.map((s, idx) => {
      if ((s.routeIdx ?? 0) !== activeRouteIdx) return s;
      routeSlotIndices.push(idx);
      return {
        ...s,
        waypoints: next.waypoints.map((w) => ({ ...w })),
        avoidAreas: next.avoidAreas.map((a) => ({ ...a })),
      };
    });
    slotsRef.current = nextSlots;
    setSlotsState(nextSlots);
    saveToUrlAndStorage(nextSlots, activeIdx);
    requestSlotsRoutes(nextSlots, routeSlotIndices, true);
    updateUndoRedo(activeIdx);
  }, [requestSlotsRoutes, saveToUrlAndStorage, updateUndoRedo]);

  const clearWorkerGraph = useCallback(
    (recompute = false) => {
      if (workerRef.current) {
        workerRef.current.postMessage({ type: 'CLEAR_GRAPH' } satisfies WorkerMessage);
      }
      if (recompute && slotsRef.current.some((s) => s.waypoints.length >= 2)) {
        requestSlotsRoutes(slotsRef.current, undefined, false);
      }
    },
    [requestSlotsRoutes],
  );

  const triggerFitBounds = useCallback(() => {
    setFitBoundsSeq((s) => s + 1);
  }, []);

  const inspectPoint = useCallback(
    (lon: number, lat: number, maxDistanceM = 45): Promise<PointWayInfo | null> => {
      if (!workerRef.current) return Promise.resolve(null);
      const id = `inspect-${++routeCounterRef.current}`;
      return new Promise<PointWayInfo | null>((resolve) => {
        pendingInspectCallbacksRef.current.set(id, resolve);
        workerRef.current?.postMessage({
          type: 'INSPECT_POINT_REQUEST',
          id,
          lon,
          lat,
          maxDistanceM,
        } satisfies WorkerMessage);
      });
    },
    [],
  );

  const importGpxContent = useCallback((gpxXml: string, toleranceM = 20, targetSlotIdx?: number) => {
    if (!workerRef.current) return;
    const slotIdx =
      targetSlotIdx !== undefined && targetSlotIdx >= 0 && targetSlotIdx < slotsRef.current.length
        ? targetSlotIdx
        : activeSlotIdxRef.current;
    const targetRouteIdx = slotsRef.current[slotIdx]?.routeIdx ?? 0;
    const firstRouteSlotIdx = slotsRef.current.findIndex(
      (s) => (s.routeIdx ?? 0) === targetRouteIdx,
    );
    const primaryIdx = firstRouteSlotIdx !== -1 ? firstRouteSlotIdx : slotIdx;

    setStatus('Matching GPX to road network...');
    setIsError(false);

    const nextSlots = slotsRef.current.map((s, idx) => ({
      ...s,
      isRouting: idx === primaryIdx ? true : s.isRouting,
    }));
    slotsRef.current = nextSlots;
    setSlotsState(nextSlots);

    const id = String(++routeCounterRef.current);
    activeImportRef.current = { id, routeIdx: targetRouteIdx };
    activeSlotRouteIdRef.current[primaryIdx] = null;

    workerRef.current.postMessage({
      type: 'IMPORT_GPX_REQUEST',
      id,
      payload: {
        gpxXml,
        profile: nextSlots[primaryIdx]?.profile || PROFILE_ORDER[0],
        toleranceM,
      },
    } satisfies WorkerMessage);
  }, []);

  const importGpxFile = useCallback(
    (file: File, toleranceM = 20, targetSlotIdx?: number) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        if (text) importGpxContent(text, toleranceM, targetSlotIdx);
      };
      reader.readAsText(file);
    },
    [importGpxContent],
  );

  const updateCustomProfileDsl = useCallback(
    (profileId: ProfileName, content: string, recomputeActiveSlots = true) => {
      if (!workerRef.current) return;
      // Include `id` when recomputing so a freshly respawned Worker parses and validates the
      // `.brf` script immediately via `CUSTOM_PROFILE_LOADED` instead of deferring parse errors.
      workerRef.current.postMessage({
        type: 'LOAD_CUSTOM_PROFILE',
        id: recomputeActiveSlots ? String(++routeCounterRef.current) : undefined,
        name: profileId,
        content,
      } satisfies WorkerMessage);

      if (recomputeActiveSlots) {
        const currentSlots = slotsRef.current;
        const matchingSlotIndices: number[] = [];
        currentSlots.forEach((s, idx) => {
          if (s.profile === profileId && s.waypoints.length >= 2) {
            matchingSlotIndices.push(idx);
          }
        });
        if (matchingSlotIndices.length > 0) {
          const nextSlots = currentSlots.map((s) =>
            s.profile === profileId && s.waypoints.length >= 2 ? { ...s, isRouting: true } : s,
          );
          slotsRef.current = nextSlots;
          setSlotsState(nextSlots);
          setStatus('Calculating route...');
          setIsError(false);
          for (const idx of matchingSlotIndices) {
            postSlotRouteRequest(
              idx,
              nextSlots[idx].waypoints,
              profileId,
              nextSlots[idx].avoidAreas,
              nextSlots[idx].alternativeIdx,
            );
          }
        }
      }
    },
    [postSlotRouteRequest],
  );

  const saveCustomProfile = useCallback(
    (record: CustomProfileRecord, recompute = true) => {
      setCustomProfiles((prev) => {
        const exists = prev.some((c) => c.id === record.id);
        const next = exists
          ? prev.map((c) => (c.id === record.id ? record : c))
          : [...prev, record];
        customProfilesRef.current = next;
        saveCustomProfilesToStorage(next);
        return next;
      });
      draftProfileRef.current = record;
      setDraftProfileState(record);
      updateCustomProfileDsl(record.id, record.dsl, recompute);
      if (
        record.id !== 'custom:__draft__' &&
        !slotsRef.current.some((s) => s.profile === 'custom:__draft__')
      ) {
        workerRef.current?.postMessage({
          type: 'REMOVE_CUSTOM_PROFILE',
          name: 'custom:__draft__',
        } satisfies WorkerMessage);
      }
    },
    [updateCustomProfileDsl],
  );

  const deleteCustomProfile = useCallback(
    (profileId: string) => {
      setCustomProfiles((prev) => {
        const next = prev.filter((c) => c.id !== profileId);
        customProfilesRef.current = next;
        saveCustomProfilesToStorage(next);
        return next;
      });
      if (draftProfileRef.current?.id === profileId) {
        draftProfileRef.current = null;
        setDraftProfileState(null);
      }
      workerRef.current?.postMessage({
        type: 'REMOVE_CUSTOM_PROFILE',
        name: profileId,
      } satisfies WorkerMessage);
      const currentSlots = slotsRef.current;
      if (currentSlots.some((s) => s.profile === profileId)) {
        const fallback = PROFILE_ORDER[0];
        const nextSlots = currentSlots.map((s) =>
          s.profile === profileId
            ? {
                ...s,
                profile: fallback,
                alternativeIdx: 0,
                isRouting: s.waypoints.length >= 2,
              }
            : s,
        );
        slotsRef.current = nextSlots;
        setSlotsState(nextSlots);
        saveToUrlAndStorage(nextSlots, activeSlotIdxRef.current);
        nextSlots.forEach((slot, idx) => {
          if (currentSlots[idx].profile === profileId && slot.waypoints.length >= 2) {
            postSlotRouteRequest(idx, slot.waypoints, fallback, slot.avoidAreas, 0);
          }
        });
      }
    },
    [postSlotRouteRequest, saveToUrlAndStorage],
  );

  const loadSavedRoute = useCallback(
    (record: SavedRouteRecord, mode: 'current' | 'new-route' = 'current') => {
      let resolvedProfile: ProfileName = record.profile;
      if (record.customProfile && record.profile === record.customProfile.id) {
        const cp = record.customProfile;
        const exists = customProfilesRef.current.some((c) => c.id === cp.id);
        if (!exists) {
          const nextCustom = [...customProfilesRef.current, cp];
          customProfilesRef.current = nextCustom;
          setCustomProfiles(nextCustom);
          saveCustomProfilesToStorage(nextCustom);
        }
        workerRef.current?.postMessage({
          type: 'LOAD_CUSTOM_PROFILE',
          name: cp.id,
          content: cp.dsl,
        } satisfies WorkerMessage);
      } else if (
        !(record.profile in PROFILE_INFO) &&
        !customProfilesRef.current.some((c) => c.id === record.profile) &&
        draftProfileRef.current?.id !== record.profile
      ) {
        resolvedProfile = PROFILE_ORDER[0];
      }

      const newWps = record.waypoints.map((w) => ({ ...w }));
      const newAvoids = record.avoidAreas.map((a) => ({ ...a }));
      const alt = Math.max(0, Math.min(3, Math.trunc(record.alternativeIdx || 0)));
      const hasWps = newWps.length >= 2;
      const currentRouteCount = getRouteCount(slotsRef.current);

      if (mode === 'new-route' && currentRouteCount < MAX_ROUTES) {
        const usedColors = new Set(slotsRef.current.map((s, idx) => getSlotColor(s, idx).id));
        const nextColor =
          ROUTE_COLOR_PALETTE.find((c) => !usedColors.has(c.id)) || ROUTE_COLOR_PALETTE[0];
        const newRouteIdx = currentRouteCount;
        const newSlotIdx = slotsRef.current.length;

        const nextSlots: RouteSlotState[] = [
          ...slotsRef.current,
          {
            routeIdx: newRouteIdx,
            profile: resolvedProfile,
            waypoints: newWps,
            avoidAreas: newAvoids,
            alternativeIdx: alt,
            route: null,
            isRouting: hasWps && Boolean(workerRef.current),
            colorId: nextColor.id,
          },
        ];
        historiesRef.current[newRouteIdx] = new HistoryStack<RouteHistorySnapshot>(MAX_UNDO);
        activeSlotRouteIdRef.current.push(null);
        requestedSlotAltRef.current.push(alt);
        shownSlotAltRef.current.push(alt);

        activeSlotIdxRef.current = newSlotIdx;
        slotsRef.current = nextSlots;
        setActiveSlotIdxState(newSlotIdx);
        setSlotsState(nextSlots);
        setRouteSavedId(newRouteIdx, record.id);
        updateUndoRedo(newSlotIdx);
        saveToUrlAndStorage(nextSlots, newSlotIdx);
        setFitBoundsSeq((s) => s + 1);

        if (hasWps && workerRef.current) {
          setStatus('Calculating route...');
          setIsError(false);
          postSlotRouteRequest(newSlotIdx, newWps, resolvedProfile, newAvoids, alt);
        }
        return;
      }

      const activeIdx = activeSlotIdxRef.current;
      const targetRouteIdx = slotsRef.current[activeIdx]?.routeIdx ?? 0;
      const firstRouteSlotIdx = slotsRef.current.findIndex(
        (s) => (s.routeIdx ?? 0) === targetRouteIdx,
      );
      if (firstRouteSlotIdx === -1) return;

      const primarySlotIdx =
        (slotsRef.current[activeIdx]?.routeIdx ?? 0) === targetRouteIdx
          ? activeIdx
          : firstRouteSlotIdx;
      const currentSlot = slotsRef.current[primarySlotIdx];

      if (currentSlot.waypoints.length > 0 || currentSlot.avoidAreas.length > 0) {
        if (!historiesRef.current[targetRouteIdx]) {
          historiesRef.current[targetRouteIdx] = new HistoryStack(MAX_UNDO);
        }
        historiesRef.current[targetRouteIdx].record({
          waypoints: currentSlot.waypoints.map((w) => ({ ...w })),
          avoidAreas: currentSlot.avoidAreas.map((a) => ({ ...a })),
        });
      }
      if (activeImportRef.current?.routeIdx === targetRouteIdx) {
        activeImportRef.current = null;
      }

      const slotsToRoute: Array<{ idx: number; prof: ProfileName; alt: number }> = [];
      const nextSlots = slotsRef.current.map((s, idx) => {
        if ((s.routeIdx ?? 0) !== targetRouteIdx) return s;
        const isPrimary = idx === primarySlotIdx;
        const slotProf = isPrimary ? resolvedProfile : s.profile;
        const slotAlt = isPrimary ? alt : 0;
        activeSlotRouteIdRef.current[idx] = null;
        requestedSlotAltRef.current[idx] = slotAlt;
        shownSlotAltRef.current[idx] = slotAlt;
        if (hasWps) {
          slotsToRoute.push({ idx, prof: slotProf, alt: slotAlt });
        }
        return {
          ...s,
          profile: slotProf,
          waypoints: newWps.map((w) => ({ ...w })),
          avoidAreas: newAvoids.map((a) => ({ ...a })),
          alternativeIdx: slotAlt,
          route: null,
          isRouting: hasWps && Boolean(workerRef.current),
        };
      });

      slotsRef.current = nextSlots;
      setSlotsState(nextSlots);
      setRouteSavedId(targetRouteIdx, record.id);
      updateUndoRedo(primarySlotIdx);
      saveToUrlAndStorage(nextSlots, activeIdx);
      setFitBoundsSeq((s) => s + 1);

      if (slotsToRoute.length > 0 && workerRef.current) {
        setStatus('Calculating route...');
        setIsError(false);
        for (const item of slotsToRoute) {
          postSlotRouteRequest(item.idx, newWps, item.prof, newAvoids, item.alt);
        }
      }
    },
    [postSlotRouteRequest, saveToUrlAndStorage, setRouteSavedId, updateUndoRedo],
  );

  const setActiveSavedRouteId = useCallback(
    (id: number | null) => {
      const currentRouteIdx = slotsRef.current[activeSlotIdxRef.current]?.routeIdx ?? 0;
      setRouteSavedId(currentRouteIdx, id);
    },
    [setRouteSavedId],
  );

  const activeSlot = slots[activeSlotIdx] ||
    slots[0] || {
      routeIdx: 0,
      profile: PROFILE_ORDER[0],
      waypoints: [],
      avoidAreas: [],
      alternativeIdx: 0,
      route: null,
      isRouting: false,
    };
  const activeRouteIdx = activeSlot.routeIdx ?? 0;
  const routeCount = getRouteCount(slots);
  const isRouting = slots.some((s) => s.isRouting);

  return {
    slots,
    activeSlotIdx,
    setActiveSlot,
    routeCount,
    activeRouteIdx,
    setActiveRoute,
    addRoute,
    removeRoute,
    addProfileSlot,
    removeProfileSlot,
    setSlotProfile,
    setSlotColor,
    selectSlotAlternative,
    customProfiles,
    draftProfile,
    setDraftProfile,
    customProfileError,
    getProfileMeta,
    updateCustomProfileDsl,
    abortInFlightProfileRoute,
    saveCustomProfile,
    deleteCustomProfile,
    profile: activeSlot.profile,
    setProfile,
    waypoints: activeSlot.waypoints,
    setWaypoints,
    avoidAreas: activeSlot.avoidAreas,
    setAvoidAreas,
    currentRoute: activeSlot.route,
    alternativeIdx: activeSlot.alternativeIdx,
    selectAlternative,
    status,
    isError,
    setStatus: setStatusMsg,
    isRouting,
    canUndo,
    canRedo,
    fitBoundsSeq,
    triggerFitBounds,
    inspectPoint,
    importGpxContent,
    importGpxFile,
    loadSavedRoute,
    activeSavedRouteId: savedRouteIdsByRoute[activeRouteIdx] ?? null,
    setActiveSavedRouteId,
    clearDeletedSavedRouteId,
    addWaypoint,
    insertWaypointAtLeg,
    moveWaypoint,
    removeWaypoint,
    renameWaypoint,
    reorderWaypoints,
    reverseRoute,
    addAvoidArea,
    updateAvoidAreaRadius,
    removeAvoidArea,
    clearAvoidAreas,
    clearRoute,
    undo,
    redo,
    clearWorkerGraph,
  };
}
