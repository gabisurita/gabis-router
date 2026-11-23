import type maplibregl from 'maplibre-gl';
import {
  getSlotColor,
  MAX_TOTAL_SLOTS,
  type AvoidArea,
  type LatLon,
  type RouteSlotState,
} from '../types.ts';
import type { SegmentHighlight } from './classification.ts';
import { createCirclePolygon } from './geo.ts';
import type { PreviewLibraryRoute, SuggestedLibraryTrack } from './route-library.ts';
import type { RobustnessAnalysis } from './robustness.ts';

const ROUTE_HIT_PX = 8;

const EMPTY_FC: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

export function syncAvoidAreasLayer(map: maplibregl.Map, avoidAreas: AvoidArea[]) {
  const polyData: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: avoidAreas.map((area, index) => ({
      type: 'Feature',
      properties: { index, radius: area.radius },
      geometry: {
        type: 'Polygon',
        coordinates: [createCirclePolygon(area, area.radius)],
      },
    })),
  };

  const centerData: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: avoidAreas.map((area, index) => ({
      type: 'Feature',
      properties: { index },
      geometry: { type: 'Point', coordinates: [area.lon, area.lat] },
    })),
  };

  const polySource = map.getSource('nogo-areas') as maplibregl.GeoJSONSource | undefined;
  if (polySource) {
    polySource.setData(polyData);
  } else {
    map.addSource('nogo-areas', { type: 'geojson', data: polyData });
    map.addLayer({
      id: 'nogo-areas-fill',
      type: 'fill',
      source: 'nogo-areas',
      paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.35 },
    });
    map.addLayer({
      id: 'nogo-areas-stroke',
      type: 'line',
      source: 'nogo-areas',
      paint: { 'line-color': '#dc2626', 'line-width': 2, 'line-dasharray': [2, 2] },
    });
  }

  const centerSource = map.getSource('nogo-areas-center') as maplibregl.GeoJSONSource | undefined;
  if (centerSource) {
    centerSource.setData(centerData);
  } else {
    map.addSource('nogo-areas-center', { type: 'geojson', data: centerData });
    map.addLayer({
      id: 'nogo-areas-center',
      type: 'circle',
      source: 'nogo-areas-center',
      paint: {
        'circle-radius': 5,
        'circle-color': '#dc2626',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
      },
    });
  }
}

export function syncRoutesLayers(
  map: maplibregl.Map,
  slots: RouteSlotState[],
  activeSlotIdx = 0,
) {
  const hitFeatures: GeoJSON.Feature[] = [];

  // Create/update sources and layers in reverse slot order
  for (let slotIdx = MAX_TOTAL_SLOTS - 1; slotIdx >= 0; slotIdx--) {
    const slot = slots[slotIdx];
    const data: GeoJSON.FeatureCollection = slot?.route || EMPTY_FC;
    if (slot?.route?.features) {
      for (const f of slot.route.features) {
        hitFeatures.push({
          ...f,
          properties: { ...(f.properties || {}), slotIdx },
        });
      }
    }

    const sourceId = slotIdx === 0 ? 'route' : `route-${slotIdx}`;
    const haloId = slotIdx === 0 ? 'route-halo' : `route-${slotIdx}-halo`;
    const casingId = slotIdx === 0 ? 'route-casing' : `route-${slotIdx}-casing`;
    const lineId = slotIdx === 0 ? 'route-line' : `route-${slotIdx}-line`;
    const color = getSlotColor(slot, slotIdx);

    const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
    if (source) {
      source.setData(data);
      if (map.getLayer(haloId)) {
        map.setPaintProperty(haloId, 'line-width', [
          'interpolate',
          ['linear'],
          ['zoom'],
          6,
          4.0,
          12,
          4.8,
          16,
          5.6,
        ]);
        map.setPaintProperty(haloId, 'line-opacity', 0.45);
      }
      if (map.getLayer(casingId)) map.setPaintProperty(casingId, 'line-color', color.casing);
      if (map.getLayer(lineId)) map.setPaintProperty(lineId, 'line-color', color.line);
    } else if (slotIdx < Math.max(3, slots.length)) {
      map.addSource(sourceId, { type: 'geojson', data });
      map.addLayer({
        id: haloId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#f8f4f0',
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 4.0, 12, 4.8, 16, 5.6],
          'line-opacity': 0.45,
        },
      });
      map.addLayer({
        id: casingId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': color.casing,
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3.4, 12, 4.2, 16, 5.4],
          'line-opacity': 0.9,
        },
      });
      map.addLayer({
        id: lineId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': color.line,
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2.2, 12, 2.8, 16, 3.8],
          'line-opacity': 1,
        },
      });
    }
  }

  const hitData: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: hitFeatures,
  };
  const hitSource = map.getSource('route-hit-src') as maplibregl.GeoJSONSource | undefined;
  if (hitSource) {
    hitSource.setData(hitData);
  } else {
    map.addSource('route-hit-src', { type: 'geojson', data: hitData });
    map.addLayer({
      id: 'route-hit',
      type: 'line',
      source: 'route-hit-src',
      paint: { 'line-color': '#000000', 'line-width': ROUTE_HIT_PX * 2.5, 'line-opacity': 0 },
    });
  }

  ensureRouteLayerOrder(map, slots, activeSlotIdx);
}

function getFirstLabelLayerId(map: maplibregl.Map): string | undefined {
  const preferred = [
    'waterway_line_label',
    'highway-name-path',
    'highway-name-minor',
    'highway-name-major',
    'ocm-route-label-proposed',
    'ocm-route-label-mtb',
  ];
  for (const id of preferred) {
    if (map.getLayer(id)) return id;
  }
  const layers = map.getStyle()?.layers;
  if (layers) {
    const firstSymbol = layers.find((l) => l.type === 'symbol');
    if (firstSymbol) return firstSymbol.id;
  }
  return undefined;
}

function slotLayerIds(slotIdx: number): [string, string, string] {
  const prefix = slotIdx === 0 ? 'route' : `route-${slotIdx}`;
  return [`${prefix}-halo`, `${prefix}-casing`, `${prefix}-line`];
}

function ensureRouteLayerOrder(
  map: maplibregl.Map,
  slots: RouteSlotState[],
  activeSlotIdx = 0,
) {
  const beforeId = getFirstLabelLayerId(map);
  const activeRouteIdx = slots[activeSlotIdx]?.routeIdx ?? 0;
  const inactiveRouteSlots: number[] = [];
  const activeRouteSlots: number[] = [];
  for (let i = MAX_TOTAL_SLOTS - 1; i >= 0; i--) {
    if (i === activeSlotIdx) continue;
    const rIdx = slots[i]?.routeIdx ?? 0;
    if (rIdx === activeRouteIdx) {
      activeRouteSlots.push(i);
    } else {
      inactiveRouteSlots.push(i);
    }
  }
  const slotOrder: number[] = [...inactiveRouteSlots, ...activeRouteSlots, activeSlotIdx];

  const orderedIds = [
    'robustness-corridors-halo',
    'robustness-corridors-casing',
    'robustness-corridors-line',
    ...slotOrder.flatMap((idx) => slotLayerIds(idx)),
    'robustness-stability-halo',
    'robustness-stability-casing',
    'robustness-stability-line',
    'robustness-focus-halo',
    'robustness-focus-casing',
    'robustness-focus-line',
    'route-hit',
    'route-segment-halo',
    'route-segment-line',
  ];
  for (const id of orderedIds) {
    if (map.getLayer(id)) {
      map.moveLayer(id, beforeId);
    }
  }
}

export function syncHighlightLayer(map: maplibregl.Map, highlight: SegmentHighlight | null) {
  const data: GeoJSON.FeatureCollection = highlight
    ? {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { color: highlight.color },
            geometry: { type: 'MultiLineString', coordinates: highlight.coordinates },
          },
        ],
      }
    : EMPTY_FC;

  const beforeId = getFirstLabelLayerId(map);
  const source = map.getSource('route-segment-highlight') as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    if (highlight && highlight.coordinates.length > 0) {
      if (map.getLayer('route-segment-halo')) map.moveLayer('route-segment-halo', beforeId);
      if (map.getLayer('route-segment-line')) map.moveLayer('route-segment-line', beforeId);
    }
  } else {
    map.addSource('route-segment-highlight', { type: 'geojson', data });
    map.addLayer(
      {
        id: 'route-segment-halo',
        type: 'line',
        source: 'route-segment-highlight',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#f8f4f0', 'line-width': 8, 'line-opacity': 0.95 },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: 'route-segment-line',
        type: 'line',
        source: 'route-segment-highlight',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['coalesce', ['get', 'color'], '#f59e0b'],
          'line-width': 4.8,
          'line-opacity': 1.0,
        },
      },
      beforeId,
    );
  }
}

export function getRouteBoundsPadding(): maplibregl.PaddingOptions {
  const rootEl = document.getElementById('root');
  const vw = rootEl?.clientWidth || window.innerWidth;
  const vh = rootEl?.clientHeight || window.innerHeight;
  const isMobile = vw <= 860;
  const controlsEl = document.getElementById('controls');
  const drawerEl = document.getElementById('route-info');

  if (isMobile) {
    const isControlsExpanded = controlsEl && !controlsEl.classList.contains('collapsed');
    const maxTopPad = controlsEl?.classList.contains('library-open')
      ? Math.round(vh * 0.6)
      : 260;
    const topPad = isControlsExpanded
      ? Math.min(maxTopPad, (controlsEl?.offsetHeight || 200) + 20)
      : 72;
    const isDrawerVisible = drawerEl && !drawerEl.hidden;
    const isDrawerExpanded = isDrawerVisible && !drawerEl.classList.contains('collapsed');
    const bottomPad = isDrawerExpanded
      ? Math.min(Math.round(vh * 0.72), (drawerEl?.offsetHeight || 220) + 44)
      : isDrawerVisible
      ? Math.min(260, (drawerEl?.offsetHeight || 72) + 44)
      : 48;
    return { top: topPad, bottom: bottomPad, left: 28, right: 28 };
  } else {
    const isControlsCollapsed = controlsEl?.classList.contains('collapsed');
    const leftPad = isControlsCollapsed ? 96 : (controlsEl?.offsetWidth || 372) + 48;
    const isDrawerVisible = drawerEl && !drawerEl.hidden;
    const isDrawerExpanded = isDrawerVisible && !drawerEl.classList.contains('collapsed');
    const bottomPad = isDrawerExpanded
      ? Math.min(Math.round(vh * 0.76), (drawerEl?.offsetHeight || 240) + 48)
      : isDrawerVisible
      ? Math.min(280, (drawerEl?.offsetHeight || 76) + 48)
      : 56;
    return { top: 44, bottom: bottomPad, left: leftPad, right: 64 };
  }
}

export function fitRouteBounds(
  map: maplibregl.Map,
  slots: RouteSlotState[],
  waypoints: LatLon[],
  animate = true,
) {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let count = 0;

  for (const slot of slots) {
    const route = slot.route;
    if (route && route.features) {
      for (const feat of route.features) {
        if (feat.geometry && feat.geometry.type === 'LineString') {
          const coords = (feat.geometry as GeoJSON.LineString).coordinates;
          for (const [lon, lat] of coords) {
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            count++;
          }
        }
      }
    }
  }

  if (count === 0) {
    for (const slot of slots) {
      for (const wp of slot.waypoints || []) {
        if (wp.lon < minLon) minLon = wp.lon;
        if (wp.lon > maxLon) maxLon = wp.lon;
        if (wp.lat < minLat) minLat = wp.lat;
        if (wp.lat > maxLat) maxLat = wp.lat;
        count++;
      }
    }
  }

  if (count === 0 && waypoints.length > 0) {
    for (const wp of waypoints) {
      if (wp.lon < minLon) minLon = wp.lon;
      if (wp.lon > maxLon) maxLon = wp.lon;
      if (wp.lat < minLat) minLat = wp.lat;
      if (wp.lat > maxLat) maxLat = wp.lat;
      count++;
    }
  }

  if (count === 0) return;

  const shouldAnimate = animate && (typeof document === 'undefined' || !document.hidden);

  if (minLon === maxLon && minLat === maxLat) {
    map.flyTo({
      center: [minLon, minLat],
      zoom: 14,
      duration: shouldAnimate ? 600 : 0,
    });
    return;
  }

  const padding = getRouteBoundsPadding();
  map.fitBounds(
    [
      [minLon, minLat],
      [maxLon, maxLat],
    ],
    {
      padding,
      maxZoom: 16,
      duration: shouldAnimate ? 600 : 0,
    },
  );
}

export function fitCoordinatesBounds(
  map: maplibregl.Map,
  coordinates: [number, number][],
  animate = true,
) {
  if (coordinates.length === 0) return;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of coordinates) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const shouldAnimate = animate && (typeof document === 'undefined' || !document.hidden);
  if (minLon === maxLon && minLat === maxLat) {
    map.flyTo({ center: [minLon, minLat], zoom: 13, duration: shouldAnimate ? 500 : 0 });
    return;
  }
  map.fitBounds(
    [
      [minLon, minLat],
      [maxLon, maxLat],
    ],
    {
      padding: getRouteBoundsPadding(),
      maxZoom: 14.5,
      duration: shouldAnimate ? 500 : 0,
    },
  );
}

export type SuggestionDimLevel = 'none' | 'soft' | 'strong';

export function syncLibraryLayers(
  map: maplibregl.Map,
  isLibraryOpen: boolean,
  suggestedTracks: SuggestedLibraryTrack[],
  activePreview: PreviewLibraryRoute | null,
  dimLevel: SuggestionDimLevel = 'none',
) {
  // Soften background cycle-network lines while browsing the route library so
  // suggested routes stand out clearly without purple/red overlay clutter.
  const styleLayers = map.getStyle()?.layers;
  if (styleLayers) {
    const cycleLineOpacity = isLibraryOpen ? 0.22 : 1;
    for (const l of styleLayers) {
      if (l.type === 'line' && l.id.startsWith('ocm-route-')) {
        map.setPaintProperty(l.id, 'line-opacity', cycleLineOpacity);
      }
    }
  }

  const beforeId = getFirstLabelLayerId(map);
  const focusedId = activePreview?.route.id ?? null;
  const dimCode = dimLevel === 'strong' ? 2 : dimLevel === 'soft' ? 1 : 0;

  const suggestionFeatures: GeoJSON.Feature[] = [];
  if (isLibraryOpen) {
    // Reverse so #1 renders above #2..#5 when routes overlap.
    for (let i = suggestedTracks.length - 1; i >= 0; i--) {
      const item = suggestedTracks[i];
      if (item.coordinates.length < 2) continue;
      if (focusedId === item.route.id) continue;
      suggestionFeatures.push({
        type: 'Feature',
        properties: {
          id: item.route.id,
          rank: item.rank,
          lineColor: item.color.line,
          casingColor: item.color.casing,
          dimCode,
        },
        geometry: {
          type: 'LineString',
          coordinates: item.coordinates,
        },
      });
    }
  }

  const suggestionsData: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: suggestionFeatures,
  };

  const previewLineData: GeoJSON.FeatureCollection =
    isLibraryOpen && activePreview && activePreview.coordinates.length >= 2
      ? {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {
                id: activePreview.route.id,
                lineColor: activePreview.color.line,
                casingColor: activePreview.color.casing,
              },
              geometry: {
                type: 'LineString',
                coordinates: activePreview.coordinates,
              },
            },
          ],
        }
      : EMPTY_FC;

  const previewPinFeatures: GeoJSON.Feature[] = [];
  if (isLibraryOpen && activePreview && activePreview.coordinates.length >= 2) {
    for (const stop of activePreview.route.stops || []) {
      if (stop.pos && stop.pos.length === 2) {
        previewPinFeatures.push({
          type: 'Feature',
          properties: { role: 'stop', name: stop.name },
          geometry: { type: 'Point', coordinates: stop.pos },
        });
      }
    }
    const first = activePreview.coordinates[0];
    const last = activePreview.coordinates[activePreview.coordinates.length - 1];
    if (!activePreview.route.loop) {
      previewPinFeatures.push({
        type: 'Feature',
        properties: { role: 'end' },
        geometry: { type: 'Point', coordinates: last },
      });
    }
    previewPinFeatures.push({
      type: 'Feature',
      properties: { role: 'start' },
      geometry: { type: 'Point', coordinates: first },
    });
  }
  const previewPinsData: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: previewPinFeatures,
  };

  const sugSrc = map.getSource('library-suggestions') as maplibregl.GeoJSONSource | undefined;
  if (sugSrc) {
    sugSrc.setData(suggestionsData);
  } else if (isLibraryOpen) {
    map.addSource('library-suggestions', { type: 'geojson', data: suggestionsData });
    map.addLayer(
      {
        id: 'library-suggestions-halo',
        type: 'line',
        source: 'library-suggestions',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 6.4, 11, 7.8, 15, 9.2],
          'line-opacity': ['match', ['get', 'dimCode'], 2, 0.2, 1, 0.4, 0.92],
        },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: 'library-suggestions-casing',
        type: 'line',
        source: 'library-suggestions',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'casingColor'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 4.6, 11, 5.8, 15, 7.0],
          'line-opacity': ['match', ['get', 'dimCode'], 2, 0.22, 1, 0.42, 0.94],
        },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: 'library-suggestions-line',
        type: 'line',
        source: 'library-suggestions',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'lineColor'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3.0, 11, 4.0, 15, 5.0],
          'line-opacity': ['match', ['get', 'dimCode'], 2, 0.25, 1, 0.48, 1],
        },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: 'library-suggestions-hit',
        type: 'line',
        source: 'library-suggestions',
        paint: { 'line-color': '#000000', 'line-width': 16, 'line-opacity': 0 },
      },
      beforeId,
    );
  }

  const previewSrc = map.getSource('library-preview') as maplibregl.GeoJSONSource | undefined;
  if (previewSrc) {
    previewSrc.setData(previewLineData);
  } else if (isLibraryOpen) {
    map.addSource('library-preview', { type: 'geojson', data: previewLineData });
    map.addLayer(
      {
        id: 'library-preview-halo',
        type: 'line',
        source: 'library-preview',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 8.2, 11, 10.0, 15, 11.8],
          'line-opacity': 0.96,
        },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: 'library-preview-casing',
        type: 'line',
        source: 'library-preview',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'casingColor'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 5.8, 11, 7.2, 15, 8.8],
          'line-opacity': 0.98,
        },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: 'library-preview-line',
        type: 'line',
        source: 'library-preview',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'lineColor'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 4.0, 11, 5.0, 15, 6.2],
          'line-opacity': 1,
        },
      },
      beforeId,
    );
  }

  const pinsSrc = map.getSource('library-preview-pins') as maplibregl.GeoJSONSource | undefined;
  if (pinsSrc) {
    pinsSrc.setData(previewPinsData);
  } else if (isLibraryOpen) {
    map.addSource('library-preview-pins', { type: 'geojson', data: previewPinsData });
    map.addLayer({
      id: 'library-preview-pins-layer',
      type: 'circle',
      source: 'library-preview-pins',
      paint: {
        'circle-radius': ['match', ['get', 'role'], 'stop', 5.5, 7],
        'circle-color': [
          'match',
          ['get', 'role'],
          'start',
          '#16a34a',
          'end',
          '#dc2626',
          '#f59e0b',
        ],
        'circle-stroke-width': 2.4,
        'circle-stroke-color': '#ffffff',
      },
    });
  }
}

export function syncRobustnessLayers(
  map: maplibregl.Map,
  isOpen: boolean,
  analysis: RobustnessAnalysis | null,
  showStabilityMap: boolean,
  focusedBranchId: string | null,
  viewMode: 'segments' | 'variants' = 'segments',
) {
  const beforeId = getFirstLabelLayerId(map);
  const active = isOpen && Boolean(analysis);

  const branchFeatures: GeoJSON.Feature[] = [];
  let focusData: GeoJSON.FeatureCollection = EMPTY_FC;
  let focusEndpointsData: GeoJSON.FeatureCollection = EMPTY_FC;
  let replacedBaseData: GeoJSON.FeatureCollection = EMPTY_FC;
  const hasFocus = active && Boolean(focusedBranchId);

  if (active && analysis) {
    if (viewMode === 'variants') {
      const items = analysis.corridors;
      for (let i = items.length - 1; i >= 0; i--) {
        const c = items[i];
        if (c.coordinates.length < 2) continue;
        if (c.id === focusedBranchId) {
          focusData = {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {
                  id: c.id,
                  lineColor: c.color.line,
                  casingColor: c.color.casing,
                },
                geometry: {
                  type: 'LineString',
                  coordinates: c.coordinates,
                },
              },
            ],
          };
          continue;
        }
        branchFeatures.push({
          type: 'Feature',
          properties: {
            id: c.id,
            lineColor: c.color.line,
            casingColor: c.color.casing,
            dimmed: hasFocus ? 1 : 0,
          },
          geometry: {
            type: 'LineString',
            coordinates: c.coordinates,
          },
        });
      }
    } else {
      const items = analysis.branches;
      for (let i = items.length - 1; i >= 0; i--) {
        const b = items[i];
        if (b.coordinates.length < 2) continue;
        if (b.id === focusedBranchId) {
          focusData = {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {
                  id: b.id,
                  lineColor: b.color.line,
                  casingColor: b.color.casing,
                },
                geometry: {
                  type: 'LineString',
                  coordinates: b.coordinates,
                },
              },
            ],
          };
          const first = b.coordinates[0];
          const last = b.coordinates[b.coordinates.length - 1];
          focusEndpointsData = {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: { role: 'split', lineColor: b.color.line, casingColor: b.color.casing },
                geometry: { type: 'Point', coordinates: first },
              },
              {
                type: 'Feature',
                properties: { role: 'rejoin', lineColor: b.color.line, casingColor: b.color.casing },
                geometry: { type: 'Point', coordinates: last },
              },
            ],
          };
          if (b.replacedBaseCoords.length >= 2) {
            replacedBaseData = {
              type: 'FeatureCollection',
              features: [
                {
                  type: 'Feature',
                  properties: { id: b.id },
                  geometry: {
                    type: 'LineString',
                    coordinates: b.replacedBaseCoords,
                  },
                },
              ],
            };
          }
          continue;
        }
        branchFeatures.push({
          type: 'Feature',
          properties: {
            id: b.id,
            lineColor: b.color.line,
            casingColor: b.color.casing,
            dimmed: hasFocus ? 1 : 0,
          },
          geometry: {
            type: 'LineString',
            coordinates: b.coordinates,
          },
        });
      }
    }
  }

  const corridorsData: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: branchFeatures,
  };

  const stabilityData: GeoJSON.FeatureCollection =
    active && analysis && showStabilityMap && analysis.segments.length > 0
      ? {
          type: 'FeatureCollection',
          features: analysis.segments.map((seg, idx) => ({
            type: 'Feature',
            properties: {
              idx,
              color: seg.color,
              band: seg.band,
              dimmed: hasFocus ? 1 : 0,
            },
            geometry: {
              type: 'LineString',
              coordinates: seg.coordinates,
            },
          })),
        }
      : EMPTY_FC;

  const firstRouteLayer = map.getLayer('route-halo') ? 'route-halo' : beforeId;

  const corrSrc = map.getSource('robustness-corridors') as maplibregl.GeoJSONSource | undefined;
  if (corrSrc) {
    corrSrc.setData(corridorsData);
  } else if (active) {
    map.addSource('robustness-corridors', { type: 'geojson', data: corridorsData });
    map.addLayer(
      {
        id: 'robustness-corridors-halo',
        type: 'line',
        source: 'robustness-corridors',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 6.2, 12, 7.6, 16, 9.2],
          'line-opacity': ['match', ['get', 'dimmed'], 1, 0.14, 0.85],
        },
      },
      firstRouteLayer,
    );
    map.addLayer(
      {
        id: 'robustness-corridors-casing',
        type: 'line',
        source: 'robustness-corridors',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'casingColor'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 4.4, 12, 5.6, 16, 7.0],
          'line-opacity': ['match', ['get', 'dimmed'], 1, 0.18, 0.92],
        },
      },
      firstRouteLayer,
    );
    map.addLayer(
      {
        id: 'robustness-corridors-line',
        type: 'line',
        source: 'robustness-corridors',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'lineColor'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3.0, 12, 4.0, 16, 5.0],
          'line-opacity': ['match', ['get', 'dimmed'], 1, 0.22, 0.96],
        },
      },
      firstRouteLayer,
    );
    map.addLayer(
      {
        id: 'robustness-corridors-hit',
        type: 'line',
        source: 'robustness-corridors',
        paint: {
          'line-color': '#000000',
          'line-width': 18,
          'line-opacity': 0,
        },
      },
      beforeId,
    );
  }

  const stabSrc = map.getSource('robustness-stability') as maplibregl.GeoJSONSource | undefined;
  if (stabSrc) {
    stabSrc.setData(stabilityData);
  } else if (active) {
    map.addSource('robustness-stability', { type: 'geojson', data: stabilityData });
    map.addLayer(
      {
        id: 'robustness-stability-halo',
        type: 'line',
        source: 'robustness-stability',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 5.6, 12, 6.8, 16, 8.4],
          'line-opacity': ['match', ['get', 'dimmed'], 1, 0.16, 0.72],
        },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: 'robustness-stability-casing',
        type: 'line',
        source: 'robustness-stability',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#0f172a',
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 4.2, 12, 5.2, 16, 6.6],
          'line-opacity': ['match', ['get', 'dimmed'], 1, 0.22, 0.85],
        },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: 'robustness-stability-line',
        type: 'line',
        source: 'robustness-stability',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2.8, 12, 3.6, 16, 4.8],
          'line-opacity': ['match', ['get', 'dimmed'], 1, 0.28, 1.0],
        },
      },
      beforeId,
    );
  }

  const replSrc = map.getSource('robustness-replaced') as maplibregl.GeoJSONSource | undefined;
  if (replSrc) {
    replSrc.setData(replacedBaseData);
  } else if (active) {
    map.addSource('robustness-replaced', { type: 'geojson', data: replacedBaseData });
    map.addLayer(
      {
        id: 'robustness-replaced-casing',
        type: 'line',
        source: 'robustness-replaced',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#1e293b',
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 5.2, 12, 6.4, 16, 7.8],
          'line-opacity': 0.5,
        },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: 'robustness-replaced-line',
        type: 'line',
        source: 'robustness-replaced',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#f87171',
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3.0, 12, 3.8, 16, 4.8],
          'line-opacity': 0.65,
        },
      },
      beforeId,
    );
  }

  const focusSrc = map.getSource('robustness-focus') as maplibregl.GeoJSONSource | undefined;
  if (focusSrc) {
    focusSrc.setData(focusData);
  } else if (active) {
    map.addSource('robustness-focus', { type: 'geojson', data: focusData });
    map.addLayer(
      {
        id: 'robustness-focus-halo',
        type: 'line',
        source: 'robustness-focus',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 8.4, 12, 10.4, 16, 12.4],
          'line-opacity': 0.96,
        },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: 'robustness-focus-casing',
        type: 'line',
        source: 'robustness-focus',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'casingColor'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 6.0, 12, 7.6, 16, 9.2],
          'line-opacity': 0.98,
        },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: 'robustness-focus-line',
        type: 'line',
        source: 'robustness-focus',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'lineColor'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 4.2, 12, 5.4, 16, 6.6],
          'line-opacity': 1,
        },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: 'robustness-focus-hit',
        type: 'line',
        source: 'robustness-focus',
        paint: {
          'line-color': '#000000',
          'line-width': 20,
          'line-opacity': 0,
        },
      },
      beforeId,
    );
  }

  const epSrc = map.getSource('robustness-focus-endpoints') as maplibregl.GeoJSONSource | undefined;
  if (epSrc) {
    epSrc.setData(focusEndpointsData);
  } else if (active) {
    map.addSource('robustness-focus-endpoints', { type: 'geojson', data: focusEndpointsData });
    map.addLayer({
      id: 'robustness-focus-endpoints-circle',
      type: 'circle',
      source: 'robustness-focus-endpoints',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4.5, 13, 6.5, 16, 8],
        'circle-color': ['get', 'lineColor'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2.5,
      },
    });
  }
}

/**
 * Reads road, park, and cycle-route names already rendered on the MapLibre canvas along a branch.
 * Requires zero network requests and gracefully returns an empty array when zoomed out.
 */
export function queryBranchMapLabels(
  map: maplibregl.Map,
  coordinates: [number, number][],
): string[] {
  if (coordinates.length < 2) return [];
  const canvas = map.getCanvas();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w <= 0 || h <= 0) return [];

  const cycleRefs: string[] = [];
  const placeNames: string[] = [];
  const roadNames: string[] = [];
  const seen = new Set<string>();

  const pushUnique = (target: string[], raw: unknown) => {
    if (typeof raw !== 'string') return;
    const s = raw.trim();
    if (!s || s.length > 42) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    target.push(s);
  };

  const fracs = [0.22, 0.38, 0.5, 0.62, 0.78];
  for (const f of fracs) {
    const idx = Math.min(coordinates.length - 1, Math.max(0, Math.floor((coordinates.length - 1) * f)));
    const pt = map.project(coordinates[idx]);
    if (pt.x < 0 || pt.y < 0 || pt.x > w || pt.y > h) continue;
    const box: [[number, number], [number, number]] = [
      [Math.max(0, pt.x - 10), Math.max(0, pt.y - 10)],
      [Math.min(w, pt.x + 10), Math.min(h, pt.y + 10)],
    ];
    const feats = map.queryRenderedFeatures(box);
    for (const feat of feats) {
      const layerId = feat.layer?.id || '';
      if (layerId.startsWith('robustness-') || layerId.startsWith('route')) continue;
      const props = (feat.properties || {}) as Record<string, unknown>;
      const srcLayer = String((feat as unknown as { sourceLayer?: string }).sourceLayer || '').toLowerCase();
      if (layerId.includes('cycle') || srcLayer.includes('cycle')) {
        pushUnique(cycleRefs, props.ref || props.name);
      } else if (
        srcLayer.includes('park') ||
        srcLayer.includes('landuse') ||
        srcLayer.includes('landcover') ||
        srcLayer.includes('poi')
      ) {
        const cls = String(props.class || '').toLowerCase();
        if (['park', 'wood', 'forest', 'common', 'heath', 'nature_reserve', 'garden', 'recreation_ground'].includes(cls)) {
          pushUnique(placeNames, props['name:en'] || props.name);
        }
      } else if (srcLayer.includes('transport') || layerId.includes('road') || layerId.includes('path')) {
        pushUnique(roadNames, props['name:en'] || props.name || props.ref);
      }
    }
  }

  return [...cycleRefs.slice(0, 2), ...placeNames.slice(0, 2), ...roadNames.slice(0, 2)].slice(0, 3);
}
