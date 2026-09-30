/* notebooks.js — runtime commun chargé par chaque page de cours générée.
   Gère : bulles de définition, quiz cliquables, flashcards, onglets comparatifs,
   et déclenche MathJax une fois le contenu prêt. */
(function () {
    "use strict";

    function courseNameFromPage() {
        const path = window.location.pathname;
        const file = path.substring(path.lastIndexOf("/") + 1);
        return decodeURIComponent(file.replace(/\.html?$/i, ""));
    }

    let definitionsCache = null;

    async function loadDefinitions(course) {
        if (definitionsCache) return definitionsCache;
        try {
            const res = await fetch(`/api/notebooks/${encodeURIComponent(course)}/context`);
            const data = await res.json();
            definitionsCache = (data && data.context && data.context.definitions) || {};
            if (definitionsCache == {}) {
                const res = await fetch(`/api/notebooks/${encodeURIComponent(course)}/definitions`);
                const data = await res.json();
                definitionsCache = (data && data.context && data.context.definitions) || {};
            }

        } catch (e) {
            definitionsCache = {};
        }
        return definitionsCache;
    }

    function ensureTooltipEl() {
        let tip = document.getElementById("nb-def-tooltip");
        if (!tip) {
            tip = document.createElement("div");
            tip.id = "nb-def-tooltip";
            tip.className = "def-tooltip";
            tip.style.display = "none";
            tip.innerHTML = '<strong id="nb-def-term"></strong><div id="nb-def-body"></div>';
            document.body.appendChild(tip);
        }
        return tip;
    }

    function showTooltip(anchor, term, definition) {
        const tip = ensureTooltipEl();
        tip.querySelector("#nb-def-term").textContent = term;
        tip.querySelector("#nb-def-body").textContent = definition || "Définition non trouvée.";
        const rect = anchor.getBoundingClientRect();
        tip.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 290)) + "px";
        tip.style.top = (rect.bottom + 8) + "px";
        tip.style.display = "block";
    }

    function hideTooltip() {
        const tip = document.getElementById("nb-def-tooltip");
        if (tip) tip.style.display = "none";
    }

    function initDefinitionTerms(course) {
        document.querySelectorAll(".def-term").forEach((span) => {
            span.addEventListener("click", async (ev) => {
                ev.stopPropagation();
                const termId = span.dataset.def || span.textContent.trim().toLowerCase();
                const defs = await loadDefinitions(course);
                showTooltip(span, span.textContent, defs[termId] || defs[span.textContent.trim()]);
            });
        });
        document.addEventListener("click", (e) => {
            if (!e.target.closest("#nb-def-tooltip") && !e.target.closest(".def-term")) hideTooltip();
        });
    }

    function initTabs() {
        document.querySelectorAll(".nb-tabs").forEach((container) => {
            const btns = container.querySelectorAll(".nb-tab-btn");
            const panels = container.querySelectorAll(".nb-tab-panel");
            btns.forEach((btn, index) => {
                btn.addEventListener("click", () => {
                    btns.forEach((b) => b.classList.remove("active"));
                    panels.forEach((p) => p.classList.remove("active"));
                    btn.classList.add("active");
                    if (panels[index]) panels[index].classList.add("active");
                });
            });
        });
    }

    function initQuizzes() {
        document.querySelectorAll(".nb-quiz").forEach((quiz) => {
            const correctIndex = parseInt(quiz.dataset.answer, 10);
            const choices = Array.from(quiz.querySelectorAll(".nb-quiz-choice"));
            choices.forEach((btn, i) => {
                btn.addEventListener("click", () => {
                    choices.forEach((b) => (b.disabled = true));
                    btn.classList.add(i === correctIndex ? "correct" : "incorrect");
                    if (i !== correctIndex && choices[correctIndex]) {
                        choices[correctIndex].classList.add("correct");
                    }
                });
            });
        });
    }

    function initFlashcards() {
        document.querySelectorAll(".nb-flashcard").forEach((card) => {
            card.addEventListener("click", () => card.classList.toggle("flipped"));
        });
    }

    function initNotebook() {
        const course = courseNameFromPage();
        initDefinitionTerms(course);
        initTabs();
        initQuizzes();
        initFlashcards();
        if (window.MathJax && window.MathJax.typesetPromise) {
            window.MathJax.typesetPromise();
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initNotebook);
    } else {
        initNotebook();
    }

        // <!-- SCRIPTS DE COMPORTEMENT INTERACTIF DE CARTE MENTALE INTéRACTIVE (PAN, ZOOM & SVG) -->
    (function() {
    let scale = 0.9;
    let panX = 0;
    let panY = 0;
    let isDragging = false;
    let dragMoved = false;
    let startX = 0, startY = 0;
    let pointerStartX = 0, pointerStartY = 0;

    // Pinch-to-zoom sur mobile
    let initialPinchDistance = null;
    let initialScale = scale;

    const viewport = document.getElementById('mm-viewport');
    const canvas = document.getElementById('mm-canvas');
    const svg = document.getElementById('mm-svg');
    const centerNode = document.getElementById('mm-node-center');

    function updateTransform() {
        canvas.style.transform = `translate3d(calc(-50% + ${panX}px), calc(-50% + ${panY}px), 0) scale(${scale})`;
    }

    function drawConnections() {
        const cX = centerNode.offsetLeft + centerNode.offsetWidth / 2;
        const cY = centerNode.offsetTop + centerNode.offsetHeight / 2;

        const branches = document.querySelectorAll('.mm-branch');
        let svgHtml = '';

        const colors = {
        '1': '#ef4444',
        '2': '#3b82f6',
        '3': '#10b981',
        '4': '#f59e0b',
        '5': '#a855f7'
        };

        branches.forEach(branch => {
        const id = branch.getAttribute('data-node');
        const bX = branch.offsetLeft + branch.offsetWidth / 2;
        const bY = branch.offsetTop + branch.offsetHeight / 2;

        const deltaX = bX - cX;
        const cpX1 = cX + deltaX * 0.5;
        const cpY1 = cY;
        const cpX2 = cX + deltaX * 0.5;
        const cpY2 = bY;

        const pathColor = colors[id] || '#b8905a';

        svgHtml += `<path d="M ${cX} ${cY} C ${cpX1} ${cpY1}, ${cpX2} ${cpY2}, ${bX} ${bY}" 
                            fill="none" 
                            stroke="${pathColor}" 
                            stroke-width="3" 
                            stroke-dasharray="6,4" 
                            opacity="0.6"/>`;
        });

        svg.innerHTML = svgHtml;
    }

    // --- Gestion du Drag (Déplacement) ---
    viewport.addEventListener('pointerdown', (e) => {
        isDragging = true;
        dragMoved = false;
        pointerStartX = e.clientX;
        pointerStartY = e.clientY;
        startX = e.clientX - panX;
        startY = e.clientY - panY;
    });

    window.addEventListener('pointermove', (e) => {
        if (!isDragging) return;

        // Seuil de 10px pour ignorer les tremblements lors d'un simple clic
        const dist = Math.hypot(e.clientX - pointerStartX, e.clientY - pointerStartY);
        if (dist > 10) {
        dragMoved = true;
        e.preventDefault();
        panX = e.clientX - startX;
        panY = e.clientY - startY;
        requestAnimationFrame(updateTransform);
        }
    });

    window.addEventListener('pointerup', () => {
        isDragging = false;
    });

    // --- Pinch-to-Zoom Tactile (Mobile) ---
    viewport.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
        isDragging = false;
        initialPinchDistance = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
        initialScale = scale;
        }
    }, { passive: true });

    viewport.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && initialPinchDistance) {
        e.preventDefault();
        const currentDistance = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
        const zoomFactor = currentDistance / initialPinchDistance;
        scale = Math.min(Math.max(0.4, initialScale * zoomFactor), 2.0);
        requestAnimationFrame(updateTransform);
        }
    }, { passive: false });

    viewport.addEventListener('touchend', () => { initialPinchDistance = null; });

    // --- Zoom Molette ---
    viewport.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
        scale = Math.min(Math.max(0.4, scale * zoomFactor), 2.0);
        requestAnimationFrame(updateTransform);
    }, { passive: false });

    // --- Boutons de contrôle ---
    document.getElementById('mm-zoom-in').onclick = () => { scale = Math.min(2.0, scale * 1.25); updateTransform(); };
    document.getElementById('mm-zoom-out').onclick = () => { scale = Math.max(0.4, scale / 1.25); updateTransform(); };
    document.getElementById('mm-reset').onclick = () => { scale = 0.9; panX = 0; panY = 0; updateTransform(); };

    // --- Ouverture / Fermeture au Clic ---
    window.toggleBranch = function(id) {
        if (dragMoved) return; // Si la souris/doigt a bougé pour glisser, on n'ouvre pas

        const branch = document.querySelector(`.mm-branch[data-node="${id}"]`);
        const body = branch.querySelector('.mm-branch-body');
        const icon = branch.querySelector(`.mm-icon-${id}`);

        if (body.classList.contains('hidden')) {
        body.classList.remove('hidden');
        if (icon) icon.style.transform = 'rotate(180deg)';
        } else {
        body.classList.add('hidden');
        if (icon) icon.style.transform = 'rotate(0deg)';
        }
        setTimeout(drawConnections, 60);
    };

    let allOpen = false;
    const toggleAllBtn = document.getElementById('mm-toggle-all');
    
    function toggleAll() {
        if (dragMoved) return;
        allOpen = !allOpen;
        document.querySelectorAll('.mm-branch').forEach(branch => {
        const id = branch.getAttribute('data-node');
        const body = branch.querySelector('.mm-branch-body');
        const icon = branch.querySelector(`.mm-icon-${id}`);
        if (allOpen) {
            body.classList.remove('hidden');
            if (icon) icon.style.transform = 'rotate(180deg)';
        } else {
            body.classList.add('hidden');
            if (icon) icon.style.transform = 'rotate(0deg)';
        }
        });
        toggleAllBtn.innerHTML = allOpen 
        ? '<i class="fas fa-compress-alt mr-1"></i> Fold All' 
        : '<i class="fas fa-layer-group mr-1"></i> Unfold All';
        setTimeout(drawConnections, 60);
    }

    toggleAllBtn.onclick = toggleAll;
    centerNode.onclick = toggleAll;

    // Initialisation
    setTimeout(() => {
        updateTransform();
        drawConnections();
    }, 100);

    })();


    window.SCHOOLWORKSPACE_NOTEBOOK_REINIT = initNotebook;
})();