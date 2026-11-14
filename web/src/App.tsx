import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type maplibregl from 'maplibre-gl';
import type { SegmentHighlight } from './utils/classification.ts';
import { MAX_ROUTES } from './types.ts';
import type { SuggestionDimLevel } from './utils/map-layers.ts';
import {
  fetchLibraryIndex,
  filterAndSortLibraryRoutes,
  HOVER_FALLBACK_COLOR,
  libraryTrackToGpx,
  loadLibraryRouteCoordinates,
  routeIntersectsBounds,
  SUGGESTION_COLORS,
  TOP_SUGGESTION_COUNT,
  type LibraryFilterState,
  type LibraryIndex,
  type LibraryRoute,
  type MapBoundsBox,
  type PreviewLibraryRoute,
  type SuggestedLibraryTrack,
} from './utils/route-library.ts';
import { PopoverProvider } from './components/TooltipPopover.tsx';
import { MapView } from './components/MapView.tsx';
import { ControlsPanel } from './components/ControlsPanel.tsx';
import { RouteLibraryPanel } from './components/RouteLibraryPanel.tsx';
import { RouteInfoDrawer } from './components/RouteInfoDrawer.tsx';
import { SettingsSection } from './components/SettingsSection.tsx';
import { AboutModal } from './components/AboutModal.tsx';
import { useRouting } from './hooks/useRouting.ts';
import { useOffline } from './hooks/useOffline.ts';
import { useSettings } from './hooks/useSettings.ts';
import { useMcpBridge } from './mcp-bridge.ts';

export const App: React.FC = () => {
  const mapInstanceRef = useRef<maplibregl.Map | null>(null);

  const settings = useSettings();

  const offline = useOffline(
    (recompute) => routing.clearWorkerGraph(recompute),
    (msg) => routing.setStatus(msg),
  );

  const routing = useRouting(offline.isOfflineMode);

  // Responsive drawer states
  const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 860px)').matches;
  const [isControlsCollapsed, setIsControlsCollapsed] = useState<boolean>(false);
  const [isProfileEditorOpen, setIsProfileEditorOpen] = useState<boolean>(false);
  const [isRouteLibraryOpen, setIsRouteLibraryOpen] = useState<boolean>(false);
  const [isRouteInfoCollapsed, setIsRouteInfoCollapsed] = useState<boolean>(isMobile);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isAboutOpen, setIsAboutOpen] = useState<boolean>(false);
  const [hoverPosition, setHoverPosition] = useState<{ lat: number; lon: number } | null>(null);
  const [segmentHighlight, setSegmentHighlight] = useState<SegmentHighlight | null>(null);
  const [editingWaypointIndex, setEditingWaypointIndex] = useState<number | null>(null);

  // Route Library state (lazy-loaded on first open)
  const [libraryIndex, setLibraryIndex] = useState<LibraryIndex | null>(null);
  const [isLoadingLibrary, setIsLoadingLibrary] = useState<boolean>(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryFilters, setLibraryFilters] = useState<LibraryFilterState>({
    query: '',
    inMapView: true,
    surface: 'all',
    distance: 'all',
    shape: 'all',
    source: 'all',
    sort: 'nearby',
  });
  const [selectedLibraryRouteId, setSelectedLibraryRouteId] = useState<number | null>(null);
  const [hoveredLibraryRoute, setHoveredLibraryRoute] = useState<LibraryRoute | null>(null);
  const [suggestedLibraryTracks, setSuggestedLibraryTracks] = useState<SuggestedLibraryTrack[]>([]);
  const [activeLibraryPreview, setActiveLibraryPreview] = useState<PreviewLibraryRoute | null>(
    null,
  );
  const [isPreviewLoading, setIsPreviewLoading] = useState<boolean>(false);
  const [frameLibraryPreviewSeq, setFrameLibraryPreviewSeq] = useState<number>(0);
  const [mapBounds, setMapBounds] = useState<MapBoundsBox | null>(null);
  const [mapCenter, setMapCenter] = useState<{ lat: number; lon: number }>({
    lat: 54.5,
    lon: -4.5,
  });
  const previewReqSeqRef = useRef<number>(0);

  useEffect(() => {
    if (!isRouteLibraryOpen || libraryIndex || isLoadingLibrary) return;
    setIsLoadingLibrary(true);
    setLibraryError(null);
    fetchLibraryIndex()
      .then((idx) => {
        setLibraryIndex(idx);
      })
      .catch((err: any) => {
        setLibraryError(err?.message || String(err));
      })
      .finally(() => {
        setIsLoadingLibrary(false);
      });
  }, [isRouteLibraryOpen, libraryIndex, isLoadingLibrary]);

  const sourceNamesBySlug = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of libraryIndex?.sources || []) m.set(s.slug, s.name);
    return m;
  }, [libraryIndex]);

  const isRouteLibraryOpenRef = useRef<boolean>(isRouteLibraryOpen);
  isRouteLibraryOpenRef.current = isRouteLibraryOpen;

  const filteredLibraryRoutes = useMemo(() => {
    if (!isRouteLibraryOpen || !libraryIndex) return [];
    return filterAndSortLibraryRoutes(
      libraryIndex.routes,
      sourceNamesBySlug,
      libraryFilters,
      mapBounds,
      mapCenter,
    );
  }, [isRouteLibraryOpen, libraryIndex, sourceNamesBySlug, libraryFilters, mapBounds, mapCenter]);

  const topFiveRoutes = useMemo(
    () => (isRouteLibraryOpen ? filteredLibraryRoutes.slice(0, TOP_SUGGESTION_COUNT) : []),
    [isRouteLibraryOpen, filteredLibraryRoutes],
  );
  const topFiveKey = useMemo(() => topFiveRoutes.map((r) => r.id).join(','), [topFiveRoutes]);

  // Dynamically load the Top 5 suggested tracks for the current map view / filter state
  useEffect(() => {
    if (!isRouteLibraryOpen || topFiveRoutes.length === 0) {
      setSuggestedLibraryTracks([]);
      return;
    }
    let cancelled = false;
    Promise.all(
      topFiveRoutes.map(async (route, idx) => {
        const coordinates = await loadLibraryRouteCoordinates(route);
        return {
          rank: idx + 1,
          route,
          coordinates,
          color: SUGGESTION_COLORS[idx % SUGGESTION_COLORS.length],
        };
      }),
    )
      .then((tracks) => {
        if (!cancelled) setSuggestedLibraryTracks(tracks);
      })
      .catch((err: any) => {
        if (!cancelled) {
          routing.setStatus(`Could not load suggested routes: ${err?.message || String(err)}`, true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isRouteLibraryOpen, topFiveKey]);

  const selectedLibraryRoute = useMemo(
    () =>
      selectedLibraryRouteId !== null
        ? libraryIndex?.routes.find((r) => r.id === selectedLibraryRouteId) || null
        : null,
    [libraryIndex, selectedLibraryRouteId],
  );

  const focusedLibraryRoute = hoveredLibraryRoute ?? selectedLibraryRoute;

  // Resolve active preview track for whichever route is hovered (priority) or selected
  useEffect(() => {
    const seq = ++previewReqSeqRef.current;
    if (!isRouteLibraryOpen || !focusedLibraryRoute) {
      setActiveLibraryPreview(null);
      setIsPreviewLoading(false);
      return;
    }

    const source = libraryIndex?.sources.find((s) => s.slug === focusedLibraryRoute.src);
    const existingSuggestion = suggestedLibraryTracks.find(
      (t) => t.route.id === focusedLibraryRoute.id,
    );
    if (existingSuggestion) {
      setActiveLibraryPreview({
        route: existingSuggestion.route,
        source,
        coordinates: existingSuggestion.coordinates,
        color: existingSuggestion.color,
      });
      setIsPreviewLoading(false);
      return;
    }

    const rankIdx = topFiveRoutes.findIndex((r) => r.id === focusedLibraryRoute.id);
    const color =
      rankIdx >= 0 ? SUGGESTION_COLORS[rankIdx % SUGGESTION_COLORS.length] : HOVER_FALLBACK_COLOR;

    setIsPreviewLoading(focusedLibraryRoute.id === selectedLibraryRouteId);
    loadLibraryRouteCoordinates(focusedLibraryRoute)
      .then((coordinates) => {
        if (previewReqSeqRef.current !== seq) return;
        setActiveLibraryPreview({ route: focusedLibraryRoute, source, coordinates, color });
      })
      .catch((err: any) => {
        if (previewReqSeqRef.current !== seq) return;
        routing.setStatus(`Could not load route preview: ${err?.message || String(err)}`, true);
      })
      .finally(() => {
        if (previewReqSeqRef.current === seq) {
          setIsPreviewLoading(false);
        }
      });
  }, [
    isRouteLibraryOpen,
    focusedLibraryRoute,
    suggestedLibraryTracks,
    topFiveRoutes,
    libraryIndex,
    selectedLibraryRouteId,
  ]);

  const libraryDimLevel: SuggestionDimLevel = useMemo(() => {
    if (hoveredLibraryRoute) return 'strong';
    if (
      selectedLibraryRoute &&
      (!mapBounds || routeIntersectsBounds(selectedLibraryRoute, mapBounds))
    ) {
      return 'soft';
    }
    return 'none';
  }, [hoveredLibraryRoute, selectedLibraryRoute, mapBounds]);

  const handleSelectLibraryRoute = useCallback((route: LibraryRoute | null) => {
    if (!route) {
      setSelectedLibraryRouteId(null);
      setHoveredLibraryRoute(null);
      return;
    }
    setSelectedLibraryRouteId(route.id);
  }, []);

  const handleSelectLibraryRouteById = useCallback((routeId: number) => {
    setSelectedLibraryRouteId(routeId);
  }, []);

  const handleFrameLibraryRoute = useCallback(
    (route: LibraryRoute) => {
      setSelectedLibraryRouteId(route.id);
      if (activeLibraryPreview?.route.id === route.id && activeLibraryPreview.coordinates.length > 0) {
        setFrameLibraryPreviewSeq((s) => s + 1);
        return;
      }
      const source = libraryIndex?.sources.find((s) => s.slug === route.src);
      const rankIdx = topFiveRoutes.findIndex((r) => r.id === route.id);
      const color =
        rankIdx >= 0 ? SUGGESTION_COLORS[rankIdx % SUGGESTION_COLORS.length] : HOVER_FALLBACK_COLOR;
      loadLibraryRouteCoordinates(route)
        .then((coordinates) => {
          setActiveLibraryPreview({ route, source, coordinates, color });
          setFrameLibraryPreviewSeq((s) => s + 1);
        })
        .catch((err: any) => {
          routing.setStatus(`Could not load route preview: ${err?.message || String(err)}`, true);
        });
    },
    [activeLibraryPreview, libraryIndex, topFiveRoutes, routing],
  );

  const handleLoadLibraryRouteIntoPlanner = useCallback(
    async (route: LibraryRoute, mode: 'current' | 'new-route') => {
      const coords =
        activeLibraryPreview?.route.id === route.id
          ? activeLibraryPreview.coordinates
          : await loadLibraryRouteCoordinates(route);
      const srcName = sourceNamesBySlug.get(route.src);
      const gpx = libraryTrackToGpx(route, coords, srcName);
      if (mode === 'new-route') {
        routing.addRoute('empty');
      }
      setHoveredLibraryRoute(null);
      setIsRouteLibraryOpen(false);
      if (window.innerWidth <= 860) {
        setIsControlsCollapsed(true);
      }
      routing.importGpxContent(gpx, 25);
    },
    [activeLibraryPreview, sourceNamesBySlug, routing],
  );

  const handleMapViewportChange = useCallback(
    (bounds: MapBoundsBox, center: { lat: number; lon: number }) => {
      if (!isRouteLibraryOpenRef.current) return;
      setMapBounds(bounds);
      setMapCenter(center);
    },
    [],
  );

  // Auto-open route info drawer (and auto-collapse controls panel on mobile) when route is first computed
  const hadRouteRef = useRef<boolean>(false);
  useEffect(() => {
    setHoverPosition(null);
    setSegmentHighlight(null);
    const hasRoute = !!routing.currentRoute;
    if (hasRoute && !hadRouteRef.current) {
      setIsRouteInfoCollapsed(false);
      if (window.innerWidth <= 860) {
        setIsControlsCollapsed(true);
      }
    }
    hadRouteRef.current = hasRoute;
  }, [routing.currentRoute]);

  // Global undo/redo keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.matches('input, select, textarea')) return;

      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        routing.undo();
      } else if (
        ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'z') ||
        ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'y')
      ) {
        e.preventDefault();
        routing.redo();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [routing]);

  const handleFlyTo = useCallback((lon: number, lat: number, minZoom = 14) => {
    const map = mapInstanceRef.current;
    if (map) {
      map.flyTo({
        center: [lon, lat],
        zoom: Math.max(map.getZoom(), minZoom),
      });
    }
  }, []);

  const getMapCenter = useCallback(() => {
    const map = mapInstanceRef.current;
    if (map) {
      const c = map.getCenter();
      return { lat: c.lat, lon: c.lng };
    }
    return { lat: 54.5, lon: -4.5 };
  }, []);

  const handleRequestInlineRename = useCallback((index: number) => {
    setIsControlsCollapsed(false);
    setEditingWaypointIndex(index);
  }, []);

  const handleClearEditingWaypoint = useCallback(() => {
    setEditingWaypointIndex(null);
  }, []);

  const handleMapInstance = useCallback((map: maplibregl.Map) => {
    mapInstanceRef.current = map;
  }, []);

  useMcpBridge({
    mapRef: mapInstanceRef,
    routing,
    offline,
    settings,
    ui: {
      isControlsCollapsed,
      setIsControlsCollapsed,
      isProfileEditorOpen,
      setIsProfileEditorOpen,
      isRouteInfoCollapsed,
      setIsRouteInfoCollapsed,
      isSettingsOpen,
      setIsSettingsOpen,
      isAboutOpen,
      setIsAboutOpen,
      hoverPosition,
      setHoverPosition,
      segmentHighlight,
      setSegmentHighlight,
    },
  });

  return (
    <PopoverProvider>
      <ControlsPanel
        routing={routing}
        offline={offline}
        isCollapsed={isControlsCollapsed}
        onToggleCollapse={() => {
          setIsControlsCollapsed((prev) => {
            const next = !prev;
            if (!next && window.innerWidth <= 860) {
              setIsRouteInfoCollapsed(true);
            }
            return next;
          });
        }}
        isProfileEditorOpen={isProfileEditorOpen}
        onToggleProfileEditor={() => {
          setIsProfileEditorOpen((prev) => {
            const next = !prev;
            if (next) {
              setHoveredLibraryRoute(null);
              setIsRouteLibraryOpen(false);
            }
            return next;
          });
          setIsControlsCollapsed(false);
        }}
        isRouteLibraryOpen={isRouteLibraryOpen}
        onToggleRouteLibrary={() => {
          setIsRouteLibraryOpen((prev) => {
            const next = !prev;
            if (next) {
              setIsProfileEditorOpen(false);
              if (window.innerWidth <= 860) {
                setIsRouteInfoCollapsed(true);
              }
              const map = mapInstanceRef.current;
              if (map) {
                const b = map.getBounds();
                const c = map.getCenter();
                setMapBounds({
                  west: b.getWest(),
                  south: b.getSouth(),
                  east: b.getEast(),
                  north: b.getNorth(),
                });
                setMapCenter({ lat: c.lat, lon: c.lng });
              }
            } else {
              setHoveredLibraryRoute(null);
            }
            return next;
          });
          setIsControlsCollapsed(false);
        }}
        routeLibraryNode={
          <RouteLibraryPanel
            isLoadingIndex={isLoadingLibrary}
            indexError={libraryError}
            sources={libraryIndex?.sources || []}
            totalCount={libraryIndex?.routes.length || 0}
            filteredRoutes={filteredLibraryRoutes}
            filters={libraryFilters}
            onChangeFilters={(patch) =>
              setLibraryFilters((prev) => ({ ...prev, ...patch }))
            }
            selectedRouteId={selectedLibraryRouteId}
            hoveredRouteId={hoveredLibraryRoute?.id ?? null}
            isPreviewLoading={isPreviewLoading}
            onSelectRoute={handleSelectLibraryRoute}
            onHoverRoute={setHoveredLibraryRoute}
            onFrameRoute={handleFrameLibraryRoute}
            onLoadIntoPlanner={handleLoadLibraryRouteIntoPlanner}
            hasExistingWaypoints={routing.waypoints.length > 0}
            canAddRoute={routing.routeCount < MAX_ROUTES}
            isRoutingBusy={routing.isRouting}
            units={settings.units}
            onFlyTo={handleFlyTo}
            onClose={() => {
              setHoveredLibraryRoute(null);
              setIsRouteLibraryOpen(false);
            }}
          />
        }
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenAbout={() => setIsAboutOpen(true)}
        getMapCenter={getMapCenter}
        onFlyTo={handleFlyTo}
        editingWaypointIndex={editingWaypointIndex}
        onClearEditingWaypoint={handleClearEditingWaypoint}
      />

      <RouteInfoDrawer
        slots={routing.slots}
        activeSlotIdx={routing.activeSlotIdx}
        onSelectActiveSlot={routing.setActiveSlot}
        getProfileMeta={routing.getProfileMeta}
        statusMessage={routing.status}
        units={settings.units}
        onSelectSlotAlternative={routing.selectSlotAlternative}
        onRemoveSlot={routing.removeProfileSlot}
        isCollapsed={isRouteInfoCollapsed}
        onToggleCollapse={() => {
          setIsRouteInfoCollapsed((prev) => {
            const next = !prev;
            if (!next && window.innerWidth <= 860) {
              setIsControlsCollapsed(true);
            }
            return next;
          });
        }}
        hoverPosition={hoverPosition}
        onHoverPosition={setHoverPosition}
        onHighlightSegment={setSegmentHighlight}
        onFlyTo={handleFlyTo}
        onRemoveWaypoint={routing.removeWaypoint}
      />

      <MapView
        waypoints={routing.waypoints}
        avoidAreas={routing.avoidAreas}
        slots={routing.slots}
        activeSlotIdx={routing.activeSlotIdx}
        onSelectActiveSlot={routing.setActiveSlot}
        segmentHighlight={segmentHighlight}
        hoverPosition={hoverPosition}
        isOfflineMode={offline.isOfflineMode}
        basemap={settings.basemap}
        thunderforestKey={settings.thunderforestKey}
        fitBoundsSeq={routing.fitBoundsSeq}
        onAddWaypoint={routing.addWaypoint}
        onInsertWaypointAtLeg={routing.insertWaypointAtLeg}
        onMoveWaypoint={routing.moveWaypoint}
        onRemoveWaypoint={routing.removeWaypoint}
        onRenameWaypoint={routing.renameWaypoint}
        onRequestInlineRename={handleRequestInlineRename}
        onAddAvoidArea={routing.addAvoidArea}
        onRemoveAvoidArea={routing.removeAvoidArea}
        onUpdateAvoidAreaRadius={routing.updateAvoidAreaRadius}
        onHoverPosition={setHoverPosition}
        onHighlightSegment={setSegmentHighlight}
        onInspectPoint={routing.inspectPoint}
        onStatusChange={routing.setStatus}
        onMapInstance={handleMapInstance}
        isRouteLibraryOpen={isRouteLibraryOpen}
        suggestedLibraryTracks={suggestedLibraryTracks}
        activeLibraryPreview={activeLibraryPreview}
        libraryDimLevel={libraryDimLevel}
        frameLibraryPreviewSeq={frameLibraryPreviewSeq}
        onSelectLibraryRoute={handleSelectLibraryRouteById}
        onHoverLibraryRoute={setHoveredLibraryRoute}
        onMapViewportChange={handleMapViewportChange}
      />

      <SettingsSection
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        units={settings.units}
        onChangeUnits={settings.changeUnits}
        theme={settings.theme}
        onChangeTheme={settings.changeTheme}
        isOfflineMode={offline.isOfflineMode}
        onToggleOfflineMode={offline.setOfflineMode}
        bundleStatus={offline.bundleStatus}
        snapshotDate={offline.snapshotDate}
        downloadProgress={offline.downloadProgress}
        onDownloadOffline={offline.downloadBundle}
        onUpdateOffline={offline.updateBundle}
        onDeleteOffline={offline.deleteBundle}
        onRefreshOfflineStatus={offline.refreshStatus}
      />

      <AboutModal isOpen={isAboutOpen} onClose={() => setIsAboutOpen(false)} />
    </PopoverProvider>
  );
};
