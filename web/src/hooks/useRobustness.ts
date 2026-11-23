import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type {
  ProfileMeta,
  ProfileName,
  RouteResponse,
  RouteSlotState,
  WorkerMessage,
} from '../types.ts';
import {
  normalizeProfileAxes,
  TEMPLATE_PRESETS,
  type BaseTemplateId,
  type CustomProfileRecord,
  type ProfileAxes,
} from '../utils/profile-editor.ts';
import {
  createRobustnessSession,
  buildRobustnessProbes,
  DEFAULT_SCENARIO_COUNT,
  filterRobustnessAnalysis,
  type RobustnessAnalysis,
  type RobustnessFilterMode,
  type RobustnessSession,
  type RobustnessViewMode,
  type ScenarioPresetCount,
} from '../utils/robustness.ts';
import { getSharedWasmModule } from './useRouting.ts';

const UI_FLUSH_INTERVAL_MS = 180;

interface UseRobustnessParams {
  activeSlot: RouteSlotState | undefined;
  activeSlotIdx: number;
  isOfflineMode: boolean;
  customProfiles: CustomProfileRecord[];
  draftProfile: CustomProfileRecord | null;
  getProfileMeta: (id: ProfileName) => ProfileMeta;
}

export function useRobustness({
  activeSlot,
  activeSlotIdx,
  isOfflineMode,
  customProfiles,
  draftProfile,
  getProfileMeta,
}: UseRobustnessParams) {
  const [isOpen, setIsOpen] = useState(false);
  const [scenarioCount, setScenarioCount] = useState<ScenarioPresetCount>(DEFAULT_SCENARIO_COUNT);
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [completed, setCompleted] = useState(0);
  const [total, setTotal] = useState<number>(DEFAULT_SCENARIO_COUNT);
  const [currentLabel, setCurrentLabel] = useState('');
  const [workerStatus, setWorkerStatus] = useState('');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<RobustnessAnalysis | null>(null);
  const [viewMode, setViewModeState] = useState<RobustnessViewMode>('variants');
  const [filterMode, setFilterModeState] = useState<RobustnessFilterMode>('frequent');
  const [showStabilityMap, setShowStabilityMap] = useState(false);
  const [hoveredCorridorId, setHoveredCorridorId] = useState<string | null>(null);
  const [pinnedCorridorId, setPinnedCorridorId] = useState<string | null>(null);

  const setViewMode = useCallback((mode: RobustnessViewMode) => {
    setViewModeState(mode);
    setHoveredCorridorId(null);
    setPinnedCorridorId(null);
  }, []);

  const setFilterMode = useCallback((mode: RobustnessFilterMode) => {
    setFilterModeState(mode);
    setHoveredCorridorId(null);
    setPinnedCorridorId(null);
  }, []);

  const visibleAnalysis = useMemo(
    () => (analysis ? filterRobustnessAnalysis(analysis, filterMode) : null),
    [analysis, filterMode],
  );

  const workersRef = useRef<Array<Worker | null>>([]);
  const runIdRef = useRef(0);
  const sessionRef = useRef<RobustnessSession | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTimeRef = useRef<number>(0);

  const customStamp = useMemo(() => {
    if (!activeSlot) return '';
    if (draftProfile && draftProfile.id === activeSlot.profile) {
      return `draft:${draftProfile.updatedAt}`;
    }
    const saved = customProfiles.find((c) => c.id === activeSlot.profile);
    return saved ? `saved:${saved.updatedAt}` : '';
  }, [activeSlot?.profile, customProfiles, draftProfile]);

  const routeSignature = useMemo(() => {
    if (!activeSlot || !activeSlot.route || activeSlot.waypoints.length < 2) {
      return '';
    }
    const wps = activeSlot.waypoints.map((w) => `${w.lat.toFixed(5)},${w.lon.toFixed(5)}`).join(';');
    const nogos = activeSlot.avoidAreas
      .map((a) => `${a.lat.toFixed(5)},${a.lon.toFixed(5)},${a.radius},${a.weight ?? ''}`)
      .join(';');
    return `${activeSlotIdx}|${activeSlot.profile}|${activeSlot.alternativeIdx}|${customStamp}|${wps}|${nogos}`;
  }, [
    activeSlotIdx,
    activeSlot?.profile,
    activeSlot?.alternativeIdx,
    activeSlot?.route,
    activeSlot?.waypoints,
    activeSlot?.avoidAreas,
    customStamp,
  ]);

  const clearFlushTimer = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  const terminateAllWorkers = useCallback(() => {
    clearFlushTimer();
    for (const w of workersRef.current) {
      w?.terminate();
    }
    workersRef.current = [];
  }, [clearFlushTimer]);

  const prevSigRef = useRef(routeSignature);
  useEffect(() => {
    if (prevSigRef.current === routeSignature) return;
    prevSigRef.current = routeSignature;
    runIdRef.current++;
    terminateAllWorkers();
    sessionRef.current = null;
    setPhase('idle');
    setCompleted(0);
    setCurrentLabel('');
    setWorkerStatus('');
    setElapsedSec(0);
    setError(null);
    setAnalysis(null);
    setHoveredCorridorId(null);
    setPinnedCorridorId(null);
    if (!routeSignature) {
      setIsOpen(false);
    }
  }, [routeSignature, terminateAllWorkers]);

  useEffect(() => {
    return () => {
      terminateAllWorkers();
    };
  }, [terminateAllWorkers]);

  useEffect(() => {
    if (phase !== 'running') return;
    const timer = setInterval(() => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - startTimeRef.current) / 1000)));
    }, 500);
    return () => clearInterval(timer);
  }, [phase]);

  const cancel = useCallback(() => {
    runIdRef.current++;
    terminateAllWorkers();
    sessionRef.current = null;
    setPhase('idle');
    setCompleted(0);
    setCurrentLabel('');
    setWorkerStatus('');
    setElapsedSec(0);
    setError(null);
    setAnalysis(null);
    setHoveredCorridorId(null);
    setPinnedCorridorId(null);
  }, [terminateAllWorkers]);

  const start = useCallback(
    async (overrideCount?: ScenarioPresetCount) => {
      if (!activeSlot || !activeSlot.route || activeSlot.waypoints.length < 2) return;

      const targetCount = overrideCount ?? scenarioCount;
      if (overrideCount && overrideCount !== scenarioCount) {
        setScenarioCount(overrideCount);
      }

      const baseRoute = activeSlot.route as unknown as RouteResponse;
      const runSeq = ++runIdRef.current;

      terminateAllWorkers();
      sessionRef.current = null;
      startTimeRef.current = Date.now();
      setIsOpen(true);
      setPhase('running');
      setCompleted(0);
      setTotal(targetCount);
      setCurrentLabel('Preparing scenarios...');
      setWorkerStatus('');
      setElapsedSec(0);
      setError(null);
      setAnalysis(null);
      setHoveredCorridorId(null);
      setPinnedCorridorId(null);

      try {
        let axes: ProfileAxes | undefined;
        let baseTemplate: BaseTemplateId | undefined;
        let baseDsl: string | undefined;

        const customRec =
          draftProfile && draftProfile.id === activeSlot.profile
            ? draftProfile
            : customProfiles.find((c) => c.id === activeSlot.profile);

        if (customRec) {
          if (customRec.mode === 'detailed') {
            baseTemplate = customRec.baseTemplate;
            axes = normalizeProfileAxes(customRec.axes, customRec.baseTemplate);
          } else {
            baseDsl = customRec.dsl;
          }
        } else if (activeSlot.profile in TEMPLATE_PRESETS) {
          const tpl = activeSlot.profile as BaseTemplateId;
          baseTemplate = tpl;
          axes = { ...TEMPLATE_PRESETS[tpl].axes };
        } else {
          const res = await fetch(`/profiles/${activeSlot.profile}.brf`);
          if (!res.ok) {
            throw new Error(`Failed to fetch profile ${activeSlot.profile}.brf`);
          }
          baseDsl = await res.text();
        }

        if (runIdRef.current !== runSeq) return;

        const meta = getProfileMeta(activeSlot.profile);
        const probes = buildRobustnessProbes({
          baseProfile: activeSlot.profile,
          profileLabel: meta.shortLabel || meta.label || activeSlot.profile,
          axes,
          baseTemplate,
          baseDsl,
          scenarioCount: targetCount,
        });

        setTotal(probes.length);

        const wasmModule = await getSharedWasmModule();
        if (runIdRef.current !== runSeq) return;

        const session = createRobustnessSession(baseRoute, probes.length);
        sessionRef.current = session;

        const hwCores =
          typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
        const baseDistM = Number(baseRoute.features[0]?.properties?.['track-length'] || 0);
        const maxWorkers = baseDistM > 50_000 ? 2 : 4;
        const poolSize = Math.min(
          probes.length,
          Math.max(1, Math.min(maxWorkers, Math.floor(hwCores / 2))),
        );

        let nextProbeIdx = 0;
        let finishedProbes = 0;
        let dirtyAnalysis = false;
        let receivedAnyResult = false;
        const activeLabels = new Map<number, string>();
        const nogos = activeSlot.avoidAreas.length > 0 ? activeSlot.avoidAreas : undefined;

        const flushUi = (isDone = false) => {
          clearFlushTimer();
          if (runIdRef.current !== runSeq) return;
          setCompleted(finishedProbes);
          setCurrentLabel(isDone ? '' : Array.from(activeLabels.values()).join(' · '));
          if (dirtyAnalysis && receivedAnyResult) {
            dirtyAnalysis = false;
            setAnalysis(session.snapshot());
          }
          if (isDone) {
            setPhase('done');
            setWorkerStatus('');
          }
        };

        const scheduleUiFlush = () => {
          if (flushTimerRef.current !== null) return;
          flushTimerRef.current = setTimeout(() => {
            flushTimerRef.current = null;
            flushUi(false);
          }, UI_FLUSH_INTERVAL_MS);
        };

        const dispatchNext = (workerIdx: number, worker: Worker) => {
          if (runIdRef.current !== runSeq) return;
          if (nextProbeIdx >= probes.length) {
            activeLabels.delete(workerIdx);
            worker.terminate();
            workersRef.current[workerIdx] = null;
            if (finishedProbes >= probes.length) {
              flushUi(true);
            } else {
              scheduleUiFlush();
            }
            return;
          }

          const idx = nextProbeIdx++;
          const probe = probes[idx];
          activeLabels.set(workerIdx, probe.label);

          worker.postMessage({
            type: 'ROBUSTNESS_PROBE_REQUEST',
            id: `${runSeq}:${idx}`,
            payload: {
              waypoints: activeSlot.waypoints,
              nogos,
              probe,
            },
          } satisfies WorkerMessage);
        };

        const pool: Array<Worker | null> = new Array(poolSize).fill(null);
        workersRef.current = pool;

        for (let wIdx = 0; wIdx < poolSize; wIdx++) {
          const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
          pool[wIdx] = worker;

          worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
            if (runIdRef.current !== runSeq || workersRef.current[wIdx] !== worker) return;
            const msg = e.data;
            if (msg.type === 'STATUS') {
              if (msg.message.startsWith('Downloading') || msg.message.startsWith('Fetching')) {
                setWorkerStatus(msg.message);
              }
              return;
            }
            if (msg.type === 'ROBUSTNESS_PROBE_RESULT' && msg.id.startsWith(`${runSeq}:`)) {
              setWorkerStatus('');
              finishedProbes++;
              if (msg.probeResult) {
                session.addProbe(msg.probeResult);
                receivedAnyResult = true;
                dirtyAnalysis = true;
              }
              dispatchNext(wIdx, worker);
              if (finishedProbes >= probes.length) {
                flushUi(true);
              } else if (finishedProbes === 1) {
                flushUi(false);
              } else {
                scheduleUiFlush();
              }
              return;
            }
            if (msg.type === 'ROBUSTNESS_ERROR' && msg.id.startsWith(`${runSeq}:`)) {
              setPhase('error');
              setError(msg.error);
              setCurrentLabel('');
              setWorkerStatus('');
              terminateAllWorkers();
            }
          };

          worker.onerror = (err) => {
            if (runIdRef.current !== runSeq || workersRef.current[wIdx] !== worker) return;
            setPhase('error');
            setError(err.message || 'Background worker failed');
            terminateAllWorkers();
          };

          worker.postMessage({
            type: 'SET_OFFLINE_MODE',
            offline: isOfflineMode,
          } satisfies WorkerMessage);
          worker.postMessage({ type: 'INIT', wasmModule } satisfies WorkerMessage);
          dispatchNext(wIdx, worker);
        }
        setCurrentLabel(Array.from(activeLabels.values()).join(' · '));
      } catch (err: any) {
        if (runIdRef.current !== runSeq) return;
        setPhase('error');
        setError(err?.message || String(err));
        terminateAllWorkers();
      }
    },
    [
      activeSlot,
      clearFlushTimer,
      customProfiles,
      draftProfile,
      getProfileMeta,
      isOfflineMode,
      scenarioCount,
      terminateAllWorkers,
    ],
  );

  const pendingAutoStartRef = useRef(false);

  useEffect(() => {
    if (pendingAutoStartRef.current && isOpen && phase === 'idle' && !analysis && activeSlot?.route) {
      pendingAutoStartRef.current = false;
      void start();
    }
  }, [isOpen, phase, analysis, activeSlot?.route, start]);

  const toggleOpen = useCallback(() => {
    if (isOpen) {
      pendingAutoStartRef.current = false;
      setIsOpen(false);
      setHoveredCorridorId(null);
    } else {
      setIsOpen(true);
      if (phase === 'idle' && !analysis) {
        void start();
      }
    }
  }, [isOpen, phase, analysis, start]);

  const openAndRun = useCallback(() => {
    setIsOpen(true);
    pendingAutoStartRef.current = true;
  }, []);

  const focusedCorridorId = hoveredCorridorId ?? pinnedCorridorId;

  return {
    isOpen,
    setIsOpen,
    toggleOpen,
    openAndRun,
    scenarioCount,
    setScenarioCount,
    phase,
    completed,
    total,
    currentLabel,
    workerStatus,
    elapsedSec,
    error,
    analysis,
    visibleAnalysis,
    viewMode,
    setViewMode,
    filterMode,
    setFilterMode,
    showStabilityMap,
    setShowStabilityMap,
    hoveredCorridorId,
    setHoveredCorridorId,
    pinnedCorridorId,
    setPinnedCorridorId,
    focusedCorridorId,
    start,
    cancel,
  };
}
