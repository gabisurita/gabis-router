import React, { useMemo, useState } from 'react';
import {
  formatDistance,
  formatElevation,
  type Units,
} from '../format.ts';
import {
  STABILITY_COLORS,
  type AlternativeBranch,
  type RobustnessAnalysis,
  type ScenarioPresetCount,
} from '../utils/robustness.ts';
import { Icon } from './common/Icon.tsx';
import { InfoButton } from './TooltipPopover.tsx';

const SCENARIO_PRESETS: ScenarioPresetCount[] = [20, 40, 80, 160, 320];

interface RobustnessStripProps {
  scenarioCount: ScenarioPresetCount;
  onChangeScenarioCount: (count: ScenarioPresetCount) => void;
  phase: 'idle' | 'running' | 'done' | 'error';
  completed: number;
  total: number;
  currentLabel: string;
  workerStatus: string;
  elapsedSec: number;
  error: string | null;
  analysis: RobustnessAnalysis | null;
  showStabilityMap: boolean;
  onToggleStabilityMap: (next: boolean) => void;
  pinnedCorridorId: string | null;
  onHoverCorridor: (id: string | null) => void;
  onTogglePinCorridor: (id: string) => void;
  onUseBranch: (branch: AlternativeBranch) => void;
  onCompareBranch: (branch: AlternativeBranch) => void;
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

export const RobustnessStrip: React.FC<RobustnessStripProps> = ({
  scenarioCount,
  onChangeScenarioCount,
  phase,
  completed,
  total,
  currentLabel,
  workerStatus,
  elapsedSec,
  error,
  analysis,
  showStabilityMap,
  onToggleStabilityMap,
  pinnedCorridorId,
  onHoverCorridor,
  onTogglePinCorridor,
  onUseBranch,
  onCompareBranch,
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

  const displayedBranches = useMemo(() => {
    if (!analysis) return [];
    if (branchSort === 'route') {
      return [...analysis.branches].sort((a, b) => a.baseStartM - b.baseStartM);
    }
    return analysis.branches;
  }, [analysis, branchSort]);

  return (
    <div className="ri-robustness-strip" role="region" aria-label="Route robustness analysis">
      {phase === 'idle' && (
        <div className="ri-robust-prompt">
          <div className="ri-robust-prompt-text">
            <span className="ri-robust-title">
              Robustness check
              <InfoButton
                tooltip="Runs 28 single-axis sweeps plus deterministic multi-axis jitter samples across traffic, noise, bike-route adhesion, hills, surface, trails, turns, crossings, and scenery to measure route stability and uncover trade-off corridors."
                ariaLabel="About Robustness Analysis"
              />
            </span>
            <span className="ri-robust-note">
              Runs {scenarioCount} config scenarios in parallel to map segment stability and
              alternatives. This may take up to a minute on longer routes.
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
              <span>Run analysis</span>
            </button>
            <button
              type="button"
              className="collapse-btn"
              title="Close robustness panel"
              aria-label="Close robustness panel"
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
              <span className="ri-robust-elapsed">
                {elapsedSec}s elapsed · may take up to a minute
              </span>
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
          <span>Robustness check failed: {error}</span>
          <div className="ri-robust-prompt-actions">
            <button type="button" className="btn-toolbar-mini" onClick={() => onStart()}>
              <Icon name="refresh" size={12} />
              <span>Retry</span>
            </button>
            <button
              type="button"
              className="collapse-btn"
              aria-label="Close robustness panel"
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
                title="Distance-weighted share of perturbation scenarios that follow each segment of the current route"
              >
                <strong>{stabilityPct}%</strong> route stability
              </span>
              <span className="ri-robust-stat-inline">
                Base corridor:{' '}
                <strong>
                  {analysis.baseMatchingProbes}/{analysis.completedCount}
                </strong>
              </span>
              <span className="ri-robust-stat-inline">
                Core spine: <strong>{spinePct}%</strong>
              </span>
              {fragilePct > 0 && (
                <span className="ri-robust-stat-inline">
                  Sensitive: <strong>{fragilePct}%</strong>
                </span>
              )}
              {shiftedAxes.length > 0 && (
                <span
                  className="ri-robust-axes-inline"
                  title="Single-axis preference shifts causing the largest corridor divergence"
                >
                  Most sensitive to:{' '}
                  {shiftedAxes.map((d) => `${d.dimension} (${d.maxDivergencePct}%)`).join(', ')}
                </span>
              )}
            </div>

            <div className="ri-robust-summary-controls">
              {displayedBranches.length > 1 && (
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
                    By share
                  </button>
                  <button
                    type="button"
                    className={`ri-alt-btn ${branchSort === 'route' ? 'active' : ''}`}
                    title="Order detour branches from start to finish along the route"
                    onClick={() => setBranchSort('route')}
                  >
                    Along route
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
                <span>Stability map</span>
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
                    title="Re-run robustness check"
                    aria-label="Re-run robustness check"
                    onClick={() => onStart()}
                  >
                    <Icon name="refresh" size={12} />
                  </button>
                  <button
                    type="button"
                    className="collapse-btn"
                    title="Close robustness panel"
                    aria-label="Close robustness panel"
                    onClick={onClose}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </>
              )}
            </div>
          </div>

          {displayedBranches.length === 0 ? (
            phase === 'done' && (
              <div className="ri-robust-empty">
                All {analysis.completedCount} tested config scenarios stayed on the same route.
              </div>
            )
          ) : (
            <div className="ri-corridors-row">
              {displayedBranches.map((b) => {
                const isPinned = pinnedCorridorId === b.id;
                const extraCount = b.probeLabels.length - 1;
                const mixTag = b.branchMix.hasData
                  ? `${b.branchMix.dominantSurface} · ${b.branchMix.dominantRoad}`
                  : `${formatDistance(b.distanceM)}`;
                return (
                  <div
                    key={b.id}
                    className={`ri-corridor-card ${isPinned ? 'active' : ''}`}
                    style={{ '--corridor-color': b.color.line } as React.CSSProperties}
                    onPointerEnter={() => onHoverCorridor(b.id)}
                    onPointerLeave={() => onHoverCorridor(null)}
                    onClick={() => onTogglePinCorridor(b.id)}
                  >
                    <div className="ri-corridor-top">
                      <span
                        className="ri-corridor-dot"
                        style={{ backgroundColor: b.color.line }}
                      />
                      <span
                        className="ri-corridor-label"
                        title={`${b.probeLabels.join(', ')}: ${b.description}`}
                      >
                        {b.label}
                        {extraCount > 0 ? ` +${extraCount}` : ''}
                      </span>
                      <span
                        className="ri-corridor-support"
                        title={`Chosen by ${b.probeCount} of ${analysis.completedCount} scenarios (${b.sharePct}%)`}
                      >
                        {b.sharePct > 0 ? `${b.sharePct}%` : '<1%'} ({b.probeCount}/
                        {analysis.completedCount})
                      </span>
                    </div>
                    <div className="ri-corridor-deltas">
                      <span>
                        km {(b.baseStartM / 1000).toFixed(1)}-{(b.baseEndM / 1000).toFixed(1)}
                      </span>
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
          )}
        </div>
      )}
    </div>
  );
};
