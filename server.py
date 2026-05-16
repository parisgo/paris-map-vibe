#!/usr/bin/env python3
"""Local Paris metro map server.

Serves a D3/SVG map and a small JSON API backed by the local MySQL database.
The frontend follows the d3-metro idea: D3 renders a zoomable SVG transit
network from station nodes, route paths, and line membership data.
"""

from __future__ import annotations

import json
import math
import mimetypes
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import pymysql


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"

PDF_WIDTH = 3600.0
PDF_HEIGHT = 2777.95

DB_CONFIG = {
    "host": os.environ.get("PARIS_MAP_DB_HOST", "localhost"),
    "user": os.environ.get("PARIS_MAP_DB_USER", "root"),
    "password": os.environ.get("PARIS_MAP_DB_PASSWORD", "test001**"),
    "database": os.environ.get("PARIS_MAP_DB_NAME", "paris_map"),
    "charset": "utf8mb4",
}

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


def line_color(line_type: str, code: str, color: str | None) -> str:
    if color:
        return color
    key = f"{line_type.upper()}:{code.upper()}"
    return LINE_COLORS.get(key, TYPE_COLORS.get(line_type.upper(), "#475569"))


def order_line_members(members: list[dict]) -> tuple[list[dict], bool]:
    has_station_order = any(member["order"] is not None for member in members)
    if not has_station_order:
        return members, False
    return sorted(
        members,
        key=lambda member: (
            member["order"] is None,
            member["order"] if member["order"] is not None else 0,
            member["stationId"],
        ),
    ), True


def json_point(value) -> dict | None:
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        return None
    try:
        x = float(value[0])
        y = float(value[1])
    except (TypeError, ValueError):
        return None
    if not math.isfinite(x) or not math.isfinite(y):
        return None
    return {"x": x, "y": y}


def parse_path_segments(path_json: str | None) -> tuple[list[list[dict]], bool]:
    if not path_json:
        return [], False
    try:
        raw = json.loads(path_json)
    except (TypeError, ValueError, json.JSONDecodeError):
        return [], False
    if not isinstance(raw, list):
        return [], False

    single = [point for point in (json_point(item) for item in raw) if point]
    if len(single) == len(raw) and len(single) >= 2:
        return [single], False

    segments = []
    for segment in raw:
        if not isinstance(segment, list):
            continue
        points = [point for point in (json_point(item) for item in segment) if point]
        if len(points) >= 2:
            segments.append(points)
    return segments, bool(segments)


def dedupe_points(points: list[dict]) -> list[dict]:
    unique: list[dict] = []
    for point in points:
        if not any(math.hypot(point["x"] - other["x"], point["y"] - other["y"]) < 2.0 for other in unique):
            unique.append(point)
    return unique


def spatially_order_points(points: list[dict]) -> list[dict]:
    points = dedupe_points(points)
    if len(points) <= 2:
        return points

    centroid_x = sum(point["x"] for point in points) / len(points)
    centroid_y = sum(point["y"] for point in points) / len(points)
    start_index = max(
        range(len(points)),
        key=lambda index: math.hypot(points[index]["x"] - centroid_x, points[index]["y"] - centroid_y),
    )
    ordered = [points.pop(start_index)]
    while points:
        current = ordered[-1]
        next_index = min(
            range(len(points)),
            key=lambda index: math.hypot(points[index]["x"] - current["x"], points[index]["y"] - current["y"]),
        )
        ordered.append(points.pop(next_index))
    return ordered


def fetch_map_data() -> dict:
    conn = pymysql.connect(**DB_CONFIG, cursorclass=pymysql.cursors.DictCursor)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, code, name, type, color, text_color, path_json, sort_order
                FROM line
                ORDER BY
                  FIELD(UPPER(type), 'METRO', 'RER', 'TRAIN', 'TRAM', 'TRAMWAY', 'NAVETTE'),
                  sort_order IS NULL,
                  sort_order,
                  code
                """
            )
            raw_lines = cur.fetchall()

            cur.execute(
                """
                SELECT id, name, name2, x, y
                FROM stations
                WHERE x IS NOT NULL AND y IS NOT NULL
                ORDER BY id
                """
            )
            stations = cur.fetchall()

            cur.execute(
                """
                SELECT
                  ls.line_id,
                  ls.station_id,
                  ls.station_name,
                  ls.station_order,
                  s.name2,
                  s.x,
                  s.y
                FROM line_stations ls
                JOIN stations s ON s.id = ls.station_id
                ORDER BY ls.line_id, ls.station_order IS NULL, ls.station_order, ls.id
                """
            )
            memberships = cur.fetchall()
    finally:
        conn.close()

    station_lines: dict[int, list[dict]] = {int(station["id"]): [] for station in stations}
    line_members: dict[int, list[dict]] = {}
    line_lookup = {int(line["id"]): line for line in raw_lines}

    for row in memberships:
        line_id = int(row["line_id"])
        line = line_lookup.get(line_id)
        if not line:
            continue
        station_id = int(row["station_id"])
        member = {
            "stationId": station_id,
            "stationName": row["name2"] or row["station_name"],
            "order": row["station_order"],
            "x": row["x"],
            "y": row["y"],
        }
        line_members.setdefault(line_id, []).append(member)
        if station_id in station_lines:
            station_lines[station_id].append(
                {
                    "id": line_id,
                    "code": line["code"],
                    "type": line["type"],
                    "color": line_color(line["type"], line["code"], line["color"]),
                }
            )

    lines = []
    for line in raw_lines:
        ordered_members, points_are_ordered = order_line_members(line_members.get(int(line["id"]), []))
        member_points = [
            {"x": float(member["x"]), "y": float(member["y"])}
            for member in ordered_members
            if member["x"] is not None and member["y"] is not None
        ]
        path_segments, path_is_segmented = parse_path_segments(line["path_json"])
        points = member_points
        segments = [member_points] if len(member_points) >= 2 else []
        if path_is_segmented:
            segments = path_segments
            points = [point for segment in segments for point in segment]
            points_are_ordered = True
        elif len(points) < 2 and path_segments:
            points = path_segments[0]
            segments = path_segments
            points_are_ordered = True
        if not points_are_ordered:
            points = spatially_order_points(points)
            segments = [points] if len(points) >= 2 else []
        lines.append(
            {
                "id": int(line["id"]),
                "code": line["code"],
                "name": line["name"] or f"{line['type']} {line['code']}",
                "type": line["type"],
                "color": line_color(line["type"], line["code"], line["color"]),
                "textColor": line["text_color"] or "#111827",
                "points": points,
                "segments": segments,
                "stations": ordered_members,
            }
        )

    return {
        "canvas": {"width": PDF_WIDTH, "height": PDF_HEIGHT},
        "stations": [
            {
                "id": int(station["id"]),
                "name": station["name2"] or station["name"],
                "rawName": station["name"],
                "x": float(station["x"]),
                "y": float(station["y"]),
                "lines": station_lines.get(int(station["id"]), []),
            }
            for station in stations
        ],
        "lines": lines,
        "stats": {
            "stationCount": len(stations),
            "lineCount": len(lines),
            "pathLineCount": sum(1 for line in lines if line["segments"]),
        },
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/map":
            self.send_json(fetch_map_data())
            return

        path = "/index.html" if parsed.path == "/" else parsed.path
        candidate = (PUBLIC_DIR / path.lstrip("/")).resolve()
        if not str(candidate).startswith(str(PUBLIC_DIR.resolve())) or not candidate.is_file():
            self.send_error(404)
            return

        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        body = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, data: dict) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} - {fmt % args}")


def main() -> int:
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Paris map server running at http://127.0.0.1:{port}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
