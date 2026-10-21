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

// @block nb-shader
/* Shaders GLSL dans les cours. UN SEUL contexte WebGL partagé par toute la page (les navigateurs en limitent le nombre) ; chaque
   élément .nb-shader / .nb-shader-bg reçoit un <canvas> 2D où le rendu est copié, seulement tant qu'il est visible à l'écran.
   Lecture seule pour l'IA : on écrit du HTML (voir DOC STYLE), jamais de JS pour un shader. Si le GLSL est invalide, le dégradé CSS reste. */
// presets: aurora nebula waves topo ripples blobs cells sunrise
(function () {
    "use strict";
    var S = NB._sh = NB._sh || { items: [], gl: undefined, progs: {}, q: 1, dark: 0, bg: [1, 1, 1], raf: 0, n: 0, ema: 17, slow: 0 };
    var RM = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

    var PALETTES = {
        gold: ["#b8905a", "#d97706", "#f4d58d"], blue: ["#3b82f6", "#8b5cf6", "#38bdf8"], emerald: ["#10b981", "#3b82f6", "#a7f3d0"],
        violet: ["#8b5cf6", "#3b82f6", "#f0abfc"], amber: ["#d97706", "#f59e0b", "#fde68a"], rose: ["#e11d48", "#d97706", "#fda4af"],
        sky: ["#0ea5e9", "#6366f1", "#bae6fd"], red: ["#ef4444", "#d97706", "#fecaca"], teal: ["#14b8a6", "#3b82f6", "#99f6e4"],
        stone: ["#78716c", "#b8905a", "#d6d3d1"]
    };

    /* En-tête commun (GLSL ES 1.00 / WebGL1). Uniforms : u_resolution (px), u_time (s), u_mouse (0..1, origine en bas à gauche),
       u_hover (0..1), u_press (0..1), u_dark (0 clair, 1 sombre), u_c1/u_c2/u_c3 (palette), u_bg (fond de carte du thème). */
    var HEAD = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_resolution; uniform float u_time; uniform vec2 u_mouse; uniform float u_hover; uniform float u_press; uniform float u_dark;
uniform vec3 u_c1; uniform vec3 u_c2; uniform vec3 u_c3; uniform vec3 u_bg;
float nb_hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float nb_noise(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); f=f*f*(3.0-2.0*f);
  float a=nb_hash(i); float b=nb_hash(i+vec2(1.0,0.0)); float c=nb_hash(i+vec2(0.0,1.0)); float d=nb_hash(i+vec2(1.0,1.0));
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
float nb_fbm(vec2 p){ float v=0.0; float a=0.5; for(int i=0;i<5;i++){ v+=a*nb_noise(p); p=p*2.03+vec2(17.1,9.7); a*=0.5; } return v; }
mat2 nb_rot(float a){ float c=cos(a); float s=sin(a); return mat2(c,-s,s,c); }
`;
    var TOY = `#define iResolution vec3(u_resolution,1.0)
#define iTime u_time
#define iMouse vec4(u_mouse*u_resolution,u_press,0.0)
`;
    var MAIN = `void main(){
  vec2 p=(gl_FragCoord.xy-0.5*u_resolution)/u_resolution.y;
  vec2 m=(u_mouse-0.5)*vec2(u_resolution.x/u_resolution.y,1.0);
  gl_FragColor=vec4(clamp(nb_scene(p,m),0.0,1.0),1.0);
}`;

    var PRESETS = {
        aurora: `vec3 nb_scene(vec2 p, vec2 m){
  float t=u_time*0.12; vec2 q=p+m*0.15;
  float n=nb_fbm(vec2(q.x*1.6+t,q.y*0.8-t*0.5));
  float band=0.0;
  for(int i=0;i<3;i++){ float fi=float(i);
    float y=q.y*1.2+(0.18*fi-0.15)+(nb_fbm(vec2(q.x*1.3+fi*3.1,t+fi))-0.5)*0.9;
    band+=smoothstep(0.22,0.0,abs(y))*(0.55-0.15*fi); }
  vec3 col=mix(u_c1,u_c2,smoothstep(-0.4,0.4,q.x+n-0.5));
  col=mix(col,u_c3,smoothstep(0.3,0.9,n)*0.6);
  float k=clamp(band*(0.55+0.45*n),0.0,1.0);
  return mix(u_bg,col,k*mix(0.8,1.0,u_dark))+u_c3*pow(k,3.0)*0.15;
}`,
        nebula: `vec3 nb_scene(vec2 p, vec2 m){
  float t=u_time*0.08; vec2 q=p*1.6+m*0.3;
  vec2 w=vec2(nb_fbm(q+vec2(0.0,t)),nb_fbm(q+vec2(5.2,1.3)-t));
  float f=nb_fbm(q+2.2*w+t);
  vec3 col=mix(u_c1,u_c2,clamp(f*1.4,0.0,1.0));
  col=mix(col,u_c3,clamp(length(w)-0.4,0.0,1.0));
  float a=smoothstep(0.25,0.85,f);
  vec2 sp=p*55.0; vec2 g=floor(sp); vec2 off=(vec2(nb_hash(g+9.0),nb_hash(g+5.0))-0.5)*0.5;
  float s=step(0.97,nb_hash(g))*smoothstep(0.2,0.0,length(fract(sp)-0.5-off))*(0.5+0.5*sin(u_time*1.5+nb_hash(g+3.0)*6.28));
  return mix(u_bg,col,a*mix(0.75,1.0,u_dark))+s*0.5*u_c3*u_dark;
}`,
        waves: `vec3 nb_scene(vec2 p, vec2 m){
  float t=u_time*0.5; vec3 col=u_bg;
  float bump=exp(-pow((p.x-m.x)*4.0,2.0))*(0.3+u_press)*u_hover;
  for(int i=0;i<4;i++){ float fi=float(i);
    float line=0.22-fi*0.17+sin(p.x*(3.0+fi*1.3)+t*(1.0+fi*0.3)+fi*1.7)*0.045+sin(p.x*(7.0+fi)-t*1.4)*0.015
      +sin(p.x*18.0-u_time*5.0)*0.02*bump;
    float fill=smoothstep(line+0.012,line-0.012,p.y);
    vec3 lc=mix(u_c1,u_c2,fi/3.0);
    col=mix(col,lc,fill*(0.28+0.12*fi));
    col+=u_c3*smoothstep(0.02,0.0,abs(p.y-line))*0.22; }
  return col;
}`,
        topo: `vec3 nb_scene(vec2 p, vec2 m){
  float t=u_time*0.15; vec2 q=p*1.5+vec2(t,-t)+m*0.15;
  float h=nb_noise(q)*0.62+nb_noise(q*2.1+7.3)*0.28+nb_noise(q*4.3+2.1)*0.10;
  float f=fract(h*7.0); float line=smoothstep(5.06,5.0,min(f,1.0-f)); vec3 c=mix(u_c1,u_c2,clamp((h-0.2)*1.8,0.0,1.0));
  return mix(u_bg,c,clamp(line*0.9+smoothstep(0.4,0.75,h)*0.16,0.0,0.7))+u_c3*line*0.06;
}`,
        ripples: `// --- Fonctions utilitaires pour un mouvement fluide & organique ---
vec2 hash22(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

// Bruit de Perlin 2D adouci
float smooth_noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);

    return mix(mix(dot(hash22(i + vec2(0.0,0.0)), f - vec2(0.0,0.0)),
                   dot(hash22(i + vec2(1.0,0.0)), f - vec2(1.0,0.0)), u.x),
               mix(dot(hash22(i + vec2(0.0,1.0)), f - vec2(0.0,1.0)),
                   dot(hash22(i + vec2(1.0,1.0)), f - vec2(1.0,1.0)), u.x), u.y);
}

vec3 nb_scene(vec2 p, vec2 m) {
    // 1. Distortion de l'espace par le curseur (effet de gravité/attraction)
    vec2 dir_m = p - m;
    float dist_m = length(dir_m);
    
    // Déplacement fluide vers/loin du curseur
    vec2 distorted_p = p - normalize(dir_m + 1e-5) * exp(-dist_m * 3.0) * (0.15 + u_press * 0.1) * u_hover;

    // 2. Génération de fluide organique (FBM léger à 2 octaves)
    float t = u_time * 0.25;
    
    // Première couche de fluide
    float n1 = smooth_noise(distorted_p * 2.5 + vec2(t * 0.5, -t * 0.3));
    
    // Seconde couche croisée pour donner du relief
    float n2 = smooth_noise(distorted_p * 4.0 - vec2(t * 0.7, t * 0.4) + vec2(n1));
    
    // Valeur de fluide accumulée (entre 0 et 1)
    float fluid = smoothstep(-0.2, 0.7, n1 + n2 * 0.5);

    // 3. Aura lumineuse sous le curseur
    float cursor_glow = exp(-dist_m * 2.5) * u_hover;
    
    // 4. Mélange des Couleurs (Palette dynamique)
    // Mélange progressif entre C1 et C2 selon la densité du fluide
    vec3 color_fluid = mix(u_c1, u_c2, fluid);
    
    // Ajout de la couleur d'accent u_c3 aux zones les plus denses
    color_fluid = mix(color_fluid, u_c3, smoothstep(0.5, 0.9, fluid));

    // 5. Contraste & Lisibilité du Texte
    // On garde u_bg dominant, le fluide apporte de la couleur sans dévorer l'écran
    vec3 final_color = mix(u_bg, color_fluid, fluid * 0.55);

    // Injection de lumière d'interaction sous le curseur
    final_color += u_c3 * cursor_glow * (0.4 + u_press * 0.3);

    // Vignettage doux pour recentrer l'attention sur le texte au milieu
    float vignette = 1.0 - smoothstep(0.3, 1.2, length(p));
    final_color = mix(final_color * 0.85, final_color, vignette);

    return final_color;
}`,
        blobs: `vec3 nb_scene(vec2 p, vec2 m){
  float t=u_time*0.25; vec3 col=u_bg;
  vec2 a=vec2(sin(t*1.1)*0.5,cos(t*0.8)*0.2);
  vec2 b=vec2(cos(t*0.7+2.0)*0.5,sin(t*0.9+1.0)*0.25);
  vec2 c=m*0.8+vec2(sin(t)*0.1,cos(t)*0.1);
  float fa=exp(-dot(p-a,p-a)*5.0); float fb=exp(-dot(p-b,p-b)*5.0); float fc=exp(-dot(p-c,p-c)*7.0)*(0.5+0.5*u_hover);
  col=mix(col,u_c1,fa*0.8); col=mix(col,u_c2,fb*0.8); col=mix(col,u_c3,fc*0.8);
  return col;
}`,
        cells: `vec3 nb_scene(vec2 p, vec2 m){
  vec2 q=p*5.0+vec2(u_time*0.05,u_time*0.05); vec2 i=floor(q); vec2 f=fract(q); float d1=9.0; float d2=9.0; float id=0.0;
  for(int y=-1;y<=1;y++){ for(int x=-1;x<=1;x++){ vec2 g=vec2(float(x),float(y)); vec2 o=vec2(nb_hash(i+g),nb_hash(i+g+7.7)); o=0.5+0.5*sin(u_time*0.4+6.2831*o); vec2 r=g+o-f; float d=dot(r,r); if(d<d1){ d2=d1; d1=d; id=nb_hash(i+g+30.3); } else if(d<d2){ d2=d; } } }
  float edge=smoothstep(10.0,0.17,sqrt(d2)-sqrt(d1)); vec3 c=mix(u_c1,u_c2,id); c=mix(c,u_c3,fract(id*7.0)*0.5); vec3 col=mix(u_bg,c,0.28*(0.6+0.4*id)); return mix(col,u_c1,(1.0-edge)*0.6);
}`,
        sunrise: `vec3 nb_scene(vec2 p, vec2 m){
  vec2 c=vec2(m.x*0.3,-0.45+m.y*0.1); vec2 d=p-c; float r=length(d); float a=atan(d.y,d.x); float rays=0.5+0.25*sin(a*14.0+u_time*0.25)+0.25*sin(a*9.0-u_time*0.18);
  float glow=exp(-r*1.0); float halo=smoothstep(1.55,0.0,abs(r-0.60-0.1*sin(u_time)))*0.35; float k=clamp(glow*(0.75+0.45*rays)+halo,0.0,1.0);
  vec3 col=mix(u_c2,u_c1,smoothstep(0.1,0.8,r)); col=mix(col,u_c3,glow*0.6); return mix(u_bg,col,k*mix(0.85,1.0,u_dark));
}`
    };
    var ALIAS = { mesh: "blobs", gradient: "blobs", stars: "nebula", ocean: "waves", relief: "topo", voronoi: "cells", sun: "sunrise", ink: "nebula", cellules: "cells", vagues: "waves" };

    /* ------------------------------------------------------------ couleurs */
    function parseColor(s, host) {
        s = String(s || "").trim();
        if (!s) return null;
        var v = /^var\((--[\w-]+)\)$/.exec(s);
        if (v) s = getComputedStyle(host || document.documentElement).getPropertyValue(v[1]).trim();
        var h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
        if (h) {
            var x = h[1];
            if (x.length === 3) x = x.replace(/./g, "$&$&");
            return [parseInt(x.slice(0, 2), 16) / 255, parseInt(x.slice(2, 4), 16) / 255, parseInt(x.slice(4, 6), 16) / 255];
        }
        var r = /rgba?\(([^)]+)\)/.exec(s);
        if (r) { var p = r[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return [p[0] / 255, p[1] / 255, p[2] / 255]; }
        try {                                                        // nom CSS (« gold »…) : le canvas 2D le convertit en #rrggbb
            var cx = document.createElement("canvas").getContext("2d");
            cx.fillStyle = "#010203"; cx.fillStyle = s;
            if (cx.fillStyle !== "#010203") return parseColor(cx.fillStyle);
        } catch (e) { /* ignore */ }
        return null;
    }
    function mixc(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
    function rgbCss(c) { return "rgb(" + Math.round(c[0] * 255) + "," + Math.round(c[1] * 255) + "," + Math.round(c[2] * 255) + ")"; }
    function palette(el, host) {
        var list = [];
        if (el.dataset.colors) list = el.dataset.colors.split(/\s*,\s*(?![^()]*\))/).map(function (c) { return parseColor(c, host); }).filter(Boolean);
        if (!list.length && el.dataset.palette && PALETTES[el.dataset.palette]) list = PALETTES[el.dataset.palette].map(function (c) { return parseColor(c); });
        if (!list.length) {                                          // couleurs d'un en-tête hero-* (variables --hero-a / --hero-b) sinon doré
            var cs = getComputedStyle(host), a = parseColor(cs.getPropertyValue("--hero-a")), b = parseColor(cs.getPropertyValue("--hero-b"));
            list = a ? [a, b || a, mixc(a, [1, 1, 1], 0.55)] : PALETTES.gold.map(function (c) { return parseColor(c); });
        }
        while (list.length < 3) list.push(list.length === 1 ? list[0] : mixc(list[1], [1, 1, 1], 0.5));
        return list.slice(0, 3);
    }

    /* ------------------------------------------------------------ WebGL */
    function glShader(type, src) {
        var g = S.gl, s = g.createShader(type);
        g.shaderSource(s, src); g.compileShader(s);
        if (!g.getShaderParameter(s, g.COMPILE_STATUS)) { var log = g.getShaderInfoLog(s) || "erreur de compilation"; g.deleteShader(s); throw new Error(log); }
        return s;
    }
    function setupGL() {
        var g = S.gl, b = g.createBuffer();
        g.bindBuffer(g.ARRAY_BUFFER, b);
        g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
        g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
        S.vs = glShader(g.VERTEX_SHADER, "attribute vec2 a;void main(){gl_Position=vec4(a,0.0,1.0);}");
    }
    function glGet() {
        if (S.gl !== undefined) return S.gl;
        S.gl = null;
        try {
            var c = document.createElement("canvas"); c.width = 16; c.height = 16;
            var o = { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power", preserveDrawingBuffer: false };
            var g = c.getContext("webgl", o) || c.getContext("experimental-webgl", o);
            if (!g) return null;
            S.cv = c; S.gl = g; setupGL();
            c.addEventListener("webglcontextlost", function (e) { e.preventDefault(); S.lost = true; });
            c.addEventListener("webglcontextrestored", function () {
                S.lost = false; S.progs = {}; setupGL();
                S.items.forEach(function (it) { it.dirty = true; }); wake();
            });
        } catch (e) { S.gl = null; }
        return S.gl;
    }
    var UNIFORMS = ["u_resolution", "u_time", "u_mouse", "u_hover", "u_press", "u_dark", "u_c1", "u_c2", "u_c3", "u_bg"];
    function program(src) {
        if (S.progs[src]) return S.progs[src];
        var g = S.gl, p;
        try {
            var fs = glShader(g.FRAGMENT_SHADER, src), id = g.createProgram();
            g.attachShader(id, S.vs); g.attachShader(id, fs); g.bindAttribLocation(id, 0, "a"); g.linkProgram(id);
            if (!g.getProgramParameter(id, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(id) || "erreur d'édition de liens");
            p = { id: id, u: {} };
            UNIFORMS.forEach(function (n) { p.u[n] = g.getUniformLocation(id, n); });
        } catch (e) { p = { error: String(e.message || e) }; }
        return (S.progs[src] = p);
    }
    function fail(it, msg) {
        if (it.failed) return;
        it.failed = true;
        msg = String(msg).replace(/\b0:(\d+)/g, function (_, n) { return "ligne " + Math.max(1, n - it.off); }).trim();
        it.el.dataset.state = "error"; it.el.dataset.error = msg.slice(0, 300);
        (window.NB_SHADER_ERRORS = window.NB_SHADER_ERRORS || []).push(msg);
        console.warn("[nb-shader] GLSL refusé (le dégradé CSS reste affiché) :", msg);
    }
    function build(it, code) {
        var toy;
        code = code.replace(/^\s*#version[^\n]*$/gm, "").replace(/^\s*precision\s+\w+\s+\w+\s*;\s*$/gm, "")
            .replace(/^\s*uniform\s+\w+\s+(?:u_resolution|u_time|u_mouse|u_hover|u_press|u_dark|u_c1|u_c2|u_c3|u_bg|iResolution|iTime|iMouse)\s*;\s*$/gm, "");
        toy = /void\s+mainImage\s*\(/.test(code) && !/void\s+main\s*\(/.test(code);          // code au format Shadertoy
        var head = HEAD + (toy ? TOY : "");
        it.off = head.split("\n").length - 1;
        return head + code + (toy ? "\nvoid main(){ vec4 c=vec4(0.0,0.0,0.0,1.0); mainImage(c,gl_FragCoord.xy); gl_FragColor=vec4(c.rgb,1.0); }" : "");
    }

    function render(it, ts) {
        var g = S.gl;
        if (!g || S.lost || !it.w) return;
        var p = program(it.src);
        if (p.error) return fail(it, p.error);
        var cv = S.cv, w = it.w, h = it.h;
        if (cv.width < w || cv.height < h) { cv.width = Math.max(cv.width, w); cv.height = Math.max(cv.height, h); }
        g.viewport(0, 0, w, h); g.useProgram(p.id);
        var u = p.u, m = it.m;
        g.uniform2f(u.u_resolution, w, h);
        g.uniform1f(u.u_time, it.static ? it.seed + 5 : it.seed + (ts - it.t0) / 1000 * it.speed);
        g.uniform2f(u.u_mouse, m.x, m.y); g.uniform1f(u.u_hover, m.hover); g.uniform1f(u.u_press, m.press);
        g.uniform1f(u.u_dark, S.dark);
        g.uniform3fv(u.u_c1, it.c[0]); g.uniform3fv(u.u_c2, it.c[1]); g.uniform3fv(u.u_c3, it.c[2]); g.uniform3fv(u.u_bg, S.bg);
        g.drawArrays(g.TRIANGLES, 0, 3);
        it.ctx.drawImage(cv, 0, cv.height - h, w, h, 0, 0, w, h);                 // origine GL en bas à gauche → on copie les h dernières lignes
        if (!it.on) { it.on = true; it.el.dataset.state = "on"; }
    }

    /* ------------------------------------------------------------ boucle */
    function size(it) {
        var s = Math.min(window.devicePixelRatio || 1, 1.5) * it.quality * S.q;
        var w = Math.max(2, Math.round(it.cssW * s)), h = Math.max(2, Math.round(it.cssH * s)), px = w * h;
        if (px > 1.3e6) { var k = Math.sqrt(1.3e6 / px); w = Math.round(w * k); h = Math.round(h * k); }
        if (it.cv.width !== w || it.cv.height !== h) { it.cv.width = w; it.cv.height = h; }
        it.w = w; it.h = h; it.dirty = true;
    }
    function wake() { if (!S.raf && !document.hidden) S.raf = requestAnimationFrame(tick); }
    function tick(ts) {
        S.raf = 0;
        var animated = false;
        S.items = S.items.filter(function (it) {
            if (it.el.isConnected) return true;
            it.io.disconnect(); it.ro.disconnect(); return false;
        });
        S.items.forEach(function (it) {
            if (!it.visible || it.failed || !it.w) return;
            var anim = !it.static;
            if (anim) animated = true;
            if (!it.dirty && !(anim && ts - it.last >= 1000 / it.fps - 2)) return;
            var m = it.m;
            m.x += (m.tx - m.x) * 0.15; m.y += (m.ty - m.y) * 0.15; m.hover += (m.th - m.hover) * 0.1; m.press += (m.tp - m.press) * 0.2;
            it.last = ts; it.dirty = false;
            render(it, ts);
        });
        if (animated) {
            var dt = S.lastTs ? ts - S.lastTs : 17; S.lastTs = ts;
            S.ema = S.ema * 0.92 + Math.min(dt, 200) * 0.08;
            if (S.ema > 40 && S.q > 0.45 && ++S.slow > 30) {                   // appareil lent : on baisse la résolution de tous les shaders
                S.q = Math.max(0.45, S.q * 0.85); S.slow = 0; S.ema = 17; S.items.forEach(size);
            }
            S.raf = requestAnimationFrame(tick);
        } else S.lastTs = 0;
    }
    function readTheme() {
        var root = document.documentElement;
        S.dark = root.classList.contains("dark") ? 1 : 0;
        S.bg = parseColor(getComputedStyle(root).getPropertyValue("--nb-bg-card"), root) || (S.dark ? [0.145, 0.133, 0.114] : [1, 1, 1]);
        S.items.forEach(function (it) { it.dirty = true; });
        wake();
    }

    /* ------------------------------------------------------------ éléments */
    function setup(el) {
        var bgMode = el.classList.contains("nb-shader-bg"), host = bgMode ? el.parentElement : el;
        if (!host) return;
        if (bgMode) host.classList.add("has-shader");
        var sc = el.querySelector('script[type="x-shader/x-fragment"]');
        var it = { el: el, host: host, src: "", failed: false, visible: false, on: false, dirty: true, last: 0, t0: 0, off: 0, w: 0, h: 0, cssW: 0, cssH: 0,
                   m: { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, hover: 0, th: 0, press: 0, tp: 0 } };
        var d = el.dataset;
        it.c = palette(el, host);
        el.style.setProperty("--sh-a", rgbCss(it.c[0])); el.style.setProperty("--sh-b", rgbCss(it.c[1]));   // le dégradé CSS de secours reprend la palette
        if (d.intensity !== undefined && !isNaN(+d.intensity)) el.style.setProperty("--nb-shader-o", Math.max(0, Math.min(1, +d.intensity)));
        if (d.height && !bgMode) el.style.setProperty("--nb-shader-h", Math.max(120, Math.min(900, +d.height || 220)) + "px");
        if (!bgMode && !el.getAttribute("role")) { el.setAttribute("role", "img"); el.setAttribute("aria-label", d.label || "Illustration animée"); }
        if (bgMode) el.setAttribute("aria-hidden", "true");
        it.speed = Math.max(0.1, Math.min(4, +d.speed || 1));
        it.fps = Math.max(10, Math.min(60, +d.fps || 30));
        it.seed = d.seed !== undefined ? +d.seed || 0 : (S.n++ * 7.31) % 19;
        it.static = d.static !== undefined && d.static !== "false";
        if (sc) { it.src = build(it, sc.textContent || ""); it.quality = Math.max(0.3, Math.min(1, +d.quality || 0.85)); }
        else {
            var name = ALIAS[d.preset] || d.preset || "blobs";
            if (!PRESETS[name]) { console.warn("[nb-shader] preset inconnu : " + d.preset + " (disponibles : " + Object.keys(PRESETS).join(", ") + ")"); name = "blobs"; }
            it.src = HEAD + PRESETS[name] + "\n" + MAIN; it.off = HEAD.split("\n").length - 1;
            it.quality = Math.max(0.3, Math.min(1, +d.quality || 0.6));                          // champs doux : une résolution réduite suffit
        }
        var cv = document.createElement("canvas"); cv.setAttribute("aria-hidden", "true");
        it.cv = cv; it.ctx = cv.getContext("2d"); el.appendChild(cv);
        if (d.pointer !== "off") {
            var set = function (e) { var r = host.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return; it.m.tx = (e.clientX - r.left) / r.width; it.m.ty = 1 - (e.clientY - r.top) / r.height; it.m.th = 1; };
            host.addEventListener("pointermove", set);
            host.addEventListener("pointerdown", function (e) { set(e); it.m.tp = 1; });
            host.addEventListener("pointerup", function () { it.m.tp = 0; });
            host.addEventListener("pointercancel", function () { it.m.tp = 0; it.m.th = 0; });
            host.addEventListener("pointerleave", function () { it.m.th = 0; it.m.tp = 0; });
        }
        it.io = new IntersectionObserver(function (es) {
            es.forEach(function (e) { it.visible = e.isIntersecting; if (it.visible) { it.dirty = true; it.last = 0; if (!it.t0) it.t0 = performance.now(); wake(); } });
        }, { rootMargin: "120px" });
        it.ro = new ResizeObserver(function (es) {
            var r = es[0].contentRect;
            if (r.width < 2 || r.height < 2) return;
            it.cssW = r.width; it.cssH = r.height; size(it); wake();
        });
        S.items.push(it);
        it.io.observe(el); it.ro.observe(el);
    }
    function init() {
        var els = NB.$$(".nb-shader:not([data-nbs]), .nb-shader-bg:not([data-nbs])");
        if (!els.length) return;
        if (!("IntersectionObserver" in window) || !("ResizeObserver" in window) || !glGet()) {
            els.forEach(function (el) { el.dataset.nbs = "1"; el.dataset.state = "nogl"; });          // pas de WebGL : le dégradé CSS suffit
            return;
        }
        if (!S.themed) {
            S.themed = true;
            new MutationObserver(readTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
            document.addEventListener("visibilitychange", wake);
            var onRM = function () { S.items.forEach(function (it) { it.static = RM.matches || (it.el.dataset.static !== undefined && it.el.dataset.static !== "false"); it.dirty = true; }); wake(); };
            if (RM.addEventListener) RM.addEventListener("change", onRM);
        }
        readTheme();
        els.forEach(function (el) {
            el.dataset.nbs = "1";
            try { setup(el); } catch (e) { el.dataset.state = "error"; console.warn("[nb-shader]", e); }
        });
        if (RM.matches) S.items.forEach(function (it) { it.static = true; });
    }
    NB.shader = { presets: Object.keys(PRESETS), refresh: init };
    NB.register("shader", init, { perDom: true });
})();
// @endblock nb-shader
