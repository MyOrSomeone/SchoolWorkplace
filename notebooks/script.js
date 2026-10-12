// Configuration Tailwind
window.tailwind = {
    darkMode: "class",
    theme: {
        extend: {
            colors: {
                cream: {
                    DEFAULT: "#EFECE6",
                    dark: "#121211",
                    gold: "#C5A059",
                    border: "#D3C9B8",
                    borderDark: "#2C2B28",
                },
            },
        },
    },
};

let currentCourse = null;   // matière
let currentChapter = null;  // slug du chapitre ouvert
let notebookSourcesState = {};

function getBaseUrl() {
    let path = window.location.pathname;
    if (!path.endsWith('/')) {
        if (path.endsWith('.html')) {
            path = path.substring(0, path.lastIndexOf('/') + 1);
        } else {
            path += '/';
        }
    }
    return window.location.origin + path;
}

function escapeHtmlNb(s) {
    return String(s || "").replace(/[&<>"']/g, c => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[c]));
}

function setCreationPanelVisible(visible) {
    const panel = document.getElementById("notebook-creation-panel");
    const icon = document.getElementById("notebook-toggle-icon");

    if (!panel) return;

    if (visible) {
        panel.classList.remove("hidden");
        if (icon) icon.className = "fa-solid fa-sidebar-flip text-sm";
    } else {
        panel.classList.add("hidden");
        if (icon) icon.className = "fa-solid fa-wand-magic-sparkles text-sm";
    }
}

async function loadNotebookSources() {
    const listEl = document.getElementById("notebook-sources-list");

    if (!listEl) return;

    listEl.innerHTML = '<p class="text-stone-500">Chargement…</p>';

    try {
        const res = await fetch(
            `/api/notebooks/${encodeURIComponent(currentCourse)}/sources`
        );

        const data = await res.json();

        if (!data.success) {
            throw new Error(data.error || "Erreur inconnue");
        }

        notebookSourcesState = {};

        (data.sources || [])
            .sort((a, b) => (a.ordre || 0) - (b.ordre || 0))
            .forEach(s => {
                notebookSourcesState[s.id] = {
                    ...s,
                    selected: false
                };
            });

        renderNotebookSources();

    } catch (e) {
        listEl.innerHTML =
            '<p class="text-red-500">Erreur : ' +
            escapeHtmlNb(e.message) +
            '</p>';
    }
}

async function selectNotebook(matiere, chapterSlug, url) {
    currentCourse = matiere;
    currentChapter = chapterSlug || null;

    const titleSpan = document.getElementById("notebook-modal-title")?.querySelector("span");
    if (titleSpan) titleSpan.textContent = matiere;

    const iframe = document.getElementById("notebook-iframe");
    if (iframe) {
        // url vient de data/library.json (ex: "Philosophie/01-intro.html") ; sans chapitre -> sommaire
        const target = url || `${encodeURIComponent(matiere)}/index.html`;
        iframe.src = `${getBaseUrl()}data/${target.split("/").map(encodeURIComponent).join("/")}`;
    }

    document.getElementById("notebook-selection-view")?.classList.add("hidden");
    document.getElementById("notebook-note")?.classList.add("hidden");

    const workspace = document.getElementById("notebook-workspace-view");
    if (workspace) {
        workspace.classList.remove("hidden");
        workspace.classList.add("flex");
    }

    document.getElementById("notebook-back-btn")?.classList.remove("hidden");
    document.getElementById("notebook-toggle-panel-btn")?.classList.remove("hidden");

    setCreationPanelVisible(false);
}

async function refreshNotebookTabs() {
    const tabsEl = document.getElementById("notebook-tabs");
    if (!tabsEl) return;

    tabsEl.innerHTML = '<span class="text-[11px] text-stone-500">Chargement…</span>';

    try {
        // library.json est GÉNÉRÉ par le script Python (plus d'API GitHub, plus de limite de requêtes)
        const res = await fetch(`${getBaseUrl()}data/library.json?t=${Date.now()}`);
        if (!res.ok) throw new Error(`library.json : ${res.status} ${res.statusText}`);
        const lib = await res.json();

        const emptyState = document.getElementById("notebook-empty-state");
        const matieres = lib.matieres || [];
        tabsEl.innerHTML = "";

        if (!matieres.length) {
            emptyState?.classList.remove("hidden");
            return;
        }
        emptyState?.classList.add("hidden");

        matieres.forEach(m => {
            const block = document.createElement("div");
            block.className = "w-full mb-3";

            const head = document.createElement("button");
            head.className = "w-full text-left font-bold text-xs text-cream-gold flex items-center gap-2 mb-2";
            head.innerHTML = `<i class="fa-solid fa-book"></i> ${escapeHtmlNb(m.matiere)}
                <span class="text-[10px] opacity-60">sommaire</span>`;
            head.onclick = () => selectNotebook(m.matiere, null, m.index);
            block.appendChild(head);

            const list = document.createElement("div");
            list.className = "grid gap-2";
            (m.chapters || []).forEach(c => {
                const card = document.createElement("button");
                card.className =
                    "flex flex-col items-start p-3 rounded-xl border border-cream-gold/40 " +
                    "hover:border-cream-gold hover:bg-cream-gold/10 transition text-left w-full";
                card.innerHTML = `<div class="font-bold text-xs">${escapeHtmlNb(c.title)}</div>
                    <div class="text-[10px] opacity-60">${c.n_parts} partie(s)</div>`;
                card.onclick = () => selectNotebook(m.matiere, c.slug, c.url);
                list.appendChild(card);
            });
            block.appendChild(list);
            tabsEl.appendChild(block);
        });
    } catch (e) {
        console.error("Erreur chargement library.json :", e);
        tabsEl.innerHTML = '<span class="text-[11px] text-red-500">Cours indisponibles (' +
            escapeHtmlNb(e.message) + ')</span>';
    }
}

function backToNotebookList() {
    currentCourse = null;
    currentChapter = null;
    const titleSpan = document.getElementById("notebook-modal-title")?.querySelector("span");
    if (titleSpan) titleSpan.textContent = "Cahiers Numériques";
    
    const workspace = document.getElementById("notebook-workspace-view");
    if (workspace) {
        workspace.classList.add("hidden");
        workspace.classList.remove("flex");
    }
    
    document.getElementById("notebook-selection-view")?.classList.remove("hidden");
    document.getElementById("notebook-note")?.classList.remove("hidden");
    document.getElementById("notebook-back-btn")?.classList.add("hidden");
    document.getElementById("notebook-toggle-panel-btn")?.classList.add("hidden");
    
    refreshNotebookTabs();
}

function toggleTheme() {
    const html = document.documentElement;
    const icon = document.getElementById("theme-icon");
    if (html.classList.contains("dark")) {
        html.classList.remove("dark");
        icon.className = "fa-solid fa-moon text-xs";
    } else {
        html.classList.add("dark");
        icon.className = "fa-solid fa-sun text-xs text-amber-400";
    }
    syncIframeTheme()
}

function syncIframeTheme() {
    const iframe = document.getElementById("notebook-iframe");
    if (!iframe || !iframe.contentDocument || !iframe.contentDocument.documentElement) return;
    
    const isDark = document.documentElement.classList.contains("dark");
    if (isDark) {
        iframe.contentDocument.documentElement.classList.add("dark");
    } else {
        iframe.contentDocument.documentElement.classList.remove("dark");
    }
}

function initApp() {
    document.getElementById("theme-toggle-btn")?.addEventListener("click", toggleTheme);
    document.getElementById("notebook-back-btn")?.addEventListener("click", backToNotebookList);

    const iframe = document.getElementById("notebook-iframe");
    if (iframe) {
        iframe.addEventListener("load", syncIframeTheme);
    }

    refreshNotebookTabs();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
} else {
    initApp();
}