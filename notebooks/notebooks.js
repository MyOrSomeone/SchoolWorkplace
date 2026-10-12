/* notebooks.js — runtime commun des pages de cours. Fichier découpé en blocs (@block/@endblock) ;
   l'IA lit notebooks.doc.json, jamais ce fichier en entier. Chaque module est isolé : s'il plante, les autres continuent. */

// @block nb-core
(function () {
    "use strict";
    var NB = window.NB = window.NB || {};
    NB.ready = false;
    NB._mods = [];

    function run(m) {
        try { m.fn(); } catch (e) { console.error("[notebooks] module '" + m.name + "' :", e); }
    }
    /* NB.register(nom, fn, {perDom:true}) : fn s'exécute au chargement (et tout de suite si la page est déjà prête).
       perDom:true = module lié à des éléments précis, relancé par NB.reinit(). */
    NB.register = function (name, fn, opts) {
        var m = { name: name, fn: fn, perDom: !!(opts && opts.perDom) };
        NB._mods.push(m);
        if (NB.ready) run(m);
    };
    NB.boot = function () {
        NB.ready = true;
        NB._mods.forEach(run);
        if (window.MathJax && window.MathJax.typesetPromise) window.MathJax.typesetPromise();
    };
    NB.reinit = function () {
        NB._mods.filter(function (m) { return m.perDom; }).forEach(run);
        if (window.MathJax && window.MathJax.typesetPromise) window.MathJax.typesetPromise();
    };
    NB.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
    NB.esc = function (s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    };
    NB.slug = function (t) {
        return String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
            .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    };
    window.SCHOOLWORKSPACE_NOTEBOOK_REINIT = function () { NB.reinit(); };
})();
// @endblock nb-core

// @block nb-defs
/* Bulles de définition. Définition écrite DANS le HTML :
   1re fois : <span class="def-term" data-term="slug" data-def="Définition…">mot</span>
   ensuite  : <span class="def-term" data-term="slug">mot</span>   (le glossaire de la matière est injecté par le script de build dans window.NB_DEFINITIONS) */
NB.register("defs", function () {
    var defs = window.NB_DEFINITIONS || {};

    function resolve(span) {
        var own = (span.getAttribute("data-def") || "").trim();
        if (own.length >= 25 || /\s/.test(own)) return own;           // définition en ligne
        var keys = [span.getAttribute("data-term"), own, NB.slug(span.textContent), span.textContent.trim()];
        for (var i = 0; i < keys.length; i++) if (keys[i] && defs[keys[i]]) return defs[keys[i]];
        return "";
    }
    function tip() {
        var t = document.getElementById("nb-def-tooltip");
        if (!t) {
            t = document.createElement("div");
            t.id = "nb-def-tooltip";
            t.className = "def-tooltip";
            t.style.display = "none";
            t.innerHTML = '<strong id="nb-def-term"></strong><div id="nb-def-body"></div>';
            document.body.appendChild(t);
        }
        return t;
    }
    function show(span) {
        var t = tip(), r = span.getBoundingClientRect();
        t.querySelector("#nb-def-term").textContent = span.textContent.trim();
        t.querySelector("#nb-def-body").textContent = resolve(span) || "Définition non trouvée.";
        t.style.display = "block";
        t.style.left = Math.max(8, Math.min(r.left, window.innerWidth - t.offsetWidth - 8)) + "px";
        var below = r.bottom + 8, above = r.top - t.offsetHeight - 8;
        t.style.top = (below + t.offsetHeight > window.innerHeight && above > 0 ? above : below) + "px";
    }
    function hide() { var t = document.getElementById("nb-def-tooltip"); if (t) t.style.display = "none"; }

    if (!NB._defsBound) {
        NB._defsBound = true;
        document.addEventListener("click", function (e) {
            var span = e.target.closest(".def-term");
            if (span) { e.stopPropagation(); show(span); }
            else if (!e.target.closest("#nb-def-tooltip")) hide();
        });
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape") hide();
            var span = e.target.closest && e.target.closest(".def-term");
            if (span && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); show(span); }
        });
        window.addEventListener("scroll", hide, { passive: true });
    }
    NB.$$(".def-term").forEach(function (s) { s.setAttribute("tabindex", "0"); s.setAttribute("role", "button"); });
});
// @endblock nb-defs

// @block nb-tabs
/* Onglets .nb-tabs. Marche avec onclick="switchTab(event,'id-du-panneau')" (ou openTab) ET sans onclick (par ordre). */
NB.register("tabs", function () {
    function parts(box) {
        var own = function (el) { return el.closest(".nb-tabs") === box; };
        return { btns: NB.$$(".nb-tab-btn", box).filter(own), panels: NB.$$(".nb-tab-panel", box).filter(own) };
    }
    function activate(btn, panelId) {
        var box = btn && btn.closest(".nb-tabs");
        if (!box) return;
        var p = parts(box);
        var panel = panelId ? p.panels.filter(function (x) { return x.id === panelId; })[0] : p.panels[p.btns.indexOf(btn)];
        if (!panel) return;
        p.btns.forEach(function (b) { b.classList.remove("active"); });
        p.panels.forEach(function (x) { x.classList.remove("active"); });
        btn.classList.add("active");
        panel.classList.add("active");
    }
    window.switchTab = window.openTab = function (evt, id) {
        var e = evt || window.event;
        activate((e && (e.currentTarget || e.target)).closest(".nb-tab-btn"), id);
    };
    if (!NB._tabsBound) {
        NB._tabsBound = true;
        document.addEventListener("click", function (e) {
            var btn = e.target.closest(".nb-tab-btn");
            if (btn && !btn.hasAttribute("onclick")) activate(btn);
        });
    }
});
// @endblock nb-tabs

// @block nb-mindmap
/* Carte mentale pan/zoom : éléments #mm-viewport #mm-canvas #mm-svg #mm-node-center, branches .mm-branch[data-node],
   boutons #mm-zoom-in #mm-zoom-out #mm-reset #mm-toggle-all. Sans ces éléments, le module ne fait rien. */
NB.register("mindmap", function () {
    var viewport = document.getElementById("mm-viewport");
    var canvas = document.getElementById("mm-canvas");
    var svg = document.getElementById("mm-svg");
    var centerNode = document.getElementById("mm-node-center");
    if (!viewport || !canvas || !svg || !centerNode || viewport.dataset.ready) return;
    viewport.dataset.ready = "1";

    var scale = 0.9, panX = 0, panY = 0;
    var isDragging = false, dragMoved = false, startX = 0, startY = 0, pointerStartX = 0, pointerStartY = 0;
    var initialPinchDistance = null, initialScale = scale, allOpen = false;
    var COLORS = { "1": "#ef4444", "2": "#3b82f6", "3": "#10b981", "4": "#f59e0b", "5": "#a855f7" };

    function updateTransform() {
        canvas.style.transform = "translate3d(calc(-50% + " + panX + "px), calc(-50% + " + panY + "px), 0) scale(" + scale + ")";
    }
    function drawConnections() {
        var cX = centerNode.offsetLeft + centerNode.offsetWidth / 2;
        var cY = centerNode.offsetTop + centerNode.offsetHeight / 2;
        var html = "";
        NB.$$(".mm-branch").forEach(function (branch) {
            var bX = branch.offsetLeft + branch.offsetWidth / 2;
            var bY = branch.offsetTop + branch.offsetHeight / 2;
            var mid = cX + (bX - cX) * 0.5;
            var color = COLORS[branch.getAttribute("data-node")] || "#b8905a";
            html += '<path d="M ' + cX + " " + cY + " C " + mid + " " + cY + ", " + mid + " " + bY + ", " + bX + " " + bY +
                '" fill="none" stroke="' + color + '" stroke-width="3" stroke-dasharray="6,4" opacity="0.6"/>';
        });
        svg.innerHTML = html;
    }
    function setBranch(branch, open) {
        var id = branch.getAttribute("data-node");
        var body = branch.querySelector(".mm-branch-body");
        var icon = branch.querySelector(".mm-icon-" + id);
        if (body) body.classList.toggle("hidden", !open);
        if (icon) icon.style.transform = open ? "rotate(180deg)" : "rotate(0deg)";
    }
    function toggleAll() {
        if (dragMoved) return;
        allOpen = !allOpen;
        NB.$$(".mm-branch").forEach(function (b) { setBranch(b, allOpen); });
        var btn = document.getElementById("mm-toggle-all");
        if (btn) btn.innerHTML = allOpen ? '<i class="fas fa-compress-alt mr-1"></i> Fold All' : '<i class="fas fa-layer-group mr-1"></i> Unfold All';
        setTimeout(drawConnections, 60);
    }

    viewport.addEventListener("pointerdown", function (e) {
        isDragging = true; dragMoved = false;
        pointerStartX = e.clientX; pointerStartY = e.clientY;
        startX = e.clientX - panX; startY = e.clientY - panY;
    });
    window.addEventListener("pointermove", function (e) {
        if (!isDragging) return;
        if (Math.hypot(e.clientX - pointerStartX, e.clientY - pointerStartY) > 10) {  // seuil anti-tremblement
            dragMoved = true; e.preventDefault();
            panX = e.clientX - startX; panY = e.clientY - startY;
            requestAnimationFrame(updateTransform);
        }
    });
    window.addEventListener("pointerup", function () { isDragging = false; });

    function pinch(e) { return Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }
    viewport.addEventListener("touchstart", function (e) {
        if (e.touches.length === 2) { isDragging = false; initialPinchDistance = pinch(e); initialScale = scale; }
    }, { passive: true });
    viewport.addEventListener("touchmove", function (e) {
        if (e.touches.length === 2 && initialPinchDistance) {
            e.preventDefault();
            scale = Math.min(Math.max(0.4, initialScale * pinch(e) / initialPinchDistance), 2.0);
            requestAnimationFrame(updateTransform);
        }
    }, { passive: false });
    viewport.addEventListener("touchend", function () { initialPinchDistance = null; });
    viewport.addEventListener("wheel", function (e) {
        e.preventDefault();
        scale = Math.min(Math.max(0.4, scale * (e.deltaY < 0 ? 1.1 : 0.9)), 2.0);
        requestAnimationFrame(updateTransform);
    }, { passive: false });

    function on(id, fn) { var el = document.getElementById(id); if (el) el.onclick = fn; }
    on("mm-zoom-in", function () { scale = Math.min(2.0, scale * 1.25); updateTransform(); });
    on("mm-zoom-out", function () { scale = Math.max(0.4, scale / 1.25); updateTransform(); });
    on("mm-reset", function () { scale = 0.9; panX = 0; panY = 0; updateTransform(); });
    on("mm-toggle-all", toggleAll);
    centerNode.onclick = toggleAll;

    window.toggleBranch = function (id) {
        if (dragMoved) return;
        var branch = document.querySelector('.mm-branch[data-node="' + id + '"]');
        if (!branch) return;
        var body = branch.querySelector(".mm-branch-body");
        setBranch(branch, body ? body.classList.contains("hidden") : true);
        setTimeout(drawConnections, 60);
    };
    setTimeout(function () { updateTransform(); drawConnections(); }, 100);
}, { perDom: true });
// @endblock nb-mindmap

// @block nb-map
/* Carte interactive .interactive-map-widget : filtres (filterMap), fiche (showMapInfo), plein écran (toggleMapFullscreen, Échap pour fermer).
   Les fiches viennent d'un JSON dans le widget : <script type="application/json" class="nb-map-data">{"id":{"title":"","type":"","desc":""}}</script> */
NB.register("map", function () {
    var widget = document.querySelector(".interactive-map-widget");
    if (!widget || widget.dataset.ready) return;
    widget.dataset.ready = "1";

    var side = widget.querySelector(".map-sidebar");
    var initial = side ? side.innerHTML : "";
    var data = {};
    try { data = JSON.parse(widget.querySelector("script.nb-map-data").textContent); } catch (e) { /* pas de fiches */ }
    var GROUPS = { passages: ".point-passage", flux: ".point-flux", tensions: ".point-tension", hubs: ".point-hub" };
    var ALL = ".point-passage,.point-flux,.point-tension,.point-hub,.point-zone";

    window.showMapInfo = function (id) {
        var d = data[id];
        if (!d || !side) return;
        side.innerHTML = '<div class="map-info-box"><h4><i class="fas fa-location-dot"></i> ' + NB.esc(d.title) + '</h4>' +
            '<div class="tag">' + NB.esc(d.type) + '</div><p>' + NB.esc(d.desc) + '</p>' +
            '<button class="map-btn" style="width:100%" onclick="resetMapSidebar()"><i class="fas fa-xmark"></i> Fermer la fiche</button></div>';
    };
    window.resetMapSidebar = function () { if (side) side.innerHTML = initial; };
    window.filterMap = function (category, btn) {
        NB.$$(".map-controls .map-btn", widget).forEach(function (b) { b.classList.remove("active"); });
        if (btn) btn.classList.add("active");
        NB.$$(ALL, widget).forEach(function (n) { n.style.display = "none"; });
        NB.$$(GROUPS[category] || ALL, widget).forEach(function (n) { n.style.display = ""; });
    };
    function setFullscreen(open) {
        widget.classList.toggle("map-open", open);
        document.body.style.overflow = open ? "hidden" : "";
    }
    window.toggleMapFullscreen = function () { setFullscreen(!widget.classList.contains("map-open")); };
    window.scrollToElement = function (id) {          // compatibilité anciennes pages
        var el = document.getElementById(id);
        if (!el) return;
        if (el === widget) window.toggleMapFullscreen();
        else el.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") setFullscreen(false); });
}, { perDom: true });
// @endblock nb-map

// @block nb-widgets
/* Petits widgets de leçon : courbe du sourire (highlightSmileStep, texte dans data-detail du .smile-step-box)
   et curseur UNCLOS (updateUnclosWidget, zones maritimes selon la distance en milles). */
NB.register("widgets", function () {
    window.highlightSmileStep = function (step) {
        NB.$$(".smile-step-box").forEach(function (b) { b.style.transform = b.style.boxShadow = b.style.borderColor = ""; });
        var box = document.getElementById("smile-" + step);
        if (box) {
            box.style.transform = "translateY(-3px)";
            box.style.boxShadow = "0 9px 24px rgba(0,0,0,.12)";
            box.style.borderColor = "var(--nb-gold)";
        }
        var detail = document.getElementById("smile-detail");
        if (detail) detail.textContent = box ? (box.getAttribute("data-detail") || "") : "";
    };

    var ZONES = [
        { max: 12, icon: "anchor", title: "Mer territoriale", range: "0–12 NM",
          desc: "L’État côtier exerce sa souveraineté sur cette zone, sous réserve des règles de la Convention et du droit de passage inoffensif." },
        { max: 24, icon: "shield-halved", title: "Zone contiguë", range: "12–24 NM",
          desc: "L’État peut y exercer les contrôles prévus par la Convention, notamment dans certains domaines douaniers, fiscaux, sanitaires ou migratoires." },
        { max: 200, icon: "chart-area", title: "ZEE", range: "24–200 NM",
          desc: "L’État côtier dispose de droits souverains sur l’exploration et l’exploitation des ressources, tandis que la navigation et d’autres libertés restent encadrées par la Convention." },
        { max: 350, icon: "layer-group", title: "Plateau continental étendu", range: "200–350 NM",
          desc: "Au-delà de 200 NM, le plateau continental peut être étendu sous les conditions prévues par l’article 76 ; les droits portent sur le fond et le sous-sol." },
        { max: Infinity, icon: "globe", title: "Au-delà", range: "> 350 NM",
          desc: "Au-delà des limites nationales correspondantes, on entre dans les espaces régis par les règles de la haute mer." }
    ];
    window.updateUnclosWidget = function (val) {
        var d = Number(val);
        var z = ZONES.filter(function (x) { return d <= x.max; })[0];
        var title = document.getElementById("unclos-zone-title"), desc = document.getElementById("unclos-zone-desc"),
            rep = document.getElementById("unclos-souverainete-pct");
        if (!z || !title || !desc || !rep) return;
        title.innerHTML = '<i class="fas fa-' + z.icon + '"></i> ' + z.title;
        desc.textContent = z.desc;
        rep.textContent = z.range;
    };
});
// @endblock nb-widgets

// @block nb-boot
/* Démarrage : lance tous les modules (les blocs ajoutés plus tard par l'IA s'exécutent aussitôt). Doit rester le DERNIER bloc d'origine. */
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", NB.boot);
else NB.boot();
// @endblock nb-boot
