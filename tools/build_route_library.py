#!/usr/bin/env python3
"""Build static frontend Route Library JSON assets from data/routes.db.

Outputs:
  - web/public/route-library/index.json
  - web/public/route-library/tracks/<source-slug>.json
"""

from __future__ import annotations

import html
import json
import math
import re
import sqlite3
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "routes.db"
OUT_DIR = ROOT / "web" / "public" / "route-library"
TRACKS_DIR = OUT_DIR / "tracks"

# 5x5 degree .rd5 tiles available in the UK and Ireland routing coverage.
UK_SEGMENTS = {
    "W15_N50",
    "W10_N50",
    "W10_N55",
    "W5_N50",
    "W5_N55",
    "W5_N60",
    "E0_N50",
}

RDP_TOLERANCE_M = 18.0

IGNORED_STOP_TYPES = {
    "CoursePoint:Left",
    "CoursePoint:Right",
    "CoursePoint:Straight",
    "CoursePoint:Generic",
    "Dot",
    "Flag",
    "Flag, Blue",
    "caution",
    "generic",
    "parking",
    "restroom",
    "segment_end",
    "segment_start",
}

STOP_KIND_MAP = {
    "cafe": "cafe",
    "cafe/control": "cafe",
    "coffee": "cafe",
    "CoursePoint:Food": "food",
    "food": "food",
    "refreshment": "food",
    "control/refreshment": "control",
    "control": "control",
    "pub": "pub",
    "bar": "pub",
    "winery": "pub",
    "ferry": "ferry",
    "camping": "camp",
    "lodging": "stay",
    "summit": "summit",
    "climb": "summit",
    "viewpoint": "view",
    "bike_shop": "bike",
    "water": "water",
    "rest_stop": "stop",
    "aid_station": "stop",
    "convenience_store": "shop",
    "shopping": "shop",
    "village": "place",
    "landmark": "place",
    "monument": "place",
    "park": "place",
    "transit": "transit",
}

REGION_LABELS = {
    "london": "London",
    "southern-england": "South England",
    "west-country": "South West",
    "central-england": "Central England",
    "northern-england": "North England",
    "wales": "Wales",
    "scotland": "Scotland",
    "ireland": "Ireland",
    "england": "England",
    "uk": "UK",
}


def segment_name(lon: float, lat: float) -> str:
    base_lon = math.floor(lon / 5.0) * 5
    base_lat = math.floor(lat / 5.0) * 5
    slon = f"W{-base_lon}" if base_lon < 0 else f"E{base_lon}"
    slat = f"S{-base_lat}" if base_lat < 0 else f"N{base_lat}"
    return f"{slon}_{slat}"


def parse_gpx_points(gpx_xml: str) -> list[tuple[float, float]]:
    try:
        root = ET.fromstring(gpx_xml)
    except ET.ParseError:
        pts: list[tuple[float, float]] = []
        for tag in ("trkpt", "rtept", "wpt"):
            for m in re.finditer(
                rf'<{tag}\b[^>]*\blat=["\']([^"\']+)["\'][^>]*\blon=["\']([^"\']+)["\']',
                gpx_xml,
            ):
                pts.append((float(m.group(1)), float(m.group(2))))
            if len(pts) >= 2:
                break
        return pts

    for suffix in ("trkpt", "rtept", "wpt"):
        pts = []
        for el in root.iter():
            if el.tag.endswith(suffix):
                lat_s = el.attrib.get("lat")
                lon_s = el.attrib.get("lon")
                if lat_s is not None and lon_s is not None:
                    try:
                        lat = float(lat_s)
                        lon = float(lon_s)
                        if math.isfinite(lat) and math.isfinite(lon):
                            pts.append((lat, lon))
                    except ValueError:
                        continue
        if len(pts) >= 2:
            return pts
    return []


def rdp_simplify(points: list[tuple[float, float]], epsilon_m: float) -> list[tuple[float, float]]:
    if len(points) <= 2:
        return points

    mid_lat = points[len(points) // 2][0]
    cos_lat = math.cos(math.radians(mid_lat))
    m_per_deg_lat = 111_320.0
    m_per_deg_lon = 111_320.0 * cos_lat

    xy = [(lon * m_per_deg_lon, lat * m_per_deg_lat) for lat, lon in points]
    keep = [False] * len(points)
    keep[0] = True
    keep[-1] = True
    eps_sq = epsilon_m * epsilon_m

    stack: list[tuple[int, int]] = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        if end - start <= 1:
            continue
        x1, y1 = xy[start]
        x2, y2 = xy[end]
        dx = x2 - x1
        dy = y2 - y1
        seg_len_sq = dx * dx + dy * dy

        max_dist_sq = -1.0
        max_idx = -1
        for i in range(start + 1, end):
            px, py = xy[i]
            if seg_len_sq == 0.0:
                ddx = px - x1
                ddy = py - y1
            else:
                t = ((px - x1) * dx + (py - y1) * dy) / seg_len_sq
                if t < 0.0:
                    t = 0.0
                elif t > 1.0:
                    t = 1.0
                ddx = px - (x1 + t * dx)
                ddy = py - (y1 + t * dy)
            d_sq = ddx * ddx + ddy * ddy
            if d_sq > max_dist_sq:
                max_dist_sq = d_sq
                max_idx = i

        if max_dist_sq > eps_sq and max_idx != -1:
            keep[max_idx] = True
            stack.append((start, max_idx))
            stack.append((max_idx, end))

    return [pt for pt, k in zip(points, keep) if k]


def encode_signed(num: int) -> str:
    s = ~(num << 1) if num < 0 else (num << 1)
    chunks: list[str] = []
    while s >= 0x20:
        chunks.append(chr((0x20 | (s & 0x1F)) + 63))
        s >>= 5
    chunks.append(chr(s + 63))
    return "".join(chunks)


def encode_polyline5(points: list[tuple[float, float]]) -> str:
    out: list[str] = []
    prev_lat = 0
    prev_lon = 0
    for lat, lon in points:
        ilat = int(round(lat * 1e5))
        ilon = int(round(lon * 1e5))
        out.append(encode_signed(ilat - prev_lat))
        out.append(encode_signed(ilon - prev_lon))
        prev_lat = ilat
        prev_lon = ilon
    return "".join(out)


def clean_text(raw: str | None, max_len: int = 240) -> str:
    if not raw:
        return ""
    txt = html.unescape(raw)
    txt = re.sub(r"<[^>]+>", " ", txt)
    txt = txt.replace("\u2014", ", ").replace("\u2013", "-")
    txt = re.sub(r"\s+", " ", txt).strip()
    if len(txt) <= max_len:
        return txt
    cut = txt[: max_len - 1].rsplit(" ", 1)[0].rstrip(".,;:")
    return f"{cut}..."


def clean_route_name(source_slug: str, external_id: str, raw_name: str) -> str:
    if source_slug == "cambridge-audax":
        slug = re.sub(r"-20\d\d(?=-|$)", "", external_id)
        words = slug.split("-")
        small = {"of", "the", "to", "and", "in"}
        titled = [
            w.capitalize() if (i == 0 or w not in small) else w
            for i, w in enumerate(words)
        ]
        return " ".join(titled)

    name = html.unescape(raw_name).strip()
    name = name.replace("\u2014", "-").replace("\u2013", "-")
    name = re.sub(r"\s*-\s*GPX and map\s*$", "", name, flags=re.IGNORECASE)
    name = re.sub(r"\s+", " ", name)
    return name


def format_county(slug: str) -> str:
    return " ".join(w.capitalize() for w in slug.split("-"))


def derive_region(tags: list[str], source_region: str | None) -> str:
    counties = [
        format_county(t[7:])
        for t in tags
        if t.startswith("county:") and t[7:]
    ]
    regions = [
        REGION_LABELS.get(t[7:], format_county(t[7:]))
        for t in tags
        if t.startswith("region:") and t[7:] not in ("uk", "blog")
    ]
    if counties:
        return ", ".join(counties[:2])
    if regions:
        return regions[0]
    if source_region:
        cleaned = source_region.split("(")[0].replace("&", "and").strip()
        return cleaned
    return "UK"


def derive_surface(tags: list[str], source_cat: str | None) -> str:
    tag_set = set(tags)
    if "traffic-free" in tag_set:
        return "traffic-free"
    if "gravel" in tag_set or "off-road" in tag_set or "mtb" in tag_set:
        if "on-road" in tag_set or "mixed-surface" in tag_set:
            return "mixed"
        return "gravel"
    if "mixed-surface" in tag_set:
        return "mixed"
    if source_cat == "bikepacking-gravel" and "on-road" not in tag_set:
        return "gravel"
    return "road"


def derive_terrain(tags: list[str], km: float, asc: int | None) -> str | None:
    tag_set = set(tags)
    if "hilly" in tag_set:
        return "hilly"
    if "rolling" in tag_set:
        return "rolling"
    if "flat" in tag_set:
        return "flat"
    if asc is not None and km > 1.0:
        ratio = asc / km
        if ratio >= 13.0:
            return "hilly"
        if ratio >= 7.0:
            return "rolling"
        return "flat"
    return None


def clean_stops(raw_stops: str | None) -> list[dict]:
    if not raw_stops:
        return []
    try:
        items = json.loads(raw_stops)
    except json.JSONDecodeError:
        return []
    if not isinstance(items, list):
        return []

    out: list[dict] = []
    seen_names: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        raw_type = str(item.get("type") or "").strip()
        if (
            raw_type in IGNORED_STOP_TYPES
            or raw_type.startswith("images/")
            or raw_type.startswith("http")
        ):
            continue
        role = clean_text(str(item.get("role") or ""), 48)
        if role.lower() == "route note":
            continue
        name = clean_text(str(item.get("name") or ""), 64)
        if not name or "ridewithgps.com" in name.lower():
            continue
        if name.lower() in ("recommended cafe stops", "caution") or name.lower().startswith("leave ncn"):
            continue
        norm = name.lower()
        if norm in seen_names:
            continue
        seen_names.add(norm)

        entry: dict = {"name": name}
        kind = STOP_KIND_MAP.get(raw_type)
        if kind:
            entry["kind"] = kind
        if role and role.lower() not in ("start", "finish", "start and finish"):
            entry["role"] = role
        lat = item.get("lat")
        lon = item.get("lon")
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
            if math.isfinite(lat) and math.isfinite(lon):
                entry["pos"] = [round(float(lon), 5), round(float(lat), 5)]
        out.append(entry)
        if len(out) >= 8:
            break
    return out


def alias_penalty(external_id: str) -> tuple[int, int]:
    lower = external_id.lower()
    is_alias = int(
        "test" in lower
        or lower.startswith("gdn")
        or lower == "ctc"
    )
    return (is_alias, len(external_id))


def main() -> None:
    if not DB_PATH.exists():
        raise SystemExit(f"Missing database at {DB_PATH}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    TRACKS_DIR.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    sources_by_id = {
        row["id"]: dict(row)
        for row in conn.execute("SELECT * FROM sources ORDER BY id")
    }

    raw_rows = conn.execute(
        """
        SELECT id, source_id, external_id, name, route_url, gpx_url,
               description, stops, tags, distance_km, elevation_gain_m,
               start_lat, start_lon, min_lat, min_lon, max_lat, max_lon,
               is_loop, gpx_xml
        FROM routes
        WHERE min_lat >= 50.0 AND max_lat < 65.0
          AND min_lon >= -15.0 AND max_lon < 5.0
          AND distance_km >= 2.0
        ORDER BY id
        """
    ).fetchall()

    # Deduplicate exact alias entries within the same source.
    best_by_key: dict[tuple[int, str, float], sqlite3.Row] = {}
    for row in raw_rows:
        src = sources_by_id[row["source_id"]]
        slug = src["slug"]
        gpx_url = row["gpx_url"] or ""
        if slug == "cambridge-audax" and "CB_STN_GIRTON" in gpx_url:
            continue
        cleaned_name = clean_route_name(slug, row["external_id"], row["name"])
        dedup_key = (row["source_id"], cleaned_name.lower(), round(float(row["distance_km"]), 1))
        prev = best_by_key.get(dedup_key)
        if prev is None or alias_penalty(row["external_id"]) < alias_penalty(prev["external_id"]):
            best_by_key[dedup_key] = row

    routes_out: list[dict] = []
    tracks_by_source: dict[str, dict[str, str]] = {}
    counts_by_source: dict[str, int] = {}

    for row in sorted(best_by_key.values(), key=lambda r: r["id"]):
        src = sources_by_id[row["source_id"]]
        slug = src["slug"]
        pts = parse_gpx_points(row["gpx_xml"])
        if len(pts) < 2:
            continue

        # Ensure every coordinate sits inside available .rd5 UK and Ireland tiles.
        if any(segment_name(lon, lat) not in UK_SEGMENTS for lat, lon in pts):
            continue

        simplified = rdp_simplify(pts, RDP_TOLERANCE_M)
        encoded = encode_polyline5(simplified)

        tags = json.loads(row["tags"]) if row["tags"] else []
        km = round(float(row["distance_km"]), 1)
        raw_asc = row["elevation_gain_m"]
        asc = int(round(float(raw_asc))) if raw_asc and float(raw_asc) > 0 else None

        name = clean_route_name(slug, row["external_id"], row["name"])
        surf = derive_surface(tags, src["category"])
        ter = derive_terrain(tags, km, asc)
        is_multiday = (
            "multi-day" in tags
            or "bikepacking" in tags
            or "overnighter" in tags
        )
        reg = derive_region(tags, src["region"])
        desc = clean_text(row["description"], 220)
        stops = clean_stops(row["stops"])

        route_item: dict = {
            "id": row["id"],
            "src": slug,
            "name": name,
            "km": km,
            "asc": asc,
            "loop": bool(row["is_loop"]),
            "surf": surf,
            "reg": reg,
            "bbox": [
                round(float(row["min_lon"]), 4),
                round(float(row["min_lat"]), 4),
                round(float(row["max_lon"]), 4),
                round(float(row["max_lat"]), 4),
            ],
            "start": [
                round(float(pts[0][1]), 4),
                round(float(pts[0][0]), 4),
            ],
        }
        if ter:
            route_item["ter"] = ter
        if is_multiday:
            route_item["multi"] = True
        if row["route_url"] and str(row["route_url"]).startswith("http"):
            route_item["url"] = str(row["route_url"])
        if desc:
            route_item["desc"] = desc
        if stops:
            route_item["stops"] = stops

        routes_out.append(route_item)
        tracks_by_source.setdefault(slug, {})[str(row["id"])] = encoded
        counts_by_source[slug] = counts_by_source.get(slug, 0) + 1

    # Remove stale shard files if any.
    for existing in TRACKS_DIR.glob("*.json"):
        if existing.stem not in tracks_by_source:
            existing.unlink()

    for slug, shard in tracks_by_source.items():
        shard_path = TRACKS_DIR / f"{slug}.json"
        shard_path.write_text(
            json.dumps(shard, separators=(",", ":"), ensure_ascii=False),
            encoding="utf-8",
        )

    sources_out = []
    for src in sorted(
        sources_by_id.values(),
        key=lambda s: (-counts_by_source.get(s["slug"], 0), s["name"]),
    ):
        slug = src["slug"]
        cnt = counts_by_source.get(slug, 0)
        if cnt == 0:
            continue
        sources_out.append(
            {
                "slug": slug,
                "name": clean_text(src["name"], 80),
                "category": src["category"] or "collection",
                "region": clean_text(src["region"], 80),
                "url": src["url"] or "",
                "license": clean_text(src["license_or_provenance"], 120),
                "count": cnt,
            }
        )

    index_payload = {
        "version": 1,
        "sources": sources_out,
        "routes": routes_out,
    }
    index_path = OUT_DIR / "index.json"
    index_path.write_text(
        json.dumps(index_payload, separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )

    print(
        f"Built {len(routes_out)} routes across {len(sources_out)} sources -> {index_path.relative_to(ROOT)} "
        f"({index_path.stat().st_size / 1024:.1f} KB)"
    )


if __name__ == "__main__":
    main()
