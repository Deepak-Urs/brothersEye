(() => {
  /* ============================================================
        AUTO-RESTART (FILTER + PAGINATION ONLY)
        SAFE | DEBOUNCED | NO 429 | NO JOB-ID TRIGGERS
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

    console.log("🔄 URL changed (filters/pagination) → restarting job match script...");
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
        MAIN SCRIPT WRAPPER (RESTARTABLE)
     ============================================================ */
  function startScript() {
    console.log("⚡ Job Match Script INIT");

    window.jobMatchCache = {};
    window.jobMatchRetries = {};

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
        CORE LOGIC
     ============================================================ */
  function initScriptCore() {
    const DELAY_MS = 1200;
    const processedFlag = "jobMatchDone";
    const MAX_RETRIES = 3;

    const sleep = ms => new Promise(res => setTimeout(res, ms));

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
        .card-applied {
          background-color: rgba(37,99,235,0.08) !important;
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

    window.jobMatchCache = window.jobMatchCache || {};
    window.jobMatchRetries = window.jobMatchRetries || {};

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
      fabBtn.innerHTML = `✅ Processed jobs`;
    };

    const markNewJobsArrived = () => {
      if (fabState === "done") setFabToIdle();
    };

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

      queue.push(card);
      markNewJobsArrived();
    }

    /* ============================================================
          PROCESS QUEUE + AUTO-SCROLL FIX
     ============================================================ */
    async function processQueue() {
      if (processingQueue) return;
      processingQueue = true;

      setFabToProcessing();

      while (queue.length > 0) {
        const card = queue.shift();
        try { await processCard(card); }
        catch (e) { console.error("Error processing card:", e); }
      }

      /*
      ============================================================
         AUTO-SCROLL LAZY LIST — FIXED TO SCROLL THE REAL LIST
      ============================================================
      */
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
          listRoot.scrollTop = listRoot.scrollHeight;   // **THE FIX**
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
            RETURN TO TOP (UNCHANGED)
      ============================================================ */
      try {
        window.scrollTo({ top: 0, behavior: "smooth" });

        const listRoot =
          document.querySelector(".jobs-search-results-list") ||
          document.querySelector(".jobs-search-results__list") ||
          document.querySelector(".scaffold-layout__list");

        if (listRoot) listRoot.scrollTop = 0;

        await sleep(800);

        const firstCard = document.querySelector("div.job-card-container[data-job-id]");
        if (firstCard) {
          firstCard.scrollIntoView({ behavior: "smooth", block: "center" });
          firstCard.click();
        }
      } catch (e) {}

      setFabToDone();
      processingQueue = false;
    }

    function ensureFab() {
      if (document.getElementById("job-match-fab")) {
        fabBtn = document.getElementById("job-match-fab");
        setFabToIdle();
        return;
      }

      const listRoot =
        document.querySelector(".jobs-search-results-list") ||
        document.querySelector(".jobs-search-results__list") ||
        document.querySelector(".scaffold-layout__list");

      let anchor =
        listRoot?.closest(".scaffold-layout__list") ||
        listRoot?.parentElement ||
        document.body;

      if (anchor !== document.body && getComputedStyle(anchor).position === "static") {
        anchor.style.position = "relative";
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
        fontWeight: "600"
      });

      function positionButton() {
        const rect = anchor.getBoundingClientRect();
        fabBtn.style.top = Math.max(rect.top + 12, 60) + "px";
        fabBtn.style.left = rect.left + 12 + "px";
      }

      positionButton();
      window.addEventListener("resize", positionButton);
      window.addEventListener("scroll", positionButton);

      fabBtn.addEventListener("click", () => {
        if (!processingQueue && fabState === "idle") processQueue();
      });

      document.body.appendChild(fabBtn);
      setFabToIdle();
    }

    ensureStyles();

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
