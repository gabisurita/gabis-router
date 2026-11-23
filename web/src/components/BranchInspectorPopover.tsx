import React from 'react';
import { formatDistance, formatDuration, formatElevation } from '../format.ts';
import type {
  AlternativeBranch,
  AlternativeCorridor,
  SpanProfileMix,
} from '../utils/robustness.ts';
import { Icon } from './common/Icon.tsx';

export type InspectedRobustnessItem =
  | { kind: 'segment'; item: AlternativeBranch }
  | { kind: 'variant'; item: AlternativeCorridor };

interface BranchInspectorPopoverProps {
  inspected: InspectedRobustnessItem;
  completedCount: number;
  mapLabels: string[];
  screenPos: { x: number; y: number };
  isPinned: boolean;
  canAddCompareSlot: boolean;
  onUse: (inspected: InspectedRobustnessItem) => void;
  onCompare: (inspected: InspectedRobustnessItem) => void;
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

function formatSignedTimeS(deltaS: number): string {
  const mins = Math.round(Math.abs(deltaS) / 60);
  if (mins < 1) return 'same time';
  const sign = deltaS > 0 ? '+' : '-';
  return `${sign}${formatDuration(Math.abs(deltaS))}`;
}

export const BranchInspectorPopover: React.FC<BranchInspectorPopoverProps> = ({
  inspected,
  completedCount,
  mapLabels,
  screenPos,
  isPinned,
  canAddCompareSlot,
  onUse,
  onCompare,
  onClose,
}) => {
  const isSegment = inspected.kind === 'segment';
  const common = inspected.item;
  const shareText = common.sharePct > 0 ? `${common.sharePct}%` : '<1%';
  const mix: SpanProfileMix = isSegment ? inspected.item.branchMix : inspected.item.routeMix;
  const baseMix: SpanProfileMix = common.baseMix;
  const showMix = mix.hasData;
  const subtitle =
    mapLabels.length > 0
      ? `via ${mapLabels.join(', ')}`
      : isSegment
        ? 'Detour segment'
        : 'Full route variant';

  return (
    <div
      className={`branch-inspector-popover ${isPinned ? 'is-pinned' : 'is-hover'}`}
      style={{
        left: `${Math.round(screenPos.x)}px`,
        top: `${Math.round(screenPos.y)}px`,
        '--branch-color': common.color.line,
      } as React.CSSProperties}
      role={isPinned ? 'dialog' : 'tooltip'}
      aria-label={`Route option details: ${common.label}`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="bi-header">
        <span className="bi-dot" style={{ backgroundColor: common.color.line }} />
        <div className="bi-title-wrap">
          <div className="bi-title">{common.label}</div>
          <div className="bi-subtitle">{subtitle}</div>
        </div>
        <span className="bi-share">
          {shareText} ({common.probeCount}/{completedCount})
        </span>
        {isPinned && (
          <button
            type="button"
            className="collapse-btn bi-close-btn"
            aria-label="Unpin details"
            title="Close"
            onClick={onClose}
          >
            <Icon name="close" size={12} />
          </button>
        )}
      </div>

      <div className="bi-metrics">
        <span>
          <strong>{formatDistance(common.distanceM)}</strong> ({formatSignedDeltaM(common.deltaDistanceM)})
        </span>
        <span>·</span>
        <span>
          <strong>+{formatElevation(common.ascentM)}</strong> ({formatSignedClimbM(common.deltaAscentM)})
        </span>
        {!isSegment && (
          <>
            <span>·</span>
            <span>{formatSignedTimeS(inspected.item.deltaTimeS)}</span>
          </>
        )}
      </div>

      {showMix && (
        <table className="bi-mix-table">
          <thead>
            <tr>
              <th />
              <th>{isSegment ? 'Branch' : 'Variant'}</th>
              <th>{isSegment ? 'Replaced base' : 'Base route'}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Surface</td>
              <td>{mix.dominantSurface}</td>
              <td>{baseMix.hasData ? baseMix.dominantSurface : '-'}</td>
            </tr>
            <tr>
              <td>Roads</td>
              <td>{mix.dominantRoad}</td>
              <td>{baseMix.hasData ? baseMix.dominantRoad : '-'}</td>
            </tr>
            <tr>
              <td>Traffic</td>
              <td>{mix.dominantTraffic}</td>
              <td>{baseMix.hasData ? baseMix.dominantTraffic : '-'}</td>
            </tr>
            <tr>
              <td>Noise</td>
              <td>{mix.dominantNoise}</td>
              <td>{baseMix.hasData ? baseMix.dominantNoise : '-'}</td>
            </tr>
          </tbody>
        </table>
      )}

      {isPinned ? (
        <div className="bi-actions">
          <button
            type="button"
            className="btn btn-primary btn-action-compact bi-action-btn"
            title={
              isSegment
                ? 'Fit the minimal via-waypoints needed to follow this entire branch under your active profile'
                : 'Fit the minimal via-waypoints needed to follow this route variant under your active profile'
            }
            onClick={() => onUse(inspected)}
          >
            {isSegment ? 'Use branch' : 'Use variant'}
          </button>
          <button
            type="button"
            className="ri-corridor-compare-btn bi-action-btn"
            disabled={!canAddCompareSlot}
            title={
              canAddCompareSlot
                ? 'Compare the full perturbed profile that chose this option'
                : 'Maximum of 3 compared profiles reached on this route'
            }
            onClick={() => onCompare(inspected)}
          >
            + Compare profile
          </button>
        </div>
      ) : (
        <div className="bi-hint">
          Click {isSegment ? 'branch' : 'variant'} to pin, apply, or compare
        </div>
      )}
    </div>
  );
};
