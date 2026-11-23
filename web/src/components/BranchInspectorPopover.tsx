import React from 'react';
import { formatDistance, formatElevation } from '../format.ts';
import type { AlternativeBranch } from '../utils/robustness.ts';
import { Icon } from './common/Icon.tsx';

interface BranchInspectorPopoverProps {
  branch: AlternativeBranch;
  completedCount: number;
  mapLabels: string[];
  screenPos: { x: number; y: number };
  isPinned: boolean;
  canAddCompareSlot: boolean;
  onUseBranch: (branch: AlternativeBranch) => void;
  onCompareBranch: (branch: AlternativeBranch) => void;
  onClose: () => void;
}

function formatSignedDeltaM(deltaM: number): string {
  if (Math.abs(deltaM) < 30) return 'same dist';
  const sign = deltaM > 0 ? '+' : '-';
  return `${sign}${formatDistance(Math.abs(deltaM))}`;
}

function formatSignedClimbM(deltaM: number): string {
  if (Math.abs(deltaM) < 3) return 'same climb';
  const sign = deltaM > 0 ? '+' : '-';
  return `${sign}${formatElevation(Math.abs(deltaM))}`;
}

function formatKmRange(startM: number, endM: number): string {
  return `km ${(startM / 1000).toFixed(1)} to ${(endM / 1000).toFixed(1)}`;
}

export const BranchInspectorPopover: React.FC<BranchInspectorPopoverProps> = ({
  branch,
  completedCount,
  mapLabels,
  screenPos,
  isPinned,
  canAddCompareSlot,
  onUseBranch,
  onCompareBranch,
  onClose,
}) => {
  const shareText = branch.sharePct > 0 ? `${branch.sharePct}%` : '<1%';
  const showMix = branch.branchMix.hasData;

  return (
    <div
      className={`branch-inspector-popover ${isPinned ? 'is-pinned' : 'is-hover'}`}
      style={{
        left: `${Math.round(screenPos.x)}px`,
        top: `${Math.round(screenPos.y)}px`,
        '--branch-color': branch.color.line,
      } as React.CSSProperties}
      role={isPinned ? 'dialog' : 'tooltip'}
      aria-label={`Branch details: ${branch.label}`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="bi-header">
        <span className="bi-dot" style={{ backgroundColor: branch.color.line }} />
        <div className="bi-title-wrap">
          <div className="bi-title">{branch.label}</div>
          <div className="bi-subtitle">
            {mapLabels.length > 0 ? `via ${mapLabels.join(', ')} · ` : ''}
            {formatKmRange(branch.baseStartM, branch.baseEndM)}
          </div>
        </div>
        <span className="bi-share">
          {shareText} ({branch.probeCount}/{completedCount})
        </span>
        {isPinned && (
          <button
            type="button"
            className="collapse-btn bi-close-btn"
            aria-label="Unpin branch details"
            title="Close"
            onClick={onClose}
          >
            <Icon name="close" size={12} />
          </button>
        )}
      </div>

      <div className="bi-metrics">
        <span>
          <strong>{formatDistance(branch.distanceM)}</strong> ({formatSignedDeltaM(branch.deltaDistanceM)})
        </span>
        <span>·</span>
        <span>
          <strong>+{formatElevation(branch.ascentM)}</strong> ({formatSignedClimbM(branch.deltaAscentM)})
        </span>
      </div>

      {showMix && (
        <table className="bi-mix-table">
          <thead>
            <tr>
              <th />
              <th>Branch</th>
              <th>Replaced base</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Surface</td>
              <td>{branch.branchMix.dominantSurface}</td>
              <td>{branch.baseMix.hasData ? branch.baseMix.dominantSurface : '-'}</td>
            </tr>
            <tr>
              <td>Roads</td>
              <td>{branch.branchMix.dominantRoad}</td>
              <td>{branch.baseMix.hasData ? branch.baseMix.dominantRoad : '-'}</td>
            </tr>
            <tr>
              <td>Traffic</td>
              <td>{branch.branchMix.dominantTraffic}</td>
              <td>{branch.baseMix.hasData ? branch.baseMix.dominantTraffic : '-'}</td>
            </tr>
            <tr>
              <td>Noise</td>
              <td>{branch.branchMix.dominantNoise}</td>
              <td>{branch.baseMix.hasData ? branch.baseMix.dominantNoise : '-'}</td>
            </tr>
          </tbody>
        </table>
      )}

      {branch.probeLabels.length > 0 && (
        <div className="bi-drivers">
          {branch.probeLabels.slice(0, 4).map((lbl) => (
            <span key={lbl} className="bi-driver-chip">
              {lbl}
            </span>
          ))}
        </div>
      )}

      {isPinned ? (
        <div className="bi-actions">
          <button
            type="button"
            className="btn btn-primary btn-action-compact bi-action-btn"
            title="Fit the minimal via-waypoints needed to follow this entire branch under your active profile"
            onClick={() => onUseBranch(branch)}
          >
            Use branch
          </button>
          <button
            type="button"
            className="ri-corridor-compare-btn bi-action-btn"
            disabled={!canAddCompareSlot}
            title={
              canAddCompareSlot
                ? 'Compare the full perturbed profile that chose this branch'
                : 'Maximum of 3 compared profiles reached on this route'
            }
            onClick={() => onCompareBranch(branch)}
          >
            + Compare profile
          </button>
        </div>
      ) : (
        <div className="bi-hint">Click branch to pin, apply, or compare</div>
      )}
    </div>
  );
};
