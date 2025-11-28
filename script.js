(() => {
  /* ============================================================
        AUTO-RESTART (FILTER + PAGINATION ONLY)
     ============================================================ */
  function cleanUrl(url) {
    const u = new URL(url);
    u.searchParams.delete("currentJobId");
    return u.toString();
  }

  let lastCleanUrl = cleanUrl(location.href);
  let restartLock = false;
  let restartCooldown = false;

  function safeRestart() {
    if (restartCooldown || restartLock) return;
    restartLock = true;

    console.log("🔄 URL changed → restarting job match script...");
    setTimeout(() => (restartLock = false), 400);

    restartCooldown = true;
    startScript();
    setTimeout(() => (restartCooldown = false), 2000);
  }

  setInterval(() => {
    const now = cleanUrl(location.href);
    if (now !== lastCleanUrl) {
      lastCleanUrl = now;
      safeRestart();
    }
  }, 300);


  /* ============================================================
        MAIN WRAPPER
     ============================================================ */
  function startScript() {
    console.log("⚡ Job Match Script INIT");

    window.jobMatchCache = {};
    window.jobMatchRetries = {};
    window.jobMatchMarkerCard = null;

    document.querySelectorAll(".job-match-badge").forEach(x => x.remove());

    const oldStyles = document.getElementById("job-match-badge-style");
    if (oldStyles) oldStyles.remove();

    document
      .querySelectorAll("div.job-card-container[data-job-id]")
      .forEach(card => delete card.dataset.jobMatchDone);

    if (window.jobMatchObserver) {
      window.jobMatchObserver.disconnect();
      window.jobMatchObserver = null;
    }

    const oldBtn = document.getElementById("job-match-fab");
    if (oldBtn) oldBtn.remove();

    initScriptCore();
  }


  /* ============================================================
        CORE
     ============================================================ */
  function initScriptCore() {
    const DELAY_MS = 1200;
    const processedFlag = "jobMatchDone";
    const MAX_RETRIES = 3;

    const sleep = ms => new Promise(res => setTimeout(res, ms));

    /* ============================================================
          SMOOTH SCROLL (ease-out-quint)
     ============================================================ */
    function smoothScrollTo(targetY, duration = 400) {
      const start = window.scrollY;
      const delta = targetY - start;
      const startTime = performance.now();

      function easeOutQuint(t) {
        return 1 - Math.pow(1 - t, 5);
      }

      function step(now) {
        const t = Math.min(1, (now - startTime) / duration);
        const eased = easeOutQuint(t);
        window.scrollTo(0, start + delta * eased);
        if (t < 1) requestAnimationFrame(step);
      }

      requestAnimationFrame(step);
    }

    function smoothScrollToTop(duration = 400) {
      smoothScrollTo(0, duration);
    }

    /* ============================================================
          DETAIL SCRAPERS
     ============================================================ */
    function getTopApplicantFromDetail() {
      const panel = document.querySelector("div.jobs-details__main-content");
      if (!panel) return false;
      return /you(?:'|’|`|â€™)?d be a top applicant/i.test(panel.innerText);
    }

    function getPremiumMatchLevelFromDetail() {
      const nodes = document.querySelectorAll("section, div");
      const txt = Array.from(nodes).map(n => n.innerText || "").join("\n").toLowerCase();

      const m1 = txt.match(/job match[:\s]+(high|medium|low)/i);
      if (m1) return m1[1].toLowerCase();

      const m2 = txt.match(/job match is\s+(high|medium|low)/i);
      if (m2) return m2[1].toLowerCase();

      if (/job match (info )?unavailable/i.test(txt)) return "low";

      return "unknown";
    }

    /* ============================================================
          STYLE (includes spinner + overlay)
     ============================================================ */
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

        .badge-applied {
          background-color: #ffffff !important;
          color: #2563eb !important;
          border: 1px solid #2563eb !important;
        }
        .card-applied { background-color: rgba(37,99,235,0.08) !important; }

        .spinner-badge {
          margin-left: 6px;
          padding: 2px 6px;
          border-radius: 9999px;
          font-size: 11px;
          font-weight: 700;
          background-color: #f3f4f6 !important;
          color: #4b5563 !important;
          display: inline-flex;
          align-items: center;
        }
        .spinner-badge::after {
          content: "⏳";
          font-size: 12px;
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }

        /* FULL SCREEN OVERLAY */
        #jobmatch-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          backdrop-filter: blur(6px);
          background: rgba(255,255,255,0.525);   /* Reduced translucency by 30% */
          z-index: 999999;
          display: none;
          align-items: center;
          justify-content: center;
          flex-direction: column;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        #jobmatch-overlay-spinner {
          font-size: 42px;
          margin-bottom: 14px;
          animation: spin 1.2s linear infinite;
        }

        #jobmatch-overlay-text {
          font-size: 15px;
          font-weight: 600;
          color: #444;
          margin-bottom: 6px;
        }

        #jobmatch-overlay-quote {
          font-size: 13px;
          color: #666;
          text-align: center;
          max-width: 280px;
        }
      `;
      document.head.appendChild(style);
    }

    /* ============================================================
         OVERLAY DOM + QUOTES
     ============================================================ */
    const QUOTES = [
      "Top matches save you 70% effort.",
      "High-match roles boost success odds.",
      "Smart filtering cuts search time 60%.",
      "Every focused step beats scattered effort.",
      "You’re only one right match away.",
      "Better roles show up with clarity.",
      "Strong match scores drive faster offers.",
      "Your time matters. Target better.",
      "Quality applications beat quantity every day.",
      "This workflow gives you real momentum."
    ];

    let quoteIndexPool = [];
    let quoteTimer = null;

    function ensureOverlay() {
      if (document.getElementById("jobmatch-overlay")) return;

      const box = document.createElement("div");
      box.id = "jobmatch-overlay";
      box.innerHTML = `
        <div id="jobmatch-overlay-spinner">⏳</div>
        <div id="jobmatch-overlay-text">Loading...</div>
        <div id="jobmatch-overlay-quote"></div>
      `;
      document.body.appendChild(box);
    }

    function startOverlay() {
      const overlay = document.getElementById("jobmatch-overlay");
      if (!overlay) return;

      overlay.style.display = "flex";
      quoteIndexPool = [...Array(QUOTES.length).keys()];

      function cycleQuote() {
        if (quoteIndexPool.length === 0) return;
        const idx = Math.floor(Math.random() * quoteIndexPool.length);
        const quoteIndex = quoteIndexPool.splice(idx, 1)[0];
        const qEl = document.getElementById("jobmatch-overlay-quote");
        if (qEl) qEl.innerText = QUOTES[quoteIndex];
      }

      cycleQuote();
      quoteTimer = setInterval(() => {
        if (quoteIndexPool.length === 0) {
          clearInterval(quoteTimer);
          quoteTimer = null;
          return;
        }
        cycleQuote();
      }, 5000);
    }

    function stopOverlay() {
      const overlay = document.getElementById("jobmatch-overlay");
      if (!overlay) return;

      overlay.style.display = "none";
      if (quoteTimer) {
        clearInterval(quoteTimer);
        quoteTimer = null;
      }
    }


    /* ============================================================
          SPINNER UTILS
     ============================================================ */
    function showSpinner(card) {
      const subtitle = card.querySelector(".artdeco-entity-lockup__subtitle");
      const host = subtitle || card;
      if (host.querySelector(".spinner-badge")) return;

      const spin = document.createElement("span");
      spin.className = "spinner-badge";
      host.appendChild(spin);
    }

    function removeSpinner(card) {
      const subtitle = card.querySelector(".artdeco-entity-lockup__subtitle");
      const host = subtitle || card;
      const spin = host.querySelector(".spinner-badge");
      if (spin) spin.remove();
    }




    /* ============================================================
          APPLY BADGE
     ============================================================ */
    function applyBadgeForCard(card, entry) {
      ensureStyles();
      if (!entry) return;

      removeSpinner(card);

      const liHost = card.closest("li.scaffold-layout__list-item") || card;
      const subtitle = card.querySelector(".artdeco-entity-lockup__subtitle");
      const badgeHost = subtitle || card;

      let badge = badgeHost.querySelector(".job-match-badge");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "job-match-badge";
        badgeHost.appendChild(badge);
      }

      badge.classList.remove(
        "badge-high", "badge-medium", "badge-low",
        "badge-top", "badge-applied"
      );
      liHost.classList.remove(
        "card-high", "card-medium", "card-low",
        "card-top", "card-applied"
      );

      if (entry.applied) {
        badge.textContent = "APPLIED";
        badge.classList.add("badge-applied");
        liHost.classList.add("card-applied");
        return;
      }

      if (entry.top) {
        badge.textContent = "TOP APPLICANT";
        badge.classList.add("badge-top");
        liHost.classList.add("card-top");
      } else {
        const m = entry.match || "low";
        badge.textContent = m.toUpperCase() + " MATCH";
        badge.classList.add(`badge-${m}`);
        liHost.classList.add(`card-${m}`);
      }
    }


    /* ============================================================
          QUEUE + MARKER + FAB
     ============================================================ */
    window.jobMatchCache = window.jobMatchCache || {};
    window.jobMatchRetries = window.jobMatchRetries || {};
    window.jobMatchMarkerCard = null;

    const queue = [];
    let processingQueue = false;
    let fabBtn = null;
    let fabState = "idle";

    const setFabToIdle = () => {
      fabState = "idle";
      if (!fabBtn) return;
      fabBtn.disabled = false;
      fabBtn.style.background = "#16a34a";
      fabBtn.innerHTML = `📄 Process jobs`;
    };

    const setFabToProcessing = () => {
      fabState = "processing";
      fabBtn.disabled = true;
      fabBtn.style.background = "#f59e0b";
      fabBtn.innerHTML = `⏳ Processing jobs…`;
    };

    const setFabToDone = () => {
      fabState = "done";
      fabBtn.disabled = true;
      fabBtn.style.background = "#d4af37";
      fabBtn.innerHTML = `✅ Processed`;
    };

    const markNewJobsArrived = card => {
      if (!window.jobMatchMarkerCard) {
        window.jobMatchMarkerCard = card;
        console.log("📌 Marker set at:", card.getAttribute("data-job-id"));
      }
      if (fabState === "done") setFabToIdle();
    };


    /* ============================================================
          PROCESS SINGLE CARD
     ============================================================ */
    async function processCard(card) {
      const jobId = card.getAttribute("data-job-id");
      if (!jobId) return;

      if (!window.jobMatchRetries[jobId]) window.jobMatchRetries[jobId] = 0;

      if (
        window.jobMatchCache[jobId] ||
        card.dataset[processedFlag] === "1" ||
        window.jobMatchRetries[jobId] >= MAX_RETRIES
      ) return;

      card.dataset[processedFlag] = "1";

      const cardText = card.innerText || "";
      let isTop = /you(?:'|’|`|â€™)?d be a top applicant/i.test(cardText);

      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.click();

      showSpinner(card);

      await sleep(DELAY_MS);

      if (getTopApplicantFromDetail()) isTop = true;

      let level = getPremiumMatchLevelFromDetail();

      const rhsText =
        document.querySelector("div.jobs-details__main-content")?.innerText || "";

      if (/job match summary not available/i.test(cardText + rhsText)) {
        isTop = false;
        level = "low";
      }

      const isApplied = /take the next step in your job search/i.test(rhsText);

      if (level === "unknown") {
        window.jobMatchRetries[jobId]++;
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

      const entry = { role, match: level, top: isTop, applied: isApplied };
      window.jobMatchCache[jobId] = entry;

      console.log("Processed:", role, level, isTop ? "(TOP)" : "", isApplied ? "(APPLIED)" : "");
      applyBadgeForCard(card, entry);
    }


    function enqueueCard(card) {
      const jobId = card.getAttribute("data-job-id");
      if (!jobId) return;

      if (
        window.jobMatchCache[jobId] ||
        card.dataset[processedFlag] === "1" ||
        queue.includes(card)
      ) return;

      if (!window.jobMatchMarkerCard)
        markNewJobsArrived(card);

      queue.push(card);
    }


    /* ============================================================
         PROCESS QUEUE + LAZY LOAD SUPPORT
     ============================================================ */
    async function processQueue() {
      if (processingQueue) return;
      processingQueue = true;

      startOverlay();
      setFabToProcessing();

      while (queue.length > 0) {
        const card = queue.shift();
        try { await processCard(card); }
        catch (e) { console.error(e); }
      }

      let lastCount = 0;

      while (true) {
        const cardsNow = document.querySelectorAll("div.job-card-container[data-job-id]").length;
        if (cardsNow === lastCount) break;
        lastCount = cardsNow;

        const listRoot =
          document.querySelector(".jobs-search-results-list") ||
          document.querySelector(".jobs-search-results__list") ||
          document.querySelector(".scaffold-layout__list");

        if (listRoot) {
          listRoot.scrollTop = listRoot.scrollHeight;
        } else {
          window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
        }

        await sleep(1500);

        document
          .querySelectorAll("div.job-card-container[data-job-id]")
          .forEach(enqueueCard);

        while (queue.length > 0) {
          const card = queue.shift();
          try { await processCard(card); }
          catch (e) { console.error(e); }
        }
      }

      /* ============================================================
           SCROLL BACK TO MARKER (if exists) OR TOP
       ============================================================ */
      try {
        if (window.jobMatchMarkerCard) {
          console.log("🎯 Returning to marker...");
          window.jobMatchMarkerCard.scrollIntoView({ behavior: "smooth", block: "center" });
          await sleep(400);
        } else {
          smoothScrollToTop(400);
          await sleep(400);
        }

        const listRoot =
          document.querySelector(".jobs-search-results-list") ||
          document.querySelector(".jobs-search-results__list") ||
          document.querySelector(".scaffold-layout__list");

        if (listRoot) listRoot.scrollTop = 0;

        await sleep(100);

        const firstCard =
          window.jobMatchMarkerCard ||
          document.querySelector("div.job-card-container[data-job-id]");

        if (firstCard) {
          firstCard.scrollIntoView({ behavior: "smooth", block: "center" });
          firstCard.click();
        }
      } catch (e) {
        console.error("Error during final scroll:", e);
      }

      stopOverlay();
      setFabToDone();
      window.jobMatchMarkerCard = null;
      processingQueue = false;
    }


    /* ============================================================
         FAB
     ============================================================ */
    function ensureFab() {
      if (document.getElementById("job-match-fab")) {
        fabBtn = document.getElementById("job-match-fab");
        setFabToIdle();
        return;
      }

      fabBtn = document.createElement("button");
      fabBtn.id = "job-match-fab";

      Object.assign(fabBtn.style, {
        position: "fixed",
        zIndex: "9999",
        padding: "10px 20px",
        borderRadius: "9999px",
        background: "#16a34a",
        color: "#fff",
        border: "none",
        fontSize: "13px",
        fontWeight: "600",
        left: "12px",
        top: "60px"
      });

      fabBtn.addEventListener("click", () => {
        if (!processingQueue && fabState === "idle") processQueue();
      });

      document.body.appendChild(fabBtn);
      setFabToIdle();
    }

    /* ============================================================
         OBSERVER + INIT
     ============================================================ */
    ensureStyles();
    ensureOverlay();

    document
      .querySelectorAll("div.job-card-container[data-job-id]")
      .forEach(enqueueCard);

    const listRoot =
      document.querySelector(".jobs-search-results-list") ||
      document.querySelector(".jobs-search-results__list") ||
      document.querySelector(".scaffold-layout__list");

    if (listRoot) {
      const observer = new MutationObserver(mutations => {
        for (const m of mutations) {
          m.addedNodes.forEach(node => {
            if (node.nodeType !== 1) return;

            if (node.matches?.("div.job-card-container[data-job-id]")) {
              enqueueCard(node);
            }

            node
              .querySelectorAll?.("div.job-card-container[data-job-id]")
              .forEach(enqueueCard);
          });
        }
      });

      observer.observe(listRoot, { childList: true, subtree: true });
      window.jobMatchObserver = observer;
    }

    ensureFab();
  }

  startScript();
})();
