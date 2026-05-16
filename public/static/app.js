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

let mapData = null;
let selectedLineId = null;
let selectedStationId = null;
let currentTransform = d3.zoomIdentity;
let stationLayout = new Map();

const LABEL_SCREEN_SIZE = 13;
const LABEL_LINE_HEIGHT = 15;
const LABEL_ROUTE_GAP = 8;
const LABEL_TEXT_DESCENT = 3;
const LABEL_STACK_GAP = 6;
const SVG_NS = "http://www.w3.org/2000/svg";

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

function lineSet(station) {
  return new Set(station.lines.map((line) => line.id));
}

function normalizeLabel(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function displayStationName(station) {
  return stationLayout.get(station.id)?.labelName || station.name;
}

function stationMatchesQuery(station, query) {
  if (!query) return false;
  const normalizedQuery = normalizeLabel(query);
  return normalizeLabel(station.name).includes(normalizedQuery) ||
    normalizeLabel(displayStationName(station)).includes(normalizedQuery);
}

function visibleByLine(d) {
  return !selectedLineId || d.lines?.some((line) => line.id === selectedLineId);
}

function routePath(points) {
  if (!points || points.length < 2) return "";
  return d3.line()
    .x((d) => d.x)
    .y((d) => d.y)
    .curve(d3.curveLinear)(points);
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
  const points = line.points || [];
  if (points.length < 2) return null;

  let closestIndex = -1;
  let closestDistance = Infinity;
  points.forEach((point, index) => {
    const distance = Math.hypot(+point.x - station.x, +point.y - station.y);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  });
  if (closestIndex < 0 || closestDistance > 55) return null;

  const previous = points[closestIndex - 1];
  const next = points[closestIndex + 1];
  const point = points[closestIndex];
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
    order: closestIndex,
    index: closestIndex,
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

  const drawableLines = data.lines.filter((line) => line.points.length > 1);
  routeLayer.selectAll("path")
    .data(drawableLines, (d) => d.id)
    .join("path")
    .attr("class", "route-line")
    .attr("d", (d) => routePath(d.points))
    .attr("stroke", (d) => d.color)
    .attr("stroke-width", (d) => routeStrokeWidth(d))
    .on("click", (event, d) => {
      event.stopPropagation();
      selectedLineId = selectedLineId === d.id ? null : d.id;
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
      selectedLineId = null;
      updateSelection();
      showStationDetails(d);
    });

  stations.selectAll(".station-marker").remove();
  stations.each(function (d) {
    const marker = stationLayout.get(d.id)?.marker || markerForStation(d, null);
    const node = document.createElementNS(SVG_NS, marker.shape === "capsule" ? "rect" : "circle");
    d3.select(this).append(() => node)
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

  lineFilters.selectAll("button")
    .data(data.lines.filter((line) => line.points.length > 1), (d) => d.id)
    .join("button")
    .attr("class", "line-button")
    .style("border-color", (d) => d.color)
    .style("background", (d) => selectedLineId === d.id ? d.color : "#eef1f6")
    .style("color", (d) => selectedLineId === d.id ? "#fff" : "#111827")
    .text((d) => lineLabel(d))
    .attr("title", (d) => d.name)
    .on("click", (event, d) => {
      selectedLineId = selectedLineId === d.id ? null : d.id;
      selectedStationId = null;
      updateSelection();
      if (selectedLineId) showLineDetails(d);
      else resetDetails();
    });

  svg.on("click", () => {
    selectedLineId = null;
    selectedStationId = null;
    searchInput.value = "";
    updateSelection();
    resetDetails();
  });

  stats.text(`${data.stats.stationCount} stations · ${data.stats.pathLineCount} drawable lines`);
  resetZoom();
  updateSelection();
}

function updateSelection() {
  const query = searchInput.value.trim().toLocaleLowerCase();

  routeLayer.selectAll("path")
    .classed("is-muted", (d) => selectedLineId && d.id !== selectedLineId)
    .classed("is-focus", (d) => selectedLineId === d.id);

  stationLayer.selectAll(".station")
    .classed("is-muted", (d) => {
      if (selectedLineId && !visibleByLine(d)) return true;
      if (query && !stationMatchesQuery(d, query)) return true;
      return false;
    })
    .classed("is-hit", (d) => query && stationMatchesQuery(d, query))
    .classed("is-selected", (d) => selectedStationId === d.id);

  labelLayer.selectAll("g.station-label")
    .classed("is-muted", (d) => {
      if (selectedLineId && !visibleByLine(d)) return true;
      if (query && !stationMatchesQuery(d, query)) return true;
      return false;
    });

  lineFilters.selectAll("button")
    .classed("is-active", (d) => selectedLineId === d.id)
    .style("background", (d) => selectedLineId === d.id ? d.color : "#eef1f6")
    .style("color", (d) => selectedLineId === d.id ? "#fff" : "#111827");

  updateLabelVisibility();
}

function updateLabelVisibility() {
  const scale = currentTransform.k;
  const query = searchInput.value.trim().toLocaleLowerCase();
  labelLayer.selectAll("g.station-label")
    .attr("display", (d) => {
      const selected = selectedStationId === d.id;
      const hit = query && stationMatchesQuery(d, query);
      const onLine = selectedLineId && visibleByLine(d);
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
  if (selectedLineId && visibleByLine(d)) return 2;
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
  const scale = Math.min(width / mapData.canvas.width, height / mapData.canvas.height) * 0.95;
  const tx = (width - mapData.canvas.width * scale) / 2;
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
  selectedLineId = null;
  selectedStationId = null;
  searchInput.value = "";
  updateSelection();
  resetDetails();
});

searchInput.addEventListener("input", updateSelection);
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
