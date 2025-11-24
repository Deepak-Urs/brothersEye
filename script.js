(() => {
  /* ============================================================
        AUTO-RESTART (FILTER + PAGINATION ONLY)
        SAFE | DEBOUNCED | NO 429 | NO JOB-ID TRIGGERS
     ============================================================ */
  function cleanUrl(url) {
    const u = new URL(url);
    // Ignore volatile currentJobId so clicks don't restart the script
    u.searchParams.delete("currentJobId");
    return u.toString();
  }

  let lastCleanUrl = cleanUrl(location.href);
  let restartLock = false;
  let restartCooldown = false;

  function safeRestart() {
    if (restartCooldown || restartLock) return;

    restartLock = true;
    console.log("🔄 URL changed (filters/pagination) → restarting job match script...");

    setTimeout(() => {
      restartLock = false;
    }, 400); // short lock to avoid double calls

    restartCooldown = true;
    startScript(); // FULL restart

    setTimeout(() => {
      restartCooldown = false;
    }, 2000); // 2 sec cooldown — prevents rapid restarts
  }

  // Watch URL changes every 300ms
  const urlWatcherId = setInterval(() => {
    const now = cleanUrl(location.href);
    if (now !== lastCleanUrl) {
      lastCleanUrl = now;
      safeRestart();
    }
  }, 300);

  /* ============================================================
        MAIN SCRIPT WRAPPER (RESTARTABLE)
     ============================================================ */
  function startScript() {
    console.log("⚡ Job Match Script INIT");

    // Reset global caches
    window.jobMatchCache = {};
    window.jobMatchRetries = {};

    // Remove previous badges
    document.querySelectorAll(".job-match-badge").forEach(x => x.remove());

    // Remove previous style tag if present
    const oldStyles = document.getElementById("job-match-badge-style");
    if (oldStyles) oldStyles.remove();

    // Clear processed flags on existing cards
    document
      .querySelectorAll("div.job-card-container[data-job-id]")
      .forEach(card => {
        delete card.dataset.jobMatchDone;
      });

    // Disconnect old observer if any
    if (window.jobMatchObserver) {
      window.jobMatchObserver.disconnect();
      window.jobMatchObserver = null;
    }

    // Remove old button if present
    const oldBtn = document.getElementById("job-match-fab");
    if (oldBtn) oldBtn.remove();

    initScriptCore();
  }

  /* ============================================================
        CORE LOGIC (STARTING REFERENCE + 3-STATE BUTTON)
     ============================================================ */
  function initScriptCore() {
    const DELAY_MS = 1200;
    const processedFlag = "jobMatchDone";
    const MAX_RETRIES = 3;

    function sleep(ms) {
      return new Promise(res => setTimeout(res, ms));
    }

    /* -------------------------------------------
        Detect "Top Applicant" from RHS panel
       ------------------------------------------- */
    function getTopApplicantFromDetail() {
      const panel = document.querySelector("div.jobs-details__main-content");
      if (!panel) return false;
      return /you(?:'|’|`|â€™)?d be a top applicant/i.test(panel.innerText);
    }

    function getPremiumMatchLevelFromDetail() {
      const node = Array.from(document.querySelectorAll("section, div"))
        .find(el => el.innerText && /job match is\s+\w+/i.test(el.innerText));

      if (!node) return "unknown";

      const lines = node.innerText.split("\n");
      for (const line of lines) {
        const m = line.match(/job match is\s+(\w+)[,\.]?/i);
        if (m && m[1]) return m[1].toLowerCase();
      }

      const fallback = node.innerText.match(/job match is\s+(\w+)[,\.]?/i);
      return fallback && fallback[1] ? fallback[1].toLowerCase() : "unknown";
    }

    function ensureStyles() {
      if (document.getElementById("job-match-badge-style")) return;

      const style = document.createElement("style");
      style.id = "job-match-badge-style";
      style.textContent = `
        .job-match-badge {
          margin-left: 6px;
          padding: 2px 6px;
          border-radius: 9999px;
          font-size: 11px;
          font-weight: 700;
          color: white !important;
          display: inline-flex;
          align-items: center;
        }
        .badge-high   { background-color: #16a34a !important; }
        .badge-medium { background-color: #9ca3af !important; }
        .badge-low    { background-color: #ef4444 !important; }
        .badge-top    { background-color: #d4a017 !important; }

        .card-high   { background-color: rgba(22,163,74,0.08) !important; }
        .card-medium { background-color: rgba(156,163,175,0.08) !important; }
        .card-low    { background-color: rgba(239,68,68,0.08) !important; }
        .card-top    { background-color: rgba(212,160,23,0.10) !important; }

        @keyframes job-match-spin {
          100% { transform: rotate(360deg); }
        }
        .job-match-spinner {
          animation: job-match-spin 1s linear infinite;
          transform-origin: center;
        }
      `;
      document.head.appendChild(style);
    }

    function applyBadgeForCard(card, entry) {
      ensureStyles();
      if (!entry) return;

      const liHost = card.closest("li.scaffold-layout__list-item") || card;
      const subtitle = card.querySelector(".artdeco-entity-lockup__subtitle");
      const badgeHost = subtitle || card;

      let badge = badgeHost.querySelector(".job-match-badge");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "job-match-badge";
        badgeHost.appendChild(badge);
      }

      badge.classList.remove("badge-high", "badge-medium", "badge-low", "badge-top");
      liHost.classList.remove("card-high", "card-medium", "card-low", "card-top");

      if (entry.top) {
        badge.textContent = "TOP APPLICANT";
        badge.classList.add("badge-top");
        liHost.classList.add("card-top");
      } else {
        const m = entry.match || "low";
        const norm = ["high", "medium", "low"].includes(m) ? m : "low";
        badge.textContent = norm.toUpperCase() + " MATCH";

        if (norm === "high") {
          badge.classList.add("badge-high");
          liHost.classList.add("card-high");
        } else if (norm === "medium") {
          badge.classList.add("badge-medium");
          liHost.classList.add("card-medium");
        } else {
          badge.classList.add("badge-low");
          liHost.classList.add("card-low");
        }
      }
    }

    window.jobMatchCache = window.jobMatchCache || {};
    window.jobMatchRetries = window.jobMatchRetries || {};

    const queue = [];
    let processingQueue = false;
    let fabBtn = null;
    let fabState = "idle"; // 'idle' | 'processing' | 'done'

    /* -----------------------------
       FAB STATE HELPERS (SVG ICONS)
       ----------------------------- */
    function setFabToIdle() {
      fabState = "idle";
      if (!fabBtn) return;
      fabBtn.disabled = false;
      fabBtn.style.background = "#16a34a";
      fabBtn.style.opacity = "1";
      fabBtn.style.cursor = "pointer";
      fabBtn.innerHTML = `
        <span style="display:inline-flex;align-items:center;gap:6px;">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="3" y="3"  width="10" height="2" rx="1"></rect>
            <rect x="3" y="7"  width="10" height="2" rx="1"></rect>
            <rect x="3" y="11" width="7"  height="2" rx="1"></rect>
          </svg>
          <span>Process jobs</span>
        </span>
      `;
    }

    function setFabToProcessing() {
      fabState = "processing";
      if (!fabBtn) return;
      fabBtn.disabled = true;
      fabBtn.style.background = "#bbf7d0"; // light green
      fabBtn.style.opacity = "0.8";
      fabBtn.style.cursor = "not-allowed";
      fabBtn.innerHTML = `
        <span style="display:inline-flex;align-items:center;gap:6px;">
          <svg class="job-match-spinner" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6" fill="none" stroke="rgba(22,163,74,0.3)" stroke-width="2"></circle>
            <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="#16a34a" stroke-width="2" stroke-linecap="round"></path>
          </svg>
          <span>Processing jobs…</span>
        </span>
      `;
    }

    function setFabToDone() {
      fabState = "done";
      if (!fabBtn) return;
      fabBtn.disabled = true;
      fabBtn.style.background = "#4ade80"; // medium green
      fabBtn.style.opacity = "1";
      fabBtn.style.cursor = "default";
      fabBtn.innerHTML = `
        <span style="display:inline-flex;align-items:center;gap:6px;">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6.5 11 4 8.5l1.1-1.1 1.4 1.4 4-4 1.1 1.1-5.1 5.1z"></path>
          </svg>
          <span>Processed jobs</span>
        </span>
      `;
    }

    function markNewJobsArrived() {
      // If we were "done" and new jobs appear, go back to idle so user can process again
      if (fabState === "done") {
        setFabToIdle();
      }
    }

    async function processCard(card) {
      const jobId = card.getAttribute("data-job-id");
      if (!jobId) return;

      if (!window.jobMatchRetries[jobId]) {
        window.jobMatchRetries[jobId] = 0;
      }

      if (
        window.jobMatchCache[jobId] ||
        card.dataset[processedFlag] === "1" ||
        window.jobMatchRetries[jobId] >= MAX_RETRIES
      ) {
        return;
      }

      card.dataset[processedFlag] = "1";
      const cardText = card.innerText || "";

      // LEFT-SIDE detection (original logic)
      let isTop = /you(?:'|’|`|â€™)?d be a top applicant[\s,\.]/i.test(cardText);

      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.click();
      await sleep(DELAY_MS);

      /* Detect Top Applicant from RHS panel ALSO */
      const rhsTop = getTopApplicantFromDetail();
      if (rhsTop) isTop = true;

      let level = getPremiumMatchLevelFromDetail();

      /* If "Job match summary not available" → force LOW, no TOP */
      const rhsPanel = document.querySelector("div.jobs-details__main-content");
      const rhsText = rhsPanel ? rhsPanel.innerText : "";
      const noSummaryRegex = /job match summary not available/i;
      const hasNoSummary =
        noSummaryRegex.test(cardText) || noSummaryRegex.test(rhsText);

      if (hasNoSummary) {
        isTop = false;
        level = "low";
      }

      if (level === "unknown") {
        window.jobMatchRetries[jobId]++;
        console.warn(`Retry ${window.jobMatchRetries[jobId]}/${MAX_RETRIES} for job ${jobId}`);

        if (window.jobMatchRetries[jobId] < MAX_RETRIES) {
          card.dataset[processedFlag] = "0";
          enqueueCard(card);
          return;
        }
      }

      const titleEl =
        card.querySelector(".job-card-list__title") ||
        card.querySelector("a.job-card-container__link");
      const role = titleEl ? titleEl.innerText.split("\n")[0].trim() : "Unknown";

      const entry = { role, match: level, top: isTop };
      window.jobMatchCache[jobId] = entry;

      console.log("Processed:", role, level || "unknown", isTop ? "(TOP)" : "");
      applyBadgeForCard(card, entry);
    }

    function enqueueCard(card) {
      const jobId = card.getAttribute("data-job-id");
      if (!jobId) return;

      if (
        window.jobMatchCache[jobId] ||
        card.dataset[processedFlag] === "1" ||
        queue.includes(card)
      ) {
        return;
      }

      queue.push(card);
      markNewJobsArrived(); // if we had "Processed jobs" and now new ones, go back to idle
      // Note: we do NOT auto-process – user triggers via button.
    }

    async function processQueue() {
      if (processingQueue) return;
      processingQueue = true;

      setFabToProcessing();

      while (queue.length > 0) {
        const card = queue.shift();
        try {
          await processCard(card);
        } catch (e) {
          console.error("Error processing card:", e);
        }
      }

      console.log("Current results in window.jobMatchCache");
      console.table(
        Object.entries(window.jobMatchCache).map(([id, v]) => ({
          id,
          role: v.role,
          match: v.match,
          top: v.top
        }))
      );

      try {
        window.scrollTo({ top: 0, behavior: "smooth" });

        const listRoot =
          document.querySelector(".jobs-search-results-list") ||
          document.querySelector(".jobs-search-results__list") ||
          document.querySelector(".scaffold-layout__list");

        if (listRoot) {
          listRoot.scrollTop = 0;
        }

        await sleep(800);

        const firstCard = document.querySelector("div.job-card-container[data-job-id]");
        if (firstCard) {
          firstCard.scrollIntoView({ behavior: "smooth", block: "center" });
          firstCard.click();
          console.log("Returned to first job:", firstCard.getAttribute("data-job-id"));
        } else {
          console.warn("No first job card found when trying to return to top.");
        }
      } catch (e) {
        console.warn("Unable to scroll back to top or click first card:", e);
      }

      setFabToDone();
      processingQueue = false;
    }

    function ensureFab() {
      if (document.getElementById("job-match-fab")) {
        fabBtn = document.getElementById("job-match-fab");
        setFabToIdle();
        return;
      }

      // Find the left column container
      const listRoot =
        document.querySelector(".jobs-search-results-list") ||
        document.querySelector(".jobs-search-results__list") ||
        document.querySelector(".scaffold-layout__list");

      let anchor = null;
      if (listRoot) {
        anchor =
          listRoot.closest(".scaffold-layout__list") ||
          listRoot.parentElement ||
          document.body;
      } else {
        anchor = document.body;
      }

      if (anchor !== document.body && getComputedStyle(anchor).position === "static") {
        anchor.style.position = "relative";
      }

      fabBtn = document.createElement("button");
      fabBtn.id = "job-match-fab";

      fabBtn.style.position = "fixed";
      fabBtn.style.zIndex = "9999";
      fabBtn.style.padding = "10px 20px";
      fabBtn.style.borderRadius = "9999px";
      fabBtn.style.border = "none";
      fabBtn.style.fontSize = "13px";
      fabBtn.style.fontWeight = "600";
      fabBtn.style.boxShadow = "0 4px 10px rgba(0,0,0,0.15)";
      fabBtn.style.background = "#16a34a";
      fabBtn.style.color = "#fff";

      function positionButton() {
        const rect = anchor.getBoundingClientRect();
        fabBtn.style.top = Math.max(rect.top + 12, 60) + "px";
        fabBtn.style.left = rect.left + 12 + "px";
      }

      positionButton();
      window.addEventListener("resize", positionButton);
      window.addEventListener("scroll", positionButton);

      fabBtn.addEventListener("click", () => {
        if (!processingQueue && fabState === "idle") {
          console.log("▶ Manual trigger: processing all queued jobs…");
          processQueue();
        }
      });

      document.body.appendChild(fabBtn);
      setFabToIdle();
    }

    // Init styles + enqueue existing cards
    ensureStyles();
    document
      .querySelectorAll("div.job-card-container[data-job-id]")
      .forEach(enqueueCard);

    // Attach observer to detect new lazy-loaded job cards
    const listRoot =
      document.querySelector(".jobs-search-results-list") ||
      document.querySelector(".jobs-search-results__list") ||
      document.querySelector(".scaffold-layout__list");

    if (listRoot) {
      const observer = new MutationObserver(mutations => {
        for (const m of mutations) {
          m.addedNodes.forEach(node => {
            if (node.nodeType !== 1) return;

            if (node.matches && node.matches("div.job-card-container[data-job-id]")) {
              enqueueCard(node);
            }

            const innerCards = node.querySelectorAll
              ? node.querySelectorAll("div.job-card-container[data-job-id]")
              : [];
            innerCards.forEach(enqueueCard);
          });
        }
      });

      observer.observe(listRoot, { childList: true, subtree: true });
      window.jobMatchObserver = observer;

      console.log("Observer attached for new job cards.");
    } else {
      console.warn("Job list root not found; dynamic observing disabled.");
    }

    ensureFab();

    console.log(
      "Initial cards enqueued. Use the green 'Process jobs' button (top-left of list) to classify; new lazy-loaded jobs will re-enable it."
    );
  }

  // First run
  startScript();
})();
