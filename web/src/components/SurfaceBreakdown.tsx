import React, { useMemo, useCallback, useState, useEffect } from 'react';
import type { Profile } from '../utils/geo.ts';
import { nearestIndex } from '../utils/geo.ts';
import type { SegmentHighlight, SegmentData } from '../utils/classification.ts';
import {
  classifySurface,
  classifySurfaceSubclass,
  classifyRoadGroup,
  classifyRoad,
  classifyArea,
  classifyAreaSubclass,
  classifyTraffic,
  classifyTrafficSubclass,
  classifyNoise,
  classifyNoiseSubclass,
  classifySpeedLimit,
  buildCostBreakdown,
  SURFACE_META,
  SURFACE_SUB_META,
  ROAD_GROUP_META,
  ROAD_META,
  AREA_META,
  AREA_SUB_META,
  TRAFFIC_META,
  TRAFFIC_SUB_META,
  NOISE_META,
  NOISE_SUB_META,
  SPEED_LIMIT_META,
} from '../utils/classification.ts';
import { formatDistance, type Units } from '../format.ts';
import { InfoButton } from './TooltipPopover.tsx';

export type BreakdownBarId = 'surface' | 'road' | 'area' | 'traffic' | 'noise' | 'speed' | 'cost';

export const BREAKDOWN_BAR_OPTIONS: Array<{ id: BreakdownBarId; label: string; title: string }> = [
  { id: 'surface', label: 'Surface', title: 'Toggle Surface breakdown bar' },
  { id: 'road', label: 'Road', title: 'Toggle Road Type breakdown bar' },
  { id: 'area', label: 'Area', title: 'Toggle Urban / Countryside / Park breakdown bar' },
  { id: 'traffic', label: 'Traffic', title: 'Toggle Traffic breakdown bar' },
  { id: 'noise', label: 'Noise', title: 'Toggle Noise breakdown bar' },
  { id: 'speed', label: 'Limit', title: 'Toggle Speed Limit breakdown bar' },
  { id: 'cost', label: 'Cost', title: 'Toggle Cost Factor breakdown bar' },
];

export const DEFAULT_BREAKDOWN_BARS: BreakdownBarId[] = [
  'surface',
  'road',
  'area',
  'traffic',
  'cost',
];

interface SurfaceBreakdownProps {
  slotIdx?: number;
  profile: Profile | null;
  segments: SegmentData[];
  units: Units;
  visibleBars?: BreakdownBarId[];
  onHover: (pos: { lon: number; lat: number } | null) => void;
  onHighlightSegment: (highlight: SegmentHighlight | null) => void;
}

interface StackedBarProps<T extends string, S extends string = T> {
  rowKey: string;
  title: string;
  tooltip: string;
  ariaLabel: string;
  totalDist: number;
  segments: SegmentData[];
  classifier: (s: SegmentData) => T;
  meta: Record<T, { label: string; color: string }>;
  subClassifier?: (s: SegmentData) => S;
  subMeta?: Record<S, { label: string; parent: T; color: string }>;
  profile: Profile | null;
  pinnedKey: string | null;
  onTogglePin: (key: string, highlight: SegmentHighlight) => void;
  onHover: (pos: { lon: number; lat: number } | null) => void;
  onHighlightSegment: (highlight: SegmentHighlight | null) => void;
}

function StackedBarRow<T extends string, S extends string = T>({
  rowKey,
  title,
  tooltip,
  ariaLabel,
  totalDist,
  segments,
  classifier,
  meta,
  subClassifier,
  subMeta,
  profile,
  pinnedKey,
  onTogglePin,
  onHover,
  onHighlightSegment,
}: StackedBarProps<T, S>) {
  const { merged, categoryTotals, subMerged, subTotals } = useMemo(() => {
    const totals: Partial<Record<T, number>> = {};
    const sTotals: Partial<Record<S, number>> = {};
    const m: Array<{ from: number; to: number; category: T; subCategory?: S }> = [];
    const sm: Array<{ from: number; to: number; subCategory: S }> = [];

    for (const s of segments) {
      const len = Math.max(0, s.to - s.from);
      if (len === 0) continue;
      const cat = classifier(s);
      const subCat = subClassifier ? subClassifier(s) : undefined;
      totals[cat] = (totals[cat] || 0) + len;
      if (subCat !== undefined) {
        sTotals[subCat] = (sTotals[subCat] || 0) + len;
      }

      if (
        m.length > 0 &&
        m[m.length - 1].category === cat &&
        m[m.length - 1].subCategory === subCat
      ) {
        m[m.length - 1].to = s.to;
      } else {
        m.push({ from: s.from, to: s.to, category: cat, subCategory: subCat });
      }

      if (subCat !== undefined) {
        if (sm.length > 0 && sm[sm.length - 1].subCategory === subCat) {
          sm[sm.length - 1].to = s.to;
        } else {
          sm.push({ from: s.from, to: s.to, subCategory: subCat });
        }
      }
    }
    return { merged: m, categoryTotals: totals, subMerged: sm, subTotals: sTotals };
  }, [segments, classifier, subClassifier]);

  const segmentCoordinates = useCallback(
    (fromM: number, toM: number): number[][] => {
      if (!profile || profile.coords.length < 2) return [];
      let i0 = nearestIndex(profile.dist, fromM);
      let i1 = nearestIndex(profile.dist, toM);
      if (i1 <= i0) {
        if (i0 < profile.coords.length - 1) {
          i1 = i0 + 1;
        } else {
          i0 = Math.max(0, profile.coords.length - 2);
          i1 = profile.coords.length - 1;
        }
      }
      return profile.coords.slice(i0, i1 + 1).map((pt) => [pt[0], pt[1]]);
    },
    [profile],
  );

  const buildCategoryHighlight = useCallback(
    (cat: T): SegmentHighlight | null => {
      const allCoords: number[][][] = [];
      for (const s of merged) {
        if (s.category === cat) {
          const c = segmentCoordinates(s.from, s.to);
          if (c.length >= 2) allCoords.push(c);
        }
      }
      if (allCoords.length === 0) return null;
      return {
        coordinates: allCoords,
        color: meta[cat].color,
      };
    },
    [merged, meta, segmentCoordinates],
  );

  const buildSubCategoryHighlight = useCallback(
    (subCat: S): SegmentHighlight | null => {
      if (!subMeta) return null;
      const allCoords: number[][][] = [];
      for (const s of subMerged) {
        if (s.subCategory === subCat) {
          const c = segmentCoordinates(s.from, s.to);
          if (c.length >= 2) allCoords.push(c);
        }
      }
      if (allCoords.length === 0) return null;
      return {
        coordinates: allCoords,
        color: subMeta[subCat].color,
      };
    },
    [subMerged, subMeta, segmentCoordinates],
  );

  const handleBarPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!profile) return;
    const box = e.currentTarget.getBoundingClientRect();
    const total = profile.dist[profile.dist.length - 1] || 1;
    const d = Math.min(total, Math.max(0, ((e.clientX - box.left) / box.width) * total));
    const i = nearestIndex(profile.dist, d);
    onHover({ lon: profile.coords[i][0], lat: profile.coords[i][1] });
  };

  const handleBarPointerLeave = () => {
    onHover(null);
    onHighlightSegment(null);
  };

  const cats = (Object.keys(meta) as T[]).filter((c) => (categoryTotals[c] || 0) > 0);
  const allSubKeys = subMeta ? (Object.keys(subMeta) as S[]) : [];

  // Determine which parent class is currently expanded (via pinned class or pinned subclass)
  let expandedParent: T | null = null;
  if (subMeta && pinnedKey && pinnedKey.startsWith(`${rowKey}:`)) {
    const rest = pinnedKey.slice(rowKey.length + 1);
    if (rest.startsWith('sub:')) {
      const subKey = rest.slice(4) as S;
      if (subMeta[subKey]) expandedParent = subMeta[subKey].parent;
    } else if (meta[rest as T]) {
      expandedParent = rest as T;
    }
  }

  const expandedSubCats =
    subMeta && expandedParent
      ? allSubKeys.filter((sk) => subMeta[sk].parent === expandedParent && (subTotals[sk] || 0) > 0)
      : [];

  return (
    <div className="profile-bar-row">
      <div className="profile-bar-header">
        <span className="profile-bar-title">
          {title} <InfoButton tooltip={tooltip} ariaLabel={ariaLabel} />
        </span>
        <div className="profile-bar-legend">
          {cats.map((cat) => {
            const dist = categoryTotals[cat] || 0;
            const pct = Math.round((dist / totalDist) * 100);
            if (pct < 1) return null;
            const itemKey = `${rowKey}:${cat}`;
            const isPinned = pinnedKey === itemKey || expandedParent === cat;
            const childSubs = subMeta
              ? allSubKeys
                  .filter((sk) => subMeta[sk].parent === cat && (subTotals[sk] || 0) > 0)
                  .map((sk) => {
                    const sd = subTotals[sk] || 0;
                    const sp = Math.round((sd / totalDist) * 100);
                    return `${subMeta[sk].label} ${sp}%`;
                  })
                  .join(', ')
              : '';

            return (
              <span
                key={cat}
                role="button"
                tabIndex={0}
                className={`surface-legend-item ${isPinned ? 'active' : ''}`}
                title={`${meta[cat].label}: ${formatDistance(dist)} (${pct}%)${childSubs ? ` — ${childSubs}` : ''} (Click to ${subMeta ? 'inspect subclasses & ' : ''}pin on map)`}
                onPointerEnter={() => {
                  const hl = buildCategoryHighlight(cat);
                  if (hl) onHighlightSegment(hl);
                }}
                onPointerLeave={() => onHighlightSegment(null)}
                onClick={() => {
                  const hl = buildCategoryHighlight(cat);
                  if (hl) onTogglePin(itemKey, hl);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    const hl = buildCategoryHighlight(cat);
                    if (hl) onTogglePin(itemKey, hl);
                  }
                }}
              >
                <span className="surface-swatch" style={{ backgroundColor: meta[cat].color }}></span>
                <span>{`${meta[cat].label} ${pct}%`}</span>
              </span>
            );
          })}
        </div>
      </div>

      <div
        className="surface-bar"
        role="img"
        aria-label={ariaLabel}
        onPointerMove={handleBarPointerMove}
        onPointerLeave={handleBarPointerLeave}
      >
        {merged.map((seg, i) => {
          const widthPct = Math.max(0.1, ((seg.to - seg.from) / totalDist) * 100);
          const subLabel =
            subMeta && seg.subCategory !== undefined ? ` › ${subMeta[seg.subCategory].label}` : '';
          return (
            <div
              key={i}
              className="surface-segment"
              style={{
                width: `${widthPct.toFixed(2)}%`,
                backgroundColor: meta[seg.category].color,
              }}
              title={`${meta[seg.category].label}${subLabel}: ${formatDistance(seg.to - seg.from)}`}
              onPointerEnter={() => {
                const coords = segmentCoordinates(seg.from, seg.to);
                if (coords.length >= 2) {
                  onHighlightSegment({
                    coordinates: [coords],
                    color: meta[seg.category].color,
                  });
                }
              }}
            />
          );
        })}
      </div>

      {subMeta && expandedParent && expandedSubCats.length > 0 && (
        <div className="surface-subclass-row" role="group" aria-label={`${meta[expandedParent].label} subclasses`}>
          <span className="surface-subclass-label">{meta[expandedParent].label}:</span>
          {expandedSubCats.map((subCat) => {
            const dist = subTotals[subCat] || 0;
            const pct = Math.max(1, Math.round((dist / totalDist) * 100));
            const subItemKey = `${rowKey}:sub:${subCat}`;
            const isSubPinned = pinnedKey === subItemKey;
            return (
              <span
                key={subCat}
                role="button"
                tabIndex={0}
                className={`surface-legend-item surface-subclass-item ${isSubPinned ? 'active' : ''}`}
                title={`${subMeta[subCat].label}: ${formatDistance(dist)} (${pct}%) — Click to pin subclass on map`}
                onPointerEnter={() => {
                  const hl = buildSubCategoryHighlight(subCat);
                  if (hl) onHighlightSegment(hl);
                }}
                onPointerLeave={() => onHighlightSegment(null)}
                onClick={() => {
                  const hl = buildSubCategoryHighlight(subCat);
                  if (hl) onTogglePin(subItemKey, hl);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    const hl = buildSubCategoryHighlight(subCat);
                    if (hl) onTogglePin(subItemKey, hl);
                  }
                }}
              >
                <span className="surface-swatch" style={{ backgroundColor: subMeta[subCat].color }}></span>
                <span>{`${subMeta[subCat].label} ${formatDistance(dist)} (${pct}%)`}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const SurfaceBreakdown: React.FC<SurfaceBreakdownProps> = ({
  slotIdx = 0,
  profile,
  segments,
  units: _units,
  visibleBars = DEFAULT_BREAKDOWN_BARS,
  onHover,
  onHighlightSegment,
}) => {
  const [pinned, setPinned] = useState<{ key: string; highlight: SegmentHighlight } | null>(null);

  useEffect(() => {
    setPinned(null);
  }, [profile, segments]);

  const handleHighlight = useCallback(
    (hl: SegmentHighlight | null) => {
      if (hl) {
        onHighlightSegment(hl);
      } else {
        onHighlightSegment(pinned ? pinned.highlight : null);
      }
    },
    [onHighlightSegment, pinned],
  );

  const handleTogglePin = useCallback(
    (key: string, highlight: SegmentHighlight) => {
      setPinned((prev) => {
        if (prev?.key === key) {
          onHighlightSegment(null);
          return null;
        }
        onHighlightSegment(highlight);
        return { key, highlight };
      });
    },
    [onHighlightSegment],
  );

  const costBreakdown = useMemo(() => buildCostBreakdown(segments), [segments]);
  const visibleSet = useMemo(() => new Set<BreakdownBarId>(visibleBars), [visibleBars]);

  if (!profile || segments.length === 0) return null;
  const total = profile.dist[profile.dist.length - 1] || 1;
  const domId = slotIdx === 0 ? 'surface-section' : `surface-section-${slotIdx}`;

  return (
    <div id={domId} className="surface-section">
      {visibleSet.has('surface') && (
        <StackedBarRow
          rowKey="surface"
          title="Surface"
          tooltip="OpenStreetMap surface=* classes: Paved (asphalt, paved, concrete), Cobbles (paving_stones, sett, cobblestone), Unpaved (compacted, gravel, dirt, grass, mud, wood), and Untagged. Click any class chip to expand its subclasses."
          ariaLabel="Surface types"
          totalDist={total}
          segments={segments}
          classifier={(s) => classifySurface(s.surface, s.highway)}
          meta={SURFACE_META}
          subClassifier={(s) => classifySurfaceSubclass(s.surface, s.highway)}
          subMeta={SURFACE_SUB_META}
          profile={profile}
          pinnedKey={pinned?.key ?? null}
          onTogglePin={handleTogglePin}
          onHover={onHover}
          onHighlightSegment={handleHighlight}
        />
      )}
      {visibleSet.has('road') && (
        <StackedBarRow
          rowKey="road"
          title="Road type"
          tooltip="UK OpenStreetMap highway=* classes: Paths (cycleway, footway, path, bridleway, pedestrian), Tracks (highway=track), Small Roads (C-roads/tertiary, unclassified, residential, service), B-Roads (secondary), A-Roads (primary non-primary A-roads and trunk primary A-roads), and Motorways (motorway). Click any class chip to expand its subclasses."
          ariaLabel="Road types"
          totalDist={total}
          segments={segments}
          classifier={(s) => classifyRoadGroup(s.highway)}
          meta={ROAD_GROUP_META}
          subClassifier={(s) => classifyRoad(s.highway)}
          subMeta={ROAD_META}
          profile={profile}
          pinnedKey={pinned?.key ?? null}
          onTogglePin={handleTogglePin}
          onHover={onHover}
          onHighlightSegment={handleHighlight}
        />
      )}
      {visibleSet.has('area') && (
        <StackedBarRow
          rowKey="area"
          title="Area"
          tooltip="Urban vs Countryside / Park from BRouter estimated_town_class=1..6, OpenStreetMap lit=*, sidewalk=*, and residential streets: Countryside / Park (unlit non-residential without sidewalks and town class 0) vs Urban (town class 1–6, lit=yes, sidewalk present, or residential). Click any class chip to expand its subclasses."
          ariaLabel="Urban and countryside areas"
          totalDist={total}
          segments={segments}
          classifier={(s) => classifyArea(s)}
          meta={AREA_META}
          subClassifier={(s) => classifyAreaSubclass(s)}
          subMeta={AREA_SUB_META}
          profile={profile}
          pinnedKey={pinned?.key ?? null}
          onTogglePin={handleTogglePin}
          onHover={onHover}
          onHighlightSegment={handleHighlight}
        />
      )}
      {visibleSet.has('traffic') && (
        <StackedBarRow
          rowKey="traffic"
          title="Traffic"
          tooltip="Estimated motor vehicle volume from BRouter estimated_traffic_class=0..7: Quiet (classes 0–2, where 0 is unmodelled paths and local roads), Fair (class 3), Busy (classes 4–5), and Heavy (classes 6–7). Click any class chip to expand its subclasses."
          ariaLabel="Traffic levels"
          totalDist={total}
          segments={segments}
          classifier={(s) => classifyTraffic(s.traffic, s.highway)}
          meta={TRAFFIC_META}
          subClassifier={(s) => classifyTrafficSubclass(s.traffic, s.highway)}
          subMeta={TRAFFIC_SUB_META}
          profile={profile}
          pinnedKey={pinned?.key ?? null}
          onTogglePin={handleTogglePin}
          onHover={onHover}
          onHighlightSegment={handleHighlight}
        />
      )}
      {visibleSet.has('noise') && (
        <StackedBarRow
          rowKey="noise"
          title="Noise"
          tooltip="Modeled noise exposure from BRouter estimated_noise_class=0..6: Quiet (classes 0–2, where 0 is unmodelled outside the 64 m noise buffer of major roads), Moderate (classes 3–4), and Loud (classes 5–6). Click any class chip to expand its subclasses."
          ariaLabel="Noise levels"
          totalDist={total}
          segments={segments}
          classifier={(s) => classifyNoise(s.noise)}
          meta={NOISE_META}
          subClassifier={(s) => classifyNoiseSubclass(s.noise)}
          subMeta={NOISE_SUB_META}
          profile={profile}
          pinnedKey={pinned?.key ?? null}
          onTogglePin={handleTogglePin}
          onHover={onHover}
          onHighlightSegment={handleHighlight}
        />
      )}
      {visibleSet.has('speed') && (
        <StackedBarRow
          rowKey="speed"
          title="Limit (mph)"
          tooltip="Posted motor vehicle speed limits (mph) from OpenStreetMap maxspeed=* tags, plus car-free tracks and cycle paths."
          ariaLabel="Speed limits in mph"
          totalDist={total}
          segments={segments}
          classifier={(s) => classifySpeedLimit(s.maxspeed, s.highway)}
          meta={SPEED_LIMIT_META}
          profile={profile}
          pinnedKey={pinned?.key ?? null}
          onTogglePin={handleTogglePin}
          onHover={onHover}
          onHighlightSegment={handleHighlight}
        />
      )}
      {visibleSet.has('cost') && (
        <StackedBarRow
          rowKey="cost"
          title="Cost (×)"
          tooltip="BRouter way cost factor multiplier ([0, 1.2], (1.2, 1.8], (1.8, 2.4], (2.4, 3.0], (3.0, ∞)). 1.0× equals an ideal road or path; hover any segment to see its exact multiplier or click a class chip to inspect its exact cost subclasses."
          ariaLabel="Cost factor breakdown"
          totalDist={total}
          segments={segments}
          classifier={costBreakdown.classifier}
          meta={costBreakdown.meta}
          subClassifier={costBreakdown.subClassifier}
          subMeta={costBreakdown.subMeta}
          profile={profile}
          pinnedKey={pinned?.key ?? null}
          onTogglePin={handleTogglePin}
          onHover={onHover}
          onHighlightSegment={handleHighlight}
        />
      )}
    </div>
  );
};
