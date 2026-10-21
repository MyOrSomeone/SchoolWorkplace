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
    /* Exécute les <script> d'un contenu injecté avec innerHTML (les JSON de données type="application/json" sont laissés tels quels). */
    NB.runScripts = function (root) {
        NB.$$("script", root).forEach(function (old) {
            var t = old.getAttribute("type");
            if (t && t.indexOf("javascript") < 0 && t !== "module") return;
            var n = document.createElement("script");
            Array.prototype.forEach.call(old.attributes, function (a) { n.setAttribute(a.name, a.value); });
            n.text = old.text;
            old.parentNode.replaceChild(n, old);
        });
    };
    NB.slug = function (t) {
        return String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
            .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    };
    window.SCHOOLWORKSPACE_NOTEBOOK_REINIT = function () { NB.reinit(); };
})();
// @endblock nb-core

// @block nb-data
/* Accès aux fichiers de données : tout est lu À L'OUVERTURE (rien n'est codé en dur dans une page).
   Paramètres d'URL : m = matière, c = chapitre (reader.html), w = widget (widget.html).
   NB.data.loadTree() lit subject.json + chaque chapter.json ; NB.glossary reconstruit les définitions depuis le contenu. */
(function () {
    var q = new URLSearchParams(location.search), M = q.get("m") || "";
    var SRC = "data/" + encodeURIComponent(M) + "/_src/";
    var D = NB.data = { M: M, C: q.get("c") || "", W: q.get("w") || "", SRC: SRC, frags: {}, tree: null };
    D.json = function (u) { return fetch(u, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error(u + " (" + r.status + ")"); return r.json(); }); };
    D.text = function (u) { return fetch(u, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error(u + " (" + r.status + ")"); return r.text(); }); };
    D.frag = function (slug, id) {
        var u = SRC + "chapters/" + slug + "/" + id + ".html";
        if (!D.frags[u]) D.frags[u] = fetch(u, { cache: "no-cache" }).then(function (r) { return r.ok ? r.text() : null; }).catch(function () { return null; });
        return D.frags[u];
    };
    D.readerUrl = function (c, hash) { return "reader.html?m=" + encodeURIComponent(M) + (c ? "&c=" + encodeURIComponent(c) : "") + (hash ? "#" + hash : ""); };
    D.loadTree = function () {
        if (D.tree) return D.tree;
        D.tree = D.json(SRC + "subject.json").then(function (subj) {
            return Promise.all((subj.chapters || []).map(function (s) { return D.json(SRC + "chapters/" + s + "/chapter.json").catch(function () { return null; }); })).then(function (list) {
                var chs = list.filter(Boolean), by = {};
                chs.forEach(function (c) { c.parent = c.parent || ""; c.parts = c.parts || []; by[c.slug] = c; });
                chs.forEach(function (c) { var d = 0, p = c.parent; while (p && by[p] && d < 8) { d++; p = by[p].parent; } c.depth = d; });
                return { subj: subj, chapters: chs, by: by };
            });
        });
        return D.tree;
    };
    D.ancestors = function (tree, slug) {
        var out = [], c = tree.by[slug];
        while (c && c.parent && tree.by[c.parent] && out.length < 8) { c = tree.by[c.parent]; out.unshift(c); }
        return out;
    };

    var G = NB.glossary = { ready: false, list: [], map: {}, p: null };
    G.load = function () {
        if (G.p) return G.p;
        G.p = D.loadTree().then(function (t) {
            var jobs = [];
            t.chapters.forEach(function (c) { c.parts.forEach(function (p) { jobs.push(D.frag(c.slug, p.id).then(function (html) { return { c: c, p: p, html: html }; })); }); });
            return Promise.all(jobs);
        }).then(function (rows) {
            var seen = {}, list = [];
            rows.forEach(function (r) {
                if (!r.html) return;
                new DOMParser().parseFromString(r.html, "text/html").querySelectorAll(".def-term").forEach(function (sp) {
                    var def = (sp.getAttribute("data-def") || "").trim();
                    if (!(def.length >= 25 || /\s/.test(def))) return;              // seules les définitions en ligne comptent
                    var label = sp.textContent.trim(), term = sp.getAttribute("data-term") || NB.slug(label);
                    if (seen[term]) return;                                           // la 1re définition rencontrée gagne
                    seen[term] = 1;
                    list.push({ t: term, l: label, d: def, c: r.c.slug, ct: r.c.title, p: r.p.id });
                });
            });
            list.sort(function (a, b) { return NB.slug(a.l) < NB.slug(b.l) ? -1 : 1; });
            G.list = list; G.map = {}; list.forEach(function (g) { G.map[g.t] = g.d; });
            window.NB_DEFINITIONS = G.map; window.NB_GLOSSARY = list; G.ready = true;
            document.dispatchEvent(new CustomEvent("nb:glossary"));
            return G;
        });
        return G.p;
    };
})();
// @endblock nb-data

// @block nb-defs
/* Bulles de définition. Définition écrite DANS le HTML, à côté du mot :
   1re fois : <span class="def-term" data-term="slug" data-def="Définition…">mot</span>
   ensuite  : <span class="def-term" data-term="slug">mot</span>
   Le glossaire de la matière est reconstruit à l'ouverture depuis le contenu (NB.glossary) : rien n'est codé en dur. */
NB.register("defs", function () {
    function resolve(span) {
        var own = (span.getAttribute("data-def") || "").trim();
        if (own.length >= 25 || /\s/.test(own)) return own;           // définition en ligne
        var defs = window.NB_DEFINITIONS || {};
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
    function show(span, text) {
        var t = tip(), r = span.getBoundingClientRect();
        t.querySelector("#nb-def-term").textContent = span.textContent.trim();
        t.querySelector("#nb-def-body").textContent = text;
        t.style.display = "block";
        t.style.left = Math.max(8, Math.min(r.left, window.innerWidth - t.offsetWidth - 8)) + "px";
        var below = r.bottom + 8, above = r.top - t.offsetHeight - 8;
        t.style.top = (below + t.offsetHeight > window.innerHeight && above > 0 ? above : below) + "px";
    }
    function open(span) {
        var d = resolve(span);
        if (d) return show(span, d);
        if (NB.glossary && !NB.glossary.ready) {                       // glossaire pas encore lu : on le charge puis on réessaie
            show(span, "Chargement de la définition…");
            NB.glossary.load().then(function () { show(span, resolve(span) || "Définition non trouvée."); }, function () { show(span, "Définition non trouvée."); });
            return;
        }
        show(span, "Définition non trouvée.");
    }
    function hide() { var t = document.getElementById("nb-def-tooltip"); if (t) t.style.display = "none"; }

    if (!NB._defsBound) {
        NB._defsBound = true;
        document.addEventListener("click", function (e) {
            var span = e.target.closest(".def-term");
            if (span) { e.stopPropagation(); open(span); }
            else if (!e.target.closest("#nb-def-tooltip")) hide();
        });
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape") hide();
            var span = e.target.closest && e.target.closest(".def-term");
            if (span && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(span); }
        });
        window.addEventListener("scroll", hide, { passive: true });
    }
    NB.$$(".def-term").forEach(function (s) { s.setAttribute("tabindex", "0"); s.setAttribute("role", "button"); });
}, { perDom: true });
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

// @block nb-menu
/* Menu à widgets (bouton #nbm-btn) : onglets Plan / Définitions / widgets (iframe chargée à la demande).
   Définitions : liste générée depuis window.NB_GLOSSARY (reconstruit par le build à partir du contenu). */
NB.register("menu", function () {
    var root = document.getElementById("nbm"), btn = document.getElementById("nbm-btn");
    if (!root || !btn || root.dataset.ready) return;
    root.dataset.ready = "1";

    function setTab(id, quiet) {
        NB.$$(".nbm-tab", root).forEach(function (t) { t.classList.toggle("on", t.getAttribute("data-tab") === id); });
        NB.$$(".nbm-pane", root).forEach(function (p) { p.classList.toggle("on", p.getAttribute("data-pane") === id); });
        var pane = root.querySelector('.nbm-pane[data-pane="' + id + '"]'), fr = pane && pane.querySelector("iframe[data-src]");
        if (fr && !fr.src) fr.src = fr.getAttribute("data-src");
        var tab = root.querySelector('.nbm-tab[data-tab="' + id + '"]');
        if (!quiet) root.classList.toggle("expanded", !!(tab && tab.getAttribute("data-wide")));
        try { localStorage.setItem("nbm-tab:" + location.pathname.replace(/[^/]*$/, ""), id); } catch (e) { /* ignore */ }
    }
    function open(id) { root.hidden = false; document.body.style.overflow = "hidden"; if (id) setTab(id); }
    function close() { root.hidden = true; document.body.style.overflow = ""; }
    btn.addEventListener("click", function () { open(); });
    root.querySelector(".nbm-backdrop").addEventListener("click", close);
    document.getElementById("nbm-close").addEventListener("click", close);
    document.getElementById("nbm-exp").addEventListener("click", function () { root.classList.toggle("expanded"); });
    root.querySelector(".nbm-tabs").addEventListener("click", function (e) { var t = e.target.closest(".nbm-tab"); if (t) setTab(t.getAttribute("data-tab")); });
    root.addEventListener("click", function (e) {
        var a = e.target.closest("a[href]");
        if (!a || a.closest(".nbm-def")) return;
        var u = new URL(a.href, location.href);
        if (u.pathname + u.search === location.pathname + location.search) close();   // ancre de la page courante : on ferme et on défile
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !root.hidden) close(); });
    window.addEventListener("message", function (e) {              // un widget (ex. la carte) demande à s'agrandir
        if (e.data && e.data.nbm === "toggle-expand") root.classList.toggle("expanded");
    });
    window.NBM = { open: open, close: close };

    // Définitions : liste alphabétique avec recherche, lue dynamiquement depuis le contenu (NB.glossary)
    var list = document.getElementById("nbm-dlist"), q = document.getElementById("nbm-dq"), cnt = document.getElementById("nbm-dcount");
    function render() {
        var G = (NB.glossary && NB.glossary.list) || [], ready = NB.glossary && NB.glossary.ready;
        if (cnt) cnt.textContent = ready ? G.length : "…";
        var f = NB.slug(q.value), html = "", letter = "";
        G.filter(function (g) { return !f || NB.slug(g.l).indexOf(f) >= 0 || NB.slug(g.d).indexOf(f) >= 0; }).forEach(function (g) {
            var L = (NB.slug(g.l).charAt(0) || "#").toUpperCase();
            if (L !== letter) { letter = L; html += '<div class="nbm-letter">' + L + "</div>"; }
            html += '<details class="nbm-def"><summary>' + NB.esc(g.l) + '<i class="fa-solid fa-chevron-down" style="opacity:.5"></i></summary><div>' + NB.esc(g.d) +
                (g.c ? '<br><a href="' + NB.esc(NB.data.readerUrl(g.c, g.p)) + '">Voir dans le cours · ' + NB.esc(g.ct) + "</a>" : "") + "</div></details>";
        });
        list.innerHTML = html || "<p>" + (!ready ? "Chargement des définitions…" : G.length ? "Aucune notion ne correspond." : "Aucune notion définie pour le moment.") + "</p>";
    }
    q.addEventListener("input", render);
    document.addEventListener("nb:glossary", render);
    render();
    if (NB.glossary) NB.glossary.load().catch(function () { /* hors ligne : liste vide */ });
    var saved = null; try { saved = localStorage.getItem("nbm-tab:" + location.pathname.replace(/[^/]*$/, "")); } catch (e) { /* ignore */ }
    if (saved && root.querySelector('.nbm-tab[data-tab="' + saved + '"]') && saved.indexOf("w-") !== 0) setTab(saved, true);
}, { perDom: true });
// @endblock nb-menu

// @block nb-theme
/* Thème clair/sombre : une page affichée dans une iframe (chapitre, widget) copie la classe "dark" de la page qui la contient. */
NB.register("theme", function () {
    try {
        var p = window.parent;
        if (!p || p === window) return;
        var src = p.document.documentElement, me = document.documentElement;
        var sync = function () { me.classList.toggle("dark", src.classList.contains("dark")); };
        sync();
        new MutationObserver(sync).observe(src, { attributes: true, attributeFilter: ["class"] });
    } catch (e) { /* page parente d'une autre origine : rien à synchroniser */ }
});
// @endblock nb-theme


// @block nb-reader
/* Lecteur de cours (reader.html?m=Matière&c=chapitre). Tout est lu à l'ouverture : subject.json (ordre), chaque chapter.json
   (titre, parent, parties) et chaque fragment HTML. Ajouter une partie = déposer son fichier + la déclarer dans chapter.json. */
NB.register("reader", function () {
    var app = document.getElementById("nb-app");
    if (!app || app.dataset.started) return;
    app.dataset.started = "1";
    var D = NB.data, M = D.M, C = D.C, esc = NB.esc;
    function state(msg) { app.innerHTML = '<p class="nbr-state">' + msg + "</p>"; }
    if (!M) return state("Aucune matière indiquée (reader.html?m=Matière&amp;c=chapitre).");

    function plan(tree) {
        var kids = {}, trail = {};
        tree.chapters.forEach(function (c) { (kids[c.parent] = kids[c.parent] || []).push(c); });
        if (C && tree.by[C]) { trail[C] = 1; D.ancestors(tree, C).forEach(function (a) { trail[a.slug] = 1; }); }
        function node(c) {
            var cur = c.slug === C, h = '<details class="nbm-node"' + (trail[c.slug] ? " open" : "") + '><summary><a href="' + esc(D.readerUrl(c.slug)) + '" class="' + (cur ? "active" : "") + '">' + esc(c.title) + "</a></summary>";
            if (c.parts.length) h += '<ul class="nbm-parts">' + c.parts.map(function (p) {
                return '<li class="l' + (+p.level > 1 ? 2 : 1) + '"><a href="' + esc(D.readerUrl(c.slug, p.id)) + '"' + (cur ? " data-here" : "") + ">" + esc(p.title) + "</a></li>";
            }).join("") + "</ul>";
            (kids[c.slug] || []).forEach(function (k) { h += node(k); });
            return h + "</details>";
        }
        return '<nav class="nbm-plan"><a class="nbm-home" href="' + esc(D.readerUrl("")) + '"><i class="fa-solid fa-house"></i> Sommaire de la matière</a>' +
            ((kids[""] || []).map(node).join("") || "<p>Aucun chapitre.</p>") + "</nav>";
    }
    function menu(tree, widgets) {
        var tabs = ['<button class="nbm-tab on" data-tab="plan"><i class="fa-solid fa-list-ul"></i> Plan</button>',
                    '<button class="nbm-tab" data-tab="defs"><i class="fa-solid fa-spell-check"></i> Définitions <small id="nbm-dcount">…</small></button>'];
        var panes = ['<section class="nbm-pane on" data-pane="plan">' + plan(tree) + "</section>",
                     '<section class="nbm-pane" data-pane="defs"><div class="nbm-defs"><input type="search" id="nbm-dq" placeholder="Rechercher une notion…" aria-label="Rechercher une notion"><div id="nbm-dlist"></div></div></section>'];
        widgets.forEach(function (w) {
            var id = esc(w.id);
            tabs.push('<button class="nbm-tab" data-tab="w-' + id + '"' + (w.wide ? ' data-wide="1"' : "") + ' title="' + esc(w.description) + '"><i class="fa-solid ' + esc(w.icon || "fa-puzzle-piece") + '"></i> ' + esc(w.title) + "</button>");
            panes.push('<section class="nbm-pane" data-pane="w-' + id + '"><iframe data-src="widget.html?m=' + encodeURIComponent(M) + "&w=" + encodeURIComponent(w.id) + '" title="' + esc(w.title) + '" allow="fullscreen" allowfullscreen></iframe></section>');
        });
        return '<div id="nbm" class="nbm" hidden><div class="nbm-backdrop"></div><aside class="nbm-panel" role="dialog" aria-label="Menu du cours"><header class="nbm-head"><nav class="nbm-tabs">' + tabs.join("") +
            '</nav><button class="nbm-x" id="nbm-exp" aria-label="Agrandir"><i class="fa-solid fa-expand"></i></button><button class="nbm-x" id="nbm-close" aria-label="Fermer"><i class="fa-solid fa-xmark"></i></button></header><div class="nbm-body">' + panes.join("") + "</div></aside></div>";
    }
    function bar(tree, chap) {
        var crumbs = ['<a href="' + esc(D.readerUrl("")) + '">' + esc(M) + "</a>"];
        if (chap) D.ancestors(tree, chap.slug).forEach(function (a) { crumbs.push('<a href="' + esc(D.readerUrl(a.slug)) + '">' + esc(a.title) + "</a>"); });
        var i = chap ? tree.chapters.indexOf(chap) : -1, prev = i > 0 ? tree.chapters[i - 1] : null, next = i >= 0 && i < tree.chapters.length - 1 ? tree.chapters[i + 1] : null;
        return '<div class="nbn-bar"><a href="' + esc(D.readerUrl("")) + '" title="Sommaire"><i class="fa-solid fa-house"></i></a>' +
            '<button id="nbm-btn" class="nbn-menu" aria-label="Menu du cours"><i class="fa-solid fa-compass"></i><span>Menu</span></button>' +
            '<div class="nbn-ttl"><small>' + crumbs.join(" › ") + "</small><b>" + esc(chap ? chap.title : M) + "</b></div>" +
            (prev ? '<a href="' + esc(D.readerUrl(prev.slug)) + '" title="Précédent"><i class="fa-solid fa-chevron-left"></i></a>' : "") +
            (next ? '<a href="' + esc(D.readerUrl(next.slug)) + '" title="Suivant"><i class="fa-solid fa-chevron-right"></i></a>' : "") + "</div>";
    }
    function cards(list, tree, depth) {
        var kids = {};
        tree.chapters.forEach(function (c) { (kids[c.parent] = kids[c.parent] || []).push(c); });
        function node(c, d) {
            var n = (kids[c.slug] || []).length;
            var h = '<a class="nbn-card nbn-d' + Math.min(d, 3) + '" href="' + esc(D.readerUrl(c.slug)) + '"><b>' + esc(c.title) + "</b><p>" + (esc(c.summary) || "&nbsp;") + "</p><small>" + c.parts.length + " partie(s)" + (n ? " · " + n + " sous-chapitre(s)" : "") + "</small></a>";
            (kids[c.slug] || []).forEach(function (k) { h += node(k, d + 1); });
            return h;
        }
        var last = null, html = "";
        list.forEach(function (c) { if (c.group && c.group !== last) { html += '<h2 class="nbn-group">' + esc(c.group) + "</h2>"; last = c.group; } html += node(c, depth); });
        return html;
    }

    function finish(chap) {
        document.title = (chap ? chap.title + " — " : "") + M;
        NB.runScripts(app);
        NB.reinit();                                                 // menu, cartes mentales, définitions… liés au contenu qui vient d'arriver
        var key = "nb-scroll:" + M + "/" + C;
        if (location.hash) { var el = document.getElementById(decodeURIComponent(location.hash.slice(1))); if (el) el.scrollIntoView(); }
        else { try { var y = localStorage.getItem(key); if (y) window.scrollTo(0, +y); } catch (e) { /* ignore */ } }
        var t; window.addEventListener("scroll", function () { clearTimeout(t); t = setTimeout(function () { try { localStorage.setItem(key, String(window.scrollY)); } catch (e) { /* ignore */ } }, 300); });
        var links = NB.$$(".nbm-parts a[data-here]");
        if ("IntersectionObserver" in window && links.length) {
            var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) links.forEach(function (a) { a.classList.toggle("active", a.getAttribute("href").split("#")[1] === e.target.id); }); }); }, { rootMargin: "-20% 0px -70% 0px" });
            NB.$$(".nb-part").forEach(function (s) { io.observe(s); });
        }
        var tries = 0; (function typeset() { if (window.MathJax && window.MathJax.typesetPromise) window.MathJax.typesetPromise(); else if (tries++ < 25) setTimeout(typeset, 300); })();
        (window.requestIdleCallback || function (f) { setTimeout(f, 400); })(function () { NB.glossary.load().catch(function () { /* hors ligne */ }); });
    }

    D.loadTree().then(function (tree) {
        return Promise.all((tree.subj.widgets || []).map(function (id) { return D.json(D.SRC + "widgets/" + id + "/widget.json").catch(function () { return null; }); })).then(function (ws) {
            ws = ws.filter(Boolean);
            var chap = C ? tree.by[C] : null;
            if (C && !chap) return state("Chapitre introuvable : <b>" + esc(C) + '</b>. <a href="' + esc(D.readerUrl("")) + '">Retour au sommaire</a>');
            if (!chap) {                                              // sommaire de la matière
                app.innerHTML = bar(tree, null) + "</div>" + menu(tree, ws) + '<main class="notebook-content"><div class="nbn-tree">' + (cards(tree.chapters.filter(function (c) { return !c.parent; }), tree, 0) || "<p>Aucun chapitre.</p>") +
                    '</div><details class="nb-details nbn-gloss"><summary><b>Glossaire <span id="nbr-gcount"></span></b></summary><dl id="nbr-gloss"><p>Chargement…</p></dl></details></main>';
                document.addEventListener("nb:glossary", function () {
                    document.getElementById("nbr-gcount").textContent = "(" + NB.glossary.list.length + ")";
                    document.getElementById("nbr-gloss").innerHTML = NB.glossary.list.map(function (g) { return "<dt><b>" + esc(g.l) + "</b></dt><dd>" + esc(g.d) + "</dd>"; }).join("") || "<p>Aucune notion définie.</p>";
                });
                return finish(null);
            }
            return Promise.all(chap.parts.map(function (p) { return D.frag(C, p.id); })).then(function (htmls) {
                var sections = chap.parts.map(function (p, i) {
                    return '<section class="nb-part" id="' + esc(p.id) + '" data-level="' + (+p.level || 1) + '">\n' +
                        (htmls[i] == null ? '<p class="nbn-empty">Fichier de la partie « ' + esc(p.title) + " » introuvable (<code>" + esc(p.id) + ".html</code>).</p>" : htmls[i]) + "\n</section>";
                }).join("\n");
                var kids = tree.chapters.filter(function (c) { return c.parent === C; });
                if (kids.length) sections += '\n<section class="nb-part nbn-kids"><h2 class="nbn-kids-title"><i class="fa-solid fa-sitemap"></i> Dans ce chapitre</h2><div class="nbn-cards">' + cards(kids, tree, 1).replace(/ nbn-d\d/g, "") + "</div></section>";
                else if (!chap.parts.length) sections = '<p class="nbn-empty">Chapitre vide pour le moment.</p>';
                var i = tree.chapters.indexOf(chap), prev = i > 0 ? tree.chapters[i - 1] : null, next = i < tree.chapters.length - 1 ? tree.chapters[i + 1] : null;
                var pager = '<nav class="nbn-pager">' + (prev ? '<a href="' + esc(D.readerUrl(prev.slug)) + '"><i class="fa-solid fa-arrow-left"></i> ' + esc(prev.title) + "</a>" : "<span></span>") +
                    (next ? '<a style="text-align:right" href="' + esc(D.readerUrl(next.slug)) + '">' + esc(next.title) + ' <i class="fa-solid fa-arrow-right"></i></a>' : "") + "</nav>";
                app.innerHTML = bar(tree, chap) + "</div>" + menu(tree, ws) + '<main id="notebook-content" class="notebook-content">\n<h1 class="nb-chapter-title">' + esc(chap.title) + "</h1>\n" + sections + "\n</main>" + pager;
                finish(chap);
            });
        });
    }).catch(function (e) { state("Impossible de lire la matière « " + esc(M) + " » : " + esc(e.message)); });
});
// @endblock nb-reader

// @block nb-widgetpage
/* Page d'un widget (widget.html?m=Matière&w=id) : lit widget.json puis body.html (widget libre) ou map.json (carte). */
NB.register("widgetpage", function () {
    var app = document.getElementById("nbw-app");
    if (!app || app.dataset.started) return;
    app.dataset.started = "1";
    var D = NB.data, base = D.SRC + "widgets/" + encodeURIComponent(D.W) + "/";
    function fail(e) { app.innerHTML = '<p class="nbr-state">Widget indisponible : ' + NB.esc(e.message || e) + "</p>"; }
    function loadScript(src) {
        return new Promise(function (ok, ko) { var s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = function () { ko(new Error(src)); }; document.head.appendChild(s); });
    }
    if (!D.M || !D.W) return fail("paramètres m et w manquants");
    D.json(base + "widget.json").then(function (meta) {
        document.title = meta.title || D.W;
        if (meta.kind !== "map") {
            return D.text(base + "body.html").then(function (html) { app.innerHTML = '<main class="nbw-main">' + html + "</main>"; NB.runScripts(app); NB.reinit(); });
        }
        return D.json(base + "map.json").then(function (data) {
            (data.items || []).forEach(function (it) { var r = it.ref; if (r && typeof r === "object" && r.chapter) it.href = D.readerUrl(r.chapter, r.part || ""); });
            window.NB_MAP_DATA = data;
            app.innerHTML = '<div id="mp"></div>';
            var css = document.createElement("link"); css.rel = "stylesheet"; css.href = "widgets/map.css"; document.head.appendChild(css);
            return loadScript("https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js").catch(function () { /* map.js affiche un message */ }).then(function () { return loadScript("widgets/map.js"); });
        });
    }).catch(fail);
});
// @endblock nb-widgetpage


// @block nb-themeguard
/* Garde-fou de lisibilité clair/sombre : vérifie le contraste RÉEL (texte vs fond effectif) de chaque bloc de texte du cours
   et corrige automatiquement ce qui est illisible (texte blanc sur fond clair, bloc blanc en thème sombre, classes Tailwind
   inventées, etc.). Rejoué à chaque changement de thème. Ne touche jamais au contenu, seulement à color / background-color. */
NB.register("themeguard", function () {
    var root = document.querySelector(".notebook-content, .nbw-main");
    if (!root || NB._tg) return;
    var tg = NB._tg = { undo: [], timer: null };

    function parse(s) {
        var m = /rgba?\(([^)]+)\)/.exec(s);
        if (m) { var p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]]; }
        m = /color\(srgb ([^)]+)\)/.exec(s);
        if (m) { var q = m[1].split(/[ \/]+/).filter(Boolean).map(Number); return [q[0] * 255, q[1] * 255, q[2] * 255, q[3] === undefined ? 1 : q[3]]; }
        return [0, 0, 0, 0];
    }
    function blend(t, b) { var a = t[3]; return [t[0] * a + b[0] * (1 - a), t[1] * a + b[1] * (1 - a), t[2] * a + b[2] * (1 - a), 1]; }
    function lum(c) { var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
    function ratio(a, b) { var l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
    function mix(a, b, t) { return [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t, a[3]]; }
    function css(c) { return "rgba(" + Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]) + "," + (c[3] === undefined ? 1 : c[3]) + ")"; }
    function set(el, prop, val) {
        tg.undo.push([el, prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
        el.style.setProperty(prop, val, "important");
    }
    function reset() { (tg.marked || []).forEach(function (m) { delete m.dataset.nbGuarded; }); tg.marked = []; while (tg.undo.length) { var u = tg.undo.pop(); if (u[2]) el_restore(u); else u[0].style.removeProperty(u[1]); } }
    function el_restore(u) { u[0].style.setProperty(u[1], u[2], u[3]); }

    var LIGHT_INK = [248, 243, 234, 1], DARK_INK = [28, 24, 20, 1], DARK_CARD = [28, 26, 23, 1];
    function pass() {
        reset();
        var dark = document.documentElement.classList.contains("dark"), cacheBg = new Map();
        function bgOf(el) {
            if (cacheBg.has(el)) return cacheBg.get(el);
            var base = el.parentElement && el !== document.body ? bgOf(el.parentElement) : [255, 255, 255, 1];
            var c = parse(getComputedStyle(el).backgroundColor);
            var out = c[3] > 0 ? blend(c, base) : base;
            cacheBg.set(el, out); return out;
        }
        var seen = new Set(), walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            var n = walker.currentNode, el = n.parentElement;
            if (!el || seen.has(el) || n.textContent.trim().length < 2 || el.closest("svg, script, style, .mp, canvas")) continue;
            seen.add(el);
            var cs = getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden") continue;
            var bg = bgOf(el), fg = blend(parse(cs.color), bg);
            if (ratio(fg, bg) >= 3.2) continue;
            // 1) bloc clair en thème sombre : on assombrit TOUS les fonds clairs au-dessus du texte (en gardant leur teinte et leur transparence)
            if (dark && lum(bg) > 0.45) {
                for (var a = el; a && a !== root.parentElement; a = a.parentElement) {
                    var own = parse(getComputedStyle(a).backgroundColor);
                    if (own[3] > 0.15 && lum(own) > 0.45 && !a.dataset.nbGuarded) { set(a, "background-color", css(mix(own, DARK_CARD, 0.88))); a.dataset.nbGuarded = "1"; tg.marked = tg.marked || []; tg.marked.push(a); }
                }
                cacheBg.clear(); bg = bgOf(el); fg = blend(parse(getComputedStyle(el).color), bg);
                if (ratio(fg, bg) >= 3.2) continue;
            }
            // 2) sinon on corrige le texte : on pousse sa couleur (en gardant la teinte) vers le noir ou le blanc jusqu'à un contraste >= 4.5
            var target = ratio(DARK_INK, bg) >= ratio(LIGHT_INK, bg) ? DARK_INK : LIGHT_INK, c0 = parse(cs.color), best = null;
            for (var t = 0.2; t <= 1.001; t += 0.1) { var cand = mix(c0, target, t); cand[3] = 1; if (ratio(cand, bg) >= 4.5) { best = cand; break; } }
            set(el, "color", css(best || target));
        }
    }
    function schedule(ms) { clearTimeout(tg.timer); tg.timer = setTimeout(pass, ms || 120); }
    tg.run = schedule;
    // Tailwind (CDN) génère ses styles après coup : on repasse un peu plus tard
    schedule(500); setTimeout(function () { schedule(0); }, 1800);
    new MutationObserver(function () { schedule(150); }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("load", function () { schedule(300); });
}, { perDom: true });
// @endblock nb-themeguard

// @block nb-boot
/* Démarrage : lance tous les modules (les blocs ajoutés plus tard par l'IA s'exécutent aussitôt). Doit rester le DERNIER bloc d'origine. */
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", NB.boot);
else NB.boot();
// @endblock nb-boot

// @block nb-themeprobe
/* Diagnostic : vérifie que les variantes Tailwind dark: suivent la classe .dark (et non prefers-color-scheme). Message dans la console sinon. */
NB.register("themeprobe", function () {
    if (NB._probed) return;
    NB._probed = true;
    setTimeout(function () {
        var el = document.createElement("div");
        el.className = "hidden dark:block";
        el.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
        document.body.appendChild(el);
        setTimeout(function () {                         // laisse à Tailwind (CDN) le temps de générer la règle
            var root = document.documentElement, had = root.classList.contains("dark");
            root.classList.add("dark"); var on = getComputedStyle(el).display;
            root.classList.remove("dark"); var off = getComputedStyle(el).display;
            if (had) root.classList.add("dark");
            el.remove();
            if (on === off && (on === "none" || on === "block")) {
                console.warn("[notebooks] Tailwind semble en mode « media » : les classes dark: suivent le thème du SYSTÈME, pas le bouton. " +
                             "Vérifie que tailwind.config = { darkMode: 'class' } est posé APRÈS <script src=\"https://cdn.tailwindcss.com\">.");
            }
        }, 700);
    }, 300);
});
// @endblock nb-themeprobe
