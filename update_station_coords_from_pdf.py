#!/usr/bin/env python3
"""Extract station dot coordinates from paris_map.pdf and update MySQL.

The script reads station names from the `stations` table, finds the matching
station label in the PDF, then stores the nearby map dot center as `x, y`.
Coordinates use the PDF/page coordinate space with (0, 0) at the top-left,
which is convenient for later D3 rendering.
"""

from __future__ import annotations

import argparse
import math
import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import pdfplumber
import pymysql


PDF_PATH = Path("/Users/xyu/Desktop/paris_map.pdf")

DB_CONFIG = {
    "host": "localhost",
    "user": "root",
    "password": "test001**",
    "database": "paris_map",
    "charset": "utf8mb4",
}

# The left side of this PDF contains indexes/legends. The actual map starts at
# about x=538, so ignore text and dots before that line.
MAP_MIN_X = 538.0

STOP_WORDS = {
    "a",
    "au",
    "aux",
    "d",
    "de",
    "des",
    "du",
    "l",
    "la",
    "le",
    "les",
    "en",
    "et",
}


@dataclass(frozen=True)
class Station:
    id: int
    name: str
    name2: str | None


@dataclass(frozen=True)
class TextBox:
    text: str
    norm: str
    x0: float
    x1: float
    top: float
    bottom: float
    source: str

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cy(self) -> float:
        return (self.top + self.bottom) / 2


@dataclass
class Dot:
    x: float
    y: float
    size: float
    count: int
    colors: tuple[tuple[float, ...], ...] = ()


@dataclass(frozen=True)
class Match:
    station: Station
    label: TextBox
    dot: Dot
    distance: float
    confidence: str
    score: float = 0.0
    color_distance: float | None = None


LINE_COLORS = {
    "METRO:1": "#ffcd00",
    "METRO:2": "#003ca6",
    "METRO:3": "#837902",
    "METRO:3b": "#6ec4e8",
    "METRO:4": "#cf009e",
    "METRO:5": "#ff7e2e",
    "METRO:6": "#6eca97",
    "METRO:7": "#fa9aba",
    "METRO:7b": "#6eca97",
    "METRO:8": "#e19bdf",
    "METRO:9": "#b6bd00",
    "METRO:10": "#c9910d",
    "METRO:11": "#704b1c",
    "METRO:12": "#007852",
    "METRO:13": "#6ec4e8",
    "METRO:14": "#62259d",
    "RER:A": "#e2231a",
    "RER:B": "#4b92db",
    "RER:C": "#f6c400",
    "RER:D": "#00a88f",
    "RER:E": "#c04191",
    "TRAM:1": "#0055a4",
    "TRAM:2": "#c6a500",
    "TRAM:3A": "#f28e1c",
    "TRAM:3B": "#00a88f",
    "TRAM:4": "#6f263d",
    "TRAM:5": "#7b6469",
    "TRAM:6": "#e4007c",
    "TRAM:7": "#6eca97",
    "TRAM:8": "#a05eb5",
    "TRAM:9": "#b6bd00",
    "TRAM:10": "#00a3e0",
    "TRAM:11": "#8dc63f",
    "TRAM:12": "#00a3e0",
    "TRAM:13": "#702082",
}

TYPE_COLORS = {
    "METRO": "#4a5568",
    "RER": "#2563eb",
    "TRAIN": "#64748b",
    "TRAM": "#0f766e",
    "TRAMWAY": "#0f766e",
    "NAVETTE": "#9333ea",
}


def normalize(value: str) -> str:
    value = value.replace("’", "'").replace("`", "'").replace("´", "'")
    value = unicodedata.normalize("NFKD", value)
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.casefold()
    value = value.replace("œ", "oe").replace("æ", "ae")
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def norm_tokens(value: str) -> list[str]:
    return normalize(value).split()


def unique_names(station: Station) -> list[str]:
    names: list[str] = []
    for raw in (station.name, station.name2):
        if not raw:
            continue
        cleaned = raw.strip()
        if cleaned and normalize(cleaned) not in {normalize(n) for n in names}:
            names.append(cleaned)
    return names


def fetch_stations() -> list[Station]:
    conn = pymysql.connect(**DB_CONFIG)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, name, name2 FROM stations ORDER BY id")
            return [Station(int(row[0]), row[1], row[2]) for row in cur.fetchall()]
    finally:
        conn.close()


def fetch_station_line_colors() -> dict[int, list[tuple[float, float, float, float]]]:
    conn = pymysql.connect(**DB_CONFIG)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT ls.station_id, l.type, l.code, l.color
                FROM line_stations ls
                JOIN line l ON l.id = ls.line_id
                """
            )
            station_colors: defaultdict[int, list[tuple[float, float, float, float]]] = defaultdict(list)
            for station_id, line_type, code, color in cur.fetchall():
                hex_color = color or LINE_COLORS.get(f"{str(line_type).upper()}:{str(code).upper()}")
                hex_color = hex_color or TYPE_COLORS.get(str(line_type).upper())
                if hex_color:
                    station_colors[int(station_id)].append(hex_to_cmyk(hex_color))
            return station_colors
    finally:
        conn.close()


def update_matches(matches: Iterable[Match]) -> int:
    rows = [(m.dot.x, m.dot.y, m.station.id) for m in matches]
    if not rows:
        return 0
    conn = pymysql.connect(**DB_CONFIG)
    try:
        with conn.cursor() as cur:
            cur.executemany("UPDATE stations SET x=%s, y=%s WHERE id=%s", rows)
        conn.commit()
        return len(rows)
    finally:
        conn.close()


def hex_to_cmyk(hex_color: str) -> tuple[float, float, float, float]:
    value = hex_color.strip().lstrip("#")
    if len(value) != 6:
        return (0.0, 0.0, 0.0, 1.0)
    r = int(value[0:2], 16) / 255
    g = int(value[2:4], 16) / 255
    b = int(value[4:6], 16) / 255
    k = 1 - max(r, g, b)
    if k >= 1:
        return (0.0, 0.0, 0.0, 1.0)
    c = (1 - r - k) / (1 - k)
    m = (1 - g - k) / (1 - k)
    y = (1 - b - k) / (1 - k)
    return (c, m, y, k)


def is_useful_color(color) -> bool:
    if not isinstance(color, tuple) or len(color) != 4:
        return False
    # Ignore pure white/transparent fills and black outlines. Route colors are
    # the chromatic CMYK values carried by station marker objects.
    if math.dist(color, (0.0, 0.0, 0.0, 0.0)) < 0.08:
        return False
    if math.dist(color, (0.0, 0.0, 0.0, 1.0)) < 0.08:
        return False
    return True


def extract_dots(page) -> list[Dot]:
    raw: list[tuple[float, float, float, tuple[tuple[float, ...], ...]]] = []
    for obj in page.curves:
        if not obj.get("fill"):
            continue
        if obj["x0"] < MAP_MIN_X:
            continue
        width = float(obj["width"])
        height = float(obj["height"])
        if not 3.2 <= width <= 30.0 or not 3.2 <= height <= 30.0:
            continue
        ratio = width / height if height else 99.0
        if not 0.45 <= ratio <= 2.25:
            continue
        x = (obj["x0"] + obj["x1"]) / 2
        y = (obj["top"] + obj["bottom"]) / 2
        colors = []
        for key in ("stroking_color", "non_stroking_color"):
            color = obj.get(key)
            if is_useful_color(color):
                colors.append(tuple(float(v) for v in color))
        raw.append((x, y, max(width, height), tuple(colors)))

    # Many station dots are drawn as several concentric/overlapping circles.
    # Merge objects whose centers are essentially identical.
    clusters: list[list[tuple[float, float, float, tuple[tuple[float, ...], ...]]]] = []
    for item in raw:
        x, y, _, _ = item
        for cluster in clusters:
            cx = sum(v[0] for v in cluster) / len(cluster)
            cy = sum(v[1] for v in cluster) / len(cluster)
            if math.hypot(cx - x, cy - y) <= 1.8:
                cluster.append(item)
                break
        else:
            clusters.append([item])

    dots: list[Dot] = []
    for cluster in clusters:
        x = sum(v[0] for v in cluster) / len(cluster)
        y = sum(v[1] for v in cluster) / len(cluster)
        size = max(v[2] for v in cluster)
        colors = []
        for item in cluster:
            for color in item[3]:
                if color not in colors:
                    colors.append(color)
        dots.append(Dot(x=x, y=y, size=size, count=len(cluster), colors=tuple(colors)))
    return dots


def group_words_into_lines(words: list[dict]) -> list[list[dict]]:
    sorted_words = sorted(words, key=lambda w: (((w["top"] + w["bottom"]) / 2), w["x0"]))
    lines: list[list[dict]] = []
    line_centers: list[float] = []
    for word in sorted_words:
        cy = (word["top"] + word["bottom"]) / 2
        for idx, center in enumerate(line_centers):
            if abs(center - cy) <= 3.2:
                lines[idx].append(word)
                line_centers[idx] = (center * (len(lines[idx]) - 1) + cy) / len(lines[idx])
                break
        else:
            lines.append([word])
            line_centers.append(cy)
    for line in lines:
        line.sort(key=lambda w: w["x0"])
    return sorted(lines, key=lambda line: min(w["top"] for w in line))


def word_box(words: list[dict], text: str, source: str) -> TextBox | None:
    norm = normalize(text)
    if not norm:
        return None
    x0 = min(w["x0"] for w in words)
    x1 = max(w["x1"] for w in words)
    top = min(w["top"] for w in words)
    bottom = max(w["bottom"] for w in words)
    if x0 < MAP_MIN_X:
        return None
    return TextBox(text=text, norm=norm, x0=x0, x1=x1, top=top, bottom=bottom, source=source)


def extract_text_boxes(page) -> list[TextBox]:
    boxes: list[TextBox] = []

    # pdfplumber's direct search is good for normal single-line labels.
    # The word-window pass below catches labels that are split across lines.
    words = [
        w
        for w in page.extract_words(
            x_tolerance=3,
            y_tolerance=3,
            keep_blank_chars=False,
            use_text_flow=False,
        )
        if w["x0"] >= MAP_MIN_X and w["height"] >= 5.8
    ]

    lines = group_words_into_lines(words)
    line_windows: list[tuple[int, int, int, TextBox]] = []
    for line_idx, line in enumerate(lines):
        for start in range(len(line)):
            for end in range(start + 1, min(len(line), start + 7) + 1):
                window = line[start:end]
                # Avoid joining separate labels that have a clear gap.
                ok = True
                for left, right in zip(window, window[1:]):
                    if right["x0"] - left["x1"] > 18:
                        ok = False
                        break
                if not ok:
                    break
                text = " ".join(w["text"] for w in window)
                box = word_box(window, text, "line")
                if box:
                    boxes.append(box)
                    line_windows.append((line_idx, start, end, box))
                if len(window) > 1 and all((right["x0"] - left["x1"]) <= 1.4 for left, right in zip(window, window[1:])):
                    compact_text = "".join(w["text"] for w in window)
                    compact_box = word_box(window, compact_text, "line")
                    if compact_box and (not box or compact_box.norm != box.norm):
                        boxes.append(compact_box)
                        line_windows.append((line_idx, start, end, compact_box))

    # Multi-line labels often stack each word/short phrase directly below the
    # previous one. Build aligned combinations up to four nearby lines.
    by_line: defaultdict[int, list[TextBox]] = defaultdict(list)
    for line_idx, start, end, box in line_windows:
        token_count = len(box.norm.split())
        if 1 <= token_count <= 3:
            by_line[line_idx].append(box)

    for line_idx in range(len(lines)):
        active = [(box, box.text, box.norm, box.x0, box.x1, box.top, box.bottom) for box in by_line[line_idx]]
        for next_idx in range(line_idx + 1, min(len(lines), line_idx + 4)):
            new_active = []
            for cur_box, cur_text, cur_norm, x0, x1, top, bottom in active:
                if min(w["top"] for w in lines[next_idx]) - bottom > 22:
                    continue
                for nxt in by_line[next_idx]:
                    overlap = min(x1, nxt.x1) - max(x0, nxt.x0)
                    center_gap = abs(((x0 + x1) / 2) - nxt.cx)
                    if overlap >= -8 or center_gap <= 34:
                        text = f"{cur_text} {nxt.text}"
                        norm = normalize(text)
                        merged = TextBox(
                            text=text,
                            norm=norm,
                            x0=min(x0, nxt.x0),
                            x1=max(x1, nxt.x1),
                            top=min(top, nxt.top),
                            bottom=max(bottom, nxt.bottom),
                            source="stack",
                        )
                        boxes.append(merged)
                        new_active.append((nxt, text, norm, merged.x0, merged.x1, merged.top, merged.bottom))
            active = new_active

    # Some labels share the same global text row with many unrelated labels, so
    # line-index adjacency can miss a visually stacked pair. Add a direct
    # spatial pass over short boxes to catch pairs like "Saint" + "Jacques".
    short_boxes = [
        box
        for _, _, _, box in line_windows
        if 1 <= len(box.norm.split()) <= 3 and box.x0 >= MAP_MIN_X
    ]
    short_boxes.sort(key=lambda box: (box.top, box.x0))
    for idx, top_box in enumerate(short_boxes):
        for bottom_box in short_boxes[idx + 1 :]:
            gap = bottom_box.top - top_box.bottom
            if gap > 22:
                break
            if gap < -2:
                continue
            overlap = min(top_box.x1, bottom_box.x1) - max(top_box.x0, bottom_box.x0)
            center_gap = abs(top_box.cx - bottom_box.cx)
            if overlap >= -8 or center_gap <= 34:
                boxes.append(
                    TextBox(
                        text=f"{top_box.text} {bottom_box.text}",
                        norm=normalize(f"{top_box.text} {bottom_box.text}"),
                        x0=min(top_box.x0, bottom_box.x0),
                        x1=max(top_box.x1, bottom_box.x1),
                        top=min(top_box.top, bottom_box.top),
                        bottom=max(top_box.bottom, bottom_box.bottom),
                        source="stack",
                    )
                )

    # Deduplicate nearly identical boxes.
    unique: dict[tuple[str, int, int, int, int], TextBox] = {}
    for box in boxes:
        key = (box.norm, round(box.x0), round(box.x1), round(box.top), round(box.bottom))
        unique[key] = box
    return list(unique.values())


def distance_to_box(dot: Dot, box: TextBox) -> float:
    dx = max(box.x0 - dot.x, 0.0, dot.x - box.x1)
    dy = max(box.top - dot.y, 0.0, dot.y - box.bottom)
    return math.hypot(dx, dy)


def label_dot_match(box: TextBox, dots: list[Dot]) -> tuple[Dot, float] | None:
    best: tuple[float, Dot] | None = None
    for dot in dots:
        if dot.x < MAP_MIN_X:
            continue
        dist = distance_to_box(dot, box)
        center_dist = math.hypot(dot.x - box.cx, dot.y - box.cy)
        # Dots can be close to the text but should not be absurdly far from the
        # label center. This keeps neighboring stations from stealing a label.
        if dist > 55 or center_dist > 95:
            continue
        # Prefer larger concentric clusters when distances are close; they are
        # usually the real station/interchange marker, not tiny decoration.
        score = dist - min(dot.size, 16.0) * 0.18 - min(dot.count, 4) * 0.8
        if best is None or score < best[0]:
            best = (score, dot)
    if best is None:
        return None
    dot = best[1]
    return dot, distance_to_box(dot, box)


def name_variants(station: Station) -> set[str]:
    variants: set[str] = set()
    for name in unique_names(station):
        norm = normalize(name)
        if norm:
            variants.add(norm)
            tokens = norm.split()
            if len(tokens) > 1:
                # Some PDF labels omit connector words on stacked labels.
                no_stop = " ".join(t for t in tokens if t not in STOP_WORDS)
                if no_stop:
                    variants.add(no_stop)
                if "saint" in tokens:
                    variants.add(" ".join("st" if t == "saint" else t for t in tokens))
                if "sainte" in tokens:
                    variants.add(" ".join("ste" if t == "sainte" else t for t in tokens))
                if "porte" in tokens:
                    variants.add(" ".join("pte" if t == "porte" else t for t in tokens))
                if "grande" in tokens and "arche" in tokens:
                    cut = tokens[: tokens.index("grande")]
                    if cut:
                        variants.add(" ".join(cut))
    return variants


def dot_color_distance(dot: Dot, expected_colors: list[tuple[float, float, float, float]]) -> float | None:
    if not dot.colors or not expected_colors:
        return None
    return min(math.dist(dot_color, expected) for dot_color in dot.colors for expected in expected_colors)


def candidate_score(match: Match, expected_colors: list[tuple[float, float, float, float]]) -> Match:
    color_distance = dot_color_distance(match.dot, expected_colors)
    source_penalty = 0
    confidence_penalty = 0 if match.confidence == "high" else 10
    score = match.distance + source_penalty + confidence_penalty
    if color_distance is not None:
        if color_distance <= 0.24:
            score -= 8
        elif color_distance <= 0.42:
            score -= 3
        elif color_distance >= 0.85:
            score += 12
        elif color_distance >= 0.6:
            score += 7
        else:
            score += 3
    return Match(
        station=match.station,
        label=match.label,
        dot=match.dot,
        distance=match.distance,
        confidence=match.confidence,
        score=score,
        color_distance=color_distance,
    )


def choose_match(
    station: Station,
    boxes_by_norm: dict[str, list[TextBox]],
    dots: list[Dot],
    station_line_colors: dict[int, list[tuple[float, float, float, float]]] | None = None,
) -> Match | None:
    candidates: list[Match] = []
    expected_colors = station_line_colors.get(station.id, []) if station_line_colors else []
    for norm in name_variants(station):
        for box in boxes_by_norm.get(norm, []):
            found = label_dot_match(box, dots)
            if not found:
                continue
            dot, dist = found
            confidence = "high" if dist <= 24 else "medium"
            candidates.append(
                candidate_score(
                    Match(station=station, label=box, dot=dot, distance=dist, confidence=confidence),
                    expected_colors,
                )
            )

    if not candidates:
        return None

    def sort_key(match: Match) -> tuple[float, float, float]:
        return (match.score, match.label.x0, match.label.top)

    return sorted(candidates, key=sort_key)[0]


def direct_search_boxes(page, station: Station) -> list[TextBox]:
    boxes: list[TextBox] = []
    seen_patterns: set[str] = set()
    search_names = set(unique_names(station)) | name_variants(station)
    for raw_name in search_names:
        candidates = {raw_name, raw_name.replace("-", " "), raw_name.replace("'", "’")}
        for candidate in candidates:
            tokens = [token for token in re.split(r"[\s\-–—]+", candidate.strip()) if token]
            if not tokens:
                continue
            pattern = r"[\s\-–—]+".join(re.escape(token) for token in tokens)
            pattern = pattern.replace("'", r"['’]").replace("’", r"['’]")
            pattern = rf"(?<![\wÀ-ÿ]){pattern}(?![\wÀ-ÿ])"
            if pattern in seen_patterns:
                continue
            seen_patterns.add(pattern)
            try:
                hits = page.search(pattern, regex=True, case=False)
            except Exception:
                continue
            for hit in hits:
                if hit["x0"] < MAP_MIN_X:
                    continue
                text = hit.get("text") or candidate
                box = TextBox(
                    text=text,
                    norm=normalize(text),
                    x0=float(hit["x0"]),
                    x1=float(hit["x1"]),
                    top=float(hit["top"]),
                    bottom=float(hit["bottom"]),
                    source="search",
                )
                boxes.append(box)
                alias_norm = normalize(candidate)
                if alias_norm and alias_norm != box.norm:
                    boxes.append(
                        TextBox(
                            text=text,
                            norm=alias_norm,
                            x0=box.x0,
                            x1=box.x1,
                            top=box.top,
                            bottom=box.bottom,
                            source="search",
                        )
                    )
    return boxes


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="write x/y back to MySQL")
    parser.add_argument("--pdf", default=str(PDF_PATH), help="path to the metro-map PDF")
    parser.add_argument("--limit", type=int, default=0, help="debug: only process the first N stations")
    args = parser.parse_args()

    stations = fetch_stations()
    station_line_colors = fetch_station_line_colors()
    if args.limit:
        stations = stations[: args.limit]

    with pdfplumber.open(args.pdf) as pdf:
        if len(pdf.pages) != 1:
            raise RuntimeError(f"Expected a one-page map, got {len(pdf.pages)} pages")
        page = pdf.pages[0]
        dots = extract_dots(page)
        boxes = extract_text_boxes(page)

        boxes_by_norm: defaultdict[str, list[TextBox]] = defaultdict(list)
        for box in boxes:
            boxes_by_norm[box.norm].append(box)

        matches: list[Match] = []
        misses: list[Station] = []
        for station in stations:
            match = choose_match(station, boxes_by_norm, dots, station_line_colors)
            if match:
                matches.append(match)
            else:
                misses.append(station)

        # A second pass using pdfplumber.search catches overlapping labels that
        # extract_words cannot turn into clean word windows.
        recovered: list[Match] = []
        still_missed: list[Station] = []
        for station in misses:
            for box in direct_search_boxes(page, station):
                boxes_by_norm[box.norm].append(box)
            match = choose_match(station, boxes_by_norm, dots, station_line_colors)
            if match:
                recovered.append(match)
            else:
                still_missed.append(station)
        matches.extend(recovered)
        misses = still_missed

    high = sum(1 for m in matches if m.confidence == "high")
    medium = len(matches) - high
    print(f"PDF: {args.pdf}")
    print(f"stations={len(stations)} text_boxes={len(boxes)} dot_clusters={len(dots)}")
    print(f"matched={len(matches)} high={high} medium={medium} missed={len(misses)}")
    print()
    print("sample matches:")
    for match in matches[:25]:
        print(
            f"{match.station.id:4d} {match.station.name2 or match.station.name:<35} "
            f"-> x={match.dot.x:8.2f} y={match.dot.y:8.2f} "
            f"d={match.distance:5.1f} {match.confidence:6} "
            f"score={match.score:6.1f} "
            f"color={match.color_distance if match.color_distance is not None else '-'} "
            f"label={match.label.text!r} ({match.label.source})"
        )
    if misses:
        print()
        print("sample misses:")
        for station in misses[:40]:
            print(f"{station.id:4d} {station.name2 or station.name}")

    if args.apply:
        written = update_matches(matches)
        print()
        print(f"updated rows={written}")
    else:
        print()
        print("dry-run only; pass --apply to update MySQL.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
