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

    window.SCHOOLWORKSPACE_NOTEBOOK_REINIT = initNotebook;
})();
