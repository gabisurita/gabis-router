import React, { useEffect, useRef, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as pmtiles from 'pmtiles';
import { DEFAULT_AVOID_RADIUS_M } from '../hooks/useRouting.ts';
import {
  AVOID_RADIUS_PRESETS,
  waypointKind,
  waypointLabel,
  type AvoidArea,
  type LatLon,
  type PointWayInfo,
  type RouteSlotState,
} from '../types.ts';
import type { Basemap } from '../basemap.ts';
import type { SegmentHighlight } from '../utils/classification.ts';
import {
  extractRouteWarnings,
  WARNING_META,
  warningKindSvg,
} from '../utils/warnings.ts';
import { formatDistance } from '../format.ts';
import {
  getDemSource,
  getOfflineStyle,
  getOnlineStyle,
  registerCycleShieldImages,
  UK_CENTER,
  UK_BOUNDS,
} from '../utils/map-styles.ts';
import { tilePickerControl } from '../tile-picker.ts';
import { centerRouteControl } from '../center-control.ts';
import { legendControl } from '../legend-control.ts';
import { terrain3DControl } from '../terrain-control.ts';
import { loadedPMTiles, archivesReady } from '../hooks/useOffline.ts';
import {
  CYCLE_ROUTES_ARCHIVE,
  MAP_TILES_CACHE_NAME,
  isTileStrictlyInsideSegment,
  segmentsForTile,
} from '../segment-cache.ts';
import { getMapTileDownloadUrl } from '../platform.ts';
import {
  showMenu,
  hideMenu,
  menuClosedWithin,
  updateMenuHeader,
  appendMenuTags,
  type MenuItem,
} from '../menu.ts';
import { getCachedPlaceName, reverseGeocode } from '../geocoding.ts';
import { formatPointWayTags, summarizeVectorFeatures } from '../utils/feature-info.ts';
import { distanceMeters, legIndexAt, nearestVertex } from '../utils/geo.ts';
import {
  syncAvoidAreasLayer,
  syncRoutesLayers,
  syncHighlightLayer,
  syncLibraryLayers,
  fitRouteBounds,
  fitCoordinatesBounds,
  type SuggestionDimLevel,
} from '../utils/map-layers.ts';
import type {
  LibraryRoute,
  MapBoundsBox,
  PreviewLibraryRoute,
  SuggestedLibraryTrack,
} from '../utils/route-library.ts';

const remotePMTiles = new Map<string, pmtiles.PMTiles>();
const missingDevPMTiles = new Set<string>();
let devAvailableSegmentsPromise: Promise<Set<string> | null> | null = null;
let devCycleCacheBust = Date.now();

function getDevAvailableSegments(): Promise<Set<string> | null> {
  if (!import.meta.env.DEV) return Promise.resolve(null);
  if (!devAvailableSegmentsPromise) {
    devAvailableSegmentsPromise = fetch('/map-tiles/__available.json')
      .then(async (res) => {
        if (!res.ok) return null;
        const arr = await res.json();
        return Array.isArray(arr) ? new Set<string>(arr) : null;
      })
      .catch(() => null);
  }
  return devAvailableSegmentsPromise;
}

const OFM_PLANET_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const OFM_PLANET_FALLBACK_TEMPLATE =
  'https://tiles.openfreemap.org/planet/20261101_080013_pt/{z}/{x}/{y}.pbf';
let ofmPlanetTemplatePromise: Promise<string> | null = null;

function getOpenFreeMapTileTemplate(): Promise<string> {
  if (!ofmPlanetTemplatePromise) {
    ofmPlanetTemplatePromise = fetch(OFM_PLANET_TILEJSON_URL)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const tpl =
          Array.isArray(json?.tiles) && typeof json.tiles[0] === 'string' ? json.tiles[0] : null;
        if (!tpl) throw new Error('Missing tiles template');
        return tpl;
      })
      .catch(() => OFM_PLANET_FALLBACK_TEMPLATE);
  }
  return ofmPlanetTemplatePromise;
}

// Register PMTiles protocols
function registerProtocols() {
  remotePMTiles.clear();
  missingDevPMTiles.clear();
  devAvailableSegmentsPromise = null;
  devCycleCacheBust = Date.now();
  if ((window as any).__rsrouterProtocolsRegistered) return;
  (window as any).__rsrouterProtocolsRegistered = true;
  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  getDemSource();

  const getRemoteArchive = (segmentId: string): pmtiles.PMTiles => {
    let archive = remotePMTiles.get(segmentId);
    if (!archive) {
      const baseUrl = getMapTileDownloadUrl(segmentId);
      const url =
        import.meta.env.DEV && segmentId === CYCLE_ROUTES_ARCHIVE
          ? `${baseUrl}?v=${devCycleCacheBust}`
          : baseUrl;
      archive = new pmtiles.PMTiles(url);
      remotePMTiles.set(segmentId, archive);
    }
    return archive;
  };

  maplibregl.addProtocol('pmtiles-composite', async (params, abortController) => {
    const match = params.url.match(/pmtiles-composite:\/\/(\d+)\/(\d+)\/(\d+)\.pbf/);
    if (!match) return { data: new Uint8Array(0) };
    const z = parseInt(match[1], 10);
    const x = parseInt(match[2], 10);
    const y = parseInt(match[3], 10);

    await archivesReady;

    const candidateSegments = segmentsForTile(z, x, y);
    for (const seg of candidateSegments) {
      const local = loadedPMTiles.get(seg);
      if (local) {
        const tile = await local.getZxy(z, x, y);
        if (tile && tile.data) {
          return { data: tile.data };
        }
        if (isTileStrictlyInsideSegment(z, x, y, seg)) {
          return { data: new Uint8Array(0) };
        }
      }
    }

    for (const [seg, local] of loadedPMTiles.entries()) {
      if (candidateSegments.includes(seg)) continue;
      const tile = await local.getZxy(z, x, y);
      if (tile && tile.data) {
        return { data: tile.data };
      }
    }

    const isOffline = localStorage.getItem('rsrouter_offline_mode') === 'true';
    if (!isOffline) {
      const devAvailable = await getDevAvailableSegments();
      for (const seg of candidateSegments) {
        if (loadedPMTiles.has(seg) || missingDevPMTiles.has(seg)) continue;
        if (devAvailable && !devAvailable.has(seg)) continue;
        try {
          const tile = await getRemoteArchive(seg).getZxy(z, x, y, abortController?.signal);
          if (tile && tile.data) {
            return { data: tile.data };
          }
          if (isTileStrictlyInsideSegment(z, x, y, seg)) {
            return { data: new Uint8Array(0) };
          }
        } catch (err: any) {
          if (import.meta.env.DEV && !abortController?.signal.aborted && String(err).includes('404')) {
            missingDevPMTiles.add(seg);
          }
        }
      }

      if (!abortController?.signal.aborted && z <= 14) {
        try {
          const tpl = await getOpenFreeMapTileTemplate();
          const tileUrl = tpl
            .replace('{z}', String(z))
            .replace('{x}', String(x))
            .replace('{y}', String(y));
          const res = await fetch(tileUrl, {
            cache: 'force-cache',
            signal: abortController?.signal,
          });
          if (res.ok) {
            return { data: await res.arrayBuffer() };
          }
        } catch {
          // Ignore network/abort errors
        }
      }
    }

    return { data: new Uint8Array(0) };
  });

  maplibregl.addProtocol('pmtiles-cycle', async (params, abortController) => {
    const match = params.url.match(/pmtiles-cycle:\/\/(\d+)\/(\d+)\/(\d+)\.pbf/);
    if (!match) return { data: new Uint8Array(0) };
    const z = parseInt(match[1], 10);
    const x = parseInt(match[2], 10);
    const y = parseInt(match[3], 10);

    await archivesReady;

    const isOffline = localStorage.getItem('rsrouter_offline_mode') === 'true';
    const preferRemoteInDev = import.meta.env.DEV && !isOffline;

    if (!preferRemoteInDev) {
      const local = loadedPMTiles.get(CYCLE_ROUTES_ARCHIVE);
      if (local) {
        const tile = await local.getZxy(z, x, y);
        if (tile && tile.data) {
          return { data: tile.data };
        }
        return { data: new Uint8Array(0) };
      }
    }

    if (!isOffline) {
      try {
        const tile = await getRemoteArchive(CYCLE_ROUTES_ARCHIVE).getZxy(
          z,
          x,
          y,
          abortController?.signal,
        );
        if (tile && tile.data) {
          return { data: tile.data };
        }
      } catch {
        // Ignore network/abort errors
      }
    }

    return { data: new Uint8Array(0) };
  });

  maplibregl.addProtocol('offline-tile', async (params, abortController) => {
    const originalUrl = params.url.replace(/^offline-tile:\/\//, 'https://');
    const cache = await caches.open(MAP_TILES_CACHE_NAME);
    const cached = await cache.match(originalUrl);
    if (cached) return { data: await cached.arrayBuffer() };

    const isOffline = localStorage.getItem('rsrouter_offline_mode') === 'true';
    if (isOffline) return { data: new ArrayBuffer(0) };

    try {
      const res = await fetch(originalUrl, { signal: abortController.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await cache.put(originalUrl, res.clone());
      return { data: await res.arrayBuffer() };
    } catch {
      return { data: new ArrayBuffer(0) };
    }
  });
}

const LONG_PRESS_MS = 550;
const DRAG_THRESHOLD_PX = 8;

interface MapViewProps {
  waypoints: LatLon[];
  avoidAreas: AvoidArea[];
  slots: RouteSlotState[];
  activeSlotIdx?: number;
  onSelectActiveSlot?: (slotIdx: number) => void;
  segmentHighlight: SegmentHighlight | null;
  hoverPosition: { lat: number; lon: number } | null;
  isOfflineMode: boolean;
  basemap: Basemap;
  thunderforestKey: string;
  fitBoundsSeq: number;
  onAddWaypoint: (point: LatLon, action?: 'start' | 'end' | 'via' | 'append') => void;
  onInsertWaypointAtLeg: (point: LatLon, index: number, targetSlotIdx?: number) => void;
  onMoveWaypoint: (index: number, point: LatLon) => void;
  onRemoveWaypoint: (index: number) => void;
  onRenameWaypoint: (index: number, name: string) => void;
  onRequestInlineRename?: (index: number) => void;
  onAddAvoidArea: (area: LatLon, radius?: number) => void;
  onUpdateAvoidAreaRadius: (index: number, radius: number) => void;
  onRemoveAvoidArea: (index: number) => void;
  onHoverPosition?: (pos: { lat: number; lon: number } | null) => void;
  onHighlightSegment?: (highlight: SegmentHighlight | null) => void;
  onInspectPoint?: (
    lon: number,
    lat: number,
    maxDistanceM?: number,
  ) => Promise<PointWayInfo | null>;
  onStatusChange: (status: string) => void;
  onMapInstance?: (map: maplibregl.Map) => void;
  isRouteLibraryOpen?: boolean;
  suggestedLibraryTracks?: SuggestedLibraryTrack[];
  activeLibraryPreview?: PreviewLibraryRoute | null;
  libraryDimLevel?: SuggestionDimLevel;
  frameLibraryPreviewSeq?: number;
  onSelectLibraryRoute?: (routeId: number) => void;
  onHoverLibraryRoute?: (route: LibraryRoute | null) => void;
  onMapViewportChange?: (bounds: MapBoundsBox, center: { lat: number; lon: number }) => void;
}

export const MapView: React.FC<MapViewProps> = ({
  waypoints,
  avoidAreas,
  slots,
  activeSlotIdx = 0,
  onSelectActiveSlot,
  segmentHighlight,
  hoverPosition,
  isOfflineMode,
  basemap,
  thunderforestKey,
  fitBoundsSeq,
  onAddWaypoint,
  onInsertWaypointAtLeg,
  onMoveWaypoint,
  onRemoveWaypoint,
  onRenameWaypoint,
  onRequestInlineRename,
  onAddAvoidArea,
  onUpdateAvoidAreaRadius,
  onRemoveAvoidArea,
  onHoverPosition,
  onHighlightSegment,
  onInspectPoint,
  onStatusChange,
  onMapInstance,
  isRouteLibraryOpen = false,
  suggestedLibraryTracks = [],
  activeLibraryPreview = null,
  libraryDimLevel = 'none',
  frameLibraryPreviewSeq = 0,
  onSelectLibraryRoute,
  onHoverLibraryRoute,
  onMapViewportChange,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const styleReadyRef = useRef<boolean>(false);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const warningMarkersRef = useRef<maplibregl.Marker[]>([]);
  const libraryRankMarkersRef = useRef<Array<{ routeId: number; marker: maplibregl.Marker }>>([]);
  const hoverMarkerRef = useRef<maplibregl.Marker | null>(null);
  const draggingMarkerIndexRef = useRef<number | null>(null);
  const lastOpenedMarkerIndexRef = useRef<number | null>(null);

  const waypointsRef = useRef(waypoints);
  waypointsRef.current = waypoints;
  const avoidAreasRef = useRef(avoidAreas);
  avoidAreasRef.current = avoidAreas;
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const activeSlotIdxRef = useRef(activeSlotIdx);
  activeSlotIdxRef.current = activeSlotIdx;
  const onSelectActiveSlotRef = useRef(onSelectActiveSlot);
  onSelectActiveSlotRef.current = onSelectActiveSlot;

  const onAddWaypointRef = useRef(onAddWaypoint);
  onAddWaypointRef.current = onAddWaypoint;
  const onInsertWaypointAtLegRef = useRef(onInsertWaypointAtLeg);
  onInsertWaypointAtLegRef.current = onInsertWaypointAtLeg;
  const onMoveWaypointRef = useRef(onMoveWaypoint);
  onMoveWaypointRef.current = onMoveWaypoint;
  const onRemoveWaypointRef = useRef(onRemoveWaypoint);
  onRemoveWaypointRef.current = onRemoveWaypoint;
  const onRenameWaypointRef = useRef(onRenameWaypoint);
  onRenameWaypointRef.current = onRenameWaypoint;
  const onRequestInlineRenameRef = useRef(onRequestInlineRename);
  onRequestInlineRenameRef.current = onRequestInlineRename;
  const onAddAvoidAreaRef = useRef(onAddAvoidArea);
  onAddAvoidAreaRef.current = onAddAvoidArea;
  const onUpdateAvoidAreaRadiusRef = useRef(onUpdateAvoidAreaRadius);
  onUpdateAvoidAreaRadiusRef.current = onUpdateAvoidAreaRadius;
  const onRemoveAvoidAreaRef = useRef(onRemoveAvoidArea);
  onRemoveAvoidAreaRef.current = onRemoveAvoidArea;
  const onHoverPositionRef = useRef(onHoverPosition);
  onHoverPositionRef.current = onHoverPosition;
  const onHighlightSegmentRef = useRef(onHighlightSegment);
  onHighlightSegmentRef.current = onHighlightSegment;
  const onInspectPointRef = useRef(onInspectPoint);
  onInspectPointRef.current = onInspectPoint;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const onMapInstanceRef = useRef(onMapInstance);
  onMapInstanceRef.current = onMapInstance;
  const isRouteLibraryOpenRef = useRef(isRouteLibraryOpen);
  isRouteLibraryOpenRef.current = isRouteLibraryOpen;
  const suggestedLibraryTracksRef = useRef(suggestedLibraryTracks);
  suggestedLibraryTracksRef.current = suggestedLibraryTracks;
  const activeLibraryPreviewRef = useRef(activeLibraryPreview);
  activeLibraryPreviewRef.current = activeLibraryPreview;
  const libraryDimLevelRef = useRef(libraryDimLevel);
  libraryDimLevelRef.current = libraryDimLevel;
  const onSelectLibraryRouteRef = useRef(onSelectLibraryRoute);
  onSelectLibraryRouteRef.current = onSelectLibraryRoute;
  const onHoverLibraryRouteRef = useRef(onHoverLibraryRoute);
  onHoverLibraryRouteRef.current = onHoverLibraryRoute;
  const onMapViewportChangeRef = useRef(onMapViewportChange);
  onMapViewportChangeRef.current = onMapViewportChange;

  const pendingFitRouteRef = useRef<boolean>(false);

  const insertDragRef = useRef<{
    slotIdx: number;
    leg: number;
    startPoint: { x: number; y: number };
    ghost: maplibregl.Marker | null;
    hasDragged: boolean;
  } | null>(null);

  const suppressClickUntilRef = useRef<number>(0);

  const drawAllLayers = useCallback(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    syncAvoidAreasLayer(map, avoidAreasRef.current);
    syncRoutesLayers(map, slotsRef.current, activeSlotIdxRef.current);
    syncHighlightLayer(map, segmentHighlight);
    syncLibraryLayers(
      map,
      isRouteLibraryOpenRef.current,
      suggestedLibraryTracksRef.current,
      activeLibraryPreviewRef.current ?? null,
      libraryDimLevelRef.current,
    );
  }, [segmentHighlight]);

  // Map initialization
  useEffect(() => {
    if (!containerRef.current) return;
    registerProtocols();

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: isOfflineMode ? getOfflineStyle(basemap) : getOnlineStyle(basemap, thunderforestKey),
      center: UK_CENTER,
      zoom: 6,
      maxBounds: isOfflineMode ? UK_BOUNDS : undefined,
      attributionControl: false,
      preserveDrawingBuffer: Boolean(import.meta.env.DEV),
    });
    mapRef.current = map;
    (window as any).map = map;

    map.addControl(
      new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }),
      'top-right',
    );
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showAccuracyCircle: true,
      }),
      'top-right',
    );
    map.addControl(tilePickerControl, 'top-right');
    tilePickerControl.setOffline(isOfflineMode);
    map.addControl(legendControl, 'top-right');
    map.addControl(terrain3DControl, 'top-right');
    terrain3DControl.setOffline(isOfflineMode);
    map.addControl(centerRouteControl, 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');

    centerRouteControl.setOnCenter(() => {
      const currentMap = mapRef.current;
      if (!currentMap) return;
      fitRouteBounds(currentMap, slotsRef.current, waypointsRef.current, true);
    });

    onMapInstanceRef.current?.(map);

    const onStyleLoad = () => {
      styleReadyRef.current = true;
      registerCycleShieldImages(map);
      drawAllLayers();
      terrain3DControl.syncWithStyle(map);
      if (pendingFitRouteRef.current) {
        pendingFitRouteRef.current = false;
        fitRouteBounds(map, slotsRef.current, waypointsRef.current, false);
      }
    };
    map.on('style.load', onStyleLoad);
    (map as any)._renderTaskQueue?.run?.();
    if (map.isStyleLoaded() || (map as any).style?._loaded) {
      onStyleLoad();
    }

    map.on('error', (e) => {
      const err = e.error;
      const msg = (err && (err.message || String(err))) || '';
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (/signal is aborted/i.test(msg) || /aborted/i.test(msg)) return;
      if (err && typeof err === 'object' && ('status' in err || /403|401|404/i.test(msg))) return;
      console.warn('[Map notice]', err);
    });

    map.on('styleimagemissing', (e) => {
      if (e.id.startsWith('cycle-shield-') || e.id.startsWith('scenery-pattern-')) {
        registerCycleShieldImages(map);
        return;
      }
      if (!map.hasImage(e.id)) {
        map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
      }
    });

    // Gesture & Click handling
    let singleClickTimer: ReturnType<typeof setTimeout> | undefined;
    let pressTimer: ReturnType<typeof setTimeout> | undefined;

    const clearSingleClick = () => {
      if (singleClickTimer) {
        clearTimeout(singleClickTimer);
        singleClickTimer = undefined;
      }
    };

    const cancelPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = undefined;
      }
    };

    const findAvoidAreaAt = (p: LatLon, screenPoint?: { x: number; y: number }): number => {
      const currentAvoids = avoidAreasRef.current;
      if (screenPoint) {
        for (let i = currentAvoids.length - 1; i >= 0; i--) {
          const pt = map.project([currentAvoids[i].lon, currentAvoids[i].lat]);
          if (Math.hypot(pt.x - screenPoint.x, pt.y - screenPoint.y) <= 14) return i;
        }
      }
      for (let i = currentAvoids.length - 1; i >= 0; i--) {
        if (distanceMeters(p, currentAvoids[i]) <= Math.max(currentAvoids[i].radius, 18)) return i;
      }
      return -1;
    };

    const copyCoords = async (p: LatLon) => {
      const text = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
      try {
        await navigator.clipboard.writeText(text);
        onStatusChangeRef.current(`Copied ${text}`);
      } catch (err: any) {
        onStatusChangeRef.current(`Could not copy: ${err?.message || String(err)}`);
      }
    };

    const openStreetView = (p: LatLon) => {
      window.open(
        `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat.toFixed(6)},${p.lon.toFixed(6)}`,
        '_blank',
        'noopener,noreferrer',
      );
    };

    const openOpenStreetMap = (p: LatLon) => {
      const lat = p.lat.toFixed(6);
      const lon = p.lon.toFixed(6);
      window.open(
        `https://www.openstreetmap.org/query?lat=${lat}&lon=${lon}#map=18/${lat}/${lon}`,
        '_blank',
        'noopener,noreferrer',
      );
    };

    const inspectFeaturesAt = (screenPoint?: { x: number; y: number }) => {
      if (!screenPoint) return {};
      try {
        const r = 6;
        const bbox: [[number, number], [number, number]] = [
          [screenPoint.x - r, screenPoint.y - r],
          [screenPoint.x + r, screenPoint.y + r],
        ];
        const rendered = map.queryRenderedFeatures(bbox);
        return summarizeVectorFeatures(rendered);
      } catch {
        return {};
      }
    };

    const showMapContextMenu = (
      p: LatLon,
      x: number,
      y: number,
      screenPoint?: { x: number; y: number },
    ) => {
      lastOpenedMarkerIndexRef.current = null;
      const wps = waypointsRef.current;
      const featureInfo = inspectFeaturesAt(screenPoint);
      let resolvedName = getCachedPlaceName(p.lat, p.lon);
      const coordHeader = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
      const pointWithCachedName = (): LatLon => {
        const bestName = resolvedName || featureInfo.primaryName;
        return bestName ? { ...p, name: bestName } : p;
      };

      const items: MenuItem[] = [
        {
          label: 'Add point',
          hint: wps.length === 0 ? 'Start' : wps.length === 1 ? 'End' : 'Along route',
          onSelect: () =>
            onAddWaypointRef.current(pointWithCachedName(), wps.length >= 2 ? 'via' : 'append'),
        },
        {
          label: 'Start here',
          hint: 'A',
          onSelect: () => onAddWaypointRef.current(pointWithCachedName(), 'start'),
        },
        {
          label: 'Via here',
          onSelect: () => onAddWaypointRef.current(pointWithCachedName(), 'via'),
        },
        {
          label: 'End here',
          hint: 'B',
          onSelect: () => onAddWaypointRef.current(pointWithCachedName(), 'append'),
        },
      ];

      items.push(
        {
          label: 'Avoid here',
          hint: `${DEFAULT_AVOID_RADIUS_M} m`,
          dividerBefore: true,
          onSelect: () => onAddAvoidAreaRef.current(p, DEFAULT_AVOID_RADIUS_M),
        },
        {
          label: 'See on Google Street View',
          dividerBefore: true,
          onSelect: () => openStreetView(p),
        },
        {
          label: 'See on OpenStreetMap',
          onSelect: () => openOpenStreetMap(p),
        },
        {
          label: 'Copy coordinates',
          onSelect: () => copyCoords(p),
        },
      );

      const session = showMenu(items, x, y, {
        title: resolvedName || coordHeader,
        subtitle:
          resolvedName &&
          featureInfo.subtitle &&
          resolvedName.toLowerCase().includes(featureInfo.subtitle.toLowerCase())
            ? undefined
            : featureInfo.subtitle,
        badges: featureInfo.badges,
        tags: featureInfo.tags,
      });

      if (!resolvedName) {
        reverseGeocode(p.lat, p.lon).then((name) => {
          if (name) {
            resolvedName = name;
            updateMenuHeader(name, session);
          }
        });
      }

      onInspectPointRef.current?.(p.lon, p.lat)?.then((wayInfo) => {
        const extraTags = formatPointWayTags(wayInfo, featureInfo.tags);
        if (extraTags.length > 0) {
          appendMenuTags(extraTags, session);
        }
      });
    };

    const showAvoidContextMenu = (index: number, x: number, y: number) => {
      lastOpenedMarkerIndexRef.current = null;
      const area = avoidAreasRef.current[index];
      if (!area) return;
      const items: MenuItem[] = [
        ...AVOID_RADIUS_PRESETS.map((r) => ({
          label: `Radius: ${r} m`,
          active: Math.round(area.radius) === r,
          hint: Math.round(area.radius) === r ? 'Active' : undefined,
          onSelect: () => onUpdateAvoidAreaRadiusRef.current(index, r),
        })),
        {
          label: 'Remove avoid area',
          danger: true,
          dividerBefore: true,
          onSelect: () => onRemoveAvoidAreaRef.current(index),
        },
        {
          label: 'See on Google Street View',
          dividerBefore: true,
          onSelect: () => openStreetView(area),
        },
        {
          label: 'See on OpenStreetMap',
          onSelect: () => openOpenStreetMap(area),
        },
        {
          label: 'Copy coordinates',
          onSelect: () => copyCoords(area),
        },
      ];
      showMenu(items, x, y, `Avoid area (${Math.round(area.radius)} m)`);
    };

    const emitViewport = () => {
      if (!isRouteLibraryOpenRef.current || !onMapViewportChangeRef.current) return;
      const b = map.getBounds();
      const c = map.getCenter();
      onMapViewportChangeRef.current(
        {
          west: b.getWest(),
          south: b.getSouth(),
          east: b.getEast(),
          north: b.getNorth(),
        },
        { lat: c.lat, lon: c.lng },
      );
    };
    map.on('moveend', emitViewport);
    emitViewport();

    map.on('click', (e) => {
      if (
        draggingMarkerIndexRef.current !== null ||
        performance.now() < suppressClickUntilRef.current ||
        menuClosedWithin(300)
      ) {
        return;
      }
      if ((e.originalEvent as MouseEvent)?.detail > 1) {
        clearSingleClick();
        return;
      }
      if (isRouteLibraryOpenRef.current) {
        const queryLayers = ['library-preview-line', 'library-suggestions-hit'].filter((id) =>
          Boolean(map.getLayer(id)),
        );
        if (queryLayers.length > 0) {
          const hitBox: [[number, number], [number, number]] = [
            [e.point.x - 5, e.point.y - 5],
            [e.point.x + 5, e.point.y + 5],
          ];
          const hits = map.queryRenderedFeatures(hitBox, { layers: queryLayers });
          const hitId = Number(hits[0]?.properties?.id);
          if (Number.isFinite(hitId) && hitId > 0) {
            clearSingleClick();
            hideMenu();
            onSelectLibraryRouteRef.current?.(hitId);
            return;
          }
        }
      }
      clearSingleClick();
      singleClickTimer = setTimeout(() => {
        singleClickTimer = undefined;
        if (
          draggingMarkerIndexRef.current !== null ||
          performance.now() < suppressClickUntilRef.current ||
          menuClosedWithin(300)
        ) {
          return;
        }
        const p = { lat: e.lngLat.lat, lon: e.lngLat.lng };
        const avoidIdx = findAvoidAreaAt(p, e.point);
        if (avoidIdx !== -1) {
          showAvoidContextMenu(avoidIdx, e.originalEvent.clientX, e.originalEvent.clientY);
        } else {
          showMapContextMenu(p, e.originalEvent.clientX, e.originalEvent.clientY, e.point);
        }
      }, 220);
    });

    map.on('dblclick', () => {
      clearSingleClick();
      hideMenu();
    });

    map.on('contextmenu', (e) => {
      clearSingleClick();
      e.originalEvent.preventDefault();
      const p = { lat: e.lngLat.lat, lon: e.lngLat.lng };
      const avoidIdx = findAvoidAreaAt(p, e.point);
      if (avoidIdx !== -1) {
        showAvoidContextMenu(avoidIdx, e.originalEvent.clientX, e.originalEvent.clientY);
      } else {
        showMapContextMenu(p, e.originalEvent.clientX, e.originalEvent.clientY, e.point);
      }
    });

    map.on('movestart', () => {
      clearSingleClick();
      cancelPress();
      hideMenu();
    });

    // Touch long-press
    map.on('touchstart', (e) => {
      clearSingleClick();
      cancelPress();
      if (e.points.length > 1 || (e.originalEvent.touches && e.originalEvent.touches.length > 1)) {
        suppressClickUntilRef.current = performance.now() + 600;
        if (insertDragRef.current) {
          insertDragRef.current.ghost?.remove();
          insertDragRef.current = null;
          map.getCanvas().style.cursor = '';
        }
        return;
      }
      if ((e.originalEvent.target as HTMLElement)?.closest('.wp-marker, .warning-map-marker')) return;
      const touch = e.originalEvent.touches[0];
      pressTimer = setTimeout(() => {
        suppressClickUntilRef.current = performance.now() + 500;
        if (insertDragRef.current) {
          insertDragRef.current.ghost?.remove();
          insertDragRef.current = null;
        }
        const p = { lat: e.lngLat.lat, lon: e.lngLat.lng };
        const avoidIdx = findAvoidAreaAt(p, e.point);
        if (avoidIdx !== -1) {
          showAvoidContextMenu(avoidIdx, touch.clientX, touch.clientY);
        } else {
          showMapContextMenu(p, touch.clientX, touch.clientY, e.point);
        }
      }, LONG_PRESS_MS);
    });

    map.on('touchmove', cancelPress);
    map.on('touchend', cancelPress);
    map.on('touchcancel', cancelPress);

    const cancelInsert = () => {
      if (!insertDragRef.current) return;
      insertDragRef.current.ghost?.remove();
      insertDragRef.current = null;
      map.getCanvas().style.cursor = '';
    };

    const findClosestRoute = (
      lng: number,
      lat: number,
    ): { coords: number[][]; slotIdx: number } | undefined => {
      let bestCoords: number[][] | undefined;
      let bestSlotIdx = activeSlotIdxRef.current;
      let bestDistSq = Infinity;
      slotsRef.current.forEach((slot, slotIdx) => {
        const coords = (
          slot.route?.features[0]?.geometry as GeoJSON.LineString | undefined
        )?.coordinates;
        if (!coords || coords.length === 0) return;
        const idx = nearestVertex(coords, lng, lat);
        const dx = coords[idx][0] - lng;
        const dy = coords[idx][1] - lat;
        const dSq = dx * dx + dy * dy;
        if (
          dSq < bestDistSq ||
          (Math.abs(dSq - bestDistSq) < 1e-12 && slotIdx === activeSlotIdxRef.current)
        ) {
          bestDistSq = dSq;
          bestCoords = coords;
          bestSlotIdx = slotIdx;
        }
      });
      return bestCoords ? { coords: bestCoords, slotIdx: bestSlotIdx } : undefined;
    };

    // Route dragging insert logic
    const beginInsert = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      if (draggingMarkerIndexRef.current !== null) return;
      const orig = e.originalEvent;
      if ('touches' in orig && orig.touches.length > 1) return;
      if (orig instanceof MouseEvent && orig.button !== 0) return;
      if ((orig.target as HTMLElement)?.closest('.wp-marker, .warning-map-marker')) return;
      const found = findClosestRoute(e.lngLat.lng, e.lngLat.lat);
      if (!found) return;
      const slotWps = slotsRef.current[found.slotIdx]?.waypoints || waypointsRef.current;
      const leg = legIndexAt(found.coords, slotWps, e.lngLat.lng, e.lngLat.lat);
      if (leg < 0) return;
      e.preventDefault();
      insertDragRef.current = {
        slotIdx: found.slotIdx,
        leg,
        startPoint: { x: e.point.x, y: e.point.y },
        ghost: null,
        hasDragged: false,
      };
    };

    const moveInsert = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      if (draggingMarkerIndexRef.current !== null) return;
      const drag = insertDragRef.current;
      if (!drag) return;
      if ('touches' in e.originalEvent && e.originalEvent.touches.length > 1) {
        cancelInsert();
        return;
      }
      if (!drag.hasDragged) {
        const dx = e.point.x - drag.startPoint.x;
        const dy = e.point.y - drag.startPoint.y;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        drag.hasDragged = true;
        cancelPress();
        clearSingleClick();
        onHoverPositionRef.current?.(null);
        map.getCanvas().style.cursor = 'grabbing';
        const el = document.createElement('div');
        el.className = 'wp-marker ghost';
        el.textContent = '+';
        drag.ghost = new maplibregl.Marker({ element: el }).setLngLat(e.lngLat).addTo(map);
        return;
      }
      drag.ghost?.setLngLat(e.lngLat);
    };

    const finishInsert = () => {
      const drag = insertDragRef.current;
      if (!drag) return;
      drag.ghost?.remove();
      insertDragRef.current = null;
      map.getCanvas().style.cursor = '';
      if (!drag.hasDragged || !drag.ghost) {
        if (drag.slotIdx !== activeSlotIdxRef.current) {
          suppressClickUntilRef.current = performance.now() + 400;
          clearSingleClick();
          onSelectActiveSlotRef.current?.(drag.slotIdx);
        }
        return;
      }
      suppressClickUntilRef.current = performance.now() + 400;
      const { lat, lng } = drag.ghost.getLngLat();
      onInsertWaypointAtLegRef.current({ lat, lon: lng }, drag.leg + 1, drag.slotIdx);
    };

    map.on('mousedown', 'route-hit', beginInsert);
    map.on('touchstart', 'route-hit', beginInsert);
    map.on('mousemove', moveInsert);
    map.on('touchmove', moveInsert);
    map.on('mouseup', finishInsert);
    map.on('touchend', finishInsert);
    map.on('touchcancel', cancelInsert);
    window.addEventListener('mouseup', finishInsert);

    map.on('mouseenter', 'route-hit', () => {
      if (draggingMarkerIndexRef.current === null) {
        map.getCanvas().style.cursor = 'grab';
      }
    });
    map.on('mousemove', 'route-hit', (e) => {
      if (insertDragRef.current?.hasDragged || draggingMarkerIndexRef.current !== null) return;
      const found = findClosestRoute(e.lngLat.lng, e.lngLat.lat);
      if (found && found.coords.length > 0) {
        const idx = nearestVertex(found.coords, e.lngLat.lng, e.lngLat.lat);
        onHoverPositionRef.current?.({ lon: found.coords[idx][0], lat: found.coords[idx][1] });
      }
    });
    map.on('mouseleave', 'route-hit', () => {
      if (!insertDragRef.current?.hasDragged) map.getCanvas().style.cursor = '';
      onHoverPositionRef.current?.(null);
    });
    map.on('mouseenter', 'nogo-areas-fill', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'nogo-areas-fill', () => (map.getCanvas().style.cursor = ''));
    map.on('mouseenter', 'nogo-areas-center', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'nogo-areas-center', () => (map.getCanvas().style.cursor = ''));
    map.on('mouseenter', 'library-suggestions-hit', () => {
      if (draggingMarkerIndexRef.current === null && !insertDragRef.current?.hasDragged) {
        map.getCanvas().style.cursor = 'pointer';
      }
    });
    map.on('mouseleave', 'library-suggestions-hit', () => {
      if (!insertDragRef.current?.hasDragged) {
        map.getCanvas().style.cursor = '';
      }
    });

    return () => {
      window.removeEventListener('mouseup', finishInsert);
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      warningMarkersRef.current.forEach((m) => m.remove());
      warningMarkersRef.current = [];
      libraryRankMarkersRef.current.forEach(({ marker }) => marker.remove());
      libraryRankMarkersRef.current = [];
      hoverMarkerRef.current?.remove();
      hoverMarkerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []); // Run once on mount

  // Sync layers when props change
  useEffect(() => {
    if (mapRef.current && styleReadyRef.current) {
      syncAvoidAreasLayer(mapRef.current, avoidAreas);
    }
  }, [avoidAreas]);

  useEffect(() => {
    if (mapRef.current && styleReadyRef.current) {
      syncRoutesLayers(mapRef.current, slots, activeSlotIdx);
      const anyRoute = slots.some((s) => Boolean(s.route?.features?.length));
      if (anyRoute && pendingFitRouteRef.current) {
        pendingFitRouteRef.current = false;
        fitRouteBounds(mapRef.current, slots, waypointsRef.current, true);
      }
    }
  }, [slots, activeSlotIdx]);

  // Fit bounds only when explicitly requested via fitBoundsSeq (initial load, import GPX, etc.)
  useEffect(() => {
    if (fitBoundsSeq === 0) return;
    const map = mapRef.current;
    const anyRoute = slotsRef.current.some((s) => Boolean(s.route?.features?.length));
    if (anyRoute && map && styleReadyRef.current) {
      pendingFitRouteRef.current = false;
      fitRouteBounds(map, slotsRef.current, waypointsRef.current, true);
    } else {
      pendingFitRouteRef.current = true;
      if (map && styleReadyRef.current) {
        fitRouteBounds(map, [], waypointsRef.current, true);
      }
    }
  }, [fitBoundsSeq]);

  useEffect(() => {
    const canCenter =
      waypoints.length > 0 || slots.some((s) => Boolean(s.route?.features?.length));
    centerRouteControl.setEnabled(canCenter);
  }, [waypoints, slots]);

  useEffect(() => {
    if (mapRef.current && styleReadyRef.current) {
      syncHighlightLayer(mapRef.current, segmentHighlight);
    }
  }, [segmentHighlight]);

  // Create/remove Top 5 numbered rank markers only when the suggested set or open state changes
  useEffect(() => {
    const map = mapRef.current;
    libraryRankMarkersRef.current.forEach(({ marker }) => marker.remove());
    libraryRankMarkersRef.current = [];
    if (!map || !isRouteLibraryOpen || suggestedLibraryTracks.length === 0) return;

    // Add #5 down to #1 so #1 stacks visually above lower ranks when start points coincide
    for (let i = suggestedLibraryTracks.length - 1; i >= 0; i--) {
      const item = suggestedLibraryTracks[i];
      if (item.coordinates.length === 0) continue;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'library-rank-marker';
      el.style.backgroundColor = item.color.badge;
      el.textContent = String(item.rank);
      el.title = `#${item.rank}: ${item.route.name}`;
      el.setAttribute('aria-label', `Route suggestion ${item.rank}: ${item.route.name}`);

      el.addEventListener('mouseenter', () => {
        onHoverLibraryRouteRef.current?.(item.route);
      });
      el.addEventListener('mouseleave', () => {
        onHoverLibraryRouteRef.current?.(null);
      });
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        hideMenu();
        onSelectLibraryRouteRef.current?.(item.route.id);
      });

      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat(item.coordinates[0])
        .addTo(map);
      libraryRankMarkersRef.current.push({ routeId: item.route.id, marker });
    }
  }, [isRouteLibraryOpen, suggestedLibraryTracks]);

  // Sync library WebGL polylines and update rank marker dim/focus classes in place
  useEffect(() => {
    const map = mapRef.current;
    const focusedId = activeLibraryPreview?.route.id ?? null;
    for (const { routeId, marker } of libraryRankMarkersRef.current) {
      const el = marker.getElement();
      const isFocused = focusedId === routeId;
      const isDimmed = !isFocused && libraryDimLevel !== 'none';
      el.classList.toggle('is-focused', isFocused);
      el.classList.toggle('is-dimmed', isDimmed);
    }
    if (!map || !styleReadyRef.current) return;
    syncLibraryLayers(
      map,
      isRouteLibraryOpen,
      suggestedLibraryTracks,
      activeLibraryPreview,
      libraryDimLevel,
    );
  }, [isRouteLibraryOpen, suggestedLibraryTracks, activeLibraryPreview, libraryDimLevel]);

  // Fit bounds to a library preview ONLY when explicitly requested via frameLibraryPreviewSeq
  useEffect(() => {
    if (frameLibraryPreviewSeq === 0) return;
    const map = mapRef.current;
    const preview = activeLibraryPreviewRef.current;
    if (!map || !styleReadyRef.current || !preview || preview.coordinates.length === 0) return;
    fitCoordinatesBounds(map, preview.coordinates, true);
  }, [frameLibraryPreviewSeq]);

  // Update styles when basemap/offline mode changes
  const prevStylePropsRef = useRef({ isOfflineMode, basemap, thunderforestKey });
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const prev = prevStylePropsRef.current;
    if (
      prev.isOfflineMode === isOfflineMode &&
      prev.basemap === basemap &&
      prev.thunderforestKey === thunderforestKey
    ) {
      if (import.meta.env.DEV) {
        registerCycleShieldImages(map);
        map.triggerRepaint();
      }
      return;
    }
    prevStylePropsRef.current = { isOfflineMode, basemap, thunderforestKey };

    styleReadyRef.current = false;
    registerProtocols();
    map.setMaxBounds(isOfflineMode ? UK_BOUNDS : null);
    tilePickerControl.setOffline(isOfflineMode);
    terrain3DControl.setOffline(isOfflineMode);
    legendControl.syncBasemap(basemap);
    map.setStyle(
      isOfflineMode ? getOfflineStyle(basemap) : getOnlineStyle(basemap, thunderforestKey),
      { diff: false },
    );
    (map as any)._renderTaskQueue?.run?.();
  }, [isOfflineMode, basemap, thunderforestKey]);

  // Waypoint markers synchronization (reuses existing Marker instances so active drags are never interrupted)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const n = waypoints.length;
    const currentMarkers = markersRef.current;

    // Remove excess markers from the end if waypoints were removed
    while (currentMarkers.length > n) {
      const removed = currentMarkers.pop();
      removed?.remove();
    }

    waypoints.forEach((w, index) => {
      const label = waypointLabel(index, n);
      const kind = waypointKind(index, n);
      const titleText = w.name
        ? `${label}: ${w.name}`
        : `${label}: ${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}`;

      const existing = currentMarkers[index];
      if (existing) {
        const el = existing.getElement();
        el.classList.remove('start', 'end', 'via');
        el.classList.add('maplibregl-marker', 'maplibregl-marker-anchor-center', 'wp-marker', kind);
        el.textContent = label;
        el.title = titleText;
        if (draggingMarkerIndexRef.current !== index) {
          existing.setLngLat([w.lon, w.lat]);
        }
        return;
      }

      const el = document.createElement('div');
      el.classList.add('wp-marker', kind);
      el.textContent = label;
      el.title = titleText;

      let wasDragged = false;
      const marker = new maplibregl.Marker({ element: el, draggable: true, clickTolerance: 4 })
        .setLngLat([w.lon, w.lat])
        .addTo(map);

      marker.on('dragstart', () => {
        wasDragged = true;
        draggingMarkerIndexRef.current = index;
        suppressClickUntilRef.current = performance.now() + 10000;
        onHoverPositionRef.current?.(null);
        hideMenu();
      });

      marker.on('dragend', () => {
        draggingMarkerIndexRef.current = null;
        suppressClickUntilRef.current = performance.now() + 300;
        const { lat, lng } = marker.getLngLat();
        onMoveWaypointRef.current(index, { lat, lon: lng });
        setTimeout(() => {
          wasDragged = false;
        }, 150);
      });

      const showMarkerContextMenu = (e: MouseEvent) => {
        const currentWp = waypointsRef.current[index];
        if (!currentWp) return;
        const currentN = waypointsRef.current.length;
        const currentLabel = waypointLabel(index, currentN);
        const headerTitle = currentWp.name ? `${currentLabel} · ${currentWp.name}` : `Point ${currentLabel}`;
        lastOpenedMarkerIndexRef.current = index;
        const rect = el.getBoundingClientRect();
        const x = e.clientX || rect.left + rect.width / 2;
        const y = e.clientY || rect.bottom + 4;
        showMenu(
          [
            {
              label: 'Rename point',
              onSelect: () => {
                if (onRequestInlineRenameRef.current) {
                  onRequestInlineRenameRef.current(index);
                } else {
                  const currentName = waypointsRef.current[index]?.name || '';
                  const nextName = window.prompt('Rename point:', currentName);
                  if (nextName !== null) {
                    onRenameWaypointRef.current(index, nextName);
                  }
                }
              },
            },
            {
              label: 'Remove point',
              danger: true,
              onSelect: () => onRemoveWaypointRef.current(index),
            },
            {
              label: 'See on Google Street View',
              dividerBefore: true,
              onSelect: () => {
                const wp = waypointsRef.current[index];
                if (!wp) return;
                window.open(
                  `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${wp.lat.toFixed(6)},${wp.lon.toFixed(6)}`,
                  '_blank',
                  'noopener,noreferrer',
                );
              },
            },
            {
              label: 'See on OpenStreetMap',
              onSelect: () => {
                const wp = waypointsRef.current[index];
                if (!wp) return;
                const lat = wp.lat.toFixed(6);
                const lon = wp.lon.toFixed(6);
                window.open(
                  `https://www.openstreetmap.org/query?lat=${lat}&lon=${lon}#map=18/${lat}/${lon}`,
                  '_blank',
                  'noopener,noreferrer',
                );
              },
            },
            {
              label: 'Copy coordinates',
              onSelect: async () => {
                const wp = waypointsRef.current[index];
                if (!wp) return;
                const text = `${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}`;
                await navigator.clipboard.writeText(text);
                onStatusChangeRef.current(`Copied ${text}`);
              },
            },
          ],
          x,
          y,
          headerTitle,
        );
      };

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (wasDragged) return;
        if (lastOpenedMarkerIndexRef.current === index && menuClosedWithin(250)) {
          lastOpenedMarkerIndexRef.current = null;
          return;
        }
        showMarkerContextMenu(e);
      });

      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showMarkerContextMenu(e);
      });

      currentMarkers.push(marker);
    });
  }, [waypoints]);

  // Route warning markers along all active routes/profiles
  useEffect(() => {
    const map = mapRef.current;
    warningMarkersRef.current.forEach((m) => m.remove());
    warningMarkersRef.current = [];
    if (!map) return;

    // Render non-active slots first and the active slot last so active markers sit on top,
    // deduplicating identical warnings where compared routes overlap.
    const orderedSlots = slots
      .map((slot, slotIdx) => ({ slot, slotIdx }))
      .filter(({ slot }) => Boolean(slot.route))
      .sort((a, b) => (a.slotIdx === activeSlotIdx ? 1 : b.slotIdx === activeSlotIdx ? -1 : a.slotIdx - b.slotIdx));

    const seenWarnings: Array<{ kind: string; lon: number; lat: number }> = [];

    orderedSlots.forEach(({ slot, slotIdx }) => {
      if (!slot.route) return;
      const slotWps = slot.waypoints || waypoints;
      const warnings = extractRouteWarnings(slot.route, slotWps);

      warnings.forEach((w) => {
        const isDuplicate = seenWarnings.some(
          (s) =>
            s.kind === w.kind &&
            Math.abs(s.lon - w.lon) < 0.0004 &&
            Math.abs(s.lat - w.lat) < 0.0004,
        );
        if (isDuplicate) return;
        seenWarnings.push({ kind: w.kind, lon: w.lon, lat: w.lat });

        const meta = WARNING_META[w.kind];
        const kmStr = `${(w.from / 1000).toFixed(1)} km`;
        const el = document.createElement('div');
        el.className = `warning-map-marker warning-kind-${w.kind} ${w.isProhibition ? 'is-prohibition' : 'is-warning'}`;
        el.style.setProperty('--warn-color', w.color);
        el.title = `${meta.label} (${kmStr}): ${w.detail} (${formatDistance(w.distanceM)})`;
        el.innerHTML = `<span class="warning-map-marker-inner">${warningKindSvg(w.kind, 12)}</span>`;

        const highlightObj: SegmentHighlight | null =
          w.coordinates.length >= 2
            ? { coordinates: [w.coordinates], color: w.color }
            : null;

        el.addEventListener('pointerenter', () => {
          if (highlightObj) {
            onHighlightSegmentRef.current?.(highlightObj);
          }
        });

        el.addEventListener('pointerleave', () => {
          onHighlightSegmentRef.current?.(null);
        });

        const showWarningContextMenu = (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (slotIdx !== activeSlotIdxRef.current) {
            onSelectActiveSlotRef.current?.(slotIdx);
          }
          if (highlightObj) {
            onHighlightSegmentRef.current?.(highlightObj);
          }
          const rect = el.getBoundingClientRect();
          const x = e.clientX || rect.left + rect.width / 2;
          const y = e.clientY || rect.bottom + 4;
          const currentWps = slotsRef.current[slotIdx]?.waypoints || waypointsRef.current;
          const wpLbl =
            w.waypointIndex !== undefined && currentWps.length > 0
              ? waypointLabel(w.waypointIndex, currentWps.length)
              : undefined;

          const items: MenuItem[] = [
            {
              label: 'Zoom to warning section',
              onSelect: () => {
                map.flyTo({
                  center: [w.lon, w.lat],
                  zoom: Math.max(map.getZoom(), 16),
                });
              },
            },
          ];

          if (w.waypointIndex !== undefined) {
            items.push({
              label: `Remove point ${wpLbl || w.waypointIndex} (fix rollback)`,
              danger: true,
              onSelect: () => onRemoveWaypointRef.current(w.waypointIndex!),
            });
          }

          items.push(
            {
              label: 'Avoid this section',
              hint: `${DEFAULT_AVOID_RADIUS_M} m`,
              dividerBefore: true,
              onSelect: () =>
                onAddAvoidAreaRef.current({ lat: w.lat, lon: w.lon }, DEFAULT_AVOID_RADIUS_M),
            },
            {
              label: 'See on Google Street View',
              dividerBefore: true,
              onSelect: () =>
                window.open(
                  `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${w.lat.toFixed(6)},${w.lon.toFixed(6)}`,
                  '_blank',
                  'noopener,noreferrer',
                ),
            },
            {
              label: 'See on OpenStreetMap',
              onSelect: () => {
                const lat = w.lat.toFixed(6);
                const lon = w.lon.toFixed(6);
                window.open(
                  `https://www.openstreetmap.org/query?lat=${lat}&lon=${lon}#map=18/${lat}/${lon}`,
                  '_blank',
                  'noopener,noreferrer',
                );
              },
            },
          );

          showMenu(items, x, y, {
            title: `${meta.label} · ${kmStr}`,
            subtitle: `${w.detail} (${formatDistance(w.distanceM)})`,
          });
        };

        el.addEventListener('click', showWarningContextMenu);
        el.addEventListener('contextmenu', showWarningContextMenu);

        const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([w.lon, w.lat])
          .addTo(map);
        warningMarkersRef.current.push(marker);
      });
    });
  }, [slots, activeSlotIdx, waypoints]);

  // Hover marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!hoverPosition) {
      hoverMarkerRef.current?.remove();
      hoverMarkerRef.current = null;
      return;
    }
    if (!hoverMarkerRef.current) {
      const el = document.createElement('div');
      el.className = 'hover-dot';
      hoverMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([hoverPosition.lon, hoverPosition.lat])
        .addTo(map);
    } else {
      hoverMarkerRef.current.setLngLat([hoverPosition.lon, hoverPosition.lat]);
    }
  }, [hoverPosition]);

  return <div id="map" ref={containerRef} />;
};

