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
    ...slotOrder.flatMap((idx) => slotLayerIds(idx)),
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
    const topPad = isControlsExpanded ? Math.min(260, (controlsEl?.offsetHeight || 200) + 24) : 72;
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
