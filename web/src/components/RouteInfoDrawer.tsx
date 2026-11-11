import React, { useMemo, useState, useEffect, useRef } from 'react';
import {
  getSlotColor,
  PROFILE_INFO,
  waypointLabel,
  type LatLon,
  type ProfileMeta,
  type ProfileName,
  type RouteSlotState,
} from '../types.ts';
import type { SegmentHighlight, SegmentData } from '../utils/classification.ts';
import {
  extractRouteWarnings,
  WARNING_META,
  type RouteWarningItem,
} from '../utils/warnings.ts';
import {
  formatDistance,
  formatDuration,
  formatElevation,
  formatSpeed,
  type Units,
} from '../format.ts';
import { buildProfile } from '../utils/geo.ts';
import { ElevationChart } from './ElevationChart.tsx';
import {
  SurfaceBreakdown,
  BREAKDOWN_BAR_OPTIONS,
  DEFAULT_BREAKDOWN_BARS,
  type BreakdownBarId,
} from './SurfaceBreakdown.tsx';
import { InfoButton } from './TooltipPopover.tsx';
import { Icon } from './common/Icon.tsx';

const ALTERNATIVES = [
  { idx: 0, label: 'Primary', shortLabel: 'Route 1' },
  { idx: 1, label: 'Alt 2', shortLabel: 'Alt 2' },
  { idx: 2, label: 'Alt 3', shortLabel: 'Alt 3' },
  { idx: 3, label: 'Alt 4', shortLabel: 'Alt 4' },
];

interface RouteInfoDrawerProps {
  slots: RouteSlotState[];
  activeSlotIdx?: number;
  onSelectActiveSlot?: (slotIdx: number) => void;
  getProfileMeta?: (profileId: ProfileName) => ProfileMeta;
  statusMessage?: string;
  units: Units;
  onSelectSlotAlternative: (slotIdx: number, altIdx: number) => void;
  onRemoveSlot?: (slotIdx: number) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  hoverPosition?: { lon: number; lat: number } | null;
  onHoverPosition: (pos: { lon: number; lat: number } | null) => void;
  onHighlightSegment: (highlight: SegmentHighlight | null) => void;
  onFlyTo?: (lon: number, lat: number, minZoom?: number) => void;
  onRemoveWaypoint?: (index: number) => void;
}

interface ParsedSlotData {
  distance: number;
  time: number;
  ascent: number;
  descent: number;
  cost: number;
  costFactor: number;
  profile: ReturnType<typeof buildProfile>;
  segments: SegmentData[];
  warnings: RouteWarningItem[];
}

function formatMarkerDist(meters: number, units: Units): string {
  if (units === 'imperial') {
    return `${(meters / 1609.344).toFixed(1)} mi`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

function parseRouteFeatureCollection(
  route: GeoJSON.FeatureCollection | null,
  waypoints?: LatLon[],
): ParsedSlotData | null {
  if (!route || route.features.length === 0) return null;
  const feat = route.features[0];
  const props = (feat.properties || {}) as Record<string, any>;
  const coords = (feat.geometry as GeoJSON.LineString).coordinates;
  const prof = buildProfile(coords);
  const segs: SegmentData[] = props.segments || [];
  const warnings = extractRouteWarnings(route, waypoints);

  const distance = Number(props['track-length'] || 0);
  const cost = Number(props.cost || 0);
  const costFactor = distance > 0 && cost > 0 ? cost / distance : 0;

  const ascent = Number(props['filtered ascend'] || 0);
  const net = prof.ele.length > 0 ? prof.ele[prof.ele.length - 1] - prof.ele[0] : 0;
  const descent = Math.max(0, ascent - net);

  return {
    distance,
    time: Number(props['total-time'] || 0),
    ascent,
    descent,
    cost,
    costFactor,
    profile: prof,
    segments: segs,
    warnings,
  };
}

export const RouteInfoDrawer: React.FC<RouteInfoDrawerProps> = ({
  slots,
  activeSlotIdx = 0,
  onSelectActiveSlot,
  getProfileMeta,
  statusMessage,
  units,
  onSelectSlotAlternative,
  onRemoveSlot,
  isCollapsed,
  onToggleCollapse,
  hoverPosition,
  onHoverPosition,
  onHighlightSegment,
  onFlyTo,
  onRemoveWaypoint,
}) => {
  const [expandedSlotIdx, setExpandedSlotIdx] = useState<number | null>(() =>
    isCollapsed ? null : activeSlotIdx,
  );
  const [warningsOpenBySlot, setWarningsOpenBySlot] = useState<Record<number, boolean>>({});
  const [pinnedWarningId, setPinnedWarningId] = useState<string | null>(null);
  const [visibleBars, setVisibleBars] = useState<BreakdownBarId[]>(() => {
    try {
      const raw = localStorage.getItem('rsrouter_breakdown_bars');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const validIds = new Set<string>(BREAKDOWN_BAR_OPTIONS.map((o) => o.id));
          const filtered = parsed.filter((id): id is BreakdownBarId => validIds.has(id));
          if (filtered.length > 0) return filtered;
        }
      }
    } catch {
      // ignore storage errors
    }
    return DEFAULT_BREAKDOWN_BARS;
  });

  const handleToggleBreakdownBar = (barId: BreakdownBarId) => {
    setVisibleBars((prev) => {
      const exists = prev.includes(barId);
      if (exists && prev.length <= 1) return prev;
      const next = exists
        ? prev.filter((id) => id !== barId)
        : BREAKDOWN_BAR_OPTIONS.map((o) => o.id).filter((id) => prev.includes(id) || id === barId);
      try {
        localStorage.setItem('rsrouter_breakdown_bars', JSON.stringify(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };
  const internalToggleRef = useRef<boolean>(false);
  const activeSlotIdxRef = useRef<number>(activeSlotIdx);
  activeSlotIdxRef.current = activeSlotIdx;

  useEffect(() => {
    if (internalToggleRef.current) {
      internalToggleRef.current = false;
      return;
    }
    setExpandedSlotIdx(isCollapsed ? null : activeSlotIdxRef.current);
  }, [isCollapsed]);

  const prevActiveSlotRef = useRef<number>(activeSlotIdx);
  useEffect(() => {
    if (prevActiveSlotRef.current !== activeSlotIdx) {
      prevActiveSlotRef.current = activeSlotIdx;
      setExpandedSlotIdx((prev) => (prev === null ? null : activeSlotIdx));
    }
  }, [activeSlotIdx]);

  useEffect(() => {
    setExpandedSlotIdx((prev) => {
      if (prev === null) return null;
      if (slots.length === 1) return 0;
      if (prev >= slots.length) {
        return Math.min(activeSlotIdx, Math.max(0, slots.length - 1));
      }
      return prev;
    });
  }, [slots.length, activeSlotIdx]);

  const parsedSlots = useMemo(
    () => slots.map((slot) => parseRouteFeatureCollection(slot.route, slot.waypoints)),
    [slots],
  );

  const hasAnyRoute = parsedSlots.some((d) => d !== null);
  const anyRouting = slots.some((s) => s.isRouting);
  const hadAnyRouteRef = useRef<boolean>(hasAnyRoute);

  useEffect(() => {
    if (hasAnyRoute && !hadAnyRouteRef.current && !isCollapsed) {
      setExpandedSlotIdx(activeSlotIdx);
    }
    hadAnyRouteRef.current = hasAnyRoute;
  }, [hasAnyRoute, activeSlotIdx, isCollapsed]);

  if (!hasAnyRoute && !anyRouting) return null;

  const isMultiSlot = slots.length > 1;
  const allCollapsed = expandedSlotIdx === null;
  const hasMultiRoutes = slots.some((s) => (s.routeIdx ?? 0) !== (slots[0]?.routeIdx ?? 0));

  const handleToggleSlot = (slotIdx: number) => {
    const isCurrentlyExpanded = isMultiSlot
      ? expandedSlotIdx === slotIdx
      : expandedSlotIdx !== null;
    const nextExpanded = isCurrentlyExpanded ? null : slotIdx;
    setExpandedSlotIdx(nextExpanded);

    if (nextExpanded !== null && isMultiSlot && slotIdx !== activeSlotIdx) {
      prevActiveSlotRef.current = slotIdx;
      onSelectActiveSlot?.(slotIdx);
    }

    const nextAllCollapsed = nextExpanded === null;
    if (nextAllCollapsed !== isCollapsed) {
      internalToggleRef.current = true;
      onToggleCollapse();
    }
  };

  return (
    <div
      id="route-info"
      className={`${allCollapsed ? 'collapsed' : ''} ${isMultiSlot ? 'multi-slot' : ''}`}
    >
      {slots.map((slot, slotIdx) => {
        const routeData = parsedSlots[slotIdx];
        if (!routeData && !slot.isRouting) return null;

        const slotColor = getSlotColor(slot, slotIdx);
        const profileMeta = getProfileMeta ? getProfileMeta(slot.profile) : PROFILE_INFO[slot.profile];
        const barCollapsed = isMultiSlot ? expandedSlotIdx !== slotIdx : expandedSlotIdx === null;
        const slotRouteIdx = slot.routeIdx ?? 0;
        const isSlotActive = isMultiSlot && slotIdx === activeSlotIdx;

        return (
          <div
            key={slotIdx}
            id={slotIdx === 0 ? 'route-bar-0' : `route-bar-${slotIdx}`}
            className={`route-bar-card ${barCollapsed ? 'collapsed' : ''} ${slot.isRouting ? 'is-routing' : ''} ${isSlotActive ? 'is-active' : ''}`}
            style={{ '--slot-color': slotColor.line } as React.CSSProperties}
          >
            <div
              className="ri-bar-header"
              onClick={() => {
                if (isMultiSlot && slotIdx !== activeSlotIdx) {
                  prevActiveSlotRef.current = slotIdx;
                  onSelectActiveSlot?.(slotIdx);
                }
                handleToggleSlot(slotIdx);
              }}
            >
              <div className="ri-bar-identity">
                <span
                  className={`ri-slot-dot ${slot.isRouting ? 'is-routing' : ''}`}
                  style={{ backgroundColor: slotColor.line }}
                  title={`Route ${slotRouteIdx + 1} (${slotColor.name})`}
                />
                <span className="ri-slot-title" title={profileMeta?.summary}>
                  {hasMultiRoutes
                    ? `R${slotRouteIdx + 1} · ${profileMeta?.shortLabel || profileMeta?.label || slot.profile}`
                    : isMultiSlot
                      ? profileMeta?.shortLabel || profileMeta?.label || slot.profile
                      : profileMeta?.label || slot.profile}
                </span>
                {routeData && slot.isRouting && (
                  <span
                    className="ri-updating-badge"
                    title={statusMessage || 'Recalculating route...'}
                  >
                    <span className="status-spinner status-spinner-sm" aria-hidden="true" />
                  </span>
                )}
              </div>

              {routeData ? (
                <div className={`ri-bar-metrics ${slot.isRouting ? 'is-routing' : ''}`}>
                  <div className="ri-stat">
                    <span id={slotIdx === 0 ? 'ri-distance' : `ri-distance-${slotIdx}`}>
                      {formatDistance(routeData.distance)}
                    </span>
                    <small>Distance</small>
                  </div>
                  <div className="ri-stat">
                    <span id={slotIdx === 0 ? 'ri-time' : `ri-time-${slotIdx}`}>
                      {formatDuration(routeData.time)}
                    </span>
                    <small>Est. time</small>
                  </div>
                  <div className="ri-stat">
                    <span id={slotIdx === 0 ? 'ri-ascent' : `ri-ascent-${slotIdx}`}>
                      {formatElevation(routeData.ascent)}
                    </span>
                    <small>Ascent</small>
                  </div>
                  <div className="ri-stat">
                    <span id={slotIdx === 0 ? 'ri-descent' : `ri-descent-${slotIdx}`}>
                      {formatElevation(routeData.descent)}
                    </span>
                    <small>Descent</small>
                  </div>
                  <div className="ri-stat">
                    <span id={slotIdx === 0 ? 'ri-speed' : `ri-speed-${slotIdx}`}>
                      {formatSpeed(routeData.distance, routeData.time)}
                    </span>
                    <small>Avg speed</small>
                  </div>
                  {routeData.costFactor > 0 && (
                    <div
                      className="ri-stat"
                      title={`Exact router cost: ${Math.round(routeData.cost).toLocaleString()} (${routeData.costFactor.toFixed(2)}× distance)`}
                    >
                      <span id={slotIdx === 0 ? 'ri-cost' : `ri-cost-${slotIdx}`}>
                        {routeData.costFactor.toFixed(2)}×
                      </span>
                      <small>Cost</small>
                    </div>
                  )}
                </div>
              ) : (
                <div className="ri-bar-loading" role="status" aria-live="polite">
                  <span className="status-spinner" aria-hidden="true" />
                  <span>{statusMessage || 'Calculating route...'}</span>
                </div>
              )}

              <div
                className="ri-bar-controls"
                onClick={(e) => {
                  e.stopPropagation();
                }}
              >
                {routeData && routeData.warnings.length > 0 && (
                  <button
                    type="button"
                    className={`ri-warning-badge ${warningsOpenBySlot[slotIdx] ? 'active' : ''}`}
                    title={`${routeData.warnings.length} route warning${routeData.warnings.length === 1 ? '' : 's'} along this route — click to toggle warnings list`}
                    aria-label={`${routeData.warnings.length} route warnings`}
                    aria-expanded={Boolean(warningsOpenBySlot[slotIdx])}
                    onClick={() => {
                      if (isMultiSlot && slotIdx !== activeSlotIdx) {
                        onSelectActiveSlot?.(slotIdx);
                      }
                      setWarningsOpenBySlot((prev) => ({
                        ...prev,
                        [slotIdx]: !prev[slotIdx],
                      }));
                    }}
                  >
                    <Icon name="warning" size={12} />
                    <span>{routeData.warnings.length}</span>
                  </button>
                )}

                <div className="ri-alternatives" role="group" aria-label="Route alternatives">
                  {ALTERNATIVES.map((alt) => (
                    <button
                      key={alt.idx}
                      type="button"
                      className={`ri-alt-btn ${slot.alternativeIdx === alt.idx ? 'active' : ''}`}
                      title={`Compute ${alt.label} route for ${profileMeta?.label || slot.profile}`}
                      onClick={() => onSelectSlotAlternative(slotIdx, alt.idx)}
                    >
                      {alt.shortLabel}
                    </button>
                  ))}
                </div>

                <button
                  id={slotIdx === 0 ? 'btn-toggle-ri-collapse' : `btn-toggle-ri-collapse-${slotIdx}`}
                  type="button"
                  className="collapse-btn ri-bar-collapse-btn"
                  title={barCollapsed ? 'Expand charts' : 'Collapse charts'}
                  aria-label={barCollapsed ? 'Expand charts' : 'Collapse charts'}
                  aria-expanded={!barCollapsed}
                  onClick={() => handleToggleSlot(slotIdx)}
                >
                  <Icon
                    id={slotIdx === 0 ? 'ri-collapse-icon' : undefined}
                    className="ri-collapse-chevron"
                    name="chevron-down"
                    size={15}
                  />
                </button>

                {isMultiSlot && onRemoveSlot && (
                  <button
                    type="button"
                    className="collapse-btn ri-bar-remove-btn"
                    title="Remove this profile from comparison"
                    aria-label={`Remove ${profileMeta?.label || slot.profile}`}
                    onClick={() => onRemoveSlot(slotIdx)}
                  >
                    <Icon name="close" size={14} />
                  </button>
                )}
              </div>
            </div>

            {routeData &&
              routeData.warnings.length > 0 &&
              Boolean(warningsOpenBySlot[slotIdx]) && (
                <div
                  className="ri-warnings-strip"
                  role="region"
                  aria-label="Route warnings"
                >
                  <span className="ri-warnings-title">
                    <Icon name="warning" size={11} />
                    <span>Warnings</span>
                    <InfoButton
                      tooltip="Sections along the route requiring caution (yellow) or where cycling is prohibited / dismount is required (red). Hover a chip to highlight on the map; click to zoom in."
                      ariaLabel="About Route Warnings"
                    />
                  </span>
                  <div className="ri-warnings-list">
                    {routeData.warnings.map((w) => {
                      const meta = WARNING_META[w.kind];
                      const pinKey = `${slotIdx}:${w.id}`;
                      const isPinned = pinnedWarningId === pinKey;
                      const wpCount = slot.waypoints?.length ?? 0;
                      const wpLbl =
                        w.waypointIndex !== undefined && wpCount > 0
                          ? waypointLabel(w.waypointIndex, wpCount)
                          : undefined;
                      return (
                        <div
                          key={w.id}
                          className={`ri-warning-chip ${isPinned ? 'active' : ''}`}
                          style={
                            {
                              '--warn-color': w.color,
                              '--warn-bg': w.badgeBg,
                            } as React.CSSProperties
                          }
                          onPointerEnter={() => {
                            onHoverPosition({ lon: w.lon, lat: w.lat });
                            if (w.coordinates.length >= 2) {
                              onHighlightSegment({
                                coordinates: [w.coordinates],
                                color: w.color,
                              });
                            }
                          }}
                          onPointerLeave={() => {
                            onHoverPosition(null);
                            if (!isPinned) {
                              onHighlightSegment(null);
                            }
                          }}
                        >
                          <button
                            type="button"
                            className="ri-warning-chip-main"
                            title={`${meta.label} at ${formatMarkerDist(w.from, units)}: ${w.detail} (${formatDistance(w.distanceM)}) — click to locate on map`}
                            onClick={() => {
                              if (isMultiSlot && slotIdx !== activeSlotIdx) {
                                onSelectActiveSlot?.(slotIdx);
                              }
                              setPinnedWarningId((prev) => {
                                const next = prev === pinKey ? null : pinKey;
                                if (next && w.coordinates.length >= 2) {
                                  onHighlightSegment({
                                    coordinates: [w.coordinates],
                                    color: w.color,
                                  });
                                } else {
                                  onHighlightSegment(null);
                                }
                                return next;
                              });
                              onFlyTo?.(w.lon, w.lat, 15.5);
                            }}
                          >
                            <span
                              className="ri-warning-dot"
                              style={{ backgroundColor: w.color }}
                            />
                            <span className="ri-warning-km">
                              {formatMarkerDist(w.from, units)}
                            </span>
                            <span className="ri-warning-text">{w.detail}</span>
                            <span className="ri-warning-len">
                              ({formatDistance(w.distanceM)})
                            </span>
                          </button>
                          {w.waypointIndex !== undefined && onRemoveWaypoint && (
                            <button
                              type="button"
                              className="ri-warning-fix-btn"
                              title={`Remove misplaced Waypoint ${wpLbl || w.waypointIndex} to eliminate this U-turn rollback`}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (isMultiSlot && slotIdx !== activeSlotIdx) {
                                  onSelectActiveSlot?.(slotIdx);
                                }
                                onRemoveWaypoint(w.waypointIndex!);
                              }}
                            >
                              × WP {wpLbl || w.waypointIndex}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

            {routeData && !barCollapsed && (
              <div
                id={slotIdx === 0 ? 'route-info-body' : `route-info-body-${slotIdx}`}
                className="ri-bar-body"
              >
                <div
                  id={slotIdx === 0 ? 'elevation-details' : `elevation-details-${slotIdx}`}
                  className="ri-col ri-col-elevation"
                >
                  <div className="ri-col-header">
                    <span className="ri-col-title">
                      Elevation profile
                      <InfoButton
                        tooltip="Height above sea level sampled from terrain elevation data. Gradients are calculated over 40-metre windows. Bridge elevations over water are not accurately measured."
                        ariaLabel="About Elevation Profile"
                      />
                    </span>
                  </div>
                  <ElevationChart
                    slotIdx={slotIdx}
                    compact={isMultiSlot}
                    areaColor={slotColor.soft}
                    profile={routeData.profile}
                    segments={routeData.segments}
                    units={units}
                    hoverPosition={hoverPosition}
                    onHover={onHoverPosition}
                  />
                </div>

                {routeData.segments.length > 0 && (
                  <div
                    id={slotIdx === 0 ? 'surface-details' : `surface-details-${slotIdx}`}
                    className="ri-col ri-col-surface"
                  >
                    <div className="ri-col-header ri-col-header-breakdown">
                      <span className="ri-col-title">Breakdown</span>
                      <div
                        className="breakdown-bar-selector"
                        role="group"
                        aria-label="Visible breakdown bars"
                      >
                        {BREAKDOWN_BAR_OPTIONS.map((opt) => {
                          const active = visibleBars.includes(opt.id);
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              className={`breakdown-selector-chip ${active ? 'active' : ''}`}
                              title={opt.title}
                              aria-pressed={active}
                              onClick={() => handleToggleBreakdownBar(opt.id)}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <SurfaceBreakdown
                      slotIdx={slotIdx}
                      profile={routeData.profile}
                      segments={routeData.segments}
                      units={units}
                      visibleBars={visibleBars}
                      onHover={onHoverPosition}
                      onHighlightSegment={onHighlightSegment}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
