import React, { useMemo, useState } from 'react';
import {
  formatDistance,
  formatDuration,
  formatElevation,
  type Units,
} from '../format.ts';
import {
  STABILITY_COLORS,
  type AlternativeBranch,
  type AlternativeCorridor,
  type RobustnessAnalysis,
  type RobustnessFilterMode,
  type RobustnessViewMode,
  type ScenarioPresetCount,
} from '../utils/robustness.ts';
import { Icon } from './common/Icon.tsx';
import { InfoButton } from './TooltipPopover.tsx';

const SCENARIO_PRESETS: ScenarioPresetCount[] = [20, 40, 80, 160, 320];

interface RobustnessStripProps {
  scenarioCount: ScenarioPresetCount;
  onChangeScenarioCount: (count: ScenarioPresetCount) => void;
  viewMode: RobustnessViewMode;
  onChangeViewMode: (mode: RobustnessViewMode) => void;
  filterMode: RobustnessFilterMode;
  onChangeFilterMode: (mode: RobustnessFilterMode) => void;
  phase: 'idle' | 'running' | 'done' | 'error';
  completed: number;
  total: number;
  currentLabel: string;
  workerStatus: string;
  elapsedSec: number;
  error: string | null;
  analysis: RobustnessAnalysis | null;
  totalBranchCount: number;
  totalCorridorCount: number;
  showStabilityMap: boolean;
  onToggleStabilityMap: (next: boolean) => void;
  pinnedCorridorId: string | null;
  onHoverCorridor: (id: string | null) => void;
  onTogglePinCorridor: (id: string) => void;
  onFocusCoords?: (coords: [number, number][]) => void;
  onUseBranch: (branch: AlternativeBranch) => void;
  onCompareBranch: (branch: AlternativeBranch) => void;
  onUseVariant: (corridor: AlternativeCorridor) => void;
  onCompareVariant: (corridor: AlternativeCorridor) => void;
  canAddCompareSlot: boolean;
  units: Units;
  onStart: (overrideCount?: ScenarioPresetCount) => void;
  onCancel: () => void;
  onClose: () => void;
}

function formatSignedDistance(deltaM: number): string {
  if (Math.abs(deltaM) < 30) return 'same dist';
  const sign = deltaM > 0 ? '+' : '-';
  return `${sign}${formatDistance(Math.abs(deltaM))}`;
}

function formatSignedElevation(deltaM: number): string {
  if (Math.abs(deltaM) < 3) return 'same climb';
  const sign = deltaM > 0 ? '+' : '-';
  return `${sign}${formatElevation(Math.abs(deltaM))}`;
}

function formatSignedDuration(deltaS: number): string {
  const mins = Math.round(Math.abs(deltaS) / 60);
  if (mins < 1) return 'same time';
  const sign = deltaS > 0 ? '+' : '-';
  return `${sign}${formatDuration(Math.abs(deltaS))}`;
}

export const RobustnessStrip: React.FC<RobustnessStripProps> = ({
  scenarioCount,
  onChangeScenarioCount,
  viewMode,
  onChangeViewMode,
  filterMode,
  onChangeFilterMode,
  phase,
  completed,
  total,
  currentLabel,
  workerStatus,
  elapsedSec,
  error,
  analysis,
  totalBranchCount,
  totalCorridorCount,
  showStabilityMap,
  onToggleStabilityMap,
  pinnedCorridorId,
  onHoverCorridor,
  onTogglePinCorridor,
  onFocusCoords,
  onUseBranch,
  onCompareBranch,
  onUseVariant,
  onCompareVariant,
  canAddCompareSlot,
  units: _units,
  onStart,
  onCancel,
  onClose,
}) => {
  const [branchSort, setBranchSort] = useState<'share' | 'route'>('share');
  const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const stabilityPct = analysis ? Math.round(analysis.overallStability * 100) : 0;
  const spinePct = analysis ? Math.round(analysis.spineShare * 100) : 0;
  const fragilePct = analysis ? Math.round(analysis.fragileShare * 100) : 0;
  const shiftedAxes = analysis
    ? analysis.dimensions.filter((d) => d.maxDivergencePct >= 8).slice(0, 3)
    : [];

  const stabilityDetailsTooltip = analysis
    ? [
        `Base corridor: ${analysis.baseMatchingProbes}/${analysis.completedCount} runs`,
        `Core spine: ${spinePct}%`,
        ...(fragilePct > 0 ? [`Sensitive: ${fragilePct}%`] : []),
        ...(shiftedAxes.length > 0
          ? [
              `Most sensitive to: ${shiftedAxes
                .map((d) => `${d.dimension} (${d.maxDivergencePct}%)`)
                .join(', ')}`,
            ]
          : []),
      ].join(' · ')
    : '';

  const displayedBranches = useMemo(() => {
    if (!analysis) return [];
    if (branchSort === 'route') {
      return [...analysis.branches].sort((a, b) => a.baseStartM - b.baseStartM);
    }
    return analysis.branches;
  }, [analysis, branchSort]);

  return (
    <div className="ri-robustness-strip" role="region" aria-label="Route variants">
      {phase === 'idle' && (
        <div className="ri-robust-prompt">
          <div className="ri-robust-prompt-text">
            <span className="ri-robust-title">
              Variants
              <InfoButton
                tooltip="Samples perturbed versions of your active profile in parallel to find alternative segments and full routes."
                ariaLabel="About Route Variants"
              />
            </span>
            <span className="ri-robust-note">
              Run {scenarioCount} perturbed scenarios in parallel to find alternative segments and
              full routes.
            </span>
          </div>
          <div className="ri-robust-prompt-actions">
            <div className="ri-alternatives ri-robust-count-group" role="group" aria-label="Scenario count">
              {SCENARIO_PRESETS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`ri-alt-btn ${scenarioCount === n ? 'active' : ''}`}
                  title={`Run ${n} perturbation scenarios`}
                  onClick={() => onChangeScenarioCount(n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <button
              id="btn-run-robustness"
              type="button"
              className="btn btn-primary btn-action-compact ri-robust-run-btn"
              onClick={() => onStart()}
            >
              <span>Find variants</span>
            </button>
            <button
              type="button"
              className="collapse-btn"
              title="Close variants panel"
              aria-label="Close variants panel"
              onClick={onClose}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        </div>
      )}

      {phase === 'running' && (
        <div className="ri-robust-progress-wrap">
          <div className="ri-robust-progress-header">
            <div className="ri-robust-progress-left">
              <span className="status-spinner status-spinner-sm" aria-hidden="true" />
              <span className="ri-robust-progress-count">
                {completed} / {total} ({pct}%)
              </span>
              <span className="ri-robust-progress-step">
                {workerStatus || (currentLabel ? `Testing: ${currentLabel}` : 'Starting workers...')}
              </span>
            </div>
            <div className="ri-robust-progress-right">
              <span className="ri-robust-elapsed">{elapsedSec}s elapsed</span>
              <button
                id="btn-cancel-robustness"
                type="button"
                className="btn-toolbar-mini btn-toolbar-clear"
                onClick={onCancel}
              >
                <span>Cancel</span>
              </button>
            </div>
          </div>
          <div
            className="ri-robust-progress-track"
            role="progressbar"
            aria-valuenow={completed}
            aria-valuemin={0}
            aria-valuemax={total}
          >
            <div className="ri-robust-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="ri-robust-error">
          <span>Variant search failed: {error}</span>
          <div className="ri-robust-prompt-actions">
            <button type="button" className="btn-toolbar-mini" onClick={() => onStart()}>
              <Icon name="refresh" size={12} />
              <span>Retry</span>
            </button>
            <button
              type="button"
              className="collapse-btn"
              aria-label="Close variants panel"
              onClick={onClose}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        </div>
      )}

      {analysis && analysis.completedCount > 0 && (
        <div className="ri-robust-results">
          <div className="ri-robust-summary-bar">
            <div className="ri-robust-summary-metrics">
              <span
                className="ri-robust-score-pill"
                style={{
                  borderColor:
                    stabilityPct >= 75
                      ? STABILITY_COLORS.high
                      : stabilityPct >= 45
                        ? STABILITY_COLORS.medium
                        : STABILITY_COLORS.low,
                }}
                title={stabilityDetailsTooltip}
              >
                <strong>{stabilityPct}%</strong> stability
              </span>
              <InfoButton
                tooltip={stabilityDetailsTooltip}
                ariaLabel="Stability details"
              />
            </div>

            <div className="ri-robust-summary-controls">
              <div
                className="ri-alternatives ri-robust-count-group"
                role="group"
                aria-label="Group alternatives by full routes or segments"
              >
                <button
                  type="button"
                  className={`ri-alt-btn ${viewMode === 'variants' ? 'active' : ''}`}
                  title="Group full alternative routes"
                  onClick={() => onChangeViewMode('variants')}
                >
                  Full routes ({analysis.corridors.length})
                </button>
                <button
                  type="button"
                  className={`ri-alt-btn ${viewMode === 'segments' ? 'active' : ''}`}
                  title="Group local detour segments independently along the route"
                  onClick={() => onChangeViewMode('segments')}
                >
                  Segments ({analysis.branches.length})
                </button>
              </div>
              <div
                className="ri-alternatives ri-robust-count-group"
                role="group"
                aria-label="Filter alternatives by probability mass"
              >
                <button
                  type="button"
                  className={`ri-alt-btn ${filterMode === 'frequent' ? 'active' : ''}`}
                  title="Show only high-probability alternatives (top probability mass)"
                  onClick={() => onChangeFilterMode('frequent')}
                >
                  Frequent
                </button>
                <button
                  type="button"
                  className={`ri-alt-btn ${filterMode === 'all' ? 'active' : ''}`}
                  title={`Show all discovered ${
                    viewMode === 'segments'
                      ? `${totalBranchCount} segments`
                      : `${totalCorridorCount} full routes`
                  }`}
                  onClick={() => onChangeFilterMode('all')}
                >
                  All
                </button>
              </div>
              {viewMode === 'segments' && displayedBranches.length > 1 && (
                <div
                  className="ri-alternatives ri-robust-count-group"
                  role="group"
                  aria-label="Branch sort order"
                >
                  <button
                    type="button"
                    className={`ri-alt-btn ${branchSort === 'share' ? 'active' : ''}`}
                    title="Order detour branches by scenario share"
                    onClick={() => setBranchSort('share')}
                  >
                    Share
                  </button>
                  <button
                    type="button"
                    className={`ri-alt-btn ${branchSort === 'route' ? 'active' : ''}`}
                    title="Order detour branches from start to finish along the route"
                    onClick={() => setBranchSort('route')}
                  >
                    Order
                  </button>
                </div>
              )}
              <button
                type="button"
                className={`breakdown-selector-chip ri-stability-map-chip ${showStabilityMap ? 'active' : ''}`}
                aria-pressed={showStabilityMap}
                title="Color the active route on the map by segment stability: green (>=75% of scenarios), amber (35-74%), red (<35%)"
                onClick={() => onToggleStabilityMap(!showStabilityMap)}
              >
                <span className="ri-stability-legend-dots" aria-hidden="true">
                  <i style={{ backgroundColor: STABILITY_COLORS.high }} />
                  <i style={{ backgroundColor: STABILITY_COLORS.medium }} />
                  <i style={{ backgroundColor: STABILITY_COLORS.low }} />
                </span>
                <span>Stability</span>
              </button>

              {phase === 'done' && (
                <>
                  <div
                    className="ri-alternatives ri-robust-count-group"
                    role="group"
                    aria-label="Scenario count"
                  >
                    {SCENARIO_PRESETS.map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`ri-alt-btn ${scenarioCount === n ? 'active' : ''}`}
                        title={`Run ${n} perturbation scenarios`}
                        onClick={() => {
                          onChangeScenarioCount(n);
                          if (analysis.totalCount !== n) {
                            onStart(n);
                          }
                        }}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="btn-toolbar-mini btn-toolbar-ghost"
                    title="Re-run variant search"
                    aria-label="Re-run variant search"
                    onClick={() => onStart()}
                  >
                    <Icon name="refresh" size={12} />
                  </button>
                  <button
                    type="button"
                    className="collapse-btn"
                    title="Close variants panel"
                    aria-label="Close variants panel"
                    onClick={onClose}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </>
              )}
            </div>
          </div>

          {viewMode === 'segments' ? (
            displayedBranches.length === 0 ? (
              phase === 'done' && (
                <div className="ri-robust-empty">
                  All {analysis.completedCount} tested scenarios stayed on the same route.
                </div>
              )
            ) : (
              <div className="ri-corridors-row">
                {displayedBranches.map((b) => {
                  const isPinned = pinnedCorridorId === b.id;
                  const mixTag = b.branchMix.hasData
                    ? `${b.branchMix.dominantSurface} · ${b.branchMix.dominantNoise}`
                    : `${formatDistance(b.distanceM)}`;
                  return (
                    <div
                      key={b.id}
                      className={`ri-corridor-card ${isPinned ? 'active' : ''}`}
                      style={{ '--corridor-color': b.color.line } as React.CSSProperties}
                      onPointerEnter={() => onHoverCorridor(b.id)}
                      onPointerLeave={() => onHoverCorridor(null)}
                      onClick={() => {
                        onTogglePinCorridor(b.id);
                        if (!isPinned && onFocusCoords && b.coordinates.length >= 2) {
                          onFocusCoords(b.coordinates);
                        }
                      }}
                    >
                      <div className="ri-corridor-top">
                        <span
                          className="ri-corridor-dot"
                          style={{ backgroundColor: b.color.line }}
                        />
                        <span className="ri-corridor-label">{b.label}</span>
                        <span
                          className="ri-corridor-support"
                          title={`Chosen by ${b.probeCount} of ${analysis.completedCount} scenarios (${b.sharePct}%)`}
                        >
                          {b.sharePct > 0 ? `${b.sharePct}%` : '<1%'} ({b.probeCount}/
                          {analysis.completedCount})
                        </span>
                      </div>
                      <div className="ri-corridor-deltas">
                        <span>{formatDistance(b.distanceM)}</span>
                        <span>·</span>
                        <span>{formatSignedDistance(b.deltaDistanceM)}</span>
                        <span>·</span>
                        <span>{formatSignedElevation(b.deltaAscentM)}</span>
                      </div>
                      <div className="ri-corridor-footer">
                        <span className="ri-corridor-abs" title={mixTag}>
                          {mixTag}
                        </span>
                        <div className="ri-corridor-card-actions">
                          <button
                            type="button"
                            className="ri-corridor-compare-btn"
                            title={`Fit minimal via-waypoints to follow "${b.label}" under your active profile`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onUseBranch(b);
                            }}
                          >
                            Use
                          </button>
                          <button
                            type="button"
                            className="ri-corridor-compare-btn"
                            disabled={!canAddCompareSlot}
                            title={
                              canAddCompareSlot
                                ? `Compare full profile for "${b.label}" side by side`
                                : 'Maximum of 3 compared profiles reached on this route'
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              onCompareBranch(b);
                            }}
                          >
                            + Compare
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : analysis.corridors.length === 0 ? (
            phase === 'done' && (
              <div className="ri-robust-empty">
                All {analysis.completedCount} tested config scenarios stayed on the same route
                corridor.
              </div>
            )
          ) : (
            <div className="ri-corridors-row">
              {analysis.corridors.map((c) => {
                const isPinned = pinnedCorridorId === c.id;
                const mixTag = c.routeMix.hasData
                  ? `${c.routeMix.dominantSurface} · ${c.routeMix.dominantNoise}`
                  : `${formatDistance(c.distanceM)} · ${formatElevation(c.ascentM)} climb`;
                return (
                  <div
                    key={c.id}
                    className={`ri-corridor-card ${isPinned ? 'active' : ''}`}
                    style={{ '--corridor-color': c.color.line } as React.CSSProperties}
                    onPointerEnter={() => onHoverCorridor(c.id)}
                    onPointerLeave={() => onHoverCorridor(null)}
                    onClick={() => {
                      onTogglePinCorridor(c.id);
                      if (!isPinned && onFocusCoords && c.coordinates.length >= 2) {
                        onFocusCoords(c.coordinates);
                      }
                    }}
                  >
                    <div className="ri-corridor-top">
                      <span
                        className="ri-corridor-dot"
                        style={{ backgroundColor: c.color.line }}
                      />
                      <span className="ri-corridor-label">{c.label}</span>
                      <span
                        className="ri-corridor-support"
                        title={`Chosen by ${c.probeCount} of ${analysis.completedCount} scenarios (${c.sharePct}%)`}
                      >
                        {c.sharePct > 0 ? `${c.sharePct}%` : '<1%'} ({c.probeCount}/
                        {analysis.completedCount})
                      </span>
                    </div>
                    <div className="ri-corridor-deltas">
                      <span>{formatSignedDistance(c.deltaDistanceM)}</span>
                      <span>·</span>
                      <span>{formatSignedElevation(c.deltaAscentM)}</span>
                      <span>·</span>
                      <span>{formatSignedDuration(c.deltaTimeS)}</span>
                    </div>
                    <div className="ri-corridor-footer">
                      <span className="ri-corridor-abs" title={mixTag}>
                        {mixTag}
                      </span>
                      <div className="ri-corridor-card-actions">
                        <button
                          type="button"
                          className="ri-corridor-compare-btn"
                          title={`Fit minimal via-waypoints to follow "${c.label}" under your active profile`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onUseVariant(c);
                          }}
                        >
                          Use
                        </button>
                        <button
                          type="button"
                          className="ri-corridor-compare-btn"
                          disabled={!canAddCompareSlot}
                          title={
                            canAddCompareSlot
                              ? `Compare "${c.label}" side by side with full elevation and surface breakdown`
                              : 'Maximum of 3 compared profiles reached on this route'
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            onCompareVariant(c);
                          }}
                        >
                          + Compare
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
