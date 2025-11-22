(() => {
  const DELAY_MS = 1200;
  const processedFlag = "jobMatchDone";
  const MAX_RETRIES = 3;

  function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
  }

  /* -------------------------------------------
      NEW: Detect "Top Applicant" from RHS panel
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

    /* --------------------------------------------------
        NEW: Detect Top Applicant from RHS panel ALSO
       -------------------------------------------------- */
    const rhsTop = getTopApplicantFromDetail();
    if (rhsTop) isTop = true;

    let level = getPremiumMatchLevelFromDetail();

    /* ----------------------------------------------------------------
       NEW: If "Job match summary not available" → force LOW, no TOP
       ---------------------------------------------------------------- */
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

  const queue = [];
  let processingQueue = false;

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
    if (!processingQueue) {
      processQueue();
    }
  }

  async function processQueue() {
    processingQueue = true;

    while (queue.length > 0) {
      const card = queue.shift();
      try {
        await processCard(card);
      } catch (e) {
        console.error("Error processing card:", e);
      }
    }

    processingQueue = false;

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
  }

  ensureStyles();
  document.querySelectorAll("div.job-card-container[data-job-id]").forEach(enqueueCard);

  const listRoot =
    document.querySelector(".jobs-search-results-list") ||
    document.querySelector(".jobs-search-results__list") ||
    document.querySelector(".scaffold-layout__list");

  if (listRoot) {
    if (window.jobMatchObserver) window.jobMatchObserver.disconnect();

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

  console.log(
    "Initial cards enqueued. Scroll the left list to load more; they’ll be processed automatically and you’ll be returned to the top when the queue drains."
  );
})();
