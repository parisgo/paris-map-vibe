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

const zoom = d3.zoom()
  .scaleExtent([0.18, 9])
  .on("zoom", (event) => {
    currentTransform = event.transform;
    root.attr("transform", currentTransform);
    updateLabelVisibility();
  });

svg.call(zoom);

function lineLabel(line) {
  const prefix = line.type === "METRO" ? "M" : line.type === "TRAM" || line.type === "Tramway" ? "T" : line.type;
  return `${prefix}${line.code}`;
}

function lineSet(station) {
  return new Set(station.lines.map((line) => line.id));
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
    .attr("stroke-width", (d) => d.type === "RER" || d.type === "TRAIN" ? 8 : 6)
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

  stations.append("circle")
    .attr("class", "station-dot")
    .attr("r", (d) => Math.max(5, Math.min(11, 4 + d.lines.length * 1.4)));

  labelLayer.selectAll("text")
    .data(data.stations, (d) => d.id)
    .join("text")
    .attr("class", "station-label")
    .attr("x", (d) => d.x + 12)
    .attr("y", (d) => d.y - 12)
    .text((d) => d.name);

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
      if (query && !d.name.toLocaleLowerCase().includes(query)) return true;
      return false;
    })
    .classed("is-hit", (d) => query && d.name.toLocaleLowerCase().includes(query))
    .classed("is-selected", (d) => selectedStationId === d.id);

  labelLayer.selectAll("text")
    .classed("is-muted", (d) => {
      if (selectedLineId && !visibleByLine(d)) return true;
      if (query && !d.name.toLocaleLowerCase().includes(query)) return true;
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
  labelLayer.selectAll("text")
    .attr("display", (d) => {
      const selected = selectedStationId === d.id;
      const hit = query && d.name.toLocaleLowerCase().includes(query);
      const onLine = selectedLineId && visibleByLine(d);
      return scale > 1.15 || selected || hit || onLine ? null : "none";
    })
    .attr("font-size", Math.max(10, 18 / Math.sqrt(scale)));
}

function showTooltip(event, station) {
  const lines = station.lines.map((line) => lineLabel(line)).join(" · ") || "No line data";
  tooltip
    .attr("hidden", null)
    .style("left", `${event.clientX + 14}px`)
    .style("top", `${event.clientY + 14}px`)
    .html(`<strong>${station.name}</strong><br><span>${lines}</span><br><span>x ${station.x.toFixed(1)}, y ${station.y.toFixed(1)}</span>`);
}

function showStationDetails(station) {
  detailsTitle.text(station.name);
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
