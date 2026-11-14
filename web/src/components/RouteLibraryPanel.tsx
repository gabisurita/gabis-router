import React, { useEffect, useRef, useState } from 'react';
import { formatDistance, formatElevation, type Units } from '../format.ts';
import { downloadGpxFile } from '../utils/gpx.ts';
import {
  libraryTrackToGpx,
  loadLibraryRouteCoordinates,
  SUGGESTION_COLORS,
  SURFACE_LABELS,
  TOP_SUGGESTION_COUNT,
  type DistanceBucket,
  type LibraryFilterState,
  type LibraryRoute,
  type LibrarySort,
  type LibrarySource,
  type LibrarySurface,
} from '../utils/route-library.ts';
import { Icon } from './common/Icon.tsx';

interface RouteLibraryPanelProps {
  isLoadingIndex: boolean;
  indexError: string | null;
  sources: LibrarySource[];
  totalCount: number;
  filteredRoutes: LibraryRoute[];
  filters: LibraryFilterState;
  onChangeFilters: (patch: Partial<LibraryFilterState>) => void;
  selectedRouteId: number | null;
  hoveredRouteId: number | null;
  isPreviewLoading: boolean;
  onSelectRoute: (route: LibraryRoute | null) => void;
  onHoverRoute: (route: LibraryRoute | null) => void;
  onFrameRoute: (route: LibraryRoute) => void;
  onLoadIntoPlanner: (route: LibraryRoute, mode: 'current' | 'new-route') => Promise<void>;
  hasExistingWaypoints: boolean;
  canAddRoute: boolean;
  isRoutingBusy: boolean;
  units: Units;
  onFlyTo?: (lon: number, lat: number, minZoom?: number) => void;
  onClose: () => void;
}

const PAGE_STEP = 60;

const STOP_KIND_LABELS: Record<string, string> = {
  cafe: 'Cafe',
  food: 'Food',
  pub: 'Pub',
  control: 'Control',
  ferry: 'Ferry',
  camp: 'Camp',
  stay: 'Stay',
  summit: 'Climb',
  view: 'View',
  bike: 'Bike shop',
  water: 'Water',
  stop: 'Stop',
  shop: 'Shop',
  place: 'Stop',
  transit: 'Station',
};

export const RouteLibraryPanel: React.FC<RouteLibraryPanelProps> = ({
  isLoadingIndex,
  indexError,
  sources,
  totalCount,
  filteredRoutes,
  filters,
  onChangeFilters,
  selectedRouteId,
  hoveredRouteId,
  isPreviewLoading,
  onSelectRoute,
  onHoverRoute,
  onFrameRoute,
  onLoadIntoPlanner,
  hasExistingWaypoints,
  canAddRoute,
  isRoutingBusy,
  units,
  onFlyTo,
  onClose,
}) => {
  const [visibleLimit, setVisibleLimit] = useState(PAGE_STEP);
  const [busyRouteAction, setBusyRouteAction] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectedCardRef = useRef<HTMLDivElement | null>(null);

  const sourceMap = React.useMemo(() => {
    const m = new Map<string, LibrarySource>();
    for (const s of sources) m.set(s.slug, s);
    return m;
  }, [sources]);

  useEffect(() => {
    setVisibleLimit(PAGE_STEP);
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [
    filters.query,
    filters.inMapView,
    filters.surface,
    filters.distance,
    filters.shape,
    filters.source,
    filters.sort,
  ]);

  // Ensure a route clicked directly on the map is within visibleLimit and scrolled into view.
  useEffect(() => {
    if (selectedRouteId === null) return;
    const idx = filteredRoutes.findIndex((r) => r.id === selectedRouteId);
    if (idx >= visibleLimit) {
      setVisibleLimit(Math.ceil((idx + 1) / PAGE_STEP) * PAGE_STEP);
    }
    requestAnimationFrame(() => {
      selectedCardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, [selectedRouteId, filteredRoutes]);

  const hasActiveFilters =
    filters.query.trim().length > 0 ||
    filters.surface !== 'all' ||
    filters.distance !== 'all' ||
    filters.shape !== 'all' ||
    filters.source !== 'all';

  const resetFilters = () => {
    onChangeFilters({
      query: '',
      surface: 'all',
      distance: 'all',
      shape: 'all',
      source: 'all',
    });
  };

  const handleLoadClick = async (
    e: React.MouseEvent,
    route: LibraryRoute,
    mode: 'current' | 'new-route',
  ) => {
    e.stopPropagation();
    const key = `${route.id}:${mode}`;
    setBusyRouteAction(key);
    try {
      await onLoadIntoPlanner(route, mode);
    } finally {
      setBusyRouteAction(null);
    }
  };

  const handleDownloadGpx = async (e: React.MouseEvent, route: LibraryRoute) => {
    e.stopPropagation();
    const key = `${route.id}:gpx`;
    setBusyRouteAction(key);
    try {
      const coords = await loadLibraryRouteCoordinates(route);
      const srcName = sourceMap.get(route.src)?.name;
      const gpx = libraryTrackToGpx(route, coords, srcName);
      const safeName = route.name.replace(/[/\\?%*:|"<>]/g, '_');
      await downloadGpxFile(gpx, `${safeName}.gpx`);
    } finally {
      setBusyRouteAction(null);
    }
  };

  const distanceOptions: Array<{ id: DistanceBucket; label: string }> =
    units === 'imperial'
      ? [
          { id: 'all', label: 'Any length' },
          { id: 'short', label: '< 30 mi' },
          { id: 'medium', label: '30-62 mi' },
          { id: 'long', label: '62-125 mi' },
          { id: 'ultra', label: '125+ mi' },
        ]
      : [
          { id: 'all', label: 'Any length' },
          { id: 'short', label: '< 50 km' },
          { id: 'medium', label: '50-100 km' },
          { id: 'long', label: '100-200 km' },
          { id: 'ultra', label: '200+ km' },
        ];

  const surfaceOptions: Array<{ id: 'all' | LibrarySurface; label: string }> = [
    { id: 'all', label: 'All surfaces' },
    { id: 'road', label: 'Road' },
    { id: 'mixed', label: 'Mixed' },
    { id: 'gravel', label: 'Gravel' },
    { id: 'traffic-free', label: 'Traffic-free' },
  ];

  const visibleSlice = filteredRoutes.slice(0, visibleLimit);

  return (
    <aside id="route-library-panel" className="rl-panel" aria-label="Route Library">
      <div className="rl-header">
        <div className="rl-header-top">
          <div className="rl-title-wrap">
            <Icon name="book" size={16} />
            <h2>Route library</h2>
            {totalCount > 0 && (
              <span className="rl-count-pill">
                {filteredRoutes.length} {filters.inMapView ? 'in view' : `of ${totalCount}`}
              </span>
            )}
          </div>
          <button
            id="btn-close-route-library"
            type="button"
            className="collapse-btn rl-close-btn"
            title="Close Route Library"
            aria-label="Close Route Library"
            onClick={onClose}
          >
            <span className="rl-close-label">Done</span>
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="rl-search-row">
          <div className="rl-search-input-wrap">
            <Icon name="search" size={13} className="rl-search-icon" />
            <input
              id="input-library-search"
              type="search"
              value={filters.query}
              placeholder="Search routes, regions, cafes, clubs..."
              aria-label="Search route library"
              onChange={(e) => onChangeFilters({ query: e.target.value })}
            />
            {filters.query && (
              <button
                type="button"
                className="rl-search-clear"
                title="Clear search"
                aria-label="Clear search"
                onClick={() => onChangeFilters({ query: '' })}
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
          <button
            id="btn-library-in-view"
            type="button"
            className={`rl-view-toggle ${filters.inMapView ? 'active' : ''}`}
            title="Only show routes that pass through the current map area"
            aria-pressed={filters.inMapView}
            onClick={() => onChangeFilters({ inMapView: !filters.inMapView })}
          >
            <span>In map view</span>
          </button>
        </div>

        <div className="rl-selects-row">
          <select
            id="select-library-source"
            aria-label="Filter by route collection"
            value={filters.source}
            onChange={(e) => onChangeFilters({ source: e.target.value })}
          >
            <option value="all">All collections ({totalCount})</option>
            {sources.map((src) => (
              <option key={src.slug} value={src.slug}>
                {src.name} ({src.count})
              </option>
            ))}
          </select>

          <select
            id="select-library-sort"
            aria-label="Sort routes"
            value={filters.sort}
            onChange={(e) => onChangeFilters({ sort: e.target.value as LibrarySort })}
          >
            <option value="nearby">Nearest</option>
            <option value="shortest">Shortest</option>
            <option value="longest">Longest</option>
            <option value="climbing">Most climbing</option>
          </select>
        </div>

        <div className="rl-chips-group">
          <div className="rl-chip-row" role="group" aria-label="Surface filter">
            {surfaceOptions.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`rl-chip ${filters.surface === opt.id ? 'active' : ''}`}
                onClick={() => onChangeFilters({ surface: opt.id })}
              >
                {opt.id !== 'all' && <span className={`rl-surf-dot surf-${opt.id}`} />}
                <span>{opt.label}</span>
              </button>
            ))}
          </div>

          <div className="rl-chip-row" role="group" aria-label="Distance and shape filter">
            {distanceOptions.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`rl-chip ${filters.distance === opt.id ? 'active' : ''}`}
                onClick={() => onChangeFilters({ distance: opt.id })}
              >
                {opt.label}
              </button>
            ))}
            <button
              type="button"
              className={`rl-chip ${filters.shape === 'loop' ? 'active' : ''}`}
              title="Only show circular loop routes"
              onClick={() =>
                onChangeFilters({ shape: filters.shape === 'loop' ? 'all' : 'loop' })
              }
            >
              Loop
            </button>
            {hasActiveFilters && (
              <button type="button" className="rl-chip rl-chip-reset" onClick={resetFilters}>
                Reset
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="rl-list" ref={listRef} onMouseLeave={() => onHoverRoute(null)}>
        {isLoadingIndex && (
          <div className="rl-empty-state">
            <span className="status-spinner" aria-hidden="true" />
            <span>Loading route library...</span>
          </div>
        )}

        {!isLoadingIndex && indexError && (
          <div className="rl-empty-state is-error">
            <span>Could not load route library: {indexError}</span>
          </div>
        )}

        {!isLoadingIndex && !indexError && filteredRoutes.length === 0 && (
          <div className="rl-empty-state">
            <p>No routes match these filters.</p>
            <div className="rl-empty-actions">
              {filters.inMapView && (
                <button
                  type="button"
                  className="btn btn-outline btn-action-compact"
                  onClick={() => onChangeFilters({ inMapView: false })}
                >
                  Search all UK and Ireland
                </button>
              )}
              {hasActiveFilters && (
                <button
                  type="button"
                  className="btn btn-outline btn-action-compact"
                  onClick={resetFilters}
                >
                  Reset filters
                </button>
              )}
            </div>
          </div>
        )}

        {!isLoadingIndex && !indexError && filteredRoutes.length > 0 && (
          <div className="rl-list-hint">
            <span>
              Top {Math.min(TOP_SUGGESTION_COUNT, filteredRoutes.length)} shown on map
            </span>
            <span>Hover to preview</span>
          </div>
        )}

        {visibleSlice.map((route, idx) => {
          const isSelected = route.id === selectedRouteId;
          const isHovered = route.id === hoveredRouteId;
          const suggestionColor =
            idx < TOP_SUGGESTION_COUNT ? SUGGESTION_COLORS[idx] : undefined;
          const src = sourceMap.get(route.src);
          const isLoadingCurrent = busyRouteAction === `${route.id}:current`;
          const isLoadingNew = busyRouteAction === `${route.id}:new-route`;
          const isDownloading = busyRouteAction === `${route.id}:gpx`;

          return (
            <div
              key={route.id}
              ref={isSelected ? selectedCardRef : undefined}
              className={`rl-card ${isSelected ? 'selected' : ''} ${isHovered ? 'is-hovered' : ''}`}
              style={
                suggestionColor
                  ? ({ '--rl-card-accent': suggestionColor.line } as React.CSSProperties)
                  : undefined
              }
              role="button"
              tabIndex={0}
              aria-expanded={isSelected}
              onMouseEnter={() => onHoverRoute(route)}
              onMouseLeave={() => onHoverRoute(null)}
              onFocus={() => onHoverRoute(route)}
              onBlur={() => onHoverRoute(null)}
              onClick={() => onSelectRoute(isSelected ? null : route)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectRoute(isSelected ? null : route);
                }
              }}
            >
              <div className="rl-card-top">
                <div className="rl-card-heading">
                  {suggestionColor && (
                    <span
                      className="rl-rank-badge"
                      style={{ backgroundColor: suggestionColor.badge }}
                      title={`Map suggestion #${idx + 1}`}
                    >
                      {idx + 1}
                    </span>
                  )}
                  <span className="rl-card-title">{route.name}</span>
                </div>
                <span className="rl-card-stats">
                  <strong>{formatDistance(route.km * 1000)}</strong>
                  {route.asc !== null && (
                    <span className="rl-card-asc">+{formatElevation(route.asc)}</span>
                  )}
                </span>
              </div>

              <div className="rl-card-meta">
                <span className="rl-meta-source">{src?.name || route.src}</span>
                <span className="rl-meta-sep" aria-hidden="true">
                  ·
                </span>
                <span>{route.reg}</span>
                <span className="rl-meta-sep" aria-hidden="true">
                  ·
                </span>
                <span className="rl-meta-surf">
                  <span className={`rl-surf-dot surf-${route.surf}`} />
                  {SURFACE_LABELS[route.surf]}
                </span>
                <span className="rl-meta-sep" aria-hidden="true">
                  ·
                </span>
                <span>{route.loop ? 'Loop' : 'A to B'}</span>
              </div>

              {isSelected && (
                <div className="rl-card-detail" onClick={(e) => e.stopPropagation()}>
                  {isPreviewLoading && (
                    <div className="rl-preview-loading">
                      <span className="status-spinner status-spinner-sm" aria-hidden="true" />
                      <span>Loading map preview...</span>
                    </div>
                  )}

                  {route.desc && <p className="rl-card-desc">{route.desc}</p>}

                  {route.stops && route.stops.length > 0 && (
                    <div className="rl-stops-block">
                      <span className="rl-stops-heading">Stops along route</span>
                      <div className="rl-stops-list">
                        {route.stops.map((stop, idx) => {
                          const kindLabel = stop.kind ? STOP_KIND_LABELS[stop.kind] : undefined;
                          const canFly = Boolean(stop.pos && onFlyTo);
                          return canFly ? (
                            <button
                              key={idx}
                              type="button"
                              className="rl-stop-pill is-clickable"
                              title="Zoom to stop on map"
                              onClick={() => onFlyTo?.(stop.pos![0], stop.pos![1], 14)}
                            >
                              {kindLabel && <span className="rl-stop-kind">{kindLabel}:</span>}
                              <span>{stop.name}</span>
                              {stop.role && <span className="rl-stop-role">({stop.role})</span>}
                            </button>
                          ) : (
                            <span key={idx} className="rl-stop-pill">
                              {kindLabel && <span className="rl-stop-kind">{kindLabel}:</span>}
                              <span>{stop.name}</span>
                              {stop.role && <span className="rl-stop-role">({stop.role})</span>}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="rl-attribution-row">
                    <span className="rl-attribution-text">
                      {src?.license || src?.name || route.src}
                    </span>
                    {(route.url || src?.url) && (
                      <a
                        href={route.url || src?.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rl-source-link"
                      >
                        <span>Source guide</span>
                        <Icon name="external" size={11} />
                      </a>
                    )}
                  </div>

                  <div className="rl-card-actions">
                    <button
                      id="btn-library-load-route"
                      type="button"
                      className="btn btn-primary btn-action-compact rl-btn-open"
                      disabled={isRoutingBusy || busyRouteAction !== null}
                      title="Snap this route onto the road network with editable waypoints and surface breakdown"
                      onClick={(e) => handleLoadClick(e, route, 'current')}
                    >
                      {isLoadingCurrent ? (
                        <>
                          <span className="status-spinner status-spinner-sm" aria-hidden="true" />
                          <span>Loading...</span>
                        </>
                      ) : (
                        <span>{hasExistingWaypoints ? 'Load route' : 'Open in planner'}</span>
                      )}
                    </button>

                    {hasExistingWaypoints && canAddRoute && (
                      <button
                        id="btn-library-load-new-tab"
                        type="button"
                        className="btn btn-outline btn-action-compact"
                        disabled={isRoutingBusy || busyRouteAction !== null}
                        title="Open this route in a new route tab without overwriting your current route"
                        onClick={(e) => handleLoadClick(e, route, 'new-route')}
                      >
                        {isLoadingNew ? <span>Loading...</span> : <span>+ New tab</span>}
                      </button>
                    )}

                    <button
                      id="btn-library-frame-route"
                      type="button"
                      className="btn btn-outline btn-action-compact rl-btn-icon-compact"
                      disabled={busyRouteAction !== null}
                      title="Zoom map to fit this route"
                      aria-label="Zoom map to fit this route"
                      onClick={(e) => {
                        e.stopPropagation();
                        onFrameRoute(route);
                      }}
                    >
                      <Icon name="locate" size={13} />
                    </button>

                    <button
                      id="btn-library-download-gpx"
                      type="button"
                      className="btn btn-outline btn-action-compact rl-btn-gpx"
                      disabled={busyRouteAction !== null}
                      title="Download GPX file directly"
                      onClick={(e) => handleDownloadGpx(e, route)}
                    >
                      <Icon name="download" size={12} />
                      <span>{isDownloading ? '...' : 'GPX'}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {visibleLimit < filteredRoutes.length && (
          <button
            type="button"
            className="rl-load-more-btn"
            onClick={() => setVisibleLimit((prev) => prev + PAGE_STEP)}
          >
            Show more ({filteredRoutes.length - visibleLimit} remaining)
          </button>
        )}
      </div>
    </aside>
  );
};
