import React, { useState, useEffect, useRef } from 'react';
import type { useRouting } from '../hooks/useRouting.ts';
import {
  downloadBrfFile,
  generateBrfFromAxes,
  normalizeProfileAxes,
  TEMPLATE_PRESETS,
  type BaseTemplateId,
  type CustomProfileRecord,
  type ProfileAxes,
} from '../utils/profile-editor.ts';
import { InfoButton } from './TooltipPopover.tsx';
import { Icon } from './common/Icon.tsx';

interface ProfileEditorPanelProps {
  routing: ReturnType<typeof useRouting>;
  onClose: () => void;
}

const BASE_TEMPLATE_ORDER: BaseTemplateId[] = [
  'gabis-fast-city',
  'gabis-safe-road',
  'gabis-lite-gravel',
];

const DRAFT_PROFILE_ID = 'custom:__draft__';

// Pause window after slider release, toggle clicks, or DSL edits before dispatching a route search.
// Also enforces Safeguard 1 (Timing separation): after `abortInFlightProfileRoute` terminates a
// blocked Worker at `t = 0 ms`, waiting 600 ms gives the browser and OS time to unmap the old
// 500-800 MB `WebAssembly.Memory` heap before the respawned Worker allocates a new search heap.
const EDITOR_RECALC_DEBOUNCE_MS = 600;

interface SliderRowProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  tooltip?: string;
  disallowable?: boolean;
  formatValue?: (v: number) => string;
  onChange: (val: number) => void;
}

const SliderRow: React.FC<SliderRowProps> = ({
  id,
  label,
  value,
  min,
  max,
  step,
  unit = '',
  tooltip,
  disallowable = false,
  formatValue,
  onChange,
}) => {
  const isDisallowed = disallowable && value >= 9999;
  const lastFiniteRef = useRef<number>(value < 9999 && Number.isFinite(value) ? value : max);
  if (!isDisallowed && Number.isFinite(value)) {
    lastFiniteRef.current = value;
  }

  const safeVal = isDisallowed ? max : Number.isFinite(value) ? value : min;
  const displayVal = isDisallowed
    ? '10000'
    : formatValue
      ? formatValue(safeVal)
      : `${Number(safeVal.toFixed(3))}${unit ? ` ${unit}` : ''}`;

  return (
    <div className="pe-slider-row">
      <div className="pe-slider-header">
        <span className="pe-slider-label">
          {label}
          {tooltip && <InfoButton tooltip={tooltip} ariaLabel={label} />}
        </span>
        <div className="pe-slider-right">
          {disallowable && (
            <label
              className={`pe-disallow-check ${isDisallowed ? 'active' : ''}`}
              title="Explicitly forbid this class in BRouter (sets costfactor = 10000)"
            >
              <input
                id={`${id}-disallow`}
                type="checkbox"
                checked={isDisallowed}
                onChange={(e) => {
                  if (e.target.checked) {
                    onChange(10000);
                  } else {
                    onChange(lastFiniteRef.current);
                  }
                }}
              />
              <span>Disallow</span>
            </label>
          )}
          <span className={`pe-slider-val ${isDisallowed ? 'disallowed' : ''}`}>{displayVal}</span>
        </div>
      </div>
      <input
        id={id}
        type="range"
        className="pe-range-input"
        min={min}
        max={max}
        step={step}
        value={safeVal}
        disabled={isDisallowed}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
};

interface ToggleRowProps {
  id: string;
  label: string;
  checked: boolean;
  tooltip?: string;
  onChange: (checked: boolean) => void;
}

const ToggleRow: React.FC<ToggleRowProps> = ({ id, label, checked, tooltip, onChange }) => (
  <div className="pe-toggle-row">
    <span className="pe-toggle-label">
      {label}
      {tooltip && <InfoButton tooltip={tooltip} ariaLabel={label} />}
    </span>
    <label className="offline-mode-toggle" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="offline-slider"></span>
    </label>
  </div>
);

interface SectionSummarySwitchProps {
  id: string;
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

const SectionSummarySwitch: React.FC<SectionSummarySwitchProps> = ({
  id,
  checked,
  label,
  onChange,
}) => (
  <label
    className="offline-mode-toggle pe-section-toggle"
    htmlFor={id}
    title={checked ? `Disable ${label}` : `Enable ${label}`}
    onClick={(e) => e.stopPropagation()}
  >
    <input
      id={id}
      type="checkbox"
      checked={checked}
      aria-label={`Enable ${label}`}
      onChange={(e) => onChange(e.target.checked)}
    />
    <span className="offline-slider"></span>
  </label>
);

function slugifyProfileId(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `custom:${slug || 'my-profile'}`;
}

export const ProfileEditorPanel: React.FC<ProfileEditorPanelProps> = ({ routing, onClose }) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeDraft =
    routing.draftProfile && routing.draftProfile.id === routing.profile
      ? routing.draftProfile
      : null;
  const savedCustom = routing.customProfiles.find((c) => c.id === routing.profile);
  const initialCustom = activeDraft || savedCustom;
  const initialTemplate: BaseTemplateId =
    initialCustom?.baseTemplate ||
    (routing.profile === 'gabis-safe-road' || routing.profile === 'gabis-lite-gravel'
      ? (routing.profile as BaseTemplateId)
      : 'gabis-fast-city');

  const initialName = initialCustom
    ? initialCustom.name
    : `${TEMPLATE_PRESETS[initialTemplate].shortLabel} Custom`;
  const initialSummary = initialCustom
    ? initialCustom.summary
    : TEMPLATE_PRESETS[initialTemplate].summary;
  const initialMode: 'detailed' | 'dsl' = initialCustom?.mode || 'detailed';
  const initialAxes: ProfileAxes = initialCustom
    ? normalizeProfileAxes(initialCustom.axes, initialTemplate)
    : { ...TEMPLATE_PRESETS[initialTemplate].axes };
  const initialDsl = initialCustom
    ? initialCustom.mode === 'dsl'
      ? initialCustom.dsl
      : generateBrfFromAxes(initialAxes, {
          name: initialName,
          summary: initialSummary,
        })
    : generateBrfFromAxes(initialAxes, {
        name: initialName,
        summary: initialSummary,
      });

  const [selectedSource, setSelectedSource] = useState<string>(
    savedCustom ? savedCustom.id : initialTemplate,
  );
  const [baseTemplate, setBaseTemplate] = useState<BaseTemplateId>(initialTemplate);
  const [profileName, setProfileName] = useState<string>(initialName);
  const [profileSummary, setProfileSummary] = useState<string>(initialSummary);
  const [mode, setMode] = useState<'detailed' | 'dsl'>(initialMode);
  const [axes, setAxes] = useState<ProfileAxes>(initialAxes);
  const [dslText, setDslText] = useState<string>(initialDsl);
  const [dslDirty, setDslDirty] = useState<boolean>(initialMode === 'dsl');
  const [saveToast, setSaveToast] = useState<string | null>(null);
  const [isDraggingSlider, setIsDraggingSlider] = useState<boolean>(false);

  const activeProfileIdRef = useRef<string>(
    savedCustom ? savedCustom.id : initialCustom?.id || DRAFT_PROFILE_ID,
  );
  const axesRef = useRef<ProfileAxes>(initialAxes);
  axesRef.current = axes;
  const didMountInitRef = useRef<boolean>(false);
  const lastSubmittedDslRef = useRef<string>(initialDsl);

  const resolveEditedSlotIdx = (matchProfileId?: string): number => {
    if (matchProfileId) {
      const matchingOnActiveRoute = routing.slots.findIndex(
        (s) => (s.routeIdx ?? 0) === routing.activeRouteIdx && s.profile === matchProfileId,
      );
      if (matchingOnActiveRoute !== -1) return matchingOnActiveRoute;
    }
    const activeSlot = routing.slots[routing.activeSlotIdx];
    if (activeSlot && (activeSlot.routeIdx ?? 0) === routing.activeRouteIdx) {
      return routing.activeSlotIdx;
    }
    const firstOnActiveRoute = routing.slots.findIndex(
      (s) => (s.routeIdx ?? 0) === routing.activeRouteIdx,
    );
    return firstOnActiveRoute !== -1 ? firstOnActiveRoute : 0;
  };

  const syncDraftState = (overrides?: Partial<CustomProfileRecord>) => {
    const nextRecord: CustomProfileRecord = {
      id: overrides?.id ?? activeProfileIdRef.current,
      name: (overrides?.name ?? profileName).trim() || 'Custom Profile',
      summary: (overrides?.summary ?? profileSummary).trim() || 'Custom cycling profile.',
      baseTemplate: overrides?.baseTemplate ?? baseTemplate,
      mode: overrides?.mode ?? (dslDirty ? 'dsl' : mode),
      axes: overrides?.axes ? { ...overrides.axes } : { ...axesRef.current },
      dsl: overrides?.dsl ?? dslText,
      updatedAt: Date.now(),
    };
    routing.setDraftProfile(nextRecord);
  };

  useEffect(() => {
    if (!isDraggingSlider) return;
    const finishDrag = () => setIsDraggingSlider(false);
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
    window.addEventListener('blur', finishDrag);
    return () => {
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
      window.removeEventListener('blur', finishDrag);
    };
  }, [isDraggingSlider]);

  // When editor mounts, bind the active slot to the edited custom profile without adding extra slots
  useEffect(() => {
    if (didMountInitRef.current) return;
    didMountInitRef.current = true;

    const targetId = activeProfileIdRef.current;
    lastSubmittedDslRef.current = dslText;
    syncDraftState({ id: targetId, dsl: dslText });
    routing.updateCustomProfileDsl(targetId, dslText, false);

    const targetSlotIdx = resolveEditedSlotIdx(targetId);
    const prevPrimary = routing.slots[targetSlotIdx]?.profile;
    if (prevPrimary !== targetId) {
      routing.setSlotProfile(targetSlotIdx, targetId);
    }
  }, []);

  // Debounced route update whenever dslText changes. Waits until any active slider drag ends,
  // plus EDITOR_RECALC_DEBOUNCE_MS (600 ms) so multi-property tweaks batch into one search and
  // any terminated Worker's WASM linear heap has time to unmap before the new search starts.
  useEffect(() => {
    if (isDraggingSlider) return;
    if (dslText === lastSubmittedDslRef.current) {
      return;
    }
    const timer = setTimeout(() => {
      lastSubmittedDslRef.current = dslText;
      routing.updateCustomProfileDsl(activeProfileIdRef.current, dslText, true);
    }, EDITOR_RECALC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [dslText, isDraggingSlider, selectedSource, routing.updateCustomProfileDsl]);

  const handleAxisChange = <K extends keyof ProfileAxes>(key: K, value: ProfileAxes[K]) => {
    routing.abortInFlightProfileRoute(activeProfileIdRef.current);
    const nextAxes = { ...axesRef.current, [key]: value };
    axesRef.current = nextAxes;
    const nextDsl = generateBrfFromAxes(nextAxes, {
      name: profileName,
      summary: profileSummary,
    });
    setAxes(nextAxes);
    setDslText(nextDsl);
    setDslDirty(false);
    syncDraftState({ axes: nextAxes, dsl: nextDsl, mode: 'detailed' });
  };

  const handleSelectSource = (val: string) => {
    const prevId = activeProfileIdRef.current;
    const aborted = routing.abortInFlightProfileRoute(prevId);
    const targetSlotIdx = resolveEditedSlotIdx(prevId);
    setSelectedSource(val);
    if (val in TEMPLATE_PRESETS) {
      const tpl = val as BaseTemplateId;
      const preset = TEMPLATE_PRESETS[tpl];
      const nextName = `${preset.shortLabel} Custom`;
      const nextAxes = { ...preset.axes };
      const nextDsl = generateBrfFromAxes(nextAxes, {
        name: nextName,
        summary: preset.summary,
      });
      axesRef.current = nextAxes;
      setBaseTemplate(tpl);
      setProfileName(nextName);
      setProfileSummary(preset.summary);
      setAxes(nextAxes);
      // Safeguard 1: if an in-flight Worker was just terminated, defer recomputation to the
      // 600 ms debounce timer instead of allocating a new WASM heap synchronously at t = 0 ms.
      lastSubmittedDslRef.current = aborted ? '' : nextDsl;
      setDslText(nextDsl);
      setDslDirty(false);
      activeProfileIdRef.current = DRAFT_PROFILE_ID;
      syncDraftState({
        id: DRAFT_PROFILE_ID,
        name: nextName,
        summary: preset.summary,
        baseTemplate: tpl,
        mode: 'detailed',
        axes: nextAxes,
        dsl: nextDsl,
      });
      routing.updateCustomProfileDsl(DRAFT_PROFILE_ID, nextDsl, false);
      routing.setSlotProfile(targetSlotIdx, DRAFT_PROFILE_ID, !aborted);
      return;
    }

    const saved = routing.customProfiles.find((c) => c.id === val);
    if (saved) {
      const normAxes = normalizeProfileAxes(saved.axes, saved.baseTemplate);
      axesRef.current = normAxes;
      setBaseTemplate(saved.baseTemplate);
      setProfileName(saved.name);
      setProfileSummary(saved.summary);
      setMode(saved.mode);
      setAxes(normAxes);
      lastSubmittedDslRef.current = aborted ? '' : saved.dsl;
      setDslText(saved.dsl);
      setDslDirty(saved.mode === 'dsl');
      activeProfileIdRef.current = saved.id;
      syncDraftState({
        id: saved.id,
        name: saved.name,
        summary: saved.summary,
        baseTemplate: saved.baseTemplate,
        mode: saved.mode,
        axes: normAxes,
        dsl: saved.dsl,
      });
      routing.updateCustomProfileDsl(saved.id, saved.dsl, false);
      routing.setSlotProfile(targetSlotIdx, saved.id, !aborted);
    }
  };

  const handleResetToTemplate = () => {
    routing.abortInFlightProfileRoute(activeProfileIdRef.current);
    const preset = TEMPLATE_PRESETS[baseTemplate];
    const nextAxes = { ...preset.axes };
    axesRef.current = nextAxes;
    const nextDsl = generateBrfFromAxes(nextAxes, {
      name: profileName,
      summary: profileSummary,
    });
    setAxes(nextAxes);
    setDslText(nextDsl);
    setDslDirty(false);
    syncDraftState({ axes: nextAxes, dsl: nextDsl, mode: 'detailed' });
  };

  const handleSaveProfile = () => {
    const prevId = activeProfileIdRef.current;
    const targetSlotIdx = resolveEditedSlotIdx(prevId);
    const targetSlot = routing.slots[targetSlotIdx];
    const trimmedName = profileName.trim() || 'Custom Profile';
    const id = slugifyProfileId(trimmedName);
    const finalDsl = dslDirty
      ? dslText
      : generateBrfFromAxes(axesRef.current, { name: trimmedName, summary: profileSummary });

    const hasMatchingRoute =
      finalDsl === lastSubmittedDslRef.current &&
      !targetSlot?.isRouting &&
      Boolean(targetSlot?.route);
    const alreadyComputingSameProfile =
      prevId === id &&
      finalDsl === lastSubmittedDslRef.current &&
      Boolean(targetSlot?.isRouting);
    const aborted =
      prevId !== id || finalDsl !== lastSubmittedDslRef.current
        ? routing.abortInFlightProfileRoute(prevId)
        : false;
    const needsImmediateRecompute =
      !aborted &&
      !hasMatchingRoute &&
      !alreadyComputingSameProfile &&
      (targetSlot?.waypoints.length ?? 0) >= 2;

    const record: CustomProfileRecord = {
      id,
      name: trimmedName,
      summary: profileSummary.trim() || 'Custom cycling profile.',
      baseTemplate,
      mode: dslDirty ? 'dsl' : mode,
      axes: { ...axesRef.current },
      dsl: finalDsl,
      updatedAt: Date.now(),
    };

    activeProfileIdRef.current = id;
    lastSubmittedDslRef.current = aborted ? '' : finalDsl;
    setSelectedSource(id);
    setDslText(finalDsl);
    if (targetSlot && targetSlot.profile !== id) {
      routing.setSlotProfile(targetSlotIdx, id, false);
    }
    routing.saveCustomProfile(record, needsImmediateRecompute);

    setSaveToast(`Saved "${trimmedName}"`);
    setTimeout(() => setSaveToast(null), 2200);
  };

  const handleDeleteCurrent = () => {
    const saved = routing.customProfiles.find((c) => c.id === selectedSource);
    if (!saved) return;
    routing.deleteCustomProfile(saved.id);
    handleSelectSource(baseTemplate);
  };

  const handleExportBrf = async () => {
    const slug = (profileName || 'custom-profile')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, '-');
    await downloadBrfFile(dslText, `${slug}.brf`);
    routing.setStatus(`Exported ${slug}.brf`);
  };

  const handleImportBrfFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = String(ev.target?.result || '');
      if (!text.trim()) return;
      const prevId = activeProfileIdRef.current;
      const aborted = routing.abortInFlightProfileRoute(prevId);
      const targetSlotIdx = resolveEditedSlotIdx(prevId);
      const stem = file.name.replace(/\.brf$/i, '').replace(/[-_]+/g, ' ');
      const formattedName = stem.charAt(0).toUpperCase() + stem.slice(1);
      const nextSummary = `Imported from ${file.name}`;
      setSelectedSource(baseTemplate);
      setProfileName(formattedName);
      setProfileSummary(nextSummary);
      lastSubmittedDslRef.current = aborted ? '' : text;
      setDslText(text);
      setDslDirty(true);
      setMode('dsl');
      activeProfileIdRef.current = DRAFT_PROFILE_ID;
      syncDraftState({
        id: DRAFT_PROFILE_ID,
        name: formattedName,
        summary: nextSummary,
        mode: 'dsl',
        dsl: text,
      });
      routing.updateCustomProfileDsl(DRAFT_PROFILE_ID, text, false);
      routing.setSlotProfile(targetSlotIdx, DRAFT_PROFILE_ID, !aborted);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const isSavedCustomSelected = routing.customProfiles.some((c) => c.id === selectedSource);

  return (
    <div
      id="profile-editor-panel"
      className="pe-panel"
      onPointerDownCapture={(e) => {
        if ((e.target as HTMLElement)?.classList?.contains('pe-range-input')) {
          setIsDraggingSlider(true);
          routing.abortInFlightProfileRoute(activeProfileIdRef.current);
        }
      }}
    >
      <div className="pe-header">
        <div className="pe-header-top">
          <div className="pe-title-wrap">
            <Icon name="sliders" size={15} />
            <h2>Profile Editor</h2>
          </div>
          <button
            id="btn-close-profile-editor"
            type="button"
            className="collapse-btn pe-close-btn"
            title="Close Profile Editor"
            aria-label="Close Profile Editor"
            onClick={onClose}
          >
            <span className="pe-close-label">Done</span>
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="pe-toolbar-row">
          <div className="pe-source-field">
            <label htmlFor="pe-source-select">Base / Saved</label>
            <select
              id="pe-source-select"
              value={selectedSource}
              onChange={(e) => handleSelectSource(e.target.value)}
            >
              <optgroup label="Starting Templates (Gabi's Profiles)">
                {BASE_TEMPLATE_ORDER.map((id) => (
                  <option key={id} value={id}>
                    Fork: {TEMPLATE_PRESETS[id].name}
                  </option>
                ))}
              </optgroup>
              {routing.customProfiles.length > 0 && (
                <optgroup label="Saved Custom Profiles">
                  {routing.customProfiles.map((cp) => (
                    <option key={cp.id} value={cp.id}>
                      {cp.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          <div className="pe-name-field">
            <label htmlFor="pe-name-input">Profile Name</label>
            <input
              id="pe-name-input"
              type="text"
              value={profileName}
              placeholder="My Custom Profile"
              onChange={(e) => {
                const nextName = e.target.value;
                setProfileName(nextName);
                syncDraftState({ name: nextName });
              }}
            />
          </div>
        </div>

        <div className="pe-mode-bar">
          <div className="pe-mode-tabs" role="tablist" aria-label="Profile editor mode">
            <button
              id="tab-pe-detailed"
              type="button"
              role="tab"
              aria-selected={mode === 'detailed'}
              className={`pe-mode-tab ${mode === 'detailed' ? 'active' : ''}`}
              onClick={() => setMode('detailed')}
            >
              <Icon name="sliders" size={13} />
              <span>Detailed Multi-Axis</span>
            </button>
            <button
              id="tab-pe-dsl"
              type="button"
              role="tab"
              aria-selected={mode === 'dsl'}
              className={`pe-mode-tab ${mode === 'dsl' ? 'active' : ''}`}
              onClick={() => setMode('dsl')}
            >
              <Icon name="code" size={13} />
              <span>Advanced DSL (.brf)</span>
            </button>
          </div>

          <button
            id="btn-pe-reset"
            type="button"
            className="btn-toolbar-mini"
            title="Reset all axes to the base template defaults"
            onClick={handleResetToTemplate}
          >
            <Icon name="refresh" size={12} />
            <span>Reset</span>
          </button>
        </div>
      </div>

      {routing.customProfileError && (
        <div id="pe-error-banner" className="pe-error-banner" role="alert">
          <strong>DSL Parse Error:</strong> {routing.customProfileError}
        </div>
      )}

      {mode === 'detailed' ? (
        <div className="pe-body pe-detailed-body">
          {dslDirty && (
            <div className="pe-dirty-notice">
              <span>Custom DSL edits are active. Moving any slider will regenerate the DSL from sliders.</span>
            </div>
          )}

          <div className="pe-formula-card">
            <div className="pe-formula-header">
              <span className="pe-formula-title">
                How each street is scored
                <InfoButton
                  tooltip="Every street starts at 1.0 (its physical length). All way penalties in Group A start at +0.0 (no penalty) and add together: 1.0 + road_penalty + surface_penalty + cycle_network_penalty + traffic_penalty. BRouter adds penalties instead of multiplying them so overlapping OSM tags (such as highway=track + surface=unpaved) do not compound into extreme 100x detours. Each +1.0 means you would ride 1 extra metre of ideal road per metre of that feature."
                  ariaLabel="How each street is scored"
                />
              </span>
            </div>
            <div className="pe-formula-flow">
              <span className="pe-flow-op">length &times; ( 1.0 +</span>
              <span className="pe-flow-step pe-flow-a">
                <strong>A</strong> Way Penalties (+0.0+)
              </span>
              <span className="pe-flow-op">) +</span>
              <span className="pe-flow-step pe-flow-c">
                <strong>B</strong> Hills &amp; Turns (+m)
              </span>
            </div>
            <div className="pe-formula-example">
              Why additive? Penalties add on top of <strong>1.0</strong> so overlapping OSM tags (e.g. Track + Unpaved) don&apos;t multiply into extreme detours: 100 m &times; (<strong>1.0</strong> + Unclassified <strong>+0.1</strong> + Gravel <strong>+5.0</strong>) = <strong>610 m</strong>.
            </div>
          </div>

          <div className="pe-group-banner pe-group-a">
            <span className="pe-group-pill">A</span>
            <div className="pe-group-text">
              <strong>Additive Way Penalties (+0.0 = no penalty, added to 1.0 base length)</strong>
              <span>Cycle Network + Road/Path + Surface + Traffic add together per metre</span>
            </div>
          </div>

          {/* Section 1: Cycle Networks & Access */}
          <details className="pe-section">
            <summary className="pe-section-summary">
              <span>1. Cycle Networks &amp; Access (route=bicycle)</span>
              <span className="pe-section-badge pe-badge-a">+0–2</span>
            </summary>
            <div className="pe-section-content">
              <ToggleRow
                id="pe-stick-cycleroutes"
                label="Prefer designated cycle routes (lcn / rcn / ncn)"
                checked={axes.stickToCycleRoutes}
                tooltip="OSM route=bicycle relations with network=lcn, rcn, ncn, or icn (e.g. London Cycleways and National Cycle Network). When enabled, ordinary motor roads outside cycle relations or cycle lanes receive the additive penalty below."
                onChange={(v) => handleAxisChange('stickToCycleRoutes', v)}
              />
              <SliderRow
                id="pe-non-cycleroute-penalty"
                label="Non-cycle-route road penalty"
                value={axes.nonCycleRouteRoadPenalty}
                min={0.0}
                max={5.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty (+0.0 = no penalty) added per metre to motor roads that lack route=bicycle relations, cycleway=* lanes/tracks, or bicycle=designated access."
                onChange={(v) => handleAxisChange('nonCycleRouteRoadPenalty', v)}
              />
              <ToggleRow
                id="pe-use-proposed"
                label="Include proposed cycle routes (state=proposed)"
                checked={axes.useProposedCycleRoutes}
                tooltip="OSM cycle route relations tagged state=proposed. Treats planned or newly built cycle routes awaiting sign-off as active cycle networks."
                onChange={(v) => handleAxisChange('useProposedCycleRoutes', v)}
              />
              <ToggleRow
                id="pe-allow-buslanes"
                label="Treat bus lanes as cycleways (busway=*)"
                checked={axes.allowBusLanes}
                tooltip="OSM busway=lane, busway:left=lane, or busway:right=lane. Exempts roads with dedicated bus lanes from the non-cycle-route penalty and caps their traffic penalty."
                onChange={(v) => handleAxisChange('allowBusLanes', v)}
              />
              <ToggleRow
                id="pe-allow-urban-trunks"
                label="Treat urban trunk A-roads as primary (lit & ≤ 30 mph)"
                checked={axes.allowUrbanTrunks}
                tooltip="When enabled (as in Fast Bike), urban highway=trunk roads that are both lit=yes and posted ≤ 30 mph (maxspeed=10|20|30|40|50|urban in BRouter's km/h lookup) use the Primary (highway=primary) penalty instead of the Trunk penalty. When disabled (as in Safe Road), all non-motorroad trunk roads use the Trunk penalty in Section 2."
                onChange={(v) => handleAxisChange('allowUrbanTrunks', v)}
              />
            </div>
          </details>

          {/* Section 2: OSM Way Types (highway=*, aligned with Route Summary Road Type classes) */}
          <details className="pe-section">
            <summary className="pe-section-summary">
              <span>2. Road Type (highway=*)</span>
              <span className="pe-section-badge pe-badge-a">+0–20</span>
            </summary>
            <div className="pe-section-content">
              <div className="pe-subsection-header">
                <span>2a. A-Roads (trunk, primary)</span>
                <span className="pe-section-badge pe-badge-a">+0–20</span>
              </div>
              <SliderRow
                id="pe-trunk-cost"
                label="Trunk (highway=trunk)"
                value={axes.trunkCost}
                min={0.0}
                max={20.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) for OSM highway=trunk and trunk_link: UK Primary Route Network A-roads (green-signed strategic routes and TfL Red Routes). Applies to all non-motorroad trunk roads when the urban trunk toggle in Section 1 is off, or only to non-urban trunks when urban trunks are treated as primary roads. Trunk roads tagged motorroad=yes are always forbidden (10000)."
                onChange={(v) => handleAxisChange('trunkCost', v)}
              />
              <SliderRow
                id="pe-primary-cost"
                label="Primary (highway=primary)"
                value={axes.primaryCost}
                min={0.0}
                max={10.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) for OSM highway=primary and primary_link: non-primary UK A-roads (white-signed A-roads linking towns and urban districts)."
                onChange={(v) => handleAxisChange('primaryCost', v)}
              />

              <div className="pe-subsection-header pe-subsection-divider">
                <span>2b. B-Roads (secondary)</span>
                <span className="pe-section-badge pe-badge-a">+0–10</span>
              </div>
              <SliderRow
                id="pe-secondary-cost"
                label="Secondary (highway=secondary)"
                value={axes.secondaryCost}
                min={0.0}
                max={10.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) for OSM highway=secondary and secondary_link: UK B-roads connecting smaller towns and urban neighbourhoods."
                onChange={(v) => handleAxisChange('secondaryCost', v)}
              />

              <div className="pe-subsection-header pe-subsection-divider">
                <span>2c. Small Roads (tertiary, unclassified, residential, service)</span>
                <span className="pe-section-badge pe-badge-a">+0–10</span>
              </div>
              <SliderRow
                id="pe-tertiary-cost"
                label="Tertiary (highway=tertiary)"
                value={axes.tertiaryCost}
                min={0.0}
                max={10.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) for OSM highway=tertiary and tertiary_link: classified unnumbered UK C-roads and local collector streets linking villages, suburbs, and estates."
                onChange={(v) => handleAxisChange('tertiaryCost', v)}
              />
              <SliderRow
                id="pe-unclassified-cost"
                label="Unclassified (highway=unclassified)"
                value={axes.unclassifiedCost}
                min={0.0}
                max={10.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) for OSM highway=unclassified: minor public through-roads of the lowest motor hierarchy, including rural country lanes and non-residential urban connectors."
                onChange={(v) => handleAxisChange('unclassifiedCost', v)}
              />
              <SliderRow
                id="pe-residential-cost"
                label="Residential (highway=residential|living_street)"
                value={axes.residentialCost}
                min={0.0}
                max={10.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) for OSM highway=residential and highway=living_street: local streets providing direct access to housing without a through-traffic function."
                onChange={(v) => handleAxisChange('residentialCost', v)}
              />
              <SliderRow
                id="pe-service-cost"
                label="Service (highway=service)"
                value={axes.serviceCost}
                min={0.0}
                max={10.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) for OSM highway=service: access roads to estates, parks, industrial sites, parking aisles, or alleys."
                onChange={(v) => handleAxisChange('serviceCost', v)}
              />
              <SliderRow
                id="pe-road-tunnel-cost"
                label="Road Tunnel (tunnel=yes on motor roads)"
                value={axes.roadTunnelPenalty}
                min={0.0}
                max={20.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) for motor roads inside tunnels (tunnel=yes on highway=trunk, primary, secondary, tertiary, unclassified, residential, service)."
                onChange={(v) => handleAxisChange('roadTunnelPenalty', v)}
              />

              <div className="pe-subsection-header pe-subsection-divider">
                <span>2d. Paths (cycleway, path, footway, bridleway, pedestrian)</span>
                <span className="pe-section-badge pe-badge-a">+0–20</span>
              </div>
              <SliderRow
                id="pe-cycleway-cost"
                label="Cycleway, segregated (highway=cycleway)"
                value={axes.cyclewayCost}
                min={0.0}
                max={20.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) for OSM highway=cycleway where cyclists are dedicated or physically separated from pedestrians (segregated=yes or no shared foot=designated)."
                onChange={(v) => handleAxisChange('cyclewayCost', v)}
              />
              <SliderRow
                id="pe-cycleway-shared-cost"
                label="Cycleway, shared foot (segregated=no)"
                value={axes.cyclewaySharedCost}
                min={0.0}
                max={20.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) for OSM highway=cycleway with segregated=no, or foot=designated without segregated=yes. Common on shared park paths (e.g. Tooting Common) and canal towpaths where cyclists share space with pedestrians."
                onChange={(v) => handleAxisChange('cyclewaySharedCost', v)}
              />
              <SliderRow
                id="pe-path-cost"
                label="Path (highway=path)"
                value={axes.pathCost}
                min={0.0}
                max={20.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) for OSM highway=path: generic multi-use or non-specific off-road paths not tagged as highway=cycleway or highway=footway (often narrow park trails, desire lines, or woodland paths)."
                onChange={(v) => handleAxisChange('pathCost', v)}
              />
              <SliderRow
                id="pe-footway-cost"
                label="Footway (highway=footway)"
                value={axes.footwayCost}
                min={0.0}
                max={20.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) for OSM highway=footway: ways designated mainly or exclusively for pedestrians (pavements, park walks, footpaths). An extra +5 access penalty is added when bicycle=yes/designated/permissive is absent."
                onChange={(v) => handleAxisChange('footwayCost', v)}
              />
              <SliderRow
                id="pe-bridleway-cost"
                label="Bridleway (highway=bridleway)"
                value={axes.bridlewayCost}
                min={0.0}
                max={20.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) for OSM highway=bridleway: trails designated for equestrians where cyclists have legal right of way in England and Wales (Countryside Act 1968), often unpaved."
                onChange={(v) => handleAxisChange('bridlewayCost', v)}
              />
              <SliderRow
                id="pe-pedestrian-cost"
                label="Pedestrian (highway=pedestrian)"
                value={axes.pedestrianCost}
                min={0.0}
                max={20.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) for OSM highway=pedestrian: pedestrianized shopping streets, civic squares, and plazas reserved primarily for foot traffic."
                onChange={(v) => handleAxisChange('pedestrianCost', v)}
              />

              <div className="pe-subsection-header pe-subsection-divider">
                <span>2e. Tracks (highway=track, tracktype=grade1–5)</span>
                <span className="pe-section-badge pe-badge-a">+0–20</span>
              </div>
              <SliderRow
                id="pe-track-g1"
                label="Track Grade 1 (tracktype=grade1)"
                value={axes.trackGrade1Cost}
                min={0.0}
                max={20.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) for OSM highway=track with tracktype=grade1: agricultural or forestry track with a solid paved, sealed, or heavily compacted hard surface."
                onChange={(v) => handleAxisChange('trackGrade1Cost', v)}
              />
              <SliderRow
                id="pe-track-g2"
                label="Track Grade 2 (tracktype=grade2)"
                value={axes.trackGrade2Cost}
                min={0.0}
                max={20.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) for OSM highway=track with tracktype=grade2 (or untagged paved track): mostly solid unpaved gravel or crushed-stone farm/forest road."
                onChange={(v) => handleAxisChange('trackGrade2Cost', v)}
              />
              <SliderRow
                id="pe-track-g3"
                label="Track Grade 3 (tracktype=grade3)"
                value={axes.trackGrade3Cost}
                min={0.0}
                max={20.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) for OSM highway=track with tracktype=grade3 (or untagged unpaved track): even mixture of hard and soft materials, often two gravel wheel ruts with grass or soil in the centre."
                onChange={(v) => handleAxisChange('trackGrade3Cost', v)}
              />
              <SliderRow
                id="pe-track-g4"
                label="Track Grade 4–5 (tracktype=grade4|5)"
                value={axes.trackGrade4Cost}
                min={0.0}
                max={20.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) for OSM highway=track with tracktype=grade4 (mostly soft soil/sand/grass with some hard material) or tracktype=grade5 (unlaminated soft earth, mud, or grass field track)."
                onChange={(v) => handleAxisChange('trackGrade4Cost', v)}
              />
              <SliderRow
                id="pe-track-untagged"
                label="Track, untagged grade (tracktype= missing)"
                value={axes.trackUntaggedCost}
                min={0.0}
                max={20.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) when an OSM highway=track or highway=road has no tracktype=* grade tag in OpenStreetMap (uncertain track quality)."
                onChange={(v) => handleAxisChange('trackUntaggedCost', v)}
              />
            </div>
          </details>

          {/* Section 3: OSM Surface Penalties (surface=*, aligned with Route Summary Surface classes & subclasses) */}
          <details className={`pe-section ${!axes.enableSurfacePenalties ? 'pe-section-disabled' : ''}`}>
            <summary className="pe-section-summary">
              <span>3. Surface Penalties (surface=*)</span>
              <div className="pe-section-summary-right">
                <span className={`pe-section-badge ${axes.enableSurfacePenalties ? 'pe-badge-a' : 'pe-badge-off'}`}>
                  {axes.enableSurfacePenalties ? '+0–15' : 'Off'}
                </span>
                <SectionSummarySwitch
                  id="pe-enable-surface"
                  checked={axes.enableSurfacePenalties}
                  label="Surface Penalties"
                  onChange={(v) => handleAxisChange('enableSurfacePenalties', v)}
                />
              </div>
            </summary>
            <div className={`pe-section-content ${!axes.enableSurfacePenalties ? 'pe-content-disabled' : ''}`}>
              <div className="pe-subsection-note">
                Organized into the same 4 Surface classes (<code>Paved</code>, <code>Cobbles</code>, <code>Unpaved</code>, <code>Untagged</code>) and 16 subclasses shown in the Route Summary. Click any Surface chip in the Route Summary to inspect its subclasses along the route.
              </div>

              <div className="pe-subsection-header">
                <span>3a. Paved (asphalt, paved, concrete)</span>
                <span className="pe-section-badge pe-badge-a">+0–15</span>
              </div>
              <SliderRow
                id="pe-surf-asphalt"
                label="Asphalt (surface=asphalt)"
                value={axes.asphaltPenalty}
                min={0.0}
                max={15.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) when OSM surface=asphalt (tarmac/bitumen macadam) or smoothness=excellent|good."
                onChange={(v) => handleAxisChange('asphaltPenalty', v)}
              />
              <SliderRow
                id="pe-surf-paved"
                label="Paved / Sealed (surface=paved)"
                value={axes.pavedPenalty}
                min={0.0}
                max={15.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) when OSM surface=paved (generic sealed pavement, chipseal, or brick in BRouter's lookup)."
                onChange={(v) => handleAxisChange('pavedPenalty', v)}
              />
              <SliderRow
                id="pe-surf-concrete"
                label="Concrete (surface=concrete)"
                value={axes.concretePenalty}
                min={0.0}
                max={15.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) when OSM surface=concrete (includes concrete slabs, concrete:plates, concrete:lanes, and cement)."
                onChange={(v) => handleAxisChange('concretePenalty', v)}
              />

              <div className="pe-subsection-header pe-subsection-divider">
                <span>3b. Cobbles (paving_stones, sett, cobblestone)</span>
                <span className="pe-section-badge pe-badge-a">+0–15</span>
              </div>
              <SliderRow
                id="pe-surf-paving-stones"
                label="Paving Stones (surface=paving_stones)"
                value={axes.pavingStonesPenalty}
                min={0.0}
                max={15.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) when OSM surface=paving_stones: flat, closely fitted concrete or stone block pavers/flagstones."
                onChange={(v) => handleAxisChange('pavingStonesPenalty', v)}
              />
              <SliderRow
                id="pe-surf-sett"
                label="Sett (surface=sett)"
                value={axes.settPenalty}
                min={0.0}
                max={15.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) when OSM surface=sett: dressed rectangular granite or stone blocks with mortar joints."
                onChange={(v) => handleAxisChange('settPenalty', v)}
              />
              <SliderRow
                id="pe-surf-cobble"
                label="Cobblestone (surface=cobblestone)"
                value={axes.cobblestonePenalty}
                min={0.0}
                max={15.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) when OSM surface=cobblestone: traditional uncut, rounded or irregular cobbles."
                onChange={(v) => handleAxisChange('cobblestonePenalty', v)}
              />

              <div className="pe-subsection-header pe-subsection-divider">
                <span>3c. Unpaved (compacted, gravel, dirt, grass, mud, wood)</span>
                <span className="pe-section-badge pe-badge-a">+0–15</span>
              </div>
              <SliderRow
                id="pe-surf-compacted"
                label="Compacted (surface=compacted)"
                value={axes.compactedPenalty}
                min={0.0}
                max={15.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) when OSM surface=compacted (hard-packed rolled mineral aggregate bound with fines, common on UK canal towpaths and park trails) or smoothness=intermediate."
                onChange={(v) => handleAxisChange('compactedPenalty', v)}
              />
              <SliderRow
                id="pe-surf-fine-gravel"
                label="Fine Gravel (surface=fine_gravel)"
                value={axes.fineGravelPenalty}
                min={0.0}
                max={15.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) when OSM surface=fine_gravel: small crushed stone grit or fine aggregate."
                onChange={(v) => handleAxisChange('fineGravelPenalty', v)}
              />
              <SliderRow
                id="pe-surf-gravel"
                label="Gravel (surface=gravel)"
                value={axes.gravelPenalty}
                min={0.0}
                max={15.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) when OSM surface=gravel: loose crushed rock or coarse gravel stones."
                onChange={(v) => handleAxisChange('gravelPenalty', v)}
              />
              <SliderRow
                id="pe-surf-pebblestone"
                label="Pebblestone (surface=pebblestone)"
                value={axes.pebblestonePenalty}
                min={0.0}
                max={15.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) when OSM surface=pebblestone: loose rounded pebbles or shingle."
                onChange={(v) => handleAxisChange('pebblestonePenalty', v)}
              />
              <SliderRow
                id="pe-surf-unpaved"
                label="Dirt / Earth (surface=unpaved|ground|dirt|earth)"
                value={axes.unpavedPenalty}
                min={0.0}
                max={15.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) when OSM surface=unpaved, ground, dirt, earth, rock, stone, or smoothness=bad|very_bad|horrible."
                onChange={(v) => handleAxisChange('unpavedPenalty', v)}
              />
              <SliderRow
                id="pe-surf-grass"
                label="Grass & Turf (surface=grass|grass_paver)"
                value={axes.grassPenalty}
                min={0.0}
                max={15.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) when OSM surface=grass, grass_paver, or artificial_turf."
                onChange={(v) => handleAxisChange('grassPenalty', v)}
              />
              <SliderRow
                id="pe-surf-mud"
                label="Mud / Sand / Clay (surface=mud|sand|clay)"
                value={axes.mudSandPenalty}
                min={0.0}
                max={15.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) when OSM surface=mud, sand, or clay (soft, boggy, or loose ground)."
                onChange={(v) => handleAxisChange('mudSandPenalty', v)}
              />
              <SliderRow
                id="pe-surf-wood"
                label="Wood & Metal Decks (surface=wood|metal)"
                value={axes.woodMetalPenalty}
                min={0.0}
                max={15.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty (+0.0 = no penalty) when OSM surface=wood (timber boardwalks/bridges) or surface=metal (metal bridge decking/gratings)."
                onChange={(v) => handleAxisChange('woodMetalPenalty', v)}
              />

              <div className="pe-subsection-header pe-subsection-divider">
                <span>3d. Untagged (surface= missing)</span>
                <span className="pe-section-badge pe-badge-a">+0–15</span>
              </div>
              <SliderRow
                id="pe-surf-untagged-road"
                label="Untagged Road (surface= missing on motor roads)"
                value={axes.untaggedRoadSurfacePenalty}
                min={0.0}
                max={15.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty when a motor road (primary, secondary, tertiary, unclassified, residential, service) has no surface=* or smoothness=* tag in OSM. In the UK, untagged motor roads are almost always tarmac (+0.0)."
                onChange={(v) => handleAxisChange('untaggedRoadSurfacePenalty', v)}
              />
              <SliderRow
                id="pe-surf-untagged-path"
                label="Untagged Path / Track (surface= missing on paths & tracks)"
                value={axes.untaggedPathSurfacePenalty}
                min={0.0}
                max={15.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty when a non-motor way (cycleway, path, footway, bridleway, track) has no surface=* or smoothness=* tag in OSM (uncertain off-road surface)."
                onChange={(v) => handleAxisChange('untaggedPathSurfacePenalty', v)}
              />
            </div>
          </details>

          {/* Section 4: Estimated Traffic (estimated_traffic_class) */}
          <details className={`pe-section ${!axes.enableTrafficPenalties ? 'pe-section-disabled' : ''}`}>
            <summary className="pe-section-summary">
              <span>4. Estimated Traffic (estimated_traffic_class)</span>
              <div className="pe-section-summary-right">
                <span className={`pe-section-badge ${axes.enableTrafficPenalties ? 'pe-badge-a' : 'pe-badge-off'}`}>
                  {axes.enableTrafficPenalties ? '+0–10' : 'Off'}
                </span>
                <SectionSummarySwitch
                  id="pe-enable-traffic"
                  checked={axes.enableTrafficPenalties}
                  label="Estimated Traffic Penalties"
                  onChange={(v) => handleAxisChange('enableTrafficPenalties', v)}
                />
              </div>
            </summary>
            <div className={`pe-section-content ${!axes.enableTrafficPenalties ? 'pe-content-disabled' : ''}`}>
              <div className="pe-subsection-note">
                Heuristic estimate computed by BRouter on <code>primary</code>, <code>secondary</code>, and <code>tertiary</code> roads (<code>1–6</code>), plus <code>7</code> on untagged <code>trunk</code>/<code>motorway</code> roads. Subclasses align with the Route Summary Traffic bar: Quiet (<code>0–3</code>, including Class 0 unmodelled minor roads), Busy (<code>4–5</code>), and Heavy (<code>6–7</code>).
              </div>
              <SliderRow
                id="pe-traffic-untagged"
                label="Class 0: Unmodelled (Quiet, minor roads without traffic tag)"
                value={axes.trafficUntaggedRoadPenalty}
                min={0.0}
                max={10.0}
                step={0.1}
                disallowable
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre when a motor road (is_road, typically residential, unclassified, or service) has no estimated_traffic_class tag in the RD5 tile."
                onChange={(v) => handleAxisChange('trafficUntaggedRoadPenalty', v)}
              />
              <SliderRow
                id="pe-traffic-c1"
                label="Class 1: Very quiet (Quiet, estimated_traffic_class=1)"
                value={axes.trafficClass1Penalty}
                min={0.0}
                max={10.0}
                step={0.1}
                disallowable
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre on roads with BRouter estimated_traffic_class=1 (lowest modelled traffic)."
                onChange={(v) => handleAxisChange('trafficClass1Penalty', v)}
              />
              <SliderRow
                id="pe-traffic-c2"
                label="Class 2: Quiet (Quiet, estimated_traffic_class=2)"
                value={axes.trafficClass2Penalty}
                min={0.0}
                max={10.0}
                step={0.1}
                disallowable
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre on roads with BRouter estimated_traffic_class=2 (light local traffic)."
                onChange={(v) => handleAxisChange('trafficClass2Penalty', v)}
              />
              <SliderRow
                id="pe-traffic-c3"
                label="Class 3: Fair (Quiet, estimated_traffic_class=3)"
                value={axes.trafficClass3Penalty}
                min={0.0}
                max={10.0}
                step={0.1}
                disallowable
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre on roads with BRouter estimated_traffic_class=3 (fair traffic flow)."
                onChange={(v) => handleAxisChange('trafficClass3Penalty', v)}
              />
              <SliderRow
                id="pe-traffic-c4"
                label="Class 4: Moderate (Busy, estimated_traffic_class=4)"
                value={axes.trafficClass4Penalty}
                min={0.0}
                max={10.0}
                step={0.1}
                disallowable
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre on roads with BRouter estimated_traffic_class=4 (moderate distributor or arterial traffic)."
                onChange={(v) => handleAxisChange('trafficClass4Penalty', v)}
              />
              <SliderRow
                id="pe-traffic-c5"
                label="Class 5: Busy (Busy, estimated_traffic_class=5)"
                value={axes.trafficClass5Penalty}
                min={0.0}
                max={10.0}
                step={0.1}
                disallowable
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre on roads with BRouter estimated_traffic_class=5 (busy traffic)."
                onChange={(v) => handleAxisChange('trafficClass5Penalty', v)}
              />
              <SliderRow
                id="pe-traffic-c6"
                label="Class 6: Heavy (Heavy, estimated_traffic_class=6 — busiest A/B roads)"
                value={axes.trafficClass6Penalty}
                min={0.0}
                max={10.0}
                step={0.1}
                disallowable
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre on roads with BRouter estimated_traffic_class=6 (the highest class BRouter emits on primary, secondary, and tertiary roads)."
                onChange={(v) => handleAxisChange('trafficClass6Penalty', v)}
              />
              <SliderRow
                id="pe-traffic-c7"
                label="Class 7: Extreme (Heavy, estimated_traffic_class=7 / untagged trunk)"
                value={axes.trafficClass7Penalty}
                min={0.0}
                max={10.0}
                step={0.1}
                disallowable
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre on roads with BRouter estimated_traffic_class=7 or untagged highway=trunk / motorway roads."
                onChange={(v) => handleAxisChange('trafficClass7Penalty', v)}
              />
            </div>
          </details>

          {/* Section 5: Estimated Noise (estimated_noise_class) */}
          <details className={`pe-section ${!axes.enableNoisePenalties ? 'pe-section-disabled' : ''}`}>
            <summary className="pe-section-summary">
              <span>5. Estimated Noise (estimated_noise_class)</span>
              <div className="pe-section-summary-right">
                <span className={`pe-section-badge ${axes.enableNoisePenalties ? 'pe-badge-a' : 'pe-badge-off'}`}>
                  {axes.enableNoisePenalties ? '+0–3' : 'Off'}
                </span>
                <SectionSummarySwitch
                  id="pe-enable-noise"
                  checked={axes.enableNoisePenalties}
                  label="Estimated Noise Penalties"
                  onChange={(v) => handleAxisChange('enableNoisePenalties', v)}
                />
              </div>
            </summary>
            <div className={`pe-section-content ${!axes.enableNoisePenalties ? 'pe-content-disabled' : ''}`}>
              <div className="pe-subsection-note">
                Heuristic road-noise exposure class (<code>0–6</code>) precomputed by BRouter from 64 m buffers around motorways, trunk, primary, and secondary roads. Subclasses align with the Route Summary Noise bar: Quiet (<code>0–2</code>), Moderate (<code>3–4</code>), and Loud (<code>5–6</code>).
              </div>
              <SliderRow
                id="pe-noise-untagged"
                label="Class 0: Unmodelled (Quiet, estimated_noise_class=)"
                value={axes.noiseUntaggedPenalty}
                min={0.0}
                max={3.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre when a way is outside the 64 m noise buffer of any major road (estimated_noise_class= is empty, i.e. zero modelled road noise)."
                onChange={(v) => handleAxisChange('noiseUntaggedPenalty', v)}
              />
              <SliderRow
                id="pe-noise-c1"
                label="Class 1: Very quiet (Quiet, estimated_noise_class=1)"
                value={axes.noiseClass1Penalty}
                min={0.0}
                max={3.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre on ways with BRouter estimated_noise_class=1 (< 10% noise buffer overlap)."
                onChange={(v) => handleAxisChange('noiseClass1Penalty', v)}
              />
              <SliderRow
                id="pe-noise-c2"
                label="Class 2: Quiet (Quiet, estimated_noise_class=2)"
                value={axes.noiseClass2Penalty}
                min={0.0}
                max={3.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre on ways with BRouter estimated_noise_class=2 (10–25% noise buffer overlap)."
                onChange={(v) => handleAxisChange('noiseClass2Penalty', v)}
              />
              <SliderRow
                id="pe-noise-c3"
                label="Class 3: Moderate (Moderate, estimated_noise_class=3)"
                value={axes.noiseClass3Penalty}
                min={0.0}
                max={3.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre on ways with BRouter estimated_noise_class=3 (25–40% noise buffer overlap)."
                onChange={(v) => handleAxisChange('noiseClass3Penalty', v)}
              />
              <SliderRow
                id="pe-noise-c4"
                label="Class 4: Noticeable (Moderate, estimated_noise_class=4)"
                value={axes.noiseClass4Penalty}
                min={0.0}
                max={3.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre on ways with BRouter estimated_noise_class=4 (40–55% noise buffer overlap)."
                onChange={(v) => handleAxisChange('noiseClass4Penalty', v)}
              />
              <SliderRow
                id="pe-noise-c5"
                label="Class 5: Loud (Loud, estimated_noise_class=5)"
                value={axes.noiseClass5Penalty}
                min={0.0}
                max={3.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre on ways with BRouter estimated_noise_class=5 (55–80% noise buffer overlap)."
                onChange={(v) => handleAxisChange('noiseClass5Penalty', v)}
              />
              <SliderRow
                id="pe-noise-c6"
                label="Class 6: Very loud (Loud, estimated_noise_class=6)"
                value={axes.noiseClass6Penalty}
                min={0.0}
                max={3.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre on ways with BRouter estimated_noise_class=6 (≥ 80% noise buffer overlap)."
                onChange={(v) => handleAxisChange('noiseClass6Penalty', v)}
              />
            </div>
          </details>

          {/* Section 6: Forests & Parks */}
          <details className={`pe-section ${!axes.enableForestPenalties ? 'pe-section-disabled' : ''}`}>
            <summary className="pe-section-summary">
              <span>6. Forests &amp; Parks (estimated_forest_class)</span>
              <div className="pe-section-summary-right">
                <span className={`pe-section-badge ${axes.enableForestPenalties ? 'pe-badge-a' : 'pe-badge-off'}`}>
                  {axes.enableForestPenalties ? '+0–10' : 'Off'}
                </span>
                <SectionSummarySwitch
                  id="pe-enable-forest"
                  checked={axes.enableForestPenalties}
                  label="Forests & Parks Penalties"
                  onChange={(v) => handleAxisChange('enableForestPenalties', v)}
                />
              </div>
            </summary>
            <div className={`pe-section-content ${!axes.enableForestPenalties ? 'pe-content-disabled' : ''}`}>
              <div className="pe-subsection-note">
                Green-corridor overlap (<code>0–6</code>) precomputed by BRouter across a 62 m buffer around each way (<code>natural=wood</code>, <code>landuse=forest|recreation_ground|village_green|allotments|orchard|vineyard</code>, <code>leisure=park|nature_reserve|garden</code>). Penalize Classes <code>0–3</code> to pull routes inside parks and woods, or penalize Classes <code>5–6</code> to avoid unlit woodland.
              </div>
              <SliderRow
                id="pe-forest-untagged"
                label="Class 0: Outside woods & parks (< 10%, estimated_forest_class=)"
                value={axes.forestUntaggedPenalty}
                min={0.0}
                max={10.0}
                step={0.1}
                disallowable
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre when < 10% of the way's 62 m buffer overlaps woodland or parks (built-up streets or open farmland)."
                onChange={(v) => handleAxisChange('forestUntaggedPenalty', v)}
              />
              <SliderRow
                id="pe-forest-c1"
                label="Class 1: Touching edge (10–20%, estimated_forest_class=1)"
                value={axes.forestClass1Penalty}
                min={0.0}
                max={10.0}
                step={0.1}
                disallowable
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre on ways with estimated_forest_class=1 (10–20% green buffer overlap, e.g. brushing past a small garden or wood corner)."
                onChange={(v) => handleAxisChange('forestClass1Penalty', v)}
              />
              <SliderRow
                id="pe-forest-c2"
                label="Class 2: Scattered greenery (20–40%, estimated_forest_class=2)"
                value={axes.forestClass2Penalty}
                min={0.0}
                max={10.0}
                step={0.1}
                disallowable
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre on ways with estimated_forest_class=2 (20–40% green buffer overlap, e.g. passing small green patches or allotments)."
                onChange={(v) => handleAxisChange('forestClass2Penalty', v)}
              />
              <SliderRow
                id="pe-forest-c3"
                label="Class 3: Park or wood boundary (40–60%, estimated_forest_class=3)"
                value={axes.forestClass3Penalty}
                min={0.0}
                max={10.0}
                step={0.1}
                disallowable
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre on ways with estimated_forest_class=3 (40–60% green buffer overlap, typically a road running along the outer boundary of a park)."
                onChange={(v) => handleAxisChange('forestClass3Penalty', v)}
              />
              <SliderRow
                id="pe-forest-c4"
                label="Class 4: Mostly wooded / park (60–80%, estimated_forest_class=4)"
                value={axes.forestClass4Penalty}
                min={0.0}
                max={10.0}
                step={0.1}
                disallowable
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre on ways with estimated_forest_class=4 (60–80% green buffer overlap, mostly inside a park or wooded corridor)."
                onChange={(v) => handleAxisChange('forestClass4Penalty', v)}
              />
              <SliderRow
                id="pe-forest-c5"
                label="Class 5: Inside park or wood (80–98%, estimated_forest_class=5)"
                value={axes.forestClass5Penalty}
                min={0.0}
                max={10.0}
                step={0.1}
                disallowable
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre on ways with estimated_forest_class=5 (80–98% green buffer overlap, inside a park or wood near an edge or clearing)."
                onChange={(v) => handleAxisChange('forestClass5Penalty', v)}
              />
              <SliderRow
                id="pe-forest-c6"
                label="Class 6: Deep inside park or forest (≥ 98%, estimated_forest_class=6)"
                value={axes.forestClass6Penalty}
                min={0.0}
                max={10.0}
                step={0.1}
                disallowable
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty per metre on ways with estimated_forest_class=6 (≥ 98% green buffer overlap, fully enclosed inside a park, common, or forest)."
                onChange={(v) => handleAxisChange('forestClass6Penalty', v)}
              />
            </div>
          </details>

          {/* Section 7: Lanes & Lighting */}
          <details className={`pe-section ${!axes.enableEnvironmentPenalties ? 'pe-section-disabled' : ''}`}>
            <summary className="pe-section-summary">
              <span>7. Lanes &amp; Lighting (lanes, lit)</span>
              <div className="pe-section-summary-right">
                <span className={`pe-section-badge ${axes.enableEnvironmentPenalties ? 'pe-badge-a' : 'pe-badge-off'}`}>
                  {axes.enableEnvironmentPenalties ? '+0–5' : 'Off'}
                </span>
                <SectionSummarySwitch
                  id="pe-enable-environment"
                  checked={axes.enableEnvironmentPenalties}
                  label="Lanes & Lighting Penalties"
                  onChange={(v) => handleAxisChange('enableEnvironmentPenalties', v)}
                />
              </div>
            </summary>
            <div className={`pe-section-content ${!axes.enableEnvironmentPenalties ? 'pe-content-disabled' : ''}`}>
              <div className="pe-subsection-note">
                Applies to OSM <code>lanes=*</code> and <code>lit=*</code> tags. Use the untagged lighting slider below to decide whether ways without a <code>lit=*</code> tag are penalized.
              </div>
              <SliderRow
                id="pe-lanes-multi"
                label="Multi-lane road (lanes=3 or more)"
                value={axes.multiLanePenalty}
                min={0.0}
                max={5.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty when a road is tagged lanes=3, 4, 5, 6, 7, or 8+ in OSM. Ways with lanes=1|2 or untagged lanes= receive +0.0."
                onChange={(v) => handleAxisChange('multiLanePenalty', v)}
              />
              <SliderRow
                id="pe-lit-no"
                label="Explicitly unlit way (lit=no)"
                value={axes.unlitPenalty}
                min={0.0}
                max={5.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                disallowable
                tooltip="Additive penalty when a way is explicitly tagged lit=no in OSM (no street lighting). Useful for night riding."
                onChange={(v) => handleAxisChange('unlitPenalty', v)}
              />
              <SliderRow
                id="pe-lit-untagged"
                label="Untagged lighting (lit= missing)"
                value={axes.untaggedLitPenalty}
                min={0.0}
                max={5.0}
                step={0.1}
                formatValue={(v) => `+${Number(v.toFixed(1))}`}
                tooltip="Additive penalty when a way has no lit=* tag in OSM (lighting unknown). Keep at +0.0 unless you want to strictly require lit=yes ways."
                onChange={(v) => handleAxisChange('untaggedLitPenalty', v)}
              />
            </div>
          </details>

          <div className="pe-group-banner pe-group-c">
            <span className="pe-group-pill">B</span>
            <div className="pe-group-text">
              <strong>Hill &amp; Junction Penalties (+m virtual distance)</strong>
              <span>Extra virtual metres added when climbing hills or crossing junctions</span>
            </div>
          </div>

          {/* Section 8: Climbing & Hills */}
          <details className={`pe-section ${!axes.considerElevation ? 'pe-section-disabled' : ''}`}>
            <summary className="pe-section-summary">
              <span>8. Climbing &amp; Descents</span>
              <div className="pe-section-summary-right">
                <span className={`pe-section-badge ${axes.considerElevation ? 'pe-badge-c' : 'pe-badge-off'}`}>
                  {axes.considerElevation ? '+0–200 m/m' : 'Off'}
                </span>
                <SectionSummarySwitch
                  id="pe-consider-elevation"
                  checked={axes.considerElevation}
                  label="Climbing & Descents Penalties"
                  onChange={(v) => handleAxisChange('considerElevation', v)}
                />
              </div>
            </summary>
            <div className={`pe-section-content ${!axes.considerElevation ? 'pe-content-disabled' : ''}`}>
              <SliderRow
                id="pe-uphill-cost"
                label="Uphill climb penalty"
                value={axes.uphillCost}
                min={0}
                max={200}
                step={5}
                formatValue={(v) => `+${v} m/m`}
                tooltip="BRouter uphillcost: extra virtual horizontal metres added per 1 m of vertical climb above the uphill cutoff gradient."
                onChange={(v) => handleAxisChange('uphillCost', v)}
              />
              <SliderRow
                id="pe-uphill-cutoff"
                label="Uphill gradient cutoff"
                value={axes.uphillCutoff}
                min={0.0}
                max={8.0}
                step={0.5}
                unit="%"
                tooltip="BRouter uphillcutoff: gradients gentler than this slope percentage incur no uphill climbing penalty."
                onChange={(v) => handleAxisChange('uphillCutoff', v)}
              />
              <SliderRow
                id="pe-downhill-cost"
                label="Downhill braking penalty"
                value={axes.downhillCost}
                min={0}
                max={200}
                step={5}
                formatValue={(v) => `+${v} m/m`}
                tooltip="BRouter downhillcost: extra virtual horizontal metres per 1 m of vertical descent steeper than the downhill cutoff, penalizing rolling hills and steep braking descents."
                onChange={(v) => handleAxisChange('downhillCost', v)}
              />
              <SliderRow
                id="pe-downhill-cutoff"
                label="Downhill gradient cutoff"
                value={axes.downhillCutoff}
                min={0.0}
                max={8.0}
                step={0.5}
                unit="%"
                tooltip="BRouter downhillcutoff: descents gentler than this slope percentage incur no downhill penalty."
                onChange={(v) => handleAxisChange('downhillCutoff', v)}
              />
            </div>
          </details>

          {/* Section 9: Turns, Junctions & Barriers (all 0 to 300 m) */}
          <details className={`pe-section ${!axes.enableTurnPenalties ? 'pe-section-disabled' : ''}`}>
            <summary className="pe-section-summary">
              <span>9. Turns, Junctions &amp; Barriers</span>
              <div className="pe-section-summary-right">
                <span className={`pe-section-badge ${axes.enableTurnPenalties ? 'pe-badge-c' : 'pe-badge-off'}`}>
                  {axes.enableTurnPenalties ? '+0–300 m' : 'Off'}
                </span>
                <SectionSummarySwitch
                  id="pe-enable-turns"
                  checked={axes.enableTurnPenalties}
                  label="Turn, Junction & Barrier Penalties"
                  onChange={(v) => handleAxisChange('enableTurnPenalties', v)}
                />
              </div>
            </summary>
            <div className="pe-section-content">
              <div className={`pe-section-subcontrols ${!axes.enableTurnPenalties ? 'pe-content-disabled' : ''}`}>
                <div className="pe-subsection-header">
                  <span>9a. Turn Geometry (turncost)</span>
                  <span className="pe-section-badge pe-badge-c">+0–300 m</span>
                </div>
                <SliderRow
                  id="pe-turn-generic"
                  label="Generic 90° turn cost"
                  value={axes.turnCostGeneric}
                  min={0}
                  max={300}
                  step={10}
                  formatValue={(v) => `+${v} m`}
                  tooltip="BRouter turncost (scaled by 1 - cos(angle)): virtual metres added for a 90-degree bend on ordinary roads. Because turncost applies to every geometry vertex, keep this moderate (90–150 m) and use the junction node sliders below to penalize intersections."
                  onChange={(v) => handleAxisChange('turnCostGeneric', v)}
                />
                <SliderRow
                  id="pe-turn-cycleroute"
                  label="Cycle route 90° turn cost"
                  value={axes.turnCostCycleRoute}
                  min={0}
                  max={300}
                  step={10}
                  formatValue={(v) => `+${v} m`}
                  tooltip="BRouter turncost on designated cycle routes (route=bicycle) and safe cycle-lane roads, which often curve around modal filters."
                  onChange={(v) => handleAxisChange('turnCostCycleRoute', v)}
                />
                <SliderRow
                  id="pe-turn-roundabout"
                  label="Roundabout turn cost"
                  value={axes.turnCostRoundabout}
                  min={0}
                  max={300}
                  step={10}
                  formatValue={(v) => `+${v} m`}
                  tooltip="BRouter turncost applied on ways tagged junction=roundabout."
                  onChange={(v) => handleAxisChange('turnCostRoundabout', v)}
                />

                <div className="pe-subsection-header pe-subsection-divider">
                  <span>9b. Junction Nodes &amp; Road Transitions</span>
                  <span className="pe-section-badge pe-badge-c">+0–300 m</span>
                </div>
                <SliderRow
                  id="pe-signal-cost"
                  label="Traffic signal wait cost (highway=traffic_signals)"
                  value={axes.trafficSignalCost}
                  min={0}
                  max={300}
                  step={5}
                  formatValue={(v) => `+${v} m`}
                  tooltip="Node initialcost in virtual metres for passing an OSM highway=traffic_signals or crossing=traffic_signals node, even when going straight."
                  onChange={(v) => handleAxisChange('trafficSignalCost', v)}
                />
                <SliderRow
                  id="pe-stop-giveway-cost"
                  label="Stop & give-way junction cost (highway=stop|give_way)"
                  value={axes.stopGiveWayCost}
                  min={0}
                  max={300}
                  step={5}
                  formatValue={(v) => `+${v} m`}
                  tooltip="Node initialcost in virtual metres for passing an OSM highway=stop, highway=give_way, or highway=mini_roundabout intersection node."
                  onChange={(v) => handleAxisChange('stopGiveWayCost', v)}
                />
                <SliderRow
                  id="pe-road-transition-cost"
                  label="Road category switch cost (initialclassifier)"
                  value={axes.roadTransitionCost}
                  min={0}
                  max={300}
                  step={5}
                  formatValue={(v) => `+${v} m`}
                  tooltip="Way initialcost added once whenever the route switches road categories between A-roads (trunk/primary), B-roads (secondary), C-roads (tertiary), Local Streets (unclassified/residential/service), and Cycleways/Paths. Penalizes both minor-to-major and major-to-major road switches without any turn angle penalty."
                  onChange={(v) => handleAxisChange('roadTransitionCost', v)}
                />

                <div className="pe-subsection-header pe-subsection-divider">
                  <span>9c. Uncontrolled Road Crossings (estimated_crossing_class=1..6)</span>
                  <span className="pe-section-badge pe-badge-c">+0–1000 m</span>
                </div>
                <SliderRow
                  id="pe-crossing-1"
                  label="Class 1: Very low risk (traffic class 1-2 or refuge island)"
                  value={axes.crossingClass1Cost}
                  min={0}
                  max={1000}
                  step={10}
                  disallowable
                  formatValue={(v) => `+${v} m`}
                  tooltip="Node initialcost when entering or crossing a Class 1 junction from a minor road or cycleway/path (way:coming_from_lowprio). Applies regardless of turn angle."
                  onChange={(v) => handleAxisChange('crossingClass1Cost', v)}
                />
                <SliderRow
                  id="pe-crossing-2"
                  label="Class 2: Low risk (traffic class 2-3)"
                  value={axes.crossingClass2Cost}
                  min={0}
                  max={1000}
                  step={10}
                  disallowable
                  formatValue={(v) => `+${v} m`}
                  tooltip="Node initialcost when entering or crossing a Class 2 junction from a minor road or cycleway/path (way:coming_from_lowprio)."
                  onChange={(v) => handleAxisChange('crossingClass2Cost', v)}
                />
                <SliderRow
                  id="pe-crossing-3"
                  label="Class 3: Moderate risk (traffic class 3-4)"
                  value={axes.crossingClass3Cost}
                  min={0}
                  max={1000}
                  step={10}
                  disallowable
                  formatValue={(v) => `+${v} m`}
                  tooltip="Node initialcost when entering or crossing a Class 3 junction from a minor road or cycleway/path (way:coming_from_lowprio)."
                  onChange={(v) => handleAxisChange('crossingClass3Cost', v)}
                />
                <SliderRow
                  id="pe-crossing-4"
                  label="Class 4: High risk (traffic class 4-5)"
                  value={axes.crossingClass4Cost}
                  min={0}
                  max={1000}
                  step={10}
                  disallowable
                  formatValue={(v) => `+${v} m`}
                  tooltip="Node initialcost when entering or crossing a Class 4 junction from a minor road or cycleway/path (way:coming_from_lowprio)."
                  onChange={(v) => handleAxisChange('crossingClass4Cost', v)}
                />
                <SliderRow
                  id="pe-crossing-5"
                  label="Class 5: Very high risk (traffic class 5-6)"
                  value={axes.crossingClass5Cost}
                  min={0}
                  max={1000}
                  step={10}
                  disallowable
                  formatValue={(v) => `+${v} m`}
                  tooltip="Node initialcost when entering or crossing a Class 5 junction from a minor road or cycleway/path (way:coming_from_lowprio)."
                  onChange={(v) => handleAxisChange('crossingClass5Cost', v)}
                />
                <SliderRow
                  id="pe-crossing-6"
                  label="Class 6: Extreme risk (traffic class 6, fast or multi-lane)"
                  value={axes.crossingClass6Cost}
                  min={0}
                  max={1000}
                  step={10}
                  disallowable
                  formatValue={(v) => `+${v} m`}
                  tooltip="Node initialcost when entering or crossing a Class 6 junction from a minor road or cycleway/path (way:coming_from_lowprio)."
                  onChange={(v) => handleAxisChange('crossingClass6Cost', v)}
                />

                <div className="pe-subsection-header pe-subsection-divider">
                  <span>9d. Turns Across Oncoming Traffic (cost_ToRight_from_H)</span>
                  <span className="pe-section-badge pe-badge-c">+0–400 m</span>
                </div>
                <SliderRow
                  id="pe-turn-across-1"
                  label="Class 1: Very low risk right turn"
                  value={axes.turnAcrossTrafficClass1Cost}
                  min={0}
                  max={400}
                  step={5}
                  formatValue={(v) => `+${v} m`}
                  tooltip="BRouter cost_ToRight_from_H_class1: extra virtual metres when turning right (across oncoming UK left-hand traffic) from a major road (tertiary..primary, prio >= 21) onto a minor street or path (prio <= 20) at a Class 1 junction."
                  onChange={(v) => handleAxisChange('turnAcrossTrafficClass1Cost', v)}
                />
                <SliderRow
                  id="pe-turn-across-2"
                  label="Class 2: Low risk right turn"
                  value={axes.turnAcrossTrafficClass2Cost}
                  min={0}
                  max={400}
                  step={5}
                  formatValue={(v) => `+${v} m`}
                  tooltip="BRouter cost_ToRight_from_H_class2: extra virtual metres when turning right across oncoming traffic from a major road onto a minor road at a Class 2 junction."
                  onChange={(v) => handleAxisChange('turnAcrossTrafficClass2Cost', v)}
                />
                <SliderRow
                  id="pe-turn-across-3"
                  label="Class 3: Moderate risk right turn"
                  value={axes.turnAcrossTrafficClass3Cost}
                  min={0}
                  max={400}
                  step={5}
                  formatValue={(v) => `+${v} m`}
                  tooltip="BRouter cost_ToRight_from_H_class3: extra virtual metres when turning right across oncoming traffic from a major road onto a minor road at a Class 3 junction."
                  onChange={(v) => handleAxisChange('turnAcrossTrafficClass3Cost', v)}
                />
                <SliderRow
                  id="pe-turn-across-4"
                  label="Class 4: High risk right turn"
                  value={axes.turnAcrossTrafficClass4Cost}
                  min={0}
                  max={400}
                  step={5}
                  formatValue={(v) => `+${v} m`}
                  tooltip="BRouter cost_ToRight_from_H_class4: extra virtual metres when turning right across oncoming traffic from a major road onto a minor road at a Class 4 junction."
                  onChange={(v) => handleAxisChange('turnAcrossTrafficClass4Cost', v)}
                />
                <SliderRow
                  id="pe-turn-across-5"
                  label="Class 5: Very high risk right turn"
                  value={axes.turnAcrossTrafficClass5Cost}
                  min={0}
                  max={400}
                  step={5}
                  formatValue={(v) => `+${v} m`}
                  tooltip="BRouter cost_ToRight_from_H_class5: extra virtual metres when turning right across oncoming traffic from a major road onto a minor road at a Class 5 junction."
                  onChange={(v) => handleAxisChange('turnAcrossTrafficClass5Cost', v)}
                />
                <SliderRow
                  id="pe-turn-across-6"
                  label="Class 6: Extreme risk right turn"
                  value={axes.turnAcrossTrafficClass6Cost}
                  min={0}
                  max={400}
                  step={10}
                  formatValue={(v) => `+${v} m`}
                  tooltip="BRouter cost_ToRight_from_H_class6: extra virtual metres when turning right across oncoming traffic from a major road onto a minor road at a Class 6 junction."
                  onChange={(v) => handleAxisChange('turnAcrossTrafficClass6Cost', v)}
                />

                <div className="pe-subsection-header pe-subsection-divider">
                  <span>9e. One-Ways, Barriers, Steps &amp; Ferries</span>
                  <span className="pe-section-badge pe-badge-c">+0–300</span>
                </div>
                <SliderRow
                  id="pe-wrong-way-penalty"
                  label="Wrong-way one-way street penalty (onewaypenalty)"
                  value={axes.wrongWayPenalty}
                  min={0}
                  max={100}
                  step={5}
                  formatValue={(v) => `+${v} /m`}
                  tooltip="Additive per-metre costfactor penalty when routing counter-flow against a one-way street or cycleway without contraflow bike access (oneway:bicycle=no). Higher values (30–50) prevent short wrong-way shortcuts."
                  onChange={(v) => handleAxisChange('wrongWayPenalty', v)}
                />
                <SliderRow
                  id="pe-dismount-cost"
                  label="Barrier / dismount node cost (bicycle=dismount)"
                  value={axes.dismountNodeCost}
                  min={0}
                  max={300}
                  step={10}
                  formatValue={(v) => `+${v} m`}
                  tooltip="Node initialcost in virtual metres for OSM barrier=cycle_barrier, stile, kissing_gate, bollard, or nodes tagged bicycle=dismount."
                  onChange={(v) => handleAxisChange('dismountNodeCost', v)}
                />
              </div>
              <ToggleRow
                id="pe-allow-steps"
                label="Allow steps (highway=steps)"
                checked={axes.allowSteps}
                tooltip="OSM highway=steps: flights of stairs on footways or overpasses. When disabled, steps are assigned costfactor 10000 (explicitly forbidden)."
                onChange={(v) => handleAxisChange('allowSteps', v)}
              />
              <ToggleRow
                id="pe-allow-ferries"
                label="Allow ferries (route=ferry)"
                checked={axes.allowFerries}
                tooltip="OSM route=ferry water crossings where bicycles are permitted. When disabled, ferries are assigned costfactor 10000 (explicitly forbidden)."
                onChange={(v) => handleAxisChange('allowFerries', v)}
              />
            </div>
          </details>

          <div className="pe-group-banner pe-group-d">
            <span className="pe-group-pill">C</span>
            <div className="pe-group-text">
              <strong>Speed &amp; Time Model</strong>
              <span>Computes average speed and riding time; does not change which route is chosen</span>
            </div>
          </div>

          {/* Section 9: Rider & Bike Physics */}
          <details className="pe-section">
            <summary className="pe-section-summary">
              <span>10. Rider &amp; Bike Physics</span>
              <span className="pe-section-badge">Speed &amp; Time</span>
            </summary>
            <div className="pe-section-content">
              <SliderRow
                id="pe-biker-power"
                label="Rider average power"
                value={axes.bikerPower}
                min={50}
                max={350}
                step={5}
                unit="W"
                tooltip="BRouter bikerPower: sustained mechanical pedalling power in Watts used by the kinematic model to compute travel time and climbing speed."
                onChange={(v) => handleAxisChange('bikerPower', v)}
              />
              <SliderRow
                id="pe-total-mass"
                label="Rider + bike mass"
                value={axes.totalMass}
                min={50}
                max={150}
                step={1}
                unit="kg"
                tooltip="BRouter totalMass: combined mass in kilograms of rider, bicycle, and luggage for gravity and rolling resistance calculations."
                onChange={(v) => handleAxisChange('totalMass', v)}
              />
              <SliderRow
                id="pe-max-speed"
                label="Max descent speed"
                value={axes.maxSpeed}
                min={20}
                max={70}
                step={1}
                unit="km/h"
                tooltip="BRouter maxSpeed: terminal speed cap in km/h on descents in the travel-time kinematic model."
                onChange={(v) => handleAxisChange('maxSpeed', v)}
              />
              <SliderRow
                id="pe-rolling-resistance"
                label="Rolling resistance (C_r)"
                value={axes.rollingResistance}
                min={0.004}
                max={0.025}
                step={0.001}
                tooltip="BRouter S_C_x / C_r: dimensionless rolling resistance coefficient on smooth asphalt (0.004 = fast road tyres, 0.008 = touring/gravel tyres, 0.015+ = knobby MTB tyres)."
                onChange={(v) => handleAxisChange('rollingResistance', v)}
              />
            </div>
          </details>
        </div>
      ) : (
        <div className="pe-body pe-dsl-body">
          <div className="pe-dsl-bar">
            <span className="pe-dsl-info">
              Edit BRouter <code>.brf</code> script directly.
            </span>
            <a
              href="https://brouter.de/brouter/costfunctions.html"
              target="_blank"
              rel="noopener noreferrer"
              className="pe-docs-link"
            >
              BRouter DSL Docs &rarr;
            </a>
          </div>
          <textarea
            id="pe-dsl-textarea"
            className="pe-dsl-textarea"
            spellCheck={false}
            value={dslText}
            onChange={(e) => {
              const nextText = e.target.value;
              routing.abortInFlightProfileRoute(activeProfileIdRef.current);
              setDslText(nextText);
              setDslDirty(true);
              syncDraftState({ dsl: nextText, mode: 'dsl' });
            }}
          />
        </div>
      )}

      <div className="pe-footer">
        <input
          ref={fileInputRef}
          type="file"
          id="pe-import-brf-input"
          accept=".brf,.txt"
          style={{ display: 'none' }}
          onChange={handleImportBrfFile}
        />

        <div className="pe-footer-actions">
          <button
            id="btn-pe-save"
            type="button"
            className="btn btn-primary btn-action-compact"
            title="Save custom profile locally in browser"
            onClick={handleSaveProfile}
          >
            <Icon name={saveToast ? 'check' : 'save'} size={13} />
            <span>{saveToast || 'Save Profile'}</span>
          </button>

          <button
            id="btn-pe-export"
            type="button"
            className="btn btn-outline btn-action-compact"
            title="Download as standard .brf file"
            onClick={handleExportBrf}
          >
            <Icon name="download" size={13} />
            <span>Export .brf</span>
          </button>

          <button
            id="btn-pe-import"
            type="button"
            className="btn btn-outline btn-action-compact"
            title="Import an existing .brf file from disk"
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="upload" size={13} />
            <span>Import .brf</span>
          </button>

          {isSavedCustomSelected && (
            <button
              id="btn-pe-delete"
              type="button"
              className="btn btn-danger btn-action-compact"
              style={{ flex: '0 0 auto', padding: '0 9px' }}
              title="Delete this saved custom profile"
              aria-label="Delete saved profile"
              onClick={handleDeleteCurrent}
            >
              <Icon name="trash" size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
