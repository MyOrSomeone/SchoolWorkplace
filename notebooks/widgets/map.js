/* map.js — moteur de carte des cours : planisphère + globe 3D (d3-geo), pays/drapeaux, océans, lieux, routes, zones.
   Données : window.NB_MAP_DATA (généré depuis map.json). Ne pas modifier à la main. */
(function () {
    "use strict";
    var DATA = window.NB_MAP_DATA || {};
    var SCRIPT = (document.currentScript && document.currentScript.src) || "";
    var WORLD_URLS = ["https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json", "https://unpkg.com/world-atlas@2.0.2/countries-110m.json"];
    var KM_PER_DEG = 111.195, TAU = Math.PI * 2;

    function rel(f) { try { return new URL(f, SCRIPT).href; } catch (e) { return f; } }
    function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
    function norm(s) { return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function getJSON(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
    function flagUrl(a2, w) { return "https://flagcdn.com/w" + (w || 40) + "/" + a2 + ".png"; }

    /* ---- décodeur TopoJSON minimal (évite une dépendance) ---- */
    function topoFeatures(topo, obj) {
        var tf = topo.transform, arcs = topo.arcs.map(function (a) {
            var x = 0, y = 0;
            return a.map(function (p) {
                if (tf) { x += p[0]; y += p[1]; return [x * tf.scale[0] + tf.translate[0], y * tf.scale[1] + tf.translate[1]]; }
                return [p[0], p[1]];
            });
        });
        function arc(i) { return i < 0 ? arcs[~i].slice().reverse() : arcs[i].slice(); }
        function ring(ids) { var out = []; ids.forEach(function (i, j) { var a = arc(i); if (j) a.shift(); out = out.concat(a); }); return out; }
        function geom(g) {
            if (g.type === "Polygon") return { type: "Polygon", coordinates: g.arcs.map(ring) };
            if (g.type === "MultiPolygon") return { type: "MultiPolygon", coordinates: g.arcs.map(function (p) { return p.map(ring); }) };
            return null;
        }
        return obj.geometries.map(function (g) { return { type: "Feature", id: g.id, properties: g.properties || {}, geometry: geom(g) }; }).filter(function (f) { return f.geometry; });
    }

    /* ---- état ---- */
    var S = { mode: "flat", k: 1, center: [0, 0], W: 800, H: 600, s0: 100, sel: null, moved: false,
              layers: { countries: true, names: true, flags: false, seas: true, grid: false, cats: {}, hl: {} } };
    var CAT = {}, ITEMS = [], BYID = {}, FEATS = [], CTAB = { iso: {}, names: {} }, SEAS = [], proj, pathGen;
    var el = {}, raf = 0;

    (DATA.categories || []).forEach(function (c) { CAT[c.id] = c; S.layers.cats[c.id] = c.visible !== false; });
    (DATA.highlights || []).forEach(function (h) { S.layers.hl[h.id] = !!h.visible; });
    try { var saved = JSON.parse(localStorage.getItem("nbmap:" + location.pathname) || "null");
          if (saved) { S.mode = saved.mode || S.mode; Object.keys(saved.layers || {}).forEach(function (k) { if (typeof S.layers[k] === "boolean") S.layers[k] = saved.layers[k]; });
                       ["cats", "hl"].forEach(function (g) { Object.keys((saved.layers || {})[g] || {}).forEach(function (k) { if (k in S.layers[g]) S.layers[g][k] = saved.layers[g][k]; }); }); } } catch (e) { /* stockage indisponible */ }
    function persist() { try { localStorage.setItem("nbmap:" + location.pathname, JSON.stringify({ mode: S.mode, layers: S.layers })); } catch (e) { /* ignore */ } }

    /* ---- lieux : géométrie, ancre, couleur ---- */
    function prepItems() {
        (DATA.items || []).forEach(function (it) {
            var cat = CAT[it.cat] || {}, ll;
            it._c = it.color || cat.color || "#b8905a";
            it._i = (it.icon || cat.icon || "fa-location-dot").replace(/^fa-/, "");
            it._cat = cat.label || "";
            if (it.type === "route" && it.points && it.points.length > 1) {
                it._geo = { type: "LineString", coordinates: it.points.map(function (p) { return [p[1], p[0]]; }) };
                var m = it.points[Math.floor(it.points.length / 2)]; ll = [m[1], m[0]];
            } else if (it.type === "zone") {
                if (it.circle) { it._geo = d3.geoCircle().center([it.circle.lon, it.circle.lat]).radius((it.circle.radius_km || 300) / KM_PER_DEG)(); ll = [it.circle.lon, it.circle.lat]; }
                else if (it.polygon && it.polygon.length > 2) {
                    var ring = it.polygon.map(function (p) { return [p[1], p[0]]; }); ring.push(ring[0]);
                    var poly = { type: "Polygon", coordinates: [ring] };
                    if (d3.geoArea(poly) > TAU) { ring.reverse(); poly = { type: "Polygon", coordinates: [ring] }; }
                    it._geo = poly; ll = d3.geoCentroid(poly);
                }
            } else if (typeof it.lat === "number" && typeof it.lon === "number") { ll = [it.lon, it.lat]; it.type = "point"; }
            if (!ll) return;
            it._ll = ll; ITEMS.push(it); BYID[it.id] = it;
        });
    }

    /* ---- construction de l'interface ---- */
    function build() {
        var root = document.getElementById("mp");
        root.className = "mp" + (S.mode === "globe" ? " globe" : "");
        root.innerHTML =
            '<div class="mp-stage" id="mp-stage"><svg class="mp-svg" id="mp-svg"><defs>' +
            '<radialGradient id="mp-ocean-grad" cx="38%" cy="32%" r="85%"><stop offset="0" stop-color="var(--mp-ocean)"/><stop offset="1" stop-color="var(--mp-ocean2)"/></radialGradient>' +
            '</defs></svg><div class="mp-markers" id="mp-markers"></div>' +
            '<div class="mp-top"><div class="mp-search"><i class="fas fa-magnifying-glass"></i><input id="mp-q" type="search" placeholder="Rechercher un lieu, un pays, une mer…" autocomplete="off" aria-label="Rechercher"><div class="mp-results" id="mp-results"></div></div>' +
            '<div class="mp-seg" role="group" aria-label="Type de carte"><button data-mode="flat">Carte</button><button data-mode="globe">Globe</button></div>' +
            '<button class="mp-btn fs" id="mp-fs" title="Plein écran" aria-label="Plein écran"><i class="fas fa-expand"></i></button></div>' +
            '<div class="mp-zoom"><button class="mp-btn" id="mp-zin" aria-label="Zoom avant"><i class="fas fa-plus"></i></button><button class="mp-btn" id="mp-zout" aria-label="Zoom arrière"><i class="fas fa-minus"></i></button>' +
            '<button class="mp-btn" id="mp-home" title="Recentrer" aria-label="Recentrer"><i class="fas fa-crosshairs"></i></button></div>' +
            '<div class="mp-nav"><button data-open="layers"><i class="fas fa-layer-group"></i> Couches</button><button data-open="places"><i class="fas fa-list"></i> Lieux</button></div>' +
            '<div class="mp-status" id="mp-status"></div></div>' +
            '<aside class="mp-panel" id="mp-panel"><div class="mp-ptabs"><button data-tab="layers" class="on">Couches</button><button data-tab="places">Lieux</button>' +
            '<button class="x" id="mp-pclose" aria-label="Fermer"><i class="fas fa-xmark"></i></button></div>' +
            '<div class="mp-pane on" data-pane="layers" id="mp-layers"></div><div class="mp-pane" data-pane="places" id="mp-places"></div></aside>' +
            '<div class="mp-info" id="mp-info" hidden></div>';
        ["stage", "svg", "markers", "q", "results", "status", "panel", "layers", "places", "info"].forEach(function (id) { el[id] = document.getElementById("mp-" + id); });
        el.root = root;
        var svg = d3.select(el.svg);
        el.gSphere = svg.append("path").attr("class", "mp-sphere");
        el.gGrat = svg.append("path").attr("class", "mp-grat");
        el.gCountries = svg.append("g");
        el.gZones = svg.append("g"); el.gRoutes = svg.append("g");
        el.gSeas = svg.append("g"); el.gCl = svg.append("g"); el.gFlags = svg.append("g");
    }

    /* ---- projection ---- */
    function size() {
        var r = el.stage.getBoundingClientRect(); S.W = Math.max(200, r.width); S.H = Math.max(200, r.height);
        S.s0 = d3.geoNaturalEarth1().fitSize([S.W, S.H], { type: "Sphere" }).scale();
        S.R = Math.min(S.W, S.H) / 2 * 0.92;
    }
    function applyProj() {
        if (S.mode === "globe") {
            proj = d3.geoOrthographic().clipAngle(90).precision(0.6).scale(S.R * S.k).translate([S.W / 2, S.H / 2]).rotate([-S.center[0], -S.center[1]]);
        } else {
            proj = d3.geoNaturalEarth1().precision(0.6).scale(S.s0 * S.k).center(S.center).translate([S.W / 2, S.H / 2]);
        }
        pathGen = d3.geoPath(proj);
    }
    function clampCenter() {
        S.center[1] = clamp(S.center[1], S.mode === "globe" ? -88 : -80, S.mode === "globe" ? 88 : 80);
        S.center[0] = ((S.center[0] + 540) % 360) - 180;
        if (S.mode === "flat" && S.k < 1.02) S.center = [0, 0];
    }
    function pt(ll) {
        var p = proj(ll);
        if (!p) return null;
        if (S.mode === "globe" && d3.geoDistance(ll, S.center) > Math.PI / 2 - 0.02) return null;
        return p;
    }

    /* ---- rendu ---- */
    function schedule() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; draw(); }); }
    function labelOn(minK) { return S.k >= minK * (S.mode === "globe" ? 0.9 : 1); }
    function draw() {
        clampCenter(); applyProj();
        el.gSphere.attr("d", pathGen({ type: "Sphere" }));
        el.gGrat.attr("d", S.layers.grid ? pathGen(d3.geoGraticule10()) : null);
        el.gCountries.style("display", S.layers.countries ? null : "none").selectAll("path").attr("d", pathGen);
        el.gZones.selectAll("path").attr("d", function (d) { return pathGen(d._geo); });
        el.gRoutes.selectAll("path").attr("d", function (d) { return pathGen(d._geo); });
        // océans et mers
        el.gSeas.style("display", S.layers.seas ? null : "none").selectAll("text").each(function (d) {
            var p = labelOn(d.minK) ? pt([d.lon, d.lat]) : null;
            this.style.display = p ? "" : "none";
            if (p) { this.setAttribute("x", p[0]); this.setAttribute("y", p[1]); }
        });
        // noms et drapeaux des pays (selon la taille à l'écran)
        var thr = 0.02, showN = S.layers.names && S.layers.countries, showF = S.layers.flags && S.layers.countries;
        el.gCl.selectAll("text").each(function (d) {
            var p = showN && d._a * S.k * S.k >= thr ? pt(d._c) : null;
            this.style.display = p ? "" : "none";
            if (p) { this.setAttribute("x", p[0]); this.setAttribute("y", p[1] + (showF ? 17 : 4)); }
        });
        el.gFlags.selectAll("image").each(function (d) {
            var p = showF && d._a * S.k * S.k >= thr * 0.6 ? pt(d._c) : null;
            this.style.display = p ? "" : "none";
            if (p) { this.setAttribute("x", p[0] - 12); this.setAttribute("y", p[1] - 9); }
        });
        // marqueurs
        var out = 40;
        ITEMS.forEach(function (it) {
            var b = it._btn, vis = S.layers.cats[it.cat] !== false, p = vis ? pt(it._ll) : null;
            if (!p || p[0] < -out || p[1] < -out || p[0] > S.W + out || p[1] > S.H + out) { b.style.display = "none"; return; }
            b.style.display = ""; b.style.transform = "translate(" + Math.round(p[0]) + "px," + Math.round(p[1]) + "px)";
        });
        el.root.classList.toggle("labels", S.k >= 3);
    }

    function paintCountries() {
        var hl = (DATA.highlights || []).filter(function (h) { return S.layers.hl[h.id]; });
        el.gCountries.selectAll("path").each(function (d) {
            var c = null;
            hl.forEach(function (h) { if ((h.countries || []).some(function (a) { return a.toLowerCase() === d._a2; })) c = h.color || "#f59e0b"; });
            this.style.fill = c ? c : ""; this.style.fillOpacity = c ? 0.6 : "";
            this.classList.toggle("sel", S.sel && S.sel.kind === "country" && S.sel.f === d);
        });
        el.gZones.selectAll("path").classed("sel", function (d) { return S.sel && S.sel.kind === "item" && S.sel.it === d; });
        el.gRoutes.selectAll("path.mp-route").classed("sel", function (d) { return S.sel && S.sel.kind === "item" && S.sel.it === d; });
        ITEMS.forEach(function (it) { it._btn.classList.toggle("sel", !!(S.sel && S.sel.kind === "item" && S.sel.it === it)); });
    }

    /* ---- couches de contenu ---- */
    function buildContent() {
        var zones = ITEMS.filter(function (i) { return i.type === "zone" && i._geo; }), routes = ITEMS.filter(function (i) { return i.type === "route" && i._geo; });
        el.gZones.selectAll("path").data(zones).enter().append("path").attr("class", "mp-zone")
            .style("fill", function (d) { return d._c; }).style("stroke", function (d) { return d._c; })
            .style("display", function (d) { return S.layers.cats[d.cat] === false ? "none" : null; })
            .on("click", function (e, d) { if (!S.moved) select({ kind: "item", it: d }); }).append("title").text(function (d) { return d.title; });
        var gr = el.gRoutes.selectAll("g").data(routes).enter().append("g")
            .style("display", function (d) { return S.layers.cats[d.cat] === false ? "none" : null; });
        gr.append("path").attr("class", function (d) { return "mp-route" + (d.animated === false ? "" : " flow"); }).style("stroke", function (d) { return d._c; })
            ;
        gr.append("path").attr("class", "mp-hit").on("click", function (e, d) { if (!S.moved) select({ kind: "item", it: d }); })
            .append("title").text(function (d) { return d.title; });
        ITEMS.forEach(function (it) {
            var b = document.createElement("button");
            b.className = "mp-marker"; b.style.setProperty("--c", it._c); b.setAttribute("aria-label", it.title);
            b.innerHTML = '<span class="dot"><i class="fas fa-' + esc(it._i) + '"></i></span><span class="lbl">' + esc(it.title) + "</span>";
            b.addEventListener("click", function (e) { e.stopPropagation(); if (!S.moved) select({ kind: "item", it: it }); });
            el.markers.appendChild(b); it._btn = b;
        });
    }
    function refreshCats() {
        el.gZones.selectAll("path").style("display", function (d) { return S.layers.cats[d.cat] === false ? "none" : null; });
        el.gRoutes.selectAll("g").style("display", function (d) { return S.layers.cats[d.cat] === false ? "none" : null; });
        persist(); schedule();
    }
    function setCatVisible(id, on) { S.layers.cats[id] = on; refreshCats(); }

    /* ---- fond de carte ---- */
    function buildWorld(feats) {
        FEATS = feats;
        feats.forEach(function (f) {
            var id = f.id == null ? "" : String(f.id), t = CTAB.iso[id] || CTAB.names[f.properties.name] || null;
            f._a2 = t ? t[0] : ""; f._fr = t ? t[1] : (f.properties.name || "Territoire");
            var geom = f.geometry, best = f;
            if (geom.type === "MultiPolygon") {
                var bestA = -1; geom.coordinates.forEach(function (c) { var p = { type: "Polygon", coordinates: c }, a = d3.geoArea(p); if (a > bestA) { bestA = a; best = p; } });
            }
            f._c = d3.geoCentroid(best); f._area = d3.geoArea(f); f._a = f._area;
        });
        el.gCountries.selectAll("path").data(feats).enter().append("path").attr("class", "mp-country")
            .on("click", function (e, d) { if (!S.moved) select({ kind: "country", f: d }); })
            .append("title").text(function (d) { return d._fr; });
        el.gCl.selectAll("text").data(feats.filter(function (f) { return f._area > 0.0004; })).enter().append("text").attr("class", "mp-clabel").text(function (d) { return d._fr; });
        buildFlags();
        paintCountries(); buildSearchIndex(); schedule();
    }
    function buildFlags() {
        if (!S.layers.flags || el.gFlags.selectAll("image").size()) return;
        el.gFlags.selectAll("image").data(FEATS.filter(function (f) { return f._a2 && f._area > 0.0004; })).enter().append("image")
            .attr("class", "mp-flag").attr("width", 24).attr("height", 16).attr("href", function (d) { return flagUrl(d._a2, 40); })
            .on("error", function () { this.style.visibility = "hidden"; });
    }
    function buildSeas() {
        var all = SEAS.concat((DATA.labels || []).map(function (l) { return { id: l.id, text: l.text, lat: l.lat, lon: l.lon, kind: l.kind || "sea", minK: l.minK || 1.7, desc: l.desc }; }));
        SEAS = all;
        el.gSeas.selectAll("text").data(all).enter().append("text").attr("class", function (d) { return "mp-sea " + d.kind; }).text(function (d) { return d.text; });
    }

    /* ---- sélection et fiche ---- */
    function select(s) {
        S.sel = s; paintCountries(); showInfo(s);
        if (s.kind === "item") { /* ne bouge pas la vue : l'élève peut explorer */ }
    }
    function closeInfo() { S.sel = null; el.info.hidden = true; el.root.classList.remove("has-info"); paintCountries(); }
    function showInfo(s) {
        var h = "", c = "var(--mp-accent)", hd = "", acts = "";
        if (s.kind === "item") {
            var it = s.it; c = it._c;
            hd = '<div class="ic"><i class="fas fa-' + esc(it._i) + '"></i></div><div><div class="tag">' + esc(it.short || it._cat) + "</div><h3>" + esc(it.title) + "</h3></div>";
            h = (it.desc ? "<p>" + esc(it.desc) + "</p>" : "");
            if (it.facts && it.facts.length) h += '<ul class="facts">' + it.facts.map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("") + "</ul>";
            if (it.href) acts += '<a href="' + esc(it.href) + '" target="_parent"><i class="fas fa-book-open"></i> Voir dans le cours</a>';
            acts += '<button data-act="focus"><i class="fas fa-location-crosshairs"></i> Centrer</button>';
        } else if (s.kind === "country") {
            var f = s.f, note = (DATA.countryNotes || {})[(f._a2 || "").toUpperCase()] || {};
            hd = '<div class="ic">' + (f._a2 ? '<img alt="" src="' + flagUrl(f._a2, 80) + '" onerror="this.remove()">' : '<i class="fas fa-flag"></i>') + '</div><div><div class="tag">Pays</div><h3>' + esc(f._fr) + "</h3></div>";
            (DATA.highlights || []).forEach(function (hlt) { if ((hlt.countries || []).some(function (a) { return a.toLowerCase() === f._a2; })) h += '<span class="badge" style="--c:' + esc(hlt.color || "#f59e0b") + '">' + esc(hlt.title) + "</span>"; });
            if (note.desc) h += "<p>" + esc(note.desc) + "</p>";
            if (note.facts) h += '<ul class="facts">' + note.facts.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>";
            var rel2 = ITEMS.filter(function (i) { return (i.countries || []).some(function (a) { return a.toLowerCase() === f._a2; }); });
            if (rel2.length) h += "<p><b>Lieux du cours :</b> " + rel2.map(function (i) { return '<button class="mp-link" data-goto="' + esc(i.id) + '">' + esc(i.title) + "</button>"; }).join(" ") + "</p>";
            if (!h) h = "<p>Touche un lieu coloré de la carte pour voir sa fiche.</p>";
            acts += '<button data-act="focus"><i class="fas fa-location-crosshairs"></i> Centrer</button>';
        } else if (s.kind === "sea") {
            hd = '<div class="ic" style="--c:#2d6a86"><i class="fas fa-water"></i></div><div><div class="tag">' + (s.sea.kind === "ocean" ? "Océan" : "Mer / golfe") + "</div><h3>" + esc(s.sea.text) + "</h3></div>";
            h = s.sea.desc ? "<p>" + esc(s.sea.desc) + "</p>" : "<p>Touche un lieu coloré de la carte pour voir sa fiche.</p>";
            c = "#2d6a86"; acts += '<button data-act="focus"><i class="fas fa-location-crosshairs"></i> Centrer</button>';
        }
        el.info.style.setProperty("--c", c);
        el.info.innerHTML = '<div class="hd">' + hd + '<button class="cl" aria-label="Fermer" data-act="close"><i class="fas fa-xmark"></i></button></div><div class="bd">' + h + '<div class="acts">' + acts + "</div></div>";
        el.info.hidden = false; el.info.scrollTop = 0; el.root.classList.add("has-info"); el.root.classList.remove("panel-open");
    }
    function focusSel() {
        var s = S.sel; if (!s) return;
        if (s.kind === "item") flyToGeo(s.it._geo || { type: "Point", coordinates: s.it._ll }, s.it._ll);
        else if (s.kind === "country") flyToGeo(s.f.geometry, s.f._c);
        else if (s.kind === "sea") fly([s.sea.lon, s.sea.lat], s.sea.kind === "ocean" ? 1.6 : 3);
    }

    /* ---- animations de vue ---- */
    function fly(center, k, ms) {
        var c0 = S.center.slice(), k0 = S.k, t0 = performance.now(), dur = ms || 700;
        var dl = center[0] - c0[0]; if (dl > 180) dl -= 360; if (dl < -180) dl += 360;
        (function step(now) {
            var t = clamp((now - t0) / dur, 0, 1), e = t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
            S.center = [c0[0] + dl * e, c0[1] + (center[1] - c0[1]) * e];
            S.k = Math.exp(Math.log(k0) + (Math.log(k) - Math.log(k0)) * e);
            draw(); if (t < 1) requestAnimationFrame(step);
        })(t0);
    }
    function flyToGeo(geo, ll) {
        var k = S.mode === "globe" ? 2 : 3;
        if (geo.type !== "Point") {
            var b = d3.geoBounds(geo), w = b[1][0] - b[0][0]; if (w < 0) w += 360;
            var span = Math.max(w * 1.5, (b[1][1] - b[0][1]) * 2.2, 8);
            k = clamp((S.mode === "globe" ? 150 : 330) / span, 1.2, 14);
            ll = [b[0][0] + w / 2, (b[0][1] + b[1][1]) / 2]; if (ll[0] > 180) ll[0] -= 360;
        }
        fly(ll, k);
    }

    /* ---- interactions ---- */
    function bindInteractions() {
        var ptrs = {}, last = null, pinch0 = 0, k0 = 1;
        function pos(e) { var r = el.stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
        el.stage.addEventListener("pointerdown", function (e) {
            if (e.target.closest(".mp-top,.mp-zoom,.mp-nav,.mp-status,.mp-marker")) return;
            ptrs[e.pointerId] = pos(e); S.moved = false; last = pos(e);
            if (Object.keys(ptrs).length === 2) { var a = Object.values(ptrs); pinch0 = Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]); k0 = S.k; }
            el.stage.classList.add("dragging");
        });
        window.addEventListener("pointermove", function (e) {
            if (!ptrs[e.pointerId]) return;
            var p = pos(e), n = Object.keys(ptrs).length; ptrs[e.pointerId] = p;
            if (n >= 2) {
                var a = Object.values(ptrs), d = Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]); S.moved = true;
                if (pinch0) setZoom(k0 * d / pinch0); schedule(); return;
            }
            var dx = p[0] - last[0], dy = p[1] - last[1]; last = p;
            S.dragAcc = (S.dragAcc || 0) + Math.abs(dx) + Math.abs(dy);
            if (S.dragAcc > 6) S.moved = true;
            if (!S.moved) return;
            if (S.mode === "globe") { var f = 57.2958 / (S.R * S.k); S.center = [S.center[0] - dx * f, S.center[1] + dy * f]; }
            else { var c = proj.invert([S.W / 2 - dx, S.H / 2 - dy]); if (c) S.center = c; }
            schedule();
        });
        function up(e) { delete ptrs[e.pointerId]; if (!Object.keys(ptrs).length) { el.stage.classList.remove("dragging"); S.dragAcc = 0; pinch0 = 0; setTimeout(function () { S.moved = false; }, 0); } }
        window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
        el.stage.addEventListener("wheel", function (e) { e.preventDefault(); var p = pos(e); zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, p[0], p[1]); }, { passive: false });
        el.stage.addEventListener("dblclick", function (e) { if (e.target.closest(".mp-top,.mp-zoom,.mp-marker")) return; var p = pos(e); zoomAt(2, p[0], p[1]); });
        function ctl(id, fn) { document.getElementById(id).addEventListener("click", fn); }
        ctl("mp-zin", function () { zoomAt(1.5, S.W / 2, S.H / 2); });
        ctl("mp-zout", function () { zoomAt(1 / 1.5, S.W / 2, S.H / 2); });
        ctl("mp-home", function () { fly([DATA.view && DATA.view.lon || 0, DATA.view && DATA.view.lat || 0], 1); });
        ctl("mp-fs", toggleFullscreen);
        ctl("mp-pclose", function () { el.root.classList.remove("panel-open"); });
        el.root.addEventListener("click", function (e) {
            var b = e.target.closest("[data-mode]"); if (b) setMode(b.getAttribute("data-mode"));
            b = e.target.closest("[data-open]"); if (b) { openPanel(b.getAttribute("data-open")); }
            b = e.target.closest("[data-tab]"); if (b) switchTab(b.getAttribute("data-tab"));
            b = e.target.closest("[data-act]"); if (b) { var a = b.getAttribute("data-act"); if (a === "close") closeInfo(); if (a === "focus") focusSel(); }
            b = e.target.closest("[data-goto]"); if (b) goTo(b.getAttribute("data-goto"));
        });
        document.addEventListener("keydown", function (e) { if (e.key === "Escape") { if (!el.info.hidden) closeInfo(); else el.root.classList.remove("panel-open"); } });
        new ResizeObserver(function () { size(); schedule(); }).observe(el.stage);
    }
    function setZoom(k) { S.k = clamp(k, S.mode === "globe" ? 0.6 : 1, 60); }
    function zoomAt(f, px, py) {
        if (S.mode === "globe") { setZoom(S.k * f); draw(); return; }
        var g = proj.invert([px, py]); setZoom(S.k * f); applyProj();
        if (g) { var q = proj(g); var c = proj.invert([S.W / 2 - (px - q[0]), S.H / 2 - (py - q[1])]); if (c) S.center = c; }
        draw();
    }
    function setMode(m) {
        if (m === S.mode) return;
        S.mode = m; S.k = m === "globe" ? 1.05 : 1;
        el.root.classList.toggle("globe", m === "globe");
        Array.prototype.forEach.call(document.querySelectorAll("[data-mode]"), function (b) { b.classList.toggle("on", b.getAttribute("data-mode") === m); });
        persist(); draw();
    }
    function toggleFullscreen() {
        function ask() { try { window.parent.postMessage({ nbm: "toggle-expand" }, "*"); } catch (e) { /* ignore */ } }
        var d = document.documentElement;
        if (document.fullscreenElement) { document.exitFullscreen(); }
        else if (d.requestFullscreen) { d.requestFullscreen().catch(ask); } else ask();
    }
    function openPanel(tab) { switchTab(tab); el.root.classList.add("panel-open"); el.root.classList.remove("panel-collapsed"); }
    function switchTab(tab) {
        Array.prototype.forEach.call(document.querySelectorAll("[data-tab]"), function (b) { b.classList.toggle("on", b.getAttribute("data-tab") === tab); });
        Array.prototype.forEach.call(document.querySelectorAll("[data-pane]"), function (p) { p.classList.toggle("on", p.getAttribute("data-pane") === tab); });
    }
    function goTo(id) { var it = BYID[id]; if (!it) return; select({ kind: "item", it: it }); focusSel(); }

    /* ---- panneaux Couches et Lieux ---- */
    function buildPanels() {
        var h = "<h4>Fond de carte</h4>";
        [["countries", "Pays"], ["names", "Noms des pays"], ["flags", "Drapeaux"], ["seas", "Océans et mers"], ["grid", "Grille (méridiens, parallèles)"]].forEach(function (x) {
            h += '<label class="mp-row"><input type="checkbox" data-layer="' + x[0] + '"' + (S.layers[x[0]] ? " checked" : "") + "><span>" + x[1] + "</span></label>";
        });
        var cats = (DATA.categories || []);
        if (cats.length) {
            h += '<h4>Contenu du cours</h4><div><button class="mp-link" data-all="1">Tout afficher</button><button class="mp-link" data-all="0">Tout masquer</button></div>';
            cats.forEach(function (c) {
                var n = ITEMS.filter(function (i) { return i.cat === c.id; }).length;
                h += '<label class="mp-row"><input type="checkbox" data-cat="' + esc(c.id) + '"' + (S.layers.cats[c.id] !== false ? " checked" : "") + '><span class="sw" style="--c:' + esc(c.color || "#b8905a") + '"></span><span>' + esc(c.label) + '</span><span class="n">' + n + "</span></label>";
            });
        }
        var hls = DATA.highlights || [];
        if (hls.length) {
            h += "<h4>Pays mis en évidence</h4>";
            hls.forEach(function (x) { h += '<label class="mp-row"><input type="checkbox" data-hl="' + esc(x.id) + '"' + (S.layers.hl[x.id] ? " checked" : "") + '><span class="sw" style="--c:' + esc(x.color || "#f59e0b") + '"></span><span>' + esc(x.title) + "</span></label>"; });
        }
        el.layers.innerHTML = h;
        el.layers.addEventListener("change", function (e) {
            var t = e.target;
            if (t.dataset.layer) { S.layers[t.dataset.layer] = t.checked; if (t.dataset.layer === "flags") buildFlags(); persist(); schedule(); }
            if (t.dataset.cat) setCatVisible(t.dataset.cat, t.checked);
            if (t.dataset.hl) { S.layers.hl[t.dataset.hl] = t.checked; persist(); paintCountries(); }
        });
        el.layers.addEventListener("click", function (e) {
            var b = e.target.closest("[data-all]"); if (!b) return;
            var on = b.getAttribute("data-all") === "1";
            cats.forEach(function (c) { S.layers.cats[c.id] = on; });
            Array.prototype.forEach.call(el.layers.querySelectorAll("[data-cat]"), function (i) { i.checked = on; });
            refreshCats();
        });
        var p = "";
        cats.forEach(function (c) {
            var list = ITEMS.filter(function (i) { return i.cat === c.id; });
            if (!list.length) return;
            p += '<details open><summary><span class="sw" style="--c:' + esc(c.color) + ';display:inline-block;width:12px;height:12px;border-radius:50%;background:' + esc(c.color) + ';margin-right:8px"></span>' + esc(c.label) + "</summary>";
            list.forEach(function (i) { p += '<button class="mp-row" style="width:100%;border:0;background:none;text-align:left" data-goto="' + esc(i.id) + '"><span class="sw" style="--c:' + esc(i._c) + '"></span><span>' + esc(i.title) + '</span><span class="n">' + esc(i.short || "") + "</span></button>"; });
            p += "</details>";
        });
        el.places.innerHTML = p || "<p>Aucun lieu pour le moment.</p>";
    }

    /* ---- recherche ---- */
    var INDEX = [];
    function buildSearchIndex() {
        INDEX = ITEMS.map(function (i) { return { k: "item", label: i.title, sub: i._cat, n: norm(i.title), ref: i }; })
            .concat(FEATS.map(function (f) { return { k: "country", label: f._fr, sub: "Pays", n: norm(f._fr), ref: f }; }))
            .concat(SEAS.map(function (s) { return { k: "sea", label: s.text, sub: s.kind === "ocean" ? "Océan" : "Mer", n: norm(s.text), ref: s }; }));
    }
    function bindSearch() {
        el.q.addEventListener("input", function () {
            var q = norm(el.q.value.trim());
            if (q.length < 2) { el.results.classList.remove("open"); return; }
            var res = INDEX.filter(function (x) { return x.n.indexOf(q) >= 0; })
                .sort(function (a, b) { return (a.n.indexOf(q) === 0 ? 0 : 1) - (b.n.indexOf(q) === 0 ? 0 : 1) || (a.k === "item" ? -1 : 0) - (b.k === "item" ? -1 : 0); }).slice(0, 9);
            el.results.innerHTML = res.length ? res.map(function (x, i) { return '<button data-r="' + i + '">' + esc(x.label) + "<small>" + esc(x.sub) + "</small></button>"; }).join("") : '<button disabled>Aucun résultat</button>';
            el.results._res = res; el.results.classList.add("open");
        });
        el.results.addEventListener("click", function (e) {
            var b = e.target.closest("[data-r]"); if (!b) return;
            var x = el.results._res[+b.getAttribute("data-r")];
            el.results.classList.remove("open"); el.q.blur();
            if (x.k === "item") select({ kind: "item", it: x.ref }); else if (x.k === "country") select({ kind: "country", f: x.ref }); else select({ kind: "sea", sea: x.ref });
            focusSel();
        });
        document.addEventListener("click", function (e) { if (!e.target.closest(".mp-search")) el.results.classList.remove("open"); });
    }

    /* ---- démarrage ---- */
    function status(msg) { el.status.textContent = msg || ""; el.status.classList.toggle("on", !!msg); }
    function start() {
        if (!window.d3) { document.body.innerHTML = '<p style="padding:2rem;font-family:sans-serif">La bibliothèque cartographique (d3) n’a pas pu être chargée. Vérifie la connexion.</p>'; return; }
        prepItems(); build(); size();
        if (DATA.view) { S.center = [DATA.view.lon || 0, DATA.view.lat || 0]; if (DATA.view.k) S.k = DATA.view.k; }
        Array.prototype.forEach.call(document.querySelectorAll("[data-mode]"), function (b) { b.classList.toggle("on", b.getAttribute("data-mode") === S.mode); });
        if (window.innerWidth < 900) el.root.classList.add("compact-top");
        buildContent(); buildPanels(); bindInteractions(); bindSearch();
        applyProj(); draw();
        status("Chargement du fond de carte…");
        // tables (pays en français, mers) d'abord : le fond de carte a besoin des noms et des codes pour les drapeaux
        Promise.all([getJSON(rel("countries-fr.json")).catch(function () { return CTAB; }), getJSON(rel("seas-fr.json")).catch(function () { return []; })]).then(function (r) {
            CTAB = r[0]; SEAS = r[1]; buildSeas(); buildSearchIndex(); schedule();
            (function tryWorld(i) {
                if (i >= WORLD_URLS.length) { status("Fond de carte indisponible hors connexion : les lieux du cours restent affichés."); setTimeout(function () { status(""); }, 6000); return; }
                getJSON(WORLD_URLS[i]).then(function (topo) { buildWorld(topoFeatures(topo, topo.objects.countries)); status(""); }).catch(function () { tryWorld(i + 1); });
            })(0);
        });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
