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
      let scale = 1;
      let panX = 0;
      let panY = 0;
      let isDragging = false;
      let startX, startY;

      const viewport = document.getElementById('mm-viewport');
      const canvas = document.getElementById('mm-canvas');
      const svg = document.getElementById('mm-svg');
      const centerNode = document.getElementById('mm-node-center');

      // Mettre à jour la transformation CSS du Canvas
      function updateTransform() {
        canvas.style.transform = `translate(calc(-50% + ${panX}px), calc(-50% + ${panY}px)) scale(${scale})`;
        drawConnections();
      }

      // Tracer les lignes SVG incurvées reliées au centre
      function drawConnections() {
        const centerRect = centerNode.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        
        // Centre relatif au canvas
        const cX = (centerRect.left + centerRect.width / 2 - canvasRect.left) / scale;
        const cY = (centerRect.top + centerRect.height / 2 - canvasRect.top) / scale;

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
          const bRect = branch.getBoundingClientRect();
          const bX = (bRect.left + bRect.width / 2 - canvasRect.left) / scale;
          const bY = (bRect.top + bRect.height / 2 - canvasRect.top) / scale;

          // Courbe Bezier fluide
          const deltaX = bX - cX;
          const deltaY = bY - cY;
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

      // --- Gestion du Drag / Pan ---
      viewport.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.mm-branch-header') || e.target.closest('#mm-node-center')) return;
        isDragging = true;
        startX = e.clientX - panX;
        startY = e.clientY - panY;
        viewport.setPointerCapture(e.pointerId);
      });

      viewport.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        panX = e.clientX - startX;
        panY = e.clientY - startY;
        updateTransform();
      });

      viewport.addEventListener('pointerup', (e) => {
        isDragging = false;
        try { viewport.releasePointerCapture(e.pointerId); } catch(err) {}
      });

      // --- Gestion du Zoom Molette ---
      viewport.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
        scale = Math.min(Math.max(0.5, scale * zoomFactor), 2.2);
        updateTransform();
      }, { passive: false });

      // --- Boutons de contrôle ---
      document.getElementById('mm-zoom-in').onclick = () => { scale = Math.min(2.2, scale * 1.25); updateTransform(); };
      document.getElementById('mm-zoom-out').onclick = () => { scale = Math.max(0.5, scale / 1.25); updateTransform(); };
      document.getElementById('mm-reset').onclick = () => { scale = 1; panX = 0; panY = 0; updateTransform(); };

      // --- Replier / Déplier Branche ---
      window.toggleBranch = function(id) {
        const branch = document.querySelector(`.mm-branch[data-node="${id}"]`);
        const body = branch.querySelector('.mm-branch-body');
        const icon = branch.querySelector(`.mm-icon-${id}`);

        if (body.classList.contains('hidden')) {
          body.classList.remove('hidden');
          icon.style.transform = 'rotate(180deg)';
        } else {
          body.classList.add('hidden');
          icon.style.transform = 'rotate(0deg)';
        }
        setTimeout(drawConnections, 100);
      };

      // --- Basculer Tout ---
      let allOpen = false;
      const toggleAllBtn = document.getElementById('mm-toggle-all');
      
      function toggleAll() {
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
        setTimeout(drawConnections, 120);
      }

      toggleAllBtn.onclick = toggleAll;
      centerNode.onclick = toggleAll;

      // Initialisation au chargement
      setTimeout(() => {
        updateTransform();
        drawConnections();
      }, 200);

      window.addEventListener('resize', drawConnections);
    })();


    window.SCHOOLWORKSPACE_NOTEBOOK_REINIT = initNotebook;
})();