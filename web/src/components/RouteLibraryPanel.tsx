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
import { savedRouteToGpx, type SavedRouteRecord } from '../utils/saved-routes.ts';
import { Icon } from './common/Icon.tsx';

export type RouteLibraryTab = 'curated' | 'saved';

interface RouteLibraryPanelProps {
  activeTab?: RouteLibraryTab;
  onChangeTab?: (tab: RouteLibraryTab) => void;
  savedTotalCount?: number;
  savedRoutesById?: ReadonlyMap<number, SavedRouteRecord>;
  onRenameSavedRoute?: (id: number, name: string, notes?: string) => void;
  onDeleteSavedRoute?: (id: number) => void;
  onExportSavedJson?: () => void;
  onImportSavedJsonFile?: (file: File) => void;
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

function formatShortDate(epochMs?: number): string {
  if (!epochMs || !Number.isFinite(epochMs)) return '';
  return new Date(epochMs).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export const RouteLibraryPanel: React.FC<RouteLibraryPanelProps> = ({
  activeTab = 'curated',
  onChangeTab,
  savedTotalCount = 0,
  savedRoutesById,
  onRenameSavedRoute,
  onDeleteSavedRoute,
  onExportSavedJson,
  onImportSavedJsonFile,
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
  const [editingRouteId, setEditingRouteId] = useState<number | null>(null);
  const [editName, setEditName] = useState<string>('');
  const [editNotes, setEditNotes] = useState<string>('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectedCardRef = useRef<HTMLDivElement | null>(null);
  const importBackupInputRef = useRef<HTMLInputElement | null>(null);
  const editNameInputRef = useRef<HTMLInputElement | null>(null);

  const isSavedTab = activeTab === 'saved';
  const activeTotalCount = isSavedTab ? savedTotalCount : totalCount;

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
    activeTab,
    filters.query,
    filters.inMapView,
    filters.surface,
    filters.distance,
    filters.shape,
    filters.source,
    filters.sort,
  ]);

  useEffect(() => {
    setEditingRouteId(null);
  }, [activeTab, selectedRouteId]);

  useEffect(() => {
    if (editingRouteId !== null && editNameInputRef.current) {
      editNameInputRef.current.focus();
      editNameInputRef.current.select();
    }
  }, [editingRouteId]);

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
  }, [selectedRouteId, filteredRoutes, visibleLimit]);

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
      let gpx: string;
      if (isSavedTab) {
        const savedRec = savedRoutesById?.get(route.id);
        if (!savedRec) return;
        gpx = savedRouteToGpx(savedRec);
      } else {
        const coords = await loadLibraryRouteCoordinates(route);
        const srcName = sourceMap.get(route.src)?.name;
        gpx = libraryTrackToGpx(route, coords, srcName);
      }
      const safeName = route.name.replace(/[/\\?%*:|"<>]/g, '_');
      await downloadGpxFile(gpx, `${safeName}.gpx`);
    } finally {
      setBusyRouteAction(null);
    }
  };

  const handleImportInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && onImportSavedJsonFile) {
      onImportSavedJsonFile(file);
    }
    e.target.value = '';
  };

  const startEditingRoute = (route: LibraryRoute) => {
    const savedRec = savedRoutesById?.get(route.id);
    setEditingRouteId(route.id);
    setEditName(savedRec?.name || route.name);
    setEditNotes(savedRec?.notes || '');
  };

  const commitEditingRoute = (routeId: number) => {
    const trimmed = editName.trim();
    if (trimmed && onRenameSavedRoute) {
      onRenameSavedRoute(routeId, trimmed, editNotes.trim() || undefined);
    }
    setEditingRouteId(null);
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
            {activeTotalCount > 0 && (
              <span className="rl-count-pill">
                {filteredRoutes.length} {filters.inMapView ? 'in view' : `of ${activeTotalCount}`}
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

        {onChangeTab && (
          <div className="rl-tabs-bar">
            <div className="pe-mode-tabs rl-mode-tabs" role="tablist" aria-label="Route library mode">
              <button
                id="tab-library-curated"
                type="button"
                role="tab"
                aria-selected={!isSavedTab}
                className={`pe-mode-tab ${!isSavedTab ? 'active' : ''}`}
                onClick={() => onChangeTab('curated')}
              >
                <Icon name="book" size={12} />
                <span>Curated</span>
              </button>
              <button
                id="tab-library-saved"
                type="button"
                role="tab"
                aria-selected={isSavedTab}
                className={`pe-mode-tab ${isSavedTab ? 'active' : ''}`}
                onClick={() => onChangeTab('saved')}
              >
                <Icon name="save" size={12} />
                <span>Saved</span>
                {savedTotalCount > 0 && (
                  <span className="rl-tab-badge">{savedTotalCount}</span>
                )}
              </button>
            </div>

            {isSavedTab && (
              <div className="rl-backup-actions">
                <input
                  ref={importBackupInputRef}
                  type="file"
                  id="input-import-saved-json"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={handleImportInputChange}
                />
                <button
                  id="btn-saved-import-json"
                  type="button"
                  className="btn-toolbar-mini"
                  title="Import saved routes from a JSON backup file"
                  onClick={() => importBackupInputRef.current?.click()}
                >
                  <Icon name="upload" size={11} />
                  <span>Import</span>
                </button>
                <button
                  id="btn-saved-export-json"
                  type="button"
                  className="btn-toolbar-mini"
                  disabled={savedTotalCount === 0}
                  title="Download all saved routes as a JSON backup file"
                  onClick={onExportSavedJson}
                >
                  <Icon name="download" size={11} />
                  <span>Backup</span>
                </button>
              </div>
            )}
          </div>
        )}

        <div className="rl-search-row">
          <div className="rl-search-input-wrap">
            <Icon name="search" size={13} className="rl-search-icon" />
            <input
              id="input-library-search"
              type="search"
              value={filters.query}
              placeholder={
                isSavedTab
                  ? 'Search saved routes...'
                  : 'Search routes, regions, cafes, clubs...'
              }
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
            aria-label={isSavedTab ? 'Filter by profile' : 'Filter by route collection'}
            value={filters.source}
            onChange={(e) => onChangeFilters({ source: e.target.value })}
          >
            <option value="all">
              {isSavedTab
                ? `All profiles (${savedTotalCount})`
                : `All collections (${totalCount})`}
            </option>
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
            {isSavedTab && <option value="recent">Recent</option>}
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
        {!isSavedTab && isLoadingIndex && (
          <div className="rl-empty-state">
            <span className="status-spinner" aria-hidden="true" />
            <span>Loading route library...</span>
          </div>
        )}

        {!isSavedTab && !isLoadingIndex && indexError && (
          <div className="rl-empty-state is-error">
            <span>Could not load route library: {indexError}</span>
          </div>
        )}

        {isSavedTab && savedTotalCount === 0 && (
          <div className="rl-empty-state">
            <p>No saved routes yet. Plan a route and click Save in the sidebar, or import a JSON backup.</p>
            <div className="rl-empty-actions">
              <button
                type="button"
                className="btn btn-outline btn-action-compact"
                onClick={() => importBackupInputRef.current?.click()}
              >
                <Icon name="upload" size={12} />
                <span>Import JSON backup</span>
              </button>
            </div>
          </div>
        )}

        {((!isSavedTab && !isLoadingIndex && !indexError) ||
          (isSavedTab && savedTotalCount > 0)) &&
          filteredRoutes.length === 0 && (
            <div className="rl-empty-state">
              <p>No routes match these filters.</p>
              <div className="rl-empty-actions">
                {filters.inMapView && (
                  <button
                    type="button"
                    className="btn btn-outline btn-action-compact"
                    onClick={() => onChangeFilters({ inMapView: false })}
                  >
                    {isSavedTab ? 'Show all saved routes' : 'Search all UK and Ireland'}
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

        {(isSavedTab || (!isLoadingIndex && !indexError)) && filteredRoutes.length > 0 && (
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
          const savedRec = isSavedTab ? savedRoutesById?.get(route.id) : undefined;
          const isEditingThis = isSavedTab && editingRouteId === route.id;
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
                if (e.target !== e.currentTarget) return;
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

                  {isEditingThis ? (
                    <form
                      className="rl-edit-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        commitEditingRoute(route.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          e.stopPropagation();
                          setEditingRouteId(null);
                        }
                      }}
                    >
                      <input
                        ref={editNameInputRef}
                        id="input-saved-rename"
                        type="text"
                        className="rl-edit-input"
                        value={editName}
                        placeholder="Route name"
                        aria-label="Route name"
                        onChange={(e) => setEditName(e.target.value)}
                      />
                      <input
                        id="input-saved-notes"
                        type="text"
                        className="rl-edit-input"
                        value={editNotes}
                        placeholder="Optional note"
                        aria-label="Route note"
                        onChange={(e) => setEditNotes(e.target.value)}
                      />
                      <div className="rl-edit-actions">
                        <button
                          type="submit"
                          className="btn btn-primary btn-action-compact rl-edit-btn"
                          disabled={!editName.trim()}
                        >
                          <span>Save</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-outline btn-action-compact rl-edit-btn"
                          onClick={() => setEditingRouteId(null)}
                        >
                          <span>Cancel</span>
                        </button>
                      </div>
                    </form>
                  ) : (
                    route.desc && <p className="rl-card-desc">{route.desc}</p>
                  )}

                  {route.stops && route.stops.length > 0 && (
                    <div className="rl-stops-block">
                      <span className="rl-stops-heading">
                        {isSavedTab ? 'Waypoints' : 'Stops along route'}
                      </span>
                      <div className="rl-stops-list">
                        {route.stops.map((stop, sIdx) => {
                          const kindLabel = stop.kind ? STOP_KIND_LABELS[stop.kind] : undefined;
                          const canFly = Boolean(stop.pos && onFlyTo);
                          return canFly ? (
                            <button
                              key={sIdx}
                              type="button"
                              className="rl-stop-pill is-clickable"
                              title="Zoom to point on map"
                              onClick={() => onFlyTo?.(stop.pos![0], stop.pos![1], 14)}
                            >
                              {kindLabel && <span className="rl-stop-kind">{kindLabel}:</span>}
                              <span>{stop.name}</span>
                              {stop.role && <span className="rl-stop-role">({stop.role})</span>}
                            </button>
                          ) : (
                            <span key={sIdx} className="rl-stop-pill">
                              {kindLabel && <span className="rl-stop-kind">{kindLabel}:</span>}
                              <span>{stop.name}</span>
                              {stop.role && <span className="rl-stop-role">({stop.role})</span>}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {isSavedTab ? (
                    <div className="rl-attribution-row">
                      <span className="rl-attribution-text">
                        {savedRec
                          ? `Saved ${formatShortDate(savedRec.updatedAt)} · ${savedRec.waypoints.length} pts${savedRec.avoidAreas.length > 0 ? ` · ${savedRec.avoidAreas.length} avoid` : ''}`
                          : formatShortDate(route.updatedAt)}
                      </span>
                      <div className="rl-saved-meta-actions">
                        {!isEditingThis && onRenameSavedRoute && (
                          <button
                            id={`btn-saved-rename-${route.id}`}
                            type="button"
                            className="rl-inline-btn"
                            onClick={() => startEditingRoute(route)}
                          >
                            Edit
                          </button>
                        )}
                        {onDeleteSavedRoute && (
                          <button
                            id={`btn-saved-delete-${route.id}`}
                            type="button"
                            className="rl-inline-btn is-danger"
                            onClick={() => onDeleteSavedRoute(route.id)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
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
                  )}

                  <div className="rl-card-actions">
                    <button
                      id="btn-library-load-route"
                      type="button"
                      className="btn btn-primary btn-action-compact rl-btn-open"
                      disabled={isRoutingBusy || busyRouteAction !== null}
                      title={
                        isSavedTab
                          ? 'Restore exact waypoints, avoid areas, and profile into the planner'
                          : 'Snap this route onto the road network with editable waypoints and surface breakdown'
                      }
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
