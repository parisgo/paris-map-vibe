const svg = d3.select("#metroMap");
const root = svg.append("g").attr("class", "viewport");
const gridLayer = root.append("g").attr("class", "grid");
const routeLayer = root.append("g").attr("class", "routes");
const stationLayer = root.append("g").attr("class", "stations");
const labelLayer = root.append("g").attr("class", "labels");

const lineFilters = d3.select("#lineFilters");
const stats = d3.select("#stats");
const tooltip = d3.select("#tooltip");
const detailsTitle = d3.select("#detailsTitle");
const detailsBody = d3.select("#detailsBody");
const searchInput = document.querySelector("#stationSearch");
const stationSuggestions = document.querySelector("#stationSuggestions");

let mapData = null;
let selectedLineId = null;
let selectedLineIds = new Set();
let selectedStationId = null;
let currentTransform = d3.zoomIdentity;
let stationLayout = new Map();
let suggestionStations = [];
let activeSuggestionIndex = -1;

const LABEL_SCREEN_SIZE = 13;
const LABEL_LINE_HEIGHT = 15;
const LABEL_ROUTE_GAP = 8;
const LABEL_TEXT_DESCENT = 3;
const LABEL_STACK_GAP = 6;
const SVG_NS = "http://www.w3.org/2000/svg";
const MAP_CONTENT_MIN_X = 595;
const INITIAL_MAP_PADDING = 12;

const zoom = d3.zoom()
  .scaleExtent([0.18, 9])
  .on("zoom", (event) => {
    currentTransform = event.transform;
    root.attr("transform", currentTransform);
    updateScaledSymbols();
  });

svg.call(zoom);

function lineLabel(line) {
  const prefix = line.type === "METRO" ? "M" : line.type === "TRAM" || line.type === "Tramway" ? "T" : line.type;
  return `${prefix}${line.code}`;
}

function normalizedLineType(line) {
  const type = String(line.type || "").toUpperCase();
  return type === "TRAMWAY" ? "TRAM" : type;
}

function lineTypeRank(line) {
  const type = normalizedLineType(line);
  if (type === "METRO") return 0;
  if (type === "RER") return 1;
  if (type === "TRAIN") return 2;
  if (type === "TRAM") return 3;
  if (type === "NAVETTE") return 4;
  return 5;
}

function lineCodeParts(code) {
  const value = String(code || "");
  const match = value.match(/^([A-Za-z]*)(\d+)([A-Za-z]*)$/);
  if (!match) return { prefix: value, number: Number.POSITIVE_INFINITY, suffix: "" };
  return {
    prefix: match[1].toLocaleUpperCase(),
    number: Number(match[2]),
    suffix: match[3].toLocaleLowerCase(),
  };
}

function compareLines(a, b) {
  const typeDiff = lineTypeRank(a) - lineTypeRank(b);
  if (typeDiff) return typeDiff;
  const ac = lineCodeParts(a.code);
  const bc = lineCodeParts(b.code);
  return ac.prefix.localeCompare(bc.prefix) ||
    ac.number - bc.number ||
    ac.suffix.localeCompare(bc.suffix) ||
    String(a.code).localeCompare(String(b.code));
}

function groupedDrawableLines(lines) {
  const groups = new Map();
  lines
    .filter((line) => routeSegments(line).length)
    .sort(compareLines)
    .forEach((line) => {
      const type = normalizedLineType(line);
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push(line);
    });
  return Array.from(groups, ([type, groupLines]) => ({ type, lines: groupLines }));
}

function lineSet(station) {
  return new Set(station.lines.map((line) => line.id));
}

function normalizeLabel(value) {
  return String(value || "")
    .replace(/[œŒ]/g, "oe")
    .replace(/[æÆ]/g, "ae")
    .replace(/[’'`´]/g, " ")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function displayStationName(station) {
  return stationLayout.get(station.id)?.labelName || station.name;
}

function stationSearchText(station) {
  const names = [...new Set([station.name, station.rawName, displayStationName(station)]
    .filter(Boolean)
    .map((name) => String(name).trim())
    .filter(Boolean))].join(" ");
  const normalized = normalizeLabel(names);
  const saintExpanded = normalized.replace(/\bst\b/g, "saint").replace(/\bste\b/g, "sainte");
  const saintShort = normalized.replace(/\bsaint\b/g, "st").replace(/\bsainte\b/g, "ste");
  return `${normalized} ${saintExpanded} ${saintShort}`;
}

function fuzzyIncludes(text, query) {
  if (!query) return false;
  if (text.includes(query)) return true;
  const tokens = query.split(" ").filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => text.includes(token))) return true;
  return false;
}

function stationMatchesQuery(station, query) {
  if (!query) return false;
  const normalizedQuery = normalizeLabel(query);
  return fuzzyIncludes(stationSearchText(station), normalizedQuery);
}

function visibleByLine(d) {
  return !hasLineSelection() || d.lines?.some((line) => lineIsSelected(line.id));
}

function hasLineSelection() {
  return selectedLineId !== null || selectedLineIds.size > 0;
}

function lineIsSelected(lineId) {
  return selectedLineIds.size ? selectedLineIds.has(lineId) : selectedLineId === lineId;
}

function clearLineSelection() {
  selectedLineId = null;
  selectedLineIds = new Set();
}

function setSingleLineSelection(lineId) {
  selectedLineId = lineId;
  selectedLineIds = lineId === null ? new Set() : new Set([lineId]);
}

function setStationLineSelection(station) {
  selectedLineId = null;
  selectedLineIds = new Set(station.lines.map((line) => line.id));
}

function routePath(points) {
  if (!points || points.length < 2) return "";
  return d3.line()
    .x((d) => d.x)
    .y((d) => d.y)
    .curve(d3.curveLinear)(points);
}

function routeSegments(line) {
  const segments = (line.segments || [])
    .filter((segment) => segment && segment.length > 1);
  if (segments.length) return segments;
  return line.points?.length > 1 ? [line.points] : [];
}

function drawableRouteSegments(lines) {
  return lines.flatMap((line) =>
    routeSegments(line).map((points, segmentIndex) => ({
      ...line,
      points,
      segmentIndex,
    }))
  );
}

function routeStrokeWidth(line) {
  return line?.type === "RER" || line?.type === "TRAIN" ? 8 : 6;
}

function routeHalfWidthScreen(station) {
  const scale = Math.max(currentTransform.k || 1, 0.001);
  let line = null;
  if (selectedLineId && visibleByLine(station)) {
    line = mapData?.lines.find((item) => item.id === selectedLineId);
  }
  if (!line) {
    const hasHeavyLine = station.lines?.some((item) => item.type === "RER" || item.type === "TRAIN");
    line = { type: hasHeavyLine ? "RER" : "METRO" };
  }
  return routeStrokeWidth(line) * scale / 2;
}

function aboveLabelOffset(station) {
  return routeHalfWidthScreen(station) + LABEL_ROUTE_GAP + LABEL_TEXT_DESCENT;
}

function belowLabelOffset(station, row = 0) {
  return routeHalfWidthScreen(station) + LABEL_ROUTE_GAP + LABEL_SCREEN_SIZE +
    row * (LABEL_LINE_HEIGHT + LABEL_STACK_GAP);
}

function hasPoint(value) {
  return value.x !== null && value.y !== null && Number.isFinite(+value.x) && Number.isFinite(+value.y);
}

function sortedMembers(line) {
  return (line.stations || [])
    .filter(hasPoint)
    .map((station, index) => ({ ...station, index }))
    .sort((a, b) => {
      const ao = numericOrder(a.order, a.index);
      const bo = numericOrder(b.order, b.index);
      return ao - bo;
    });
}

function numericOrder(value, fallback) {
  return value !== null && value !== undefined && Number.isFinite(+value) ? +value : fallback;
}

function linePriority(type) {
  const normalized = String(type || "").toUpperCase();
  if (normalized === "METRO") return 0;
  if (normalized === "RER") return 1;
  if (normalized === "TRAIN") return 2;
  return 3;
}

function chooseDirection(directions, preferredLineId = null) {
  if (!directions?.length) return null;
  const preferred = preferredLineId ? directions.find((direction) => direction.lineId === preferredLineId) : null;
  if (preferred) return preferred;
  return [...directions].sort((a, b) =>
    linePriority(a.type) - linePriority(b.type) ||
    Math.abs(b.dx) - Math.abs(a.dx) ||
    a.lineId - b.lineId
  )[0];
}

function selectedLineDirection(station) {
  if (!selectedLineId || !mapData) return null;
  const line = mapData.lines.find((item) => item.id === selectedLineId);
  if (!line) return null;
  const pathDirection = directionFromRoutePath(line, station);
  if (pathDirection) return pathDirection;

  const members = sortedMembers(line);
  let index = members.findIndex((member) => member.stationId === station.id);
  if (index < 0) {
    index = members.findIndex((member) => Math.hypot(+member.x - station.x, +member.y - station.y) <= 3);
  }
  if (index < 0) return null;

  const member = members[index];
  const previous = members[index - 1];
  const next = members[index + 1];
  let dx = 0;
  let dy = 0;
  if (previous && next) {
    dx = +next.x - +previous.x;
    dy = +next.y - +previous.y;
  } else if (next) {
    dx = +next.x - +member.x;
    dy = +next.y - +member.y;
  } else if (previous) {
    dx = +member.x - +previous.x;
    dy = +member.y - +previous.y;
  }

  const length = Math.hypot(dx, dy);
  if (!length) return null;
  return {
    lineId: line.id,
    type: line.type,
    code: line.code,
    order: numericOrder(member.order, index),
    index,
    dx: dx / length,
    dy: dy / length,
    angle: Math.atan2(dy, dx) * 180 / Math.PI,
  };
}

function directionFromRoutePath(line, station) {
  const segments = routeSegments(line);
  if (!segments.length) return null;

  let closest = null;
  segments.forEach((points, segmentIndex) => {
    points.forEach((point, pointIndex) => {
      const distance = Math.hypot(+point.x - station.x, +point.y - station.y);
      if (!closest || distance < closest.distance) {
        closest = { distance, point, pointIndex, points, segmentIndex };
      }
    });
  });
  if (!closest || closest.distance > 55) return null;

  const previous = closest.points[closest.pointIndex - 1];
  const next = closest.points[closest.pointIndex + 1];
  const point = closest.point;
  let dx = 0;
  let dy = 0;
  if (previous && next) {
    dx = +next.x - +previous.x;
    dy = +next.y - +previous.y;
  } else if (next) {
    dx = +next.x - +point.x;
    dy = +next.y - +point.y;
  } else if (previous) {
    dx = +point.x - +previous.x;
    dy = +point.y - +previous.y;
  }

  const length = Math.hypot(dx, dy);
  if (!length) return null;
  return {
    lineId: line.id,
    type: line.type,
    code: line.code,
    order: closest.segmentIndex * 1000 + closest.pointIndex,
    index: closest.pointIndex,
    dx: dx / length,
    dy: dy / length,
    angle: Math.atan2(dy, dx) * 180 / Math.PI,
  };
}

function buildStationLayout(data) {
  const layout = new Map(data.stations.map((station) => [station.id, { directions: [] }]));

  data.lines.forEach((line) => {
    const members = sortedMembers(line);
    members.forEach((member, index) => {
      const station = data.stations.find((item) => item.id === member.stationId);
      const pathDirection = station ? directionFromRoutePath(line, station) : null;
      if (pathDirection && layout.has(member.stationId)) {
        layout.get(member.stationId).directions.push(pathDirection);
        return;
      }

      const previous = members[index - 1];
      const next = members[index + 1];
      let dx = 0;
      let dy = 0;
      if (previous && next) {
        dx = +next.x - +previous.x;
        dy = +next.y - +previous.y;
      } else if (next) {
        dx = +next.x - +member.x;
        dy = +next.y - +member.y;
      } else if (previous) {
        dx = +member.x - +previous.x;
        dy = +member.y - +previous.y;
      }

      const length = Math.hypot(dx, dy);
      if (!length || !layout.has(member.stationId)) return;
      layout.get(member.stationId).directions.push({
        lineId: line.id,
        type: line.type,
        code: line.code,
        order: numericOrder(member.order, index),
        index,
        dx: dx / length,
        dy: dy / length,
        angle: Math.atan2(dy, dx) * 180 / Math.PI,
      });
    });
  });

  data.stations.forEach((station) => {
    const entry = layout.get(station.id) || { directions: [] };
    const primary = chooseDirection(entry.directions);
    const nearby = data.stations.filter((other) =>
      other.id !== station.id && Math.hypot(other.x - station.x, other.y - station.y) <= 22
    );
    const nearbyLineIds = new Set(station.lines.map((line) => line.id));
    nearby.forEach((other) => other.lines.forEach((line) => nearbyLineIds.add(line.id)));
    const groupedInterchange = nearby.length > 0 && nearbyLineIds.size > (station.lines?.length || 0);
    const closest = nearby.sort((a, b) =>
      Math.hypot(a.x - station.x, a.y - station.y) - Math.hypot(b.x - station.x, b.y - station.y)
    )[0];
    const groupAngle = closest ? Math.atan2(closest.y - station.y, closest.x - station.x) * 180 / Math.PI : null;
    const stationNorm = normalizeLabel(station.name);
    const fullerName = nearby
      .map((other) => other.name)
      .filter((name) => normalizeLabel(name).includes(stationNorm) && name.length > station.name.length)
      .sort((a, b) => b.length - a.length)[0];
    entry.primary = primary;
    entry.labelName = fullerName || station.name;
    entry.marker = markerForStation(station, primary, groupedInterchange, groupAngle);
    layout.set(station.id, entry);
  });

  return layout;
}

function markerForStation(station, direction, groupedInterchange = false, groupAngle = null) {
  const lineCount = station.lines?.length || 0;
  if (lineCount > 1 || groupedInterchange) {
    return {
      shape: "capsule",
      angle: groupAngle ?? direction?.angle ?? 0,
      width: Math.min(38, 26 + Math.max(lineCount, 2) * 4),
      height: 13,
    };
  }
  return {
    shape: "circle",
    radius: 4.6,
  };
}

function labelLines(name) {
  if (!name) return [""];
  const normalized = String(name).replace(/\s+/g, " ").trim();
  if (/^Asnières Quatre Routes$/i.test(normalized)) return ["Asnières", "Quatre Routes"];
  if (normalized.length <= 18) return [normalized];
  if (normalized.includes(" - ")) {
    const parts = normalized.split(" - ");
    return [parts[0], parts.slice(1).join(" - ")].filter(Boolean);
  }
  const words = normalized.split(" ");
  const lines = [];
  let current = "";
  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > 18 && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  });
  if (current) lines.push(current);
  return lines.slice(0, 3);
}

function matchingStations(query) {
  const normalizedQuery = normalizeLabel(query);
  if (!normalizedQuery || !mapData) return [];
  return mapData.stations
    .map((station) => {
      const text = stationSearchText(station);
      if (!fuzzyIncludes(text, normalizedQuery)) return null;
      const name = normalizeLabel(displayStationName(station));
      const raw = normalizeLabel(station.rawName);
      const index = Math.min(
        ...[name.indexOf(normalizedQuery), raw.indexOf(normalizedQuery), text.indexOf(normalizedQuery)]
          .filter((value) => value >= 0)
      );
      const position = Number.isFinite(index) ? index : 99;
      const starts = name.startsWith(normalizedQuery) || raw.startsWith(normalizedQuery) ? 0 : 1;
      return { station, starts, position, length: displayStationName(station).length };
    })
    .filter(Boolean)
    .sort((a, b) =>
      a.starts - b.starts ||
      a.position - b.position ||
      a.length - b.length ||
      displayStationName(a.station).localeCompare(displayStationName(b.station))
    )
    .slice(0, 10)
    .map((item) => item.station);
}

function exactStationMatch(query) {
  const normalizedQuery = normalizeLabel(query);
  if (!normalizedQuery || !mapData) return null;
  return mapData.stations.find((station) => {
    const names = [displayStationName(station), station.rawName]
      .filter(Boolean)
      .map(normalizeLabel);
    return names.some((name) => name === normalizedQuery);
  }) || null;
}

function renderStationSuggestions() {
  const query = searchInput.value.trim();
  suggestionStations = matchingStations(query);
  activeSuggestionIndex = suggestionStations.length ? 0 : -1;
  stationSuggestions.replaceChildren();
  if (!suggestionStations.length) {
    stationSuggestions.hidden = true;
    return;
  }

  suggestionStations.forEach((station, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `suggestion-item${index === activeSuggestionIndex ? " is-active" : ""}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", index === activeSuggestionIndex ? "true" : "false");

    const name = document.createElement("span");
    name.className = "suggestion-name";
    name.textContent = displayStationName(station);
    button.appendChild(name);

    const lines = document.createElement("span");
    lines.className = "suggestion-lines";
    lines.textContent = [...station.lines].sort(compareLines).map((line) => lineLabel(line)).join(" · ");
    button.appendChild(lines);

    button.addEventListener("mouseenter", () => setActiveSuggestion(index));
    button.addEventListener("click", () => selectStationSuggestion(station));
    stationSuggestions.appendChild(button);
  });
  stationSuggestions.hidden = false;
}

function setActiveSuggestion(index) {
  if (!suggestionStations.length) return;
  activeSuggestionIndex = (index + suggestionStations.length) % suggestionStations.length;
  Array.from(stationSuggestions.querySelectorAll(".suggestion-item")).forEach((button, itemIndex) => {
    const active = itemIndex === activeSuggestionIndex;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function hideStationSuggestions() {
  suggestionStations = [];
  activeSuggestionIndex = -1;
  stationSuggestions.hidden = true;
  stationSuggestions.replaceChildren();
}

function selectStationSuggestion(station) {
  selectedStationId = station.id;
  setStationLineSelection(station);
  searchInput.value = displayStationName(station);
  hideStationSuggestions();
  resetZoom();
  updateSelection();
  showStationDetails(station);
}

function labelPlacement(station) {
  const entry = stationLayout.get(station.id);
  const direction = selectedLineDirection(station) || chooseDirection(entry?.directions, selectedLineId);
  if (!direction) return { dx: 15, dy: -18, anchor: "start", block: "side" };

  const horizontal = Math.abs(direction.dx) >= Math.abs(direction.dy);
  if (horizontal) {
    return {
      dx: 0,
      dy: null,
      anchor: "middle",
      block: "above",
    };
  }

  const order = Number.isFinite(direction.order) ? direction.order : station.id;
  const right = order % 2 === 0;
  return { dx: right ? 15 : -15, dy: -8, anchor: right ? "start" : "end", block: "side" };
}

function belowLinePlacement(row = 0) {
  return {
    dx: 0,
    dy: null,
    anchor: "middle",
    block: "below",
    row,
  };
}

function drawGrid(width, height) {
  const step = 250;
  const vertical = d3.range(0, width + step, step);
  const horizontal = d3.range(0, height + step, step);
  gridLayer.selectAll("line.vertical")
    .data(vertical)
    .join("line")
    .attr("class", "grid-line vertical")
    .attr("x1", (d) => d)
    .attr("x2", (d) => d)
    .attr("y1", 0)
    .attr("y2", height);
  gridLayer.selectAll("line.horizontal")
    .data(horizontal)
    .join("line")
    .attr("class", "grid-line horizontal")
    .attr("x1", 0)
    .attr("x2", width)
    .attr("y1", (d) => d)
    .attr("y2", (d) => d);
}

function render(data) {
  mapData = data;
  stationLayout = buildStationLayout(data);
  root.insert("rect", ":first-child")
    .attr("class", "map-bg")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", data.canvas.width)
    .attr("height", data.canvas.height);
  drawGrid(data.canvas.width, data.canvas.height);

  const drawableLines = drawableRouteSegments(data.lines);
  routeLayer.selectAll("path")
    .data(drawableLines, (d) => `${d.id}-${d.segmentIndex}`)
    .join("path")
    .attr("class", "route-line")
    .attr("d", (d) => routePath(d.points))
    .attr("stroke", (d) => d.color)
    .attr("stroke-width", (d) => routeStrokeWidth(d))
    .on("click", (event, d) => {
      event.stopPropagation();
      const alreadySelected = selectedLineIds.size === 1 && selectedLineIds.has(d.id);
      setSingleLineSelection(alreadySelected ? null : d.id);
      selectedStationId = null;
      updateSelection();
      showLineDetails(d);
    });

  const stations = stationLayer.selectAll("g")
    .data(data.stations, (d) => d.id)
    .join("g")
    .attr("class", "station")
    .attr("transform", (d) => `translate(${d.x},${d.y})`)
    .on("mouseenter", (event, d) => showTooltip(event, d))
    .on("mousemove", (event, d) => showTooltip(event, d))
    .on("mouseleave", () => tooltip.attr("hidden", true))
    .on("click", (event, d) => {
      event.stopPropagation();
      selectedStationId = selectedStationId === d.id ? null : d.id;
      clearLineSelection();
      updateSelection();
      showStationDetails(d);
    });

  stations.selectAll(".station-marker").remove();
  stations.selectAll(".station-pulse").remove();
  stations.each(function (d) {
    const marker = stationLayout.get(d.id)?.marker || markerForStation(d, null);
    const pulseNode = document.createElementNS(SVG_NS, marker.shape === "capsule" ? "rect" : "circle");
    const markerNode = document.createElementNS(SVG_NS, marker.shape === "capsule" ? "rect" : "circle");
    d3.select(this).append(() => pulseNode)
      .attr("class", `station-pulse station-${marker.shape}`);
    d3.select(this).append(() => markerNode)
      .attr("class", `station-marker station-${marker.shape}`);
  });

  const labels = labelLayer.selectAll("g.station-label")
    .data(data.stations, (d) => d.id)
    .join("g")
    .attr("class", "station-label");

  labels.each(function (d) {
    const text = d3.select(this)
      .selectAll("text")
      .data([d])
      .join("text");
    text.selectAll("tspan")
      .data(labelLines(displayStationName(d)))
      .join("tspan")
      .text((line) => line);
  });

  const filterGroups = lineFilters.selectAll("div.line-filter-group")
    .data(groupedDrawableLines(data.lines), (d) => d.type)
    .join("div")
    .attr("class", "line-filter-group");

  filterGroups.selectAll("button")
    .data((d) => d.lines, (d) => d.id)
    .join("button")
    .attr("class", "line-button")
    .style("border-color", (d) => d.color)
    .style("background", (d) => lineIsSelected(d.id) ? d.color : "#eef1f6")
    .style("color", (d) => lineIsSelected(d.id) ? "#fff" : "#111827")
    .text((d) => lineLabel(d))
    .attr("title", (d) => d.name)
    .on("click", (event, d) => {
      const alreadySelected = selectedLineIds.size === 1 && selectedLineIds.has(d.id);
      setSingleLineSelection(alreadySelected ? null : d.id);
      selectedStationId = null;
      hideStationSuggestions();
      updateSelection();
      if (lineIsSelected(d.id)) showLineDetails(d);
      else resetDetails();
    });

  svg.on("click", () => {
    clearLineSelection();
    selectedStationId = null;
    searchInput.value = "";
    hideStationSuggestions();
    updateSelection();
    resetDetails();
  });

  stats.text(`${data.stats.stationCount} stations · ${data.stats.pathLineCount} drawable lines`);
  resetZoom();
  updateSelection();
}

function updateSelection() {
  const query = searchInput.value.trim();
  const filteringBySelectedLines = hasLineSelection();

  routeLayer.selectAll("path")
    .classed("is-muted", (d) => filteringBySelectedLines && !lineIsSelected(d.id))
    .classed("is-focus", (d) => lineIsSelected(d.id));

  stationLayer.selectAll(".station")
    .classed("is-muted", (d) => {
      if (filteringBySelectedLines) return !visibleByLine(d);
      if (query && !stationMatchesQuery(d, query)) return true;
      return false;
    })
    .classed("is-hit", (d) => query && stationMatchesQuery(d, query))
    .classed("is-selected", (d) => selectedStationId === d.id);

  labelLayer.selectAll("g.station-label")
    .classed("is-muted", (d) => {
      if (filteringBySelectedLines) return !visibleByLine(d);
      if (query && !stationMatchesQuery(d, query)) return true;
      return false;
    });

  lineFilters.selectAll("button")
    .classed("is-active", (d) => lineIsSelected(d.id))
    .style("background", (d) => lineIsSelected(d.id) ? d.color : "#eef1f6")
    .style("color", (d) => lineIsSelected(d.id) ? "#fff" : "#111827");

  updateLabelVisibility();
}

function updateLabelVisibility() {
  const scale = currentTransform.k;
  const query = searchInput.value.trim().toLocaleLowerCase();
  labelLayer.selectAll("g.station-label")
    .attr("display", (d) => {
      const selected = selectedStationId === d.id;
      const hit = query && stationMatchesQuery(d, query);
      const onLine = hasLineSelection() && visibleByLine(d);
      return scale > 2.05 || selected || hit || onLine ? null : "none";
    });
  updateLabelGeometry();
  requestAnimationFrame(resolveLabelCollisions);
}

function updateLabelGeometry() {
  labelLayer.selectAll("g.station-label")
    .each(function (d) {
      applyLabelPlacement(this, d, labelPlacement(d));
    });
}

function applyLabelPlacement(node, station, placement) {
  const scale = Math.max(currentTransform.k || 1, 0.001);
  const lines = labelLines(displayStationName(station));
  const fontSize = LABEL_SCREEN_SIZE / scale;
  const lineHeight = LABEL_LINE_HEIGHT / scale;
  const dy = placement.dy ?? (
    placement.block === "above" ? -aboveLabelOffset(station) :
    placement.block === "below" ? belowLabelOffset(station, placement.row || 0) :
    0
  );
  let x = station.x + placement.dx / scale;
  let y = station.y + dy / scale;
  if (placement.block === "above") y -= ((lines.length - 1) * LABEL_LINE_HEIGHT) / scale;
  if (placement.block === "side") y -= ((lines.length - 1) * LABEL_LINE_HEIGHT * 0.5) / scale;

  const text = d3.select(node).select("text")
    .attr("text-anchor", placement.anchor)
    .style("font-size", `${fontSize}px`)
    .style("stroke-width", `${3.2 / scale}px`);

  text.selectAll("tspan")
    .attr("x", x)
    .attr("y", (_, index) => y + index * lineHeight);

  d3.select(node).attr("data-placement", placement.block);
}

function labelPriority(d) {
  const query = searchInput.value.trim().toLocaleLowerCase();
  if (selectedStationId === d.id) return 4;
  if (query && stationMatchesQuery(d, query)) return 3;
  if (hasLineSelection() && visibleByLine(d)) return 2;
  return 1;
}

function boxesOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function resolveLabelCollisions() {
  const nodes = labelLayer.selectAll("g.station-label").nodes()
    .filter((node) => d3.select(node).attr("display") !== "none")
    .map((node) => {
      const datum = d3.select(node).datum();
      return {
        node,
        datum,
        box: node.getBoundingClientRect(),
        placement: d3.select(node).attr("data-placement"),
      };
    })
    .sort((a, b) => labelPriority(b.datum) - labelPriority(a.datum) || a.box.top - b.box.top || a.box.left - b.box.left);

  const accepted = [];
  nodes.forEach((item) => {
    const priority = labelPriority(item.datum);
    let padded = paddedBox(item.box);
    if (item.placement !== "below" && overlapsRouteBand(padded, item.datum)) {
      applyLabelPlacement(item.node, item.datum, belowLinePlacement());
      item.box = item.node.getBoundingClientRect();
      item.placement = "below";
      padded = paddedBox(item.box);
    }
    let collides = accepted.some((box) => boxesOverlap(padded, box));
    if (collides && item.placement !== "below") {
      applyLabelPlacement(item.node, item.datum, belowLinePlacement());
      item.box = item.node.getBoundingClientRect();
      item.placement = "below";
      padded = paddedBox(item.box);
      collides = accepted.some((box) => boxesOverlap(padded, box)) ||
        overlapsRouteBand(padded, item.datum);
    }
    if (collides && item.placement === "below") {
      applyLabelPlacement(item.node, item.datum, belowLinePlacement(1));
      item.box = item.node.getBoundingClientRect();
      item.placement = "below";
      padded = paddedBox(item.box);
      collides = accepted.some((box) => boxesOverlap(padded, box)) ||
        overlapsRouteBand(padded, item.datum);
    }
    if (collides && priority < 3) {
      d3.select(item.node).attr("display", "none");
    } else {
      accepted.push(padded);
    }
  });
}

function paddedBox(box) {
  return {
    left: box.left - 2,
    right: box.right + 2,
    top: box.top - 2,
    bottom: box.bottom + 2,
  };
}

function overlapsRouteBand(box, station) {
  const scale = Math.max(currentTransform.k || 1, 0.001);
  const svgBox = svg.node().getBoundingClientRect();
  const stationX = svgBox.left + currentTransform.x + station.x * scale;
  const stationY = svgBox.top + currentTransform.y + station.y * scale;
  const localBand = routeHalfWidthScreen(station) + 1;
  const stationBand = {
    left: stationX - 34 * scale,
    right: stationX + 34 * scale,
    top: stationY - localBand,
    bottom: stationY + localBand,
  };
  return boxesOverlap(box, stationBand);
}

function updateScaledSymbols() {
  const scale = Math.max(currentTransform.k || 1, 0.001);
  const markerScale = 1 / Math.max(1, Math.sqrt(scale));

  stationLayer.selectAll(".station-circle")
    .attr("r", (d) => {
      const marker = stationLayout.get(d.id)?.marker || markerForStation(d, null);
      return (marker.radius || 4.6) * markerScale;
    });

  stationLayer.selectAll(".station-capsule")
    .each(function (d) {
      const marker = stationLayout.get(d.id)?.marker || markerForStation(d, null);
      const width = marker.width * markerScale;
      const height = marker.height * markerScale;
      d3.select(this)
        .attr("x", -width / 2)
        .attr("y", -height / 2)
        .attr("width", width)
        .attr("height", height)
        .attr("rx", height / 2)
        .attr("ry", height / 2)
        .attr("transform", `rotate(${marker.angle || 0})`);
    });

  updateLabelVisibility();
}

function showTooltip(event, station) {
  const lines = station.lines.map((line) => lineLabel(line)).join(" · ") || "No line data";
  tooltip
    .attr("hidden", null)
    .style("left", `${event.clientX + 14}px`)
    .style("top", `${event.clientY + 14}px`)
    .html(`<strong>${displayStationName(station)}</strong><br><span>${lines}</span><br><span>x ${station.x.toFixed(1)}, y ${station.y.toFixed(1)}</span>`);
}

function showStationDetails(station) {
  detailsTitle.text(displayStationName(station));
  const linePills = station.lines.map((line) =>
    `<span class="line-pill" style="background:${line.color}">${lineLabel(line)}</span>`
  ).join("");
  detailsBody.html(`
    <div>PDF point: ${station.x.toFixed(2)}, ${station.y.toFixed(2)}</div>
    <div class="line-list">${linePills || "No line membership"}</div>
  `);
}

function showLineDetails(line) {
  const stationCount = line.stations.filter((station) => station.x !== null && station.y !== null).length;
  detailsTitle.text(line.name);
  detailsBody.html(`
    <div>${line.type} ${line.code}</div>
    <div>${stationCount} stations with PDF coordinates</div>
    <div class="line-list"><span class="line-pill" style="background:${line.color}">${lineLabel(line)}</span></div>
  `);
}

function resetDetails() {
  detailsTitle.text("Select a station");
  detailsBody.text("Click a station dot or line badge to inspect the network.");
}

function resetZoom() {
  if (!mapData) return;
  const node = svg.node();
  const width = node.clientWidth || 1000;
  const height = node.clientHeight || 700;
  const contentWidth = Math.max(mapData.canvas.width - MAP_CONTENT_MIN_X, 1);
  const scale = Math.min(width / contentWidth, height / mapData.canvas.height) * 0.97;
  const tx = INITIAL_MAP_PADDING - MAP_CONTENT_MIN_X * scale;
  const ty = (height - mapData.canvas.height * scale) / 2;
  svg.transition().duration(350).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

document.querySelector("#zoomIn").addEventListener("click", () => {
  svg.transition().duration(180).call(zoom.scaleBy, 1.25);
});

document.querySelector("#zoomOut").addEventListener("click", () => {
  svg.transition().duration(180).call(zoom.scaleBy, 0.8);
});

document.querySelector("#zoomReset").addEventListener("click", resetZoom);
document.querySelector("#clearSelection").addEventListener("click", () => {
  clearLineSelection();
  selectedStationId = null;
  searchInput.value = "";
  hideStationSuggestions();
  updateSelection();
  resetDetails();
});

searchInput.addEventListener("input", () => {
  renderStationSuggestions();
  const station = exactStationMatch(searchInput.value);
  if (station) {
    const changedStation = selectedStationId !== station.id;
    selectedStationId = station.id;
    setStationLineSelection(station);
    hideStationSuggestions();
    if (changedStation) resetZoom();
    showStationDetails(station);
  } else {
    selectedStationId = null;
    clearLineSelection();
  }
  updateSelection();
});

searchInput.addEventListener("focus", renderStationSuggestions);

searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideStationSuggestions();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setActiveSuggestion(activeSuggestionIndex + 1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    setActiveSuggestion(activeSuggestionIndex - 1);
    return;
  }
  if (event.key === "Enter" && suggestionStations.length) {
    event.preventDefault();
    const station = suggestionStations[Math.max(activeSuggestionIndex, 0)];
    if (station) selectStationSuggestion(station);
  }
});

document.addEventListener("pointerdown", (event) => {
  if (event.target === searchInput || stationSuggestions.contains(event.target)) return;
  hideStationSuggestions();
});

window.addEventListener("resize", () => window.requestAnimationFrame(resetZoom));

fetch("/api/map")
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  })
  .then(render)
  .catch((error) => {
    stats.text("Could not load map data");
    detailsTitle.text("Database error");
    detailsBody.text(error.message);
  });
