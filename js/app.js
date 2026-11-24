/* ═══════════════════════════════════════════════════════════════
   VocabMaster Ultra V3 — app.js
   100% Offline • Pure Decks • Smart Mistakes • 4 Quiz Modes • Bento + Table
   ═══════════════════════════════════════════════════════════════ */

const STORAGE_KEY = "vocabmaster_v3_ultra_store";

// ────────────────────── INITIAL SEED DATA (CLEAN STATE) ──────────────────────
// Fresh slate: Users start with a clean workspace (no pre-loaded folders or words).

// ────────────────────── APPLICATION STATE ──────────────────────
let state = {
  activeUnitId: null, // unit key, "all", or "mistakes"
  units: {},
  mistakes: {},             // { [wordId]: { unitId, streak: 0, addedAt } }
  autoPlayAudio: true,
  explorerView: "cards",    // "cards" | "table"
  contextSentences: []      // [{ text, words, date }]
};

// Pocket Audio Loop runtime
let pocketLoopActive = false;
let pocketLoopTimer = null;
let contextTargetWords = [];

// Session runtime states
let currentMode = "flashcards";
let activeQuizType = "mcq";
let flashcardIndex = 0;
let isCardFlipped = false;

// Arena shared stats
let arenaScore = 0;
let arenaStreak = 0;

// Quiz session lists
let mcqList = [], mcqIndex = 0, mcqScore = 0, mcqTotal = 0, mcqAnswered = false;
let spellList = [], spellIndex = 0, spellScore = 0, spellTotal = 0, spellAnswered = false;
let transList = [], transIndex = 0, transScore = 0, transTotal = 0, transAnswered = false, transHintUsed = false;

// Speed Match runtime
let matchSelectedTile = null;
let matchRemainingPairs = 0;
let matchLocked = false;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ════════════════════════════════════════════════════
//  1. STORAGE & PURE DECKS STATE
// ════════════════════════════════════════════════════

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  let loaded = false;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.units && Object.keys(parsed.units).length > 0) {
        state.units = parsed.units && typeof parsed.units === "object" ? parsed.units : {};
        state.mistakes = parsed.mistakes && typeof parsed.mistakes === "object" ? parsed.mistakes : {};
        state.autoPlayAudio = parsed.autoPlayAudio !== undefined ? parsed.autoPlayAudio : true;
        state.explorerView = parsed.explorerView === "table" ? "table" : "cards";
        state.contextSentences = Array.isArray(parsed.contextSentences) ? parsed.contextSentences : [];

        const keys = Object.keys(state.units);
        if (parsed.activeUnitId === "all" || parsed.activeUnitId === "mistakes" || state.units[parsed.activeUnitId]) {
          state.activeUnitId = parsed.activeUnitId;
        } else {
          state.activeUnitId = keys.length > 0 ? keys[0] : null;
        }
        loaded = true;
      }
    } catch (e) {
      console.error("Failed to parse V3 store:", e);
    }
  }

  if (!loaded) {
    seedInitialState();
    hydrateFromDiskStore();
  }
}

async function hydrateFromDiskStore() {
  try {
    const res = await fetch(`${UPDATER_BASE}/load-store`);
    if (res.ok) {
      const parsed = await res.json();
      if (parsed && parsed.units && typeof parsed.units === "object" && Object.keys(parsed.units).length > 0) {
        state.units = parsed.units;
        state.mistakes = parsed.mistakes && typeof parsed.mistakes === "object" ? parsed.mistakes : {};
        state.autoPlayAudio = parsed.autoPlayAudio !== undefined ? parsed.autoPlayAudio : true;
        state.explorerView = parsed.explorerView === "table" ? "table" : "cards";
        state.contextSentences = Array.isArray(parsed.contextSentences) ? parsed.contextSentences : [];
        const keys = Object.keys(state.units);
        state.activeUnitId = keys.length > 0 ? keys[0] : null;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        renderUnitsToolbar();
        renderExplorer();
        renderFlashcard();
        updateHeaderStats();
        console.log("Successfully hydrated state from disk fallback (vocab_store.json)!");
      }
    }
  } catch (_) {}
}

function seedInitialState() {
  state = {
    activeUnitId: null,
    units: {},
    mistakes: {},
    autoPlayAudio: true,
    explorerView: "cards",
    contextSentences: []
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  updateHeaderStats();
  // Persistent disk backup via local C# API
  try {
    fetch(`${UPDATER_BASE}/save-store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state)
    }).catch(() => {});
  } catch (_) {}
}

// ────────────────────── QUERY HELPERS ──────────────────────

const collapsedUnits = new Set();

function getTopLevelUnits() {
  return Object.values(state.units).filter((u) => !u.parentId || !state.units[u.parentId]);
}

function getChildParts(parentId) {
  return Object.values(state.units).filter((u) => u.parentId === parentId);
}

function getParentUnitId(unitId) {
  const u = state.units[unitId];
  if (u && u.parentId && state.units[u.parentId]) return u.parentId;
  return unitId;
}

function getUnitTotalWordCount(unitId) {
  const u = state.units[unitId];
  if (!u) return 0;
  let total = Array.isArray(u.words) ? u.words.length : 0;
  getChildParts(unitId).forEach((p) => {
    total += Array.isArray(p.words) ? p.words.length : 0;
  });
  return total;
}

function getAllWordsWithUnit() {
  const all = [];
  Object.values(state.units).forEach((u) => {
    const parent = u.parentId && state.units[u.parentId] ? state.units[u.parentId] : null;
    const displayName = parent ? `${parent.name} › ${u.name}` : u.name;
    u.words.forEach((w) => {
      all.push({
        ...w,
        _unitName: displayName,
        _unitId: u.id,
        _isMistake: !!state.mistakes[w.id]
      });
    });
  });
  return all;
}

function getActiveWords() {
  if (state.activeUnitId === "mistakes") {
    const list = [];
    Object.entries(state.mistakes).forEach(([wordId, meta]) => {
      for (const u of Object.values(state.units)) {
        const found = u.words.find((w) => w.id === wordId);
        if (found) {
          const parent = u.parentId && state.units[u.parentId] ? state.units[u.parentId] : null;
          list.push({
            ...found,
            _unitName: parent ? `${parent.name} › ${u.name}` : u.name,
            _unitId: u.id,
            _isMistake: true,
            _mistakeStreak: meta.streak || 0
          });
          break;
        }
      }
    });
    return list;
  }

  if (state.activeUnitId === "all") {
    return getAllWordsWithUnit();
  }

  const currentUnit = state.units[state.activeUnitId];
  if (!currentUnit || !Array.isArray(currentUnit.words)) return [];

  const isTopLevel = !currentUnit.parentId || !state.units[currentUnit.parentId];
  if (isTopLevel) {
    const combined = [];
    currentUnit.words.forEach((w) => {
      combined.push({
        ...w,
        _unitName: currentUnit.name,
        _unitId: currentUnit.id,
        _isMistake: !!state.mistakes[w.id]
      });
    });
    getChildParts(currentUnit.id).forEach((part) => {
      part.words.forEach((w) => {
        combined.push({
          ...w,
          _unitName: `${currentUnit.name} › ${part.name}`,
          _unitId: part.id,
          _isMistake: !!state.mistakes[w.id]
        });
      });
    });
    return combined;
  }

  const parent = state.units[currentUnit.parentId];
  const displayName = parent ? `${parent.name} › ${currentUnit.name}` : currentUnit.name;
  return currentUnit.words.map((w) => ({
    ...w,
    _unitName: displayName,
    _unitId: currentUnit.id,
    _isMistake: !!state.mistakes[w.id]
  }));
}

function getActiveUnitName() {
  if (state.activeUnitId === "mistakes") return "⚠️ Mistakes / Review";
  if (state.activeUnitId === "all") return "All Units";
  const u = state.units[state.activeUnitId];
  if (!u) return "No Unit";
  if (u.parentId && state.units[u.parentId]) {
    return `${state.units[u.parentId].name} › ${u.name}`;
  }
  return u.name;
}

function getFirstAvailableUnitId() {
  const keys = Object.keys(state.units);
  return keys.length > 0 ? keys[0] : null;
}

function getMistakesCount() {
  return Object.keys(state.mistakes).filter((id) => findWordRef(id) !== null).length;
}

function findWordRef(wordId) {
  for (const [uId, uObj] of Object.entries(state.units)) {
    const wordObj = uObj.words.find((w) => w.id === wordId);
    if (wordObj) return { wordObj, unitId: uId, unitName: uObj.name };
  }
  return null;
}

// ════════════════════════════════════════════════════
//  2. SMART MISTAKES SYSTEM (AUTO-CAPTURE & GRADUATION)
// ════════════════════════════════════════════════════

function recordMistake(wordId, unitId, silent = false) {
  const ref = findWordRef(wordId);
  if (!ref) return;

  const isNew = !state.mistakes[wordId];
  state.mistakes[wordId] = {
    unitId: unitId || ref.unitId,
    streak: 0,
    addedAt: isNew ? Date.now() : state.mistakes[wordId].addedAt
  };

  saveState();
  renderUnitsToolbar();

  if (!silent && isNew) {
    toast(`⚠️ Added "${ref.wordObj.word}" to Mistakes deck`, "warning");
  }
}

function recordSuccess(wordId, isEasyRating = false) {
  if (!wordId || !state.mistakes[wordId]) return;
  const ref = findWordRef(wordId);
  const wordLabel = ref ? ref.wordObj.word : "Word";

  if (isEasyRating) {
    delete state.mistakes[wordId];
    saveState();
    renderUnitsToolbar();
    toast(`🎉 Mastered! "${wordLabel}" graduated from Mistakes`, "success");
    return;
  }

  const entry = state.mistakes[wordId];
  entry.streak = (entry.streak || 0) + 1;

  if (entry.streak >= 2) {
    delete state.mistakes[wordId];
    saveState();
    renderUnitsToolbar();
    toast(`🎉 2x Correct! "${wordLabel}" graduated from Mistakes`, "success");
  } else {
    saveState();
    renderUnitsToolbar();
    toast(`👍 Good! "${wordLabel}" streak: ${entry.streak}/2 to graduate`, "info");
  }
}

function toggleManualMistake(wordId) {
  const ref = findWordRef(wordId);
  if (!ref) return;

  if (state.mistakes[wordId]) {
    delete state.mistakes[wordId];
    toast(`Removed "${ref.wordObj.word}" from Mistakes`, "info");
  } else {
    state.mistakes[wordId] = { unitId: ref.unitId, streak: 0, addedAt: Date.now() };
    toast(`⚠️ Marked "${ref.wordObj.word}" for Mistakes review`, "warning");
  }
  saveState();
  renderUnitsToolbar();
  renderExplorer();
  if (currentMode === "flashcards") renderFlashcard();
}

function clearAllMistakes() {
  const count = getMistakesCount();
  if (count === 0) return toast("Mistakes deck is already empty!", "info");
  if (!confirm(`Clear all ${count} words from the Mistakes deck?`)) return;

  state.mistakes = {};
  flashcardIndex = 0;
  saveState();
  renderUnitsToolbar();

  if (state.activeUnitId === "mistakes") {
    if (currentMode === "flashcards") renderFlashcard();
    else if (currentMode === "quiz") startActiveQuiz();
    else renderExplorer();
  } else {
    renderExplorer();
  }
  toast("🧹 All recorded mistakes cleared!", "info");
}

// ════════════════════════════════════════════════════
//  3. HEADER STATS & UNITS TOOLBAR
// ════════════════════════════════════════════════════

function updateHeaderStats() {
  const activeWords = getActiveWords();
  const allWords = getAllWordsWithUnit();
  const mistakesCount = getMistakesCount();

  $("#statUnitCount").textContent = activeWords.length;
  $("#statTotalCount").textContent = allWords.length;
  $("#statMistakesCount").textContent = mistakesCount;

  const avg = activeWords.length
    ? Math.round(activeWords.reduce((s, w) => s + (w.mastery || 0), 0) / activeWords.length)
    : 0;
  $("#statMastery").textContent = `${avg}%`;

  const currentName = getActiveUnitName();
  const fcBadge = $("#flashcardUnitName");
  if (fcBadge) fcBadge.textContent = currentName;
  const badgeWrap = $("#activeUnitBadgeWrap");
  if (badgeWrap) badgeWrap.classList.toggle("mistakes-mode", state.activeUnitId === "mistakes");

  const quizBadge = $("#quizUnitName");
  if (quizBadge) quizBadge.textContent = currentName;
  const arenaLabel = $("#quizArenaDeckLabel");
  if (arenaLabel) arenaLabel.textContent = currentName;

  const isMistakes = state.activeUnitId === "mistakes";
  const tableTag = $("#tableDeckTag");
  if (tableTag) {
    tableTag.textContent = currentName;
    tableTag.classList.toggle("mistakes-mode", isMistakes);
  }
  const bulkTarget = $("#bulkTargetUnitName");
  if (bulkTarget) {
    if (isMistakes || state.activeUnitId === "all") {
      const fallbackUnitId = getFirstAvailableUnitId();
      bulkTarget.textContent = (fallbackUnitId && state.units[fallbackUnitId]) ? state.units[fallbackUnitId].name : "Select Unit";
    } else {
      bulkTarget.textContent = currentName;
    }
  }

  // Hide New Vocabulary Entry & Batch Import when in Mistakes!
  const manageAddGrid = $("#manageAddGrid") || document.querySelector(".manage-grid");
  const mistakesBanner = $("#mistakesHeaderBanner");
  if (manageAddGrid) {
    manageAddGrid.style.display = isMistakes ? "none" : "";
  }
  if (mistakesBanner) {
    mistakesBanner.style.display = isMistakes ? "flex" : "none";
  }
}

function renderUnitsToolbar() {
  const container = $("#unitsTabList");
  container.innerHTML = "";

  // 1. Only Top-Level Units in Sidebar ("Your folders")
  getTopLevelUnits().forEach((unit) => {
    const parts = getChildParts(unit.id);
    const totalCount = getUnitTotalWordCount(unit.id);
    const isUnitActive = state.activeUnitId === unit.id;
    const isChildActive = parts.some((p) => p.id === state.activeUnitId);

    const group = document.createElement("div");
    group.className = `sidebar-unit-group ${isUnitActive ? "active" : ""} ${isChildActive ? "child-active" : ""}`;

    const btn = document.createElement("button");
    btn.className = `sidebar-item sidebar-unit-item ${isUnitActive ? "active" : isChildActive ? "child-active" : ""}`;
    btn.title = unit.name;
    btn.setAttribute("data-tooltip", `${unit.name} (${totalCount})`);
    const folderIconSvg = `
      <svg class="nav-svg-icon unit-folder-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
      </svg>
    `;
    btn.innerHTML = `
      <span class="nav-icon unit-folder-icon-wrap">${folderIconSvg}</span>
      <span class="nav-label">${escapeHTML(unit.name)}</span>
      <span class="sidebar-count-pill">${totalCount}</span>
    `;
    btn.addEventListener("click", () => {
      selectUnit(unit.id);
      closeMobileSidebar();
    });
    if (parts.length > 0) {
      const row = document.createElement("div");
      row.className = "sidebar-unit-row";

      const isExpanded = !collapsedUnits.has(unit.id);
      const chevron = document.createElement("button");
      chevron.className = `unit-chevron ${isExpanded ? "expanded" : ""}`;
      chevron.setAttribute("aria-label", "Toggle folder");
      chevron.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      `;
      chevron.addEventListener("click", (e) => {
        e.stopPropagation();
        const outer = group.querySelector(".sidebar-unit-parts-outer");
        if (collapsedUnits.has(unit.id)) {
          collapsedUnits.delete(unit.id);
          chevron.classList.add("expanded");
          if (outer) outer.classList.remove("collapsed-parts");
        } else {
          collapsedUnits.add(unit.id);
          chevron.classList.remove("expanded");
          if (outer) outer.classList.add("collapsed-parts");
        }
      });

      row.appendChild(chevron);
      row.appendChild(btn);
      group.appendChild(row);

      const partsOuter = document.createElement("div");
      partsOuter.className = `sidebar-unit-parts-outer ${isExpanded ? "" : "collapsed-parts"}`;
      const partsInner = document.createElement("div");
      partsInner.className = "sidebar-unit-parts-inner";

      const partsWrap = document.createElement("div");
      const activePartIndex = parts.findIndex((p) => p.id === state.activeUnitId);
      partsWrap.className = `sidebar-unit-parts ${isChildActive ? "has-active-child" : ""}`;
      if (activePartIndex !== -1) {
        const reachPx = activePartIndex * 38 + 20;
        partsWrap.style.setProperty("--active-part-reach", `${reachPx}px`);
        partsWrap.dataset.activePartIndex = activePartIndex;
      }

      parts.forEach((part, index) => {
        const isPartActive = state.activeUnitId === part.id;
        const pBtn = document.createElement("button");
        pBtn.className = `sidebar-item sidebar-part-item ${isPartActive ? "active" : ""}`;
        pBtn.title = part.name;
        pBtn.dataset.partIndex = index;
        pBtn.innerHTML = `
          <span class="sidebar-part-dot"></span>
          <span class="nav-label">${escapeHTML(part.name)}</span>
          <span class="sidebar-count-pill">${part.words.length}</span>
        `;
        pBtn.addEventListener("click", () => {
          selectUnit(part.id);
          closeMobileSidebar();
        });
        partsWrap.appendChild(pBtn);
      });

      const addPartBtn = document.createElement("button");
      addPartBtn.className = "sidebar-add-part-btn";
      addPartBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        <span>Add Part</span>
      `;
      addPartBtn.addEventListener("click", () => createNewPart(unit.id));
      partsWrap.appendChild(addPartBtn);

      partsInner.appendChild(partsWrap);
      partsOuter.appendChild(partsInner);
      group.appendChild(partsOuter);
    } else {
      group.appendChild(btn);
    }

    container.appendChild(group);
  });

  // 2. Permanent Smart Mistakes & All Units sidebar buttons
  const mistakesCount = getMistakesCount();
  const totalAll = getAllWordsWithUnit().length;
  const sideMistakes = $("#side-mistakes");
  const sideAll = $("#side-all");
  if (sideMistakes) {
    sideMistakes.classList.toggle("active", state.activeUnitId === "mistakes");
    const mCountEl = $("#sideMistakesCount");
    if (mCountEl) mCountEl.textContent = mistakesCount;
  }
  if (sideAll) {
    sideAll.classList.toggle("active", state.activeUnitId === "all");
    const aCountEl = $("#sideAllCount");
    if (aCountEl) aCountEl.textContent = totalAll;
  }

  // 3. Header active deck title
  const headerTitleEl = $("#headerActiveUnitTitle");
  if (headerTitleEl) {
    headerTitleEl.textContent = getActiveUnitName();
  }

  // 4. Unit Parts Bar (below header when active unit or its parent has parts)
  const activeParentId =
    state.activeUnitId === "all" || state.activeUnitId === "mistakes"
      ? null
      : getParentUnitId(state.activeUnitId);
  renderUnitPartsBar(activeParentId);

  // Action buttons visibility
  const normalActions = $("#unitsActionsNormal");
  const mistakesActions = $("#unitsActionsMistakes");
  if (state.activeUnitId === "mistakes") {
    normalActions.classList.add("hidden");
    mistakesActions.classList.remove("hidden");
  } else {
    normalActions.classList.remove("hidden");
    mistakesActions.classList.add("hidden");
    const isAll = state.activeUnitId === "all";
    const hasActiveUnit = !!state.units[state.activeUnitId];
    const addPartHeaderBtn = $("#btnAddPartToUnit");
    if (addPartHeaderBtn) addPartHeaderBtn.style.display = isAll || !hasActiveUnit ? "none" : "inline-flex";
    if ($("#btnRenameActiveUnit")) $("#btnRenameActiveUnit").style.display = isAll || !hasActiveUnit ? "none" : "inline-flex";
    if ($("#btnClearActiveUnitWords")) $("#btnClearActiveUnitWords").style.display = isAll || !hasActiveUnit ? "none" : "inline-flex";
    if ($("#btnDeleteActiveUnit")) $("#btnDeleteActiveUnit").style.display = isAll || !hasActiveUnit ? "none" : "inline-flex";
    const isPart = !!(state.units[state.activeUnitId] && state.units[state.activeUnitId].parentId);
    const delSpan = $("#btnDeleteActiveUnit span");
    if (delSpan) delSpan.textContent = isPart ? "Delete Part" : "Delete Unit";
  }

  populateAddWordUnitSelect();
  populateBulkUnitSelect();
}

function renderUnitPartsBar(parentId) {
  const bar = $("#unitPartsBar");
  if (!bar) return;

  if (!parentId || state.activeUnitId === "all" || state.activeUnitId === "mistakes") {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }

  const parentUnit = state.units[parentId];
  const parts = getChildParts(parentId);
  if (!parentUnit || parts.length === 0) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }

  bar.classList.remove("hidden");
  bar.innerHTML = `<span class="parts-bar-label">${escapeHTML(parentUnit.name)}:</span>`;

  const allPartPill = document.createElement("button");
  allPartPill.className = `part-pill ${state.activeUnitId === parentUnit.id ? "active" : ""}`;
  allPartPill.innerHTML = `<span>All Parts</span><span class="part-pill-count">(${getUnitTotalWordCount(parentUnit.id)})</span>`;
  allPartPill.addEventListener("click", () => selectUnit(parentUnit.id));
  bar.appendChild(allPartPill);

  parts.forEach((part) => {
    const pill = document.createElement("button");
    pill.className = `part-pill ${state.activeUnitId === part.id ? "active" : ""}`;
    pill.innerHTML = `<span>${escapeHTML(part.name)}</span><span class="part-pill-count">(${part.words.length})</span>`;
    pill.addEventListener("click", () => selectUnit(part.id));
    bar.appendChild(pill);
  });

  const addBtn = document.createElement("button");
  addBtn.className = "part-pill add-part";
  addBtn.textContent = "+ Add Part";
  addBtn.addEventListener("click", () => createNewPart(parentUnit.id));
  bar.appendChild(addBtn);
}

function closeMobileSidebar() {
  const sidebar = $("#appSidebar");
  const backdrop = $("#sidebarBackdrop");
  if (sidebar) sidebar.classList.remove("mobile-open");
  if (backdrop) backdrop.classList.remove("open");
}

let activeExplorerFolder = null;

function selectUnit(unitId) {
  state.activeUnitId = unitId;
  activeExplorerFolder = null;
  flashcardIndex = 0;
  saveState();
  renderUnitsToolbar();
  renderFlashcard();
  if (currentMode === "quiz") startActiveQuiz();
  else if (currentMode === "manage") renderExplorer();
  toast(`📂 Switched to: ${getActiveUnitName()}`, unitId === "mistakes" ? "warning" : "info");
}

let unitModalCallback = null;

function openUnitDialog({ title, subtitle, defaultValue = "", placeholder = "", onConfirm }) {
  const backdrop = $("#unitModalBackdrop");
  const titleEl = $("#unitModalTitle");
  const subEl = $("#unitModalSub");
  const inputEl = $("#unitModalInput");
  if (!backdrop || !inputEl) return;

  titleEl.textContent = title;
  subEl.textContent = subtitle;
  inputEl.value = defaultValue;
  inputEl.placeholder = placeholder;
  unitModalCallback = onConfirm;

  backdrop.classList.remove("hidden");
  setTimeout(() => {
    inputEl.focus();
    inputEl.select();
  }, 40);
}

function closeUnitDialog() {
  const backdrop = $("#unitModalBackdrop");
  if (backdrop) backdrop.classList.add("hidden");
  unitModalCallback = null;
}

function createNewUnit() {
  openUnitDialog({
    title: "Create New Unit",
    subtitle: "Organize a new vocabulary deck / folder",
    placeholder: "e.g. Unit 1, Business Vocab...",
    onConfirm: (clean) => {
      const unitKey = "unit_" + Date.now().toString(36);
      state.units[unitKey] = { id: unitKey, name: clean, createdAt: Date.now(), words: [] };
      state.activeUnitId = unitKey;
      flashcardIndex = 0;
      saveState();
      renderUnitsToolbar();
      renderExplorer();
      renderFlashcard();
      toast(`✅ Created unit "${clean}"`, "success");
    }
  });
}

function renameActiveUnit() {
  if (state.activeUnitId === "all" || state.activeUnitId === "mistakes") {
    return toast("⚠️ Select a specific unit to rename", "error");
  }
  const unit = state.units[state.activeUnitId];
  if (!unit) return;

  openUnitDialog({
    title: "Rename Folder",
    subtitle: `Current name: ${unit.name}`,
    defaultValue: unit.name,
    placeholder: "Enter new name...",
    onConfirm: (clean) => {
      unit.name = clean;
      saveState();
      renderUnitsToolbar();
      renderExplorer();
      updateHeaderStats();
      toast(`✏️ Renamed to "${unit.name}"`, "success");
    }
  });
}

function createNewPart(parentId) {
  const targetParentId = getParentUnitId(parentId || state.activeUnitId);
  const parentUnit = state.units[targetParentId];
  if (!parentUnit) return toast("⚠️ Select a unit first to add a part inside it", "error");

  const nextNum = getChildParts(targetParentId).length + 1;
  openUnitDialog({
    title: `Add Part to ${parentUnit.name}`,
    subtitle: "Create a sub-deck inside this unit",
    defaultValue: `Part ${nextNum}`,
    placeholder: `e.g. Part ${nextNum}, Lesson 1-2`,
    onConfirm: (clean) => {
      const partKey = "part_" + Date.now().toString(36);
      state.units[partKey] = {
        id: partKey,
        name: clean,
        parentId: targetParentId,
        createdAt: Date.now(),
        words: []
      };
      collapsedUnits.delete(targetParentId);
      state.activeUnitId = partKey;
      flashcardIndex = 0;
      saveState();
      renderUnitsToolbar();
      renderExplorer();
      renderFlashcard();
      toast(`✅ Added "${clean}" inside "${parentUnit.name}"`, "success");
    }
  });
}

function clearActiveUnitWords() {
  if (state.activeUnitId === "all" || state.activeUnitId === "mistakes") return;
  const unit = state.units[state.activeUnitId];
  if (!unit) return;
  const parts = !unit.parentId ? getChildParts(unit.id) : [];
  const totalCount = unit.words.length + parts.reduce((acc, p) => acc + p.words.length, 0);
  if (totalCount === 0) return toast("This unit is already empty!", "info");
  if (!confirm(`Clear all ${totalCount} words in "${getActiveUnitName()}"?\nThe unit structure will remain.`)) return;

  unit.words.forEach((w) => delete state.mistakes[w.id]);
  unit.words = [];
  parts.forEach((p) => {
    p.words.forEach((w) => delete state.mistakes[w.id]);
    p.words = [];
  });
  flashcardIndex = 0;
  saveState();
  renderUnitsToolbar();
  renderExplorer();
  renderFlashcard();
  toast(`🧹 Cleared words in "${unit.name}"`, "info");
}

function deleteActiveUnit() {
  if (state.activeUnitId === "all" || state.activeUnitId === "mistakes") return;
  const unit = state.units[state.activeUnitId];
  if (!unit) return;

  if (unit.parentId && state.units[unit.parentId]) {
    const parentId = unit.parentId;
    if (!confirm(`Delete part "${unit.name}" (${unit.words.length} words) from "${state.units[parentId].name}"?`)) return;
    unit.words.forEach((w) => delete state.mistakes[w.id]);
    delete state.units[state.activeUnitId];
    state.activeUnitId = parentId;
  } else {
    const parts = getChildParts(unit.id);
    const totalCount = getUnitTotalWordCount(unit.id);
    const extra = parts.length > 0 ? ` and its ${parts.length} parts` : "";
    if (!confirm(`Permanently delete "${unit.name}"${extra} (${totalCount} words)?`)) return;

    unit.words.forEach((w) => delete state.mistakes[w.id]);
    parts.forEach((p) => {
      p.words.forEach((w) => delete state.mistakes[w.id]);
      delete state.units[p.id];
    });
    delete state.units[state.activeUnitId];
    state.activeUnitId = getFirstAvailableUnitId();
  }

  flashcardIndex = 0;
  saveState();
  renderUnitsToolbar();
  renderExplorer();
  renderFlashcard();
  toast(`🗑️ Deleted "${unit.name}"`, "error");
}

function populateAddWordUnitSelect() {
  const unitSel = $("#inputTargetUnit");
  const partSel = $("#inputTargetPart");
  const hiddenSel = $("#inputUnitSelect");
  
  // Fallback if older single select exists
  if (!unitSel || !partSel) {
    const sel = $("#inputUnitSelect");
    if (!sel) return;
    sel.innerHTML = "";
    getTopLevelUnits().forEach((u) => {
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = `${u.name} (${u.words.length} words)`;
      sel.appendChild(opt);
      getChildParts(u.id).forEach((p) => {
        const pOpt = document.createElement("option");
        pOpt.value = p.id;
        pOpt.textContent = `  ↳ ${u.name} › ${p.name} (${p.words.length} words)`;
        sel.appendChild(pOpt);
      });
    });
    return;
  }

  const topUnits = getTopLevelUnits();
  if (topUnits.length === 0) {
    unitSel.innerHTML = "<option value=''>No Units</option>";
    partSel.innerHTML = "<option value=''>No Parts</option>";
    if (hiddenSel) hiddenSel.value = "";
    return;
  }

  // 1. Determine active Unit and Part defaults based on current state
  let defaultUnitId = topUnits[0].id;
  let defaultPartId = "";

  if (state.activeUnitId && state.activeUnitId !== "all" && state.activeUnitId !== "mistakes" && state.units[state.activeUnitId]) {
    const activeUnit = state.units[state.activeUnitId];
    if (activeUnit.parentId && state.units[activeUnit.parentId]) {
      defaultUnitId = activeUnit.parentId;
      defaultPartId = activeUnit.id;
    } else {
      defaultUnitId = activeUnit.id;
    }
  }

  // Preserve user's selection if they already selected another unit
  const currentSelectedUnit = unitSel.value;
  const targetUnitId = (currentSelectedUnit && state.units[currentSelectedUnit]) ? currentSelectedUnit : defaultUnitId;

  // 2. Populate Unit Dropdown
  unitSel.innerHTML = "";
  topUnits.forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u.id;
    const totalWords = getUnitTotalWordCount(u.id);
    opt.textContent = `${u.name} (${totalWords} words)`;
    if (u.id === targetUnitId) opt.selected = true;
    unitSel.appendChild(opt);
  });

  // 3. Populate Parts Dropdown based on the selected Unit
  function updatePartsForUnit(selectedUnitId, preferredPartId) {
    partSel.innerHTML = "";
    const parentUnit = state.units[selectedUnitId];
    const childParts = getChildParts(selectedUnitId);

    if (childParts.length > 0) {
      childParts.forEach((p, idx) => {
        const pOpt = document.createElement("option");
        pOpt.value = p.id;
        pOpt.textContent = `${p.name} (${p.words.length} words)`;
        if (preferredPartId && p.id === preferredPartId) {
          pOpt.selected = true;
        } else if (!preferredPartId && idx === 0) {
          pOpt.selected = true;
        }
        partSel.appendChild(pOpt);
      });

      // Also allow targeting the parent main container if desired
      const mainOpt = document.createElement("option");
      mainOpt.value = selectedUnitId;
      mainOpt.textContent = `📁 ${parentUnit ? parentUnit.name : 'Main'} (Main Deck - ${parentUnit ? parentUnit.words.length : 0} words)`;
      if (preferredPartId === selectedUnitId) mainOpt.selected = true;
      partSel.appendChild(mainOpt);
    } else {
      // No parts exist yet for this unit
      const opt = document.createElement("option");
      opt.value = selectedUnitId;
      opt.textContent = `${parentUnit ? parentUnit.name : 'Main'} (${parentUnit ? parentUnit.words.length : 0} words)`;
      opt.selected = true;
      partSel.appendChild(opt);
    }

    // Sync effective target ID
    const effectiveId = partSel.value || selectedUnitId;
    if (hiddenSel) hiddenSel.value = effectiveId;
  }

  // Populate parts initially
  updatePartsForUnit(unitSel.value, defaultPartId);

  // Hook change events cleanly
  unitSel.onchange = () => {
    updatePartsForUnit(unitSel.value, null);
  };

  partSel.onchange = () => {
    if (hiddenSel) hiddenSel.value = partSel.value || unitSel.value;
  };
}

function populateBulkUnitSelect() {
  const unitSel = $("#selBulkUnit");
  const partSel = $("#selBulkPart");
  const targetBadge = $("#bulkTargetUnitName");
  if (!unitSel || !partSel) return;

  const topUnits = getTopLevelUnits();
  if (topUnits.length === 0) {
    unitSel.innerHTML = "<option value=''>No Units</option>";
    partSel.innerHTML = "<option value=''>No Parts</option>";
    if (targetBadge) targetBadge.textContent = "—";
    return;
  }

  let defaultUnitId = topUnits[0].id;
  let defaultPartId = "";

  if (state.activeUnitId && state.activeUnitId !== "all" && state.activeUnitId !== "mistakes" && state.units[state.activeUnitId]) {
    const activeUnit = state.units[state.activeUnitId];
    if (activeUnit.parentId && state.units[activeUnit.parentId]) {
      defaultUnitId = activeUnit.parentId;
      defaultPartId = activeUnit.id;
    } else {
      defaultUnitId = activeUnit.id;
    }
  }

  const currentSelectedUnit = unitSel.value;
  const targetUnitId = (currentSelectedUnit && state.units[currentSelectedUnit]) ? currentSelectedUnit : defaultUnitId;

  unitSel.innerHTML = "";
  topUnits.forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u.id;
    const totalWords = getUnitTotalWordCount(u.id);
    opt.textContent = `${u.name} (${totalWords} words)`;
    if (u.id === targetUnitId) opt.selected = true;
    unitSel.appendChild(opt);
  });

  function updateBulkPartsForUnit(selectedUnitId, preferredPartId) {
    partSel.innerHTML = "";
    const parentUnit = state.units[selectedUnitId];
    const childParts = getChildParts(selectedUnitId);

    if (childParts.length > 0) {
      childParts.forEach((p, idx) => {
        const pOpt = document.createElement("option");
        pOpt.value = p.id;
        pOpt.textContent = `${p.name} (${p.words.length} words)`;
        if (preferredPartId && p.id === preferredPartId) {
          pOpt.selected = true;
        } else if (!preferredPartId && idx === 0) {
          pOpt.selected = true;
        }
        partSel.appendChild(pOpt);
      });

      const mainOpt = document.createElement("option");
      mainOpt.value = selectedUnitId;
      mainOpt.textContent = `📁 ${parentUnit ? parentUnit.name : 'Main'} (Main Deck)`;
      if (preferredPartId === selectedUnitId) mainOpt.selected = true;
      partSel.appendChild(mainOpt);
    } else {
      const opt = document.createElement("option");
      opt.value = selectedUnitId;
      opt.textContent = `${parentUnit ? parentUnit.name : 'Main'} (${parentUnit ? parentUnit.words.length : 0} words)`;
      opt.selected = true;
      partSel.appendChild(opt);
    }

    syncBulkTargetBadge();
  }

  function syncBulkTargetBadge() {
    if (!targetBadge) return;
    const effectiveId = partSel.value || unitSel.value;
    const unitObj = state.units[effectiveId];
    targetBadge.textContent = unitObj ? unitObj.name : "—";
  }

  updateBulkPartsForUnit(unitSel.value, defaultPartId);

  unitSel.onchange = () => {
    updateBulkPartsForUnit(unitSel.value, null);
  };

  partSel.onchange = () => {
    syncBulkTargetBadge();
  };
}

// ════════════════════════════════════════════════════
//  4. FLASHCARDS STUDIO (3D CARD + AUTO-VOICE + DECK QUEUE)
// ════════════════════════════════════════════════════

function updateAutoAudioUI() {
  const label = $("#autoAudioLabel");
  const btn = $("#btnAutoAudio");
  if (label) label.textContent = state.autoPlayAudio ? "ON" : "OFF";
  if (btn) btn.classList.toggle("voice-off", !state.autoPlayAudio);
}

function toggleAutoPlayAudio() {
  state.autoPlayAudio = !state.autoPlayAudio;
  saveState();
  updateAutoAudioUI();
  toast(`🔊 Auto-Voice is now ${state.autoPlayAudio ? "ON" : "OFF"}`, "info");
}

function shuffleFlashcards() {
  if (state.activeUnitId === "all" || state.activeUnitId === "mistakes") {
    return toast("⚠️ Select a specific unit to shuffle its order", "warning");
  }
  const unit = state.units[state.activeUnitId];
  if (!unit || unit.words.length < 2) return toast("Need at least 2 words to shuffle", "info");

  unit.words = shuffle(unit.words);
  flashcardIndex = 0;
  saveState();
  renderFlashcard();
  toast("🔀 Cards shuffled!", "info");
}

function renderFlashcard() {
  const words = getActiveWords();
  updateAutoAudioUI();

  isCardFlipped = false;
  const cardBody = $("#cardBody");
  if (cardBody) {
    cardBody.classList.remove("flipped");
    cardBody.style.transform = "";
  }
  $("#queueCountBadge").textContent = `${words.length} Words`;

  if (words.length === 0) {
    if (state.activeUnitId === "mistakes") {
      $("#cardWord").textContent = "No Mistakes! 🎉";
      $("#cardType").textContent = "ALL CLEAR";
      $("#cardMeaning").textContent = "لا توجد أخطاء حالياً — ممتاز!";
      $("#exampleEn").textContent = "You have cleared all mistakes in this review deck.";
      $("#exampleAr").textContent = "لقد أتقنت جميع الكلمات الخاطئة.";
    } else {
      $("#cardWord").textContent = "Empty Unit";
      $("#cardType").textContent = "INFO";
      $("#cardMeaning").textContent = "Add words or import JSON to start";
      $("#exampleEn").textContent = "No cards in this unit yet.";
      $("#exampleAr").textContent = "لا توجد بطاقات في هذه الوحدة.";
    }
    $("#cardWordSmall").textContent = "—";
    $("#cardMasteryBadge").textContent = "0% Mastery";
    $("#fcMistakeIndicator").classList.add("hidden");
    $("#progressFill").style.width = "0%";
    $("#progressText").textContent = "0 / 0 Mastered (0%)";
    $("#cardCounter").textContent = "Card 0 of 0";
    renderDeckQueue([]);
    return;
  }

  if (flashcardIndex < 0) flashcardIndex = words.length - 1;
  if (flashcardIndex >= words.length) flashcardIndex = 0;

  const current = words[flashcardIndex];

  $("#cardWord").textContent = current.word;
  $("#cardWordSmall").textContent = current.word;
  $("#cardType").textContent = (current.type || "word").toUpperCase();
  $("#cardMasteryBadge").textContent = `${current.mastery || 0}% Mastery`;
  $("#cardMeaning").textContent = current.meaning;
  $("#exampleEn").textContent = current.example ? `"${current.example}"` : `"Practice makes ${current.word} permanent."`;
  $("#exampleAr").textContent = current.exampleAr ? `"${current.exampleAr}"` : "";

  $("#fcMistakeIndicator").classList.toggle("hidden", !current._isMistake);

  const masteredCount = words.filter((w) => (w.mastery || 0) >= 80).length;
  const pct = Math.round((masteredCount / words.length) * 100);
  $("#progressFill").style.width = `${pct}%`;
  $("#progressText").textContent = `${masteredCount} / ${words.length} Mastered (${pct}%)`;
  $("#cardCounter").textContent = `Card ${flashcardIndex + 1} of ${words.length}`;

  renderDeckQueue(words);
}

function renderDeckQueue(words) {
  const container = $("#fcMiniQueue");
  container.innerHTML = "";

  if (words.length === 0) {
    container.innerHTML = `<div style="text-align:center;color:var(--text-secondary);font-size:0.78rem;padding:40px 10px;">No words in this deck.</div>`;
    return;
  }

  words.forEach((w, idx) => {
    const m = w.mastery || 0;
    const dotClass = m >= 80 ? "high" : m >= 40 ? "mid" : "low";
    const isActive = idx === flashcardIndex;

    const item = document.createElement("div");
    item.className = `queue-item ${isActive ? "active" : ""}`;
    item.innerHTML = `
      <div class="queue-item-left">
        <span class="queue-dot ${dotClass}"></span>
        <div class="queue-text">
          <div class="queue-word">${escapeHTML(w.word)} ${w._isMistake ? "⚠️" : ""}</div>
          <div class="queue-meaning">${escapeHTML(w.meaning)}</div>
        </div>
      </div>
      <div class="queue-item-right">
        <span class="queue-pct">${m}%</span>
        <button class="queue-speak-btn" title="Speak">🔊</button>
      </div>
    `;

    item.addEventListener("click", () => {
      flashcardIndex = idx;
      renderFlashcard();
      if (state.autoPlayAudio) playSpeech(w.word);
    });

    item.querySelector(".queue-speak-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      playSpeech(w.word);
    });

    container.appendChild(item);
  });

  const activeEl = container.querySelector(".queue-item.active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function flipFlashcard() {
  const words = getActiveWords();
  if (words.length === 0) return;
  isCardFlipped = !isCardFlipped;
  const cardBody = $("#cardBody");
  if (cardBody) {
    cardBody.style.transition = "transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)";
    cardBody.classList.toggle("flipped", isCardFlipped);
    cardBody.style.transform = isCardFlipped ? "rotateY(180deg)" : "rotateY(0deg)";
  }
  if (isCardFlipped && state.autoPlayAudio) {
    playSpeech(words[flashcardIndex].word);
  }
}

function navigateCard(delta) {
  const words = getActiveWords();
  if (words.length === 0) return;
  flashcardIndex = (flashcardIndex + delta + words.length) % words.length;
  renderFlashcard();
  if (state.autoPlayAudio) {
    const newWords = getActiveWords();
    if (newWords[flashcardIndex]) playSpeech(newWords[flashcardIndex].word);
  }
}

function rateFlashcard(rating) {
  const words = getActiveWords();
  if (words.length === 0) return;

  const current = words[flashcardIndex];
  const ref = findWordRef(current.id);
  if (ref) {
    if (rating === "hard") {
      ref.wordObj.mastery = Math.max(0, (ref.wordObj.mastery || 0) - 15);
      recordMistake(current.id, ref.unitId, false);
    } else if (rating === "good") {
      ref.wordObj.mastery = Math.min(100, (ref.wordObj.mastery || 0) + 15);
      toast(`🤔 Good! "${current.word}" +15% mastery`, "info");
    } else if (rating === "easy") {
      ref.wordObj.mastery = Math.min(100, (ref.wordObj.mastery || 0) + 30);
      if (state.mistakes[current.id]) {
        recordSuccess(current.id, true);
      } else {
        toast(`😎 Easy! "${current.word}" +30% mastery`, "success");
      }
    }
    saveState();
  }

  navigateCard(1);
}

function playSpeech(text, rate = 0.88) {
  if (!text || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'en-US';
  utter.rate = rate;

  const speakerStage = document.getElementById("speakerStage");
  if (speakerStage) {
    speakerStage.classList.add("is-speaking");
    utter.onend = () => speakerStage.classList.remove("is-speaking");
    utter.onerror = () => speakerStage.classList.remove("is-speaking");
  }

  window.speechSynthesis.speak(utter);
}

// ── Pocket Audio Loop (Hands-free Flashcards) ──
function stopPocketLoop() {
  pocketLoopActive = false;
  clearTimeout(pocketLoopTimer);
  const lbl = $("#pocketLoopLabel");
  const btn = $("#btnPocketLoop");
  if (lbl) lbl.textContent = "OFF";
  if (btn) btn.classList.remove("pocket-active");
}

function togglePocketLoop() {
  if (pocketLoopActive) {
    stopPocketLoop();
    toast("⏹ Pocket Loop stopped", "info");
    return;
  }
  const words = getActiveWords();
  if (words.length === 0) return toast("⚠️ Add words to this deck first!", "warning");

  pocketLoopActive = true;
  const lbl = $("#pocketLoopLabel");
  const btn = $("#btnPocketLoop");
  if (lbl) lbl.textContent = "ON";
  if (btn) btn.classList.add("pocket-active");
  toast("🎧 Pocket Loop started — hands-free audio review!", "success");
  runPocketLoopStep();
}

function runPocketLoopStep() {
  if (!pocketLoopActive) return;
  const words = getActiveWords();
  if (!words.length) return stopPocketLoop();

  isCardFlipped = false;
  const cb1 = $("#cardBody");
  if (cb1) {
    cb1.classList.remove("flipped");
    cb1.style.transform = "rotateY(0deg)";
  }
  const current = words[flashcardIndex];
  playSpeech(current.word, 0.9);

  pocketLoopTimer = setTimeout(() => {
    if (!pocketLoopActive) return;
    isCardFlipped = true;
    const cb2 = $("#cardBody");
    if (cb2) {
      cb2.classList.add("flipped");
      cb2.style.transform = "rotateY(180deg)";
    }
    if (current.example) playSpeech(current.example, 0.9);

    pocketLoopTimer = setTimeout(() => {
      if (!pocketLoopActive) return;
      flashcardIndex = (flashcardIndex + 1) % words.length;
      renderFlashcard();
      runPocketLoopStep();
    }, 3600);
  }, 2600);
}

// ── Active Context Builder (Signature Feature) ──
function rollContextTargetWords() {
  const pool = getActiveWords().length >= 3 ? getActiveWords() : getAllWordsWithUnit();
  const input = $("#contextSentenceInput");
  if (input) input.value = "";
  const backdrop = $("#contextHighlightBackdrop");
  if (backdrop) backdrop.innerHTML = "";

  if (pool.length < 3) {
    contextTargetWords = pool;
  } else {
    contextTargetWords = shuffle([...pool]).slice(0, 3);
  }
  renderContextBuilder();
}

function renderContextBuilder() {
  const chipsRow = $("#contextChipsRow");
  const statusLbl = $("#contextStatusLabel");
  const circle = $("#contextCountCircle");
  const input = $("#contextSentenceInput");
  if (!chipsRow) return;

  if (contextTargetWords.length === 0) {
    chipsRow.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--text-secondary);padding:24px;">Add at least 3 words to your deck to start the Context Builder!</div>`;
    if (statusLbl) statusLbl.textContent = "/ 3 Words Connected";
    if (circle) {
      circle.textContent = "0";
      circle.classList.remove("all-done");
    }
    renderSavedContextSentences();
    return;
  }

  const rawText = input ? input.value : "";
  const typed = rawText.toLowerCase();
  let matchedCount = 0;

  chipsRow.innerHTML = "";
  contextTargetWords.forEach((w, idx) => {
    const cleanWord = w.word.toLowerCase().trim();
    const stem = cleanWord.length > 4 ? cleanWord.slice(0, cleanWord.length - 1) : cleanWord;
    const isMatched = typed.includes(cleanWord) || (stem.length >= 4 && typed.includes(stem));
    if (isMatched) matchedCount++;

    const wrap = document.createElement("div");
    wrap.className = "context-card-wrapper";
    wrap.innerHTML = `
      <div class="context-card-status ${isMatched ? "completed" : "pending"}">
        Card ${idx + 1} (${isMatched ? "Completed" : "Pending"})
      </div>
      <div class="context-word-chip ${isMatched ? "matched" : ""}">
        <span class="cyber-notch top-notch"></span>
        <span class="cyber-notch bottom-notch"></span>
        ${isMatched ? '<span class="card-check-badge">✓</span>' : ""}
        <div class="context-chip-en">${escapeHTML(w.word)}</div>
        <div class="context-chip-ar">${escapeHTML(w.meaning)}</div>
      </div>
    `;
    chipsRow.appendChild(wrap);
  });

  if (circle) {
    circle.textContent = matchedCount;
    if (matchedCount === contextTargetWords.length && matchedCount > 0) {
      circle.classList.add("all-done");
    } else {
      circle.classList.remove("all-done");
    }
  }

  if (statusLbl) {
    statusLbl.textContent = `/ ${contextTargetWords.length} Words Connected`;
  }

  // Update live inline keyword highlighting in the editor backdrop!
  updateEditorHighlight(rawText);

  renderSavedContextSentences();
}

function updateEditorHighlight(rawText) {
  const backdrop = $("#contextHighlightBackdrop");
  if (!backdrop) return;
  if (!rawText || contextTargetWords.length === 0) {
    backdrop.innerHTML = "";
    return;
  }

  let safe = escapeHTML(rawText);
  contextTargetWords.forEach((w) => {
    const wordClean = w.word.trim();
    if (!wordClean) return;
    const stem = wordClean.length > 4 ? wordClean.slice(0, wordClean.length - 1) : wordClean;
    const patStr = `\\b(${escapeRegex(wordClean)}|${escapeRegex(stem)}[a-zA-Z]*)\\b`;
    try {
      const pattern = new RegExp(patStr, "gi");
      safe = safe.replace(pattern, '<mark class="ctx-match">$1</mark>');
    } catch (_) {}
  });

  if (safe.endsWith("\n")) safe += " ";
  backdrop.innerHTML = safe;
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function saveContextBuilderSentence() {
  const input = $("#contextSentenceInput");
  if (!input) return;
  const text = input.value.trim();
  if (text.length < 8) {
    return toast("⚠️ Write a complete English sentence first!", "warning");
  }
  if (contextTargetWords.length === 0) return;

  // Boost mastery for matched target words
  const lower = text.toLowerCase();
  let boosted = 0;
  contextTargetWords.forEach((w) => {
    const ref = findWordRef(w.id);
    if (ref && lower.includes(w.word.toLowerCase().slice(0, Math.max(3, w.word.length - 1)))) {
      ref.wordObj.mastery = Math.min(100, (ref.wordObj.mastery || 0) + 15);
      boosted++;
    }
  });

  state.contextSentences.unshift({
    text,
    words: contextTargetWords.map((w) => w.word),
    date: new Date().toLocaleDateString()
  });

  saveState();
  toast(`⚡ Connected! Boosted mastery for ${boosted} word(s) (+15% XP)!`, "success");
  rollContextTargetWords();
}

function renderSavedContextSentences() {
  const box = $("#savedSentencesBox");
  if (!box) return;
  if (!state.contextSentences || state.contextSentences.length === 0) {
    box.innerHTML = `<div style="font-size:0.8rem;color:var(--text-secondary);">No saved sentences yet. Write your first sentence above!</div>`;
    return;
  }

  box.innerHTML = `<div style="font-size:0.78rem;font-weight:800;color:var(--accent-cyan);text-transform:uppercase;letter-spacing:0.06em;">📝 Your Saved Context Sentences</div>` +
    state.contextSentences.slice(0, 8).map((s) => `
      <div class="saved-sentence-card">
        <div class="saved-sentence-text">"${escapeHTML(s.text)}"</div>
        <div class="saved-sentence-meta">Words: ${s.words.map(escapeHTML).join(" • ")} • ${escapeHTML(s.date || "")}</div>
      </div>
    `).join("");
}

// ════════════════════════════════════════════════════
//  5. PRACTICE ARENA (4 MODES: MCQ, TRANSLATE, SPELLING, SPEED MATCH)
// ════════════════════════════════════════════════════

function updateArenaHeader(progressText) {
  $("#arenaStreak").textContent = `🔥 ${arenaStreak} Streak`;
  $("#arenaScore").textContent = `✅ Score: ${arenaScore}`;
  $("#quizArenaProgress").textContent = progressText;
}

function handleQuizAttempt(wordObj, isCorrect) {
  const ref = findWordRef(wordObj.id);
  if (isCorrect) {
    arenaScore += 10;
    arenaStreak++;
    if (ref) {
      ref.wordObj.mastery = Math.min(100, (ref.wordObj.mastery || 0) + 10);
      saveState();
    }
    recordSuccess(wordObj.id, false);
  } else {
    arenaStreak = 0;
    if (ref) {
      ref.wordObj.mastery = Math.max(0, (ref.wordObj.mastery || 0) - 10);
      saveState();
    }
    recordMistake(wordObj.id, wordObj._unitId, false);
  }
  updateArenaHeader($("#quizArenaProgress").textContent);
}

function startActiveQuiz() {
  if (activeQuizType === "mcq") startMcqQuiz();
  else if (activeQuizType === "translate") startTranslateQuiz();
  else if (activeQuizType === "spelling") startSpellingQuiz();
  else if (activeQuizType === "match") startMatchGame();
}

// ── 5A. Multiple Choice ──
function startMcqQuiz() {
  const words = getActiveWords();
  if (words.length < 2) {
    $("#mcqWordType").textContent = "INFO";
    $("#mcqQuestion").textContent = state.activeUnitId === "mistakes" && words.length === 0
      ? "🎉 No mistakes recorded! Great job!"
      : "Need at least 2 words in this deck to start MCQ!";
    $("#mcqOptions").innerHTML = "";
    $("#btnNextMcq").style.display = "none";
    $("#mcqScore").textContent = "0 / 0 Correct";
    updateArenaHeader("Waiting for words");
    return;
  }
  mcqList = shuffle([...words]);
  mcqIndex = 0;
  mcqScore = 0;
  mcqTotal = 0;
  mcqAnswered = false;
  showMcqQuestion();
}

function showMcqQuestion() {
  if (mcqIndex >= mcqList.length) {
    $("#mcqWordType").textContent = "DONE";
    $("#mcqQuestion").textContent = `🎉 Round Complete! ${mcqScore} / ${mcqTotal} Correct`;
    $("#mcqOptions").innerHTML = "";
    $("#btnNextMcq").style.display = "none";
    updateArenaHeader("Round finished");
    return;
  }

  mcqAnswered = false;
  $("#btnNextMcq").style.display = "none";
  const current = mcqList[mcqIndex];

  $("#mcqWordType").textContent = (current.type || "Word").toUpperCase();
  $("#mcqQuestion").textContent = current.meaning;
  updateArenaHeader(`Question ${mcqIndex + 1} of ${mcqList.length}`);

  const pool = getActiveWords().length >= 4 ? getActiveWords() : getAllWordsWithUnit();
  const distractors = shuffle(pool.filter((w) => w.word.toLowerCase() !== current.word.toLowerCase()))
    .slice(0, 3)
    .map((w) => w.word);

  const options = shuffle([current.word, ...distractors]);
  const container = $("#mcqOptions");
  container.innerHTML = "";

  options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.className = "mcq-opt";
    btn.textContent = opt;
    btn.addEventListener("click", () => handleMcqSelection(btn, opt, current));
    container.appendChild(btn);
  });

  $("#mcqScore").textContent = `${mcqScore} / ${mcqTotal} Correct`;
}

function handleMcqSelection(btn, chosen, current) {
  if (mcqAnswered) return;
  mcqAnswered = true;
  mcqTotal++;

  $$(".mcq-opt").forEach((b) => b.classList.add("disabled"));
  playSpeech(current.word);

  const isCorrect = chosen === current.word;
  if (isCorrect) {
    btn.classList.add("correct");
    mcqScore++;
  } else {
    btn.classList.add("wrong");
    $$(".mcq-opt").forEach((b) => {
      if (b.textContent === current.word) b.classList.add("correct");
    });
  }

  handleQuizAttempt(current, isCorrect);
  $("#mcqScore").textContent = `${mcqScore} / ${mcqTotal} Correct`;
  $("#btnNextMcq").style.display = "inline-block";
}

// ── 5B. Translate (AR ➔ EN) ──
function startTranslateQuiz() {
  const words = getActiveWords();
  if (words.length === 0) {
    $("#translateType").textContent = "INFO";
    $("#translateQuestion").textContent = state.activeUnitId === "mistakes"
      ? "🎉 No mistakes recorded! Great job!"
      : "Add words to this deck first!";
    $("#translateInput").style.display = "none";
    $("#btnCheckTranslate").style.display = "none";
    $("#btnTranslateHint").style.display = "none";
    $("#btnTranslateListen").classList.add("hide");
    $("#btnNextTranslate").style.display = "none";
    $("#translateHintDisplay").classList.add("hidden");
    $("#translateFeedback").textContent = "";
    $("#translateExampleFeedback").textContent = "";
    $("#translateScore").textContent = "0 / 0 Correct";
    updateArenaHeader("Waiting for words");
    return;
  }
  transList = shuffle([...words]);
  transIndex = 0;
  transScore = 0;
  transTotal = 0;
  transAnswered = false;
  showTranslateQuestion();
}

function showTranslateQuestion() {
  if (transIndex >= transList.length) {
    $("#translateType").textContent = "DONE";
    $("#translateQuestion").textContent = `🎉 Round Complete! ${transScore} / ${transTotal} Correct`;
    $("#translateInput").style.display = "none";
    $("#btnCheckTranslate").style.display = "none";
    $("#btnTranslateHint").style.display = "none";
    $("#btnTranslateListen").classList.add("hide");
    $("#btnNextTranslate").style.display = "none";
    $("#translateHintDisplay").classList.add("hidden");
    $("#translateFeedback").textContent = "";
    $("#translateExampleFeedback").textContent = "";
    updateArenaHeader("Round finished");
    return;
  }

  transAnswered = false;
  transHintUsed = false;

  $("#translateInput").style.display = "";
  $("#btnCheckTranslate").style.display = "";
  $("#btnTranslateHint").style.display = "";
  $("#btnTranslateListen").classList.add("hide");
  $("#btnNextTranslate").style.display = "none";
  $("#translateHintDisplay").classList.add("hidden");
  $("#translateFeedback").textContent = "";
  $("#translateFeedback").className = "spelling-feedback";
  $("#translateExampleFeedback").textContent = "";

  const input = $("#translateInput");
  input.value = "";
  input.focus();

  const current = transList[transIndex];
  $("#translateType").textContent = (current.type || "Word").toUpperCase();
  $("#translateQuestion").textContent = current.meaning;
  $("#translateScore").textContent = `${transScore} / ${transTotal} Correct`;
  updateArenaHeader(`Question ${transIndex + 1} of ${transList.length}`);
}

function checkTranslateAnswer() {
  if (transAnswered || transIndex >= transList.length) return;
  transAnswered = true;
  transTotal++;

  const current = transList[transIndex];
  const userAns = $("#translateInput").value.trim().toLowerCase();
  const isCorrect = userAns === current.word.trim().toLowerCase();

  playSpeech(current.word);

  if (isCorrect) {
    transScore++;
    $("#translateFeedback").textContent = `✅ Spot on! (${current.word})`;
    $("#translateFeedback").className = "spelling-feedback correct";
  } else {
    $("#translateFeedback").textContent = `❌ Incorrect! Correct answer: ${current.word}`;
    $("#translateFeedback").className = "spelling-feedback wrong";
  }

  if (current.example) {
    $("#translateExampleFeedback").textContent = `"${current.example}"`;
  }

  handleQuizAttempt(current, isCorrect);
  $("#btnTranslateListen").classList.remove("hide");
  $("#translateScore").textContent = `${transScore} / ${transTotal} Correct`;
  $("#btnNextTranslate").style.display = "inline-block";
}

function provideTranslateHint() {
  if (transAnswered || transIndex >= transList.length) return;
  const w = transList[transIndex].word.trim();
  const hint = w.slice(0, Math.min(2, w.length)) + "_".repeat(Math.max(1, w.length - 2)) + ` (${w.length} letters)`;
  const el = $("#translateHintDisplay");
  el.textContent = `Hint: ${hint}`;
  el.classList.remove("hidden");

  if (!transHintUsed) {
    transHintUsed = true;
    $("#translateInput").value = w.charAt(0);
    $("#translateInput").focus();
  }
}

// ── 5C. Audio Spelling (Cyber-Acoustic 3D Studio) ──
function renderSpellingProgress() {
  const track = $("#spellingDotTrack");
  const countLabel = $("#spellingIndexLabel");
  const streakCount = $("#spellingStreakCount");
  const accuracyVal = $("#spellingAccuracyVal");

  if (countLabel) {
    const currentQ = spellList.length > 0 ? Math.min(spellIndex + 1, spellList.length) : 0;
    countLabel.textContent = `${currentQ} of ${spellList.length}`;
  }

  if (streakCount) {
    streakCount.textContent = arenaStreak;
  }

  if (accuracyVal) {
    const acc = spellTotal === 0 ? 100 : Math.round((spellScore / spellTotal) * 100);
    accuracyVal.textContent = `${acc}%`;
  }

  if (track && spellList.length > 0) {
    const totalDots = Math.min(spellList.length, 12);
    let html = "";
    for (let i = 0; i < totalDots; i++) {
      let cls = "spelling-dot";
      if (i < spellIndex) cls += " completed";
      else if (i === spellIndex) cls += " active";
      html += `<span class="${cls}"></span>`;
    }
    track.innerHTML = html;
  }
}

function startSpellingQuiz() {
  const words = getActiveWords();
  const inputWrap = document.querySelector(".spelling-input-wrap");
  const shortcuts = document.querySelector(".spelling-shortcut-hints");
  const stage = $("#speakerStage");

  if (words.length === 0) {
    $("#spellingHint").textContent = state.activeUnitId === "mistakes"
      ? "🎉 No mistakes recorded! Great job!"
      : "Add words to this deck first!";
    if (inputWrap) inputWrap.style.display = "none";
    if (shortcuts) shortcuts.style.display = "none";
    if (stage) stage.style.display = "none";
    $("#btnNextSpelling").style.display = "none";
    $("#spellingFeedback").textContent = "";
    $("#spellingScore").textContent = "0 / 0 Correct";
    renderSpellingProgress();
    updateArenaHeader("Waiting for words");
    return;
  }

  if (inputWrap) inputWrap.style.display = "";
  if (shortcuts) shortcuts.style.display = "";
  if (stage) stage.style.display = "";

  spellList = shuffle([...words]);
  spellIndex = 0;
  spellScore = 0;
  spellTotal = 0;
  spellAnswered = false;
  showSpellingQuestion();
}

function showSpellingQuestion() {
  const inputWrap = document.querySelector(".spelling-input-wrap");
  const shortcuts = document.querySelector(".spelling-shortcut-hints");
  const stage = $("#speakerStage");

  if (spellIndex >= spellList.length) {
    $("#spellingHint").textContent = `🎉 Spelling Test Complete! ${spellScore} / ${spellTotal} Correct`;
    if (inputWrap) inputWrap.style.display = "none";
    if (shortcuts) shortcuts.style.display = "none";
    if (stage) stage.style.display = "none";
    $("#btnNextSpelling").style.display = "none";
    $("#spellingFeedback").textContent = "";
    renderSpellingProgress();
    updateArenaHeader("Round finished");
    return;
  }

  spellAnswered = false;
  if (inputWrap) inputWrap.style.display = "";
  if (shortcuts) shortcuts.style.display = "";
  if (stage) stage.style.display = "";
  $("#btnNextSpelling").style.display = "none";
  $("#spellingFeedback").textContent = "";
  $("#spellingFeedback").className = "spelling-feedback";

  const input = $("#spellingInput");
  input.value = "";
  input.focus();

  const current = spellList[spellIndex];
  $("#spellingHint").textContent = current.meaning;
  $("#spellingScore").textContent = `${spellScore} / ${spellTotal} Correct`;
  renderSpellingProgress();
  updateArenaHeader(`Question ${spellIndex + 1} of ${spellList.length}`);

  playSpeech(current.word);
}

function checkSpellingAnswer() {
  if (spellAnswered || spellIndex >= spellList.length) return;
  spellAnswered = true;
  spellTotal++;

  const current = spellList[spellIndex];
  const userAns = $("#spellingInput").value.trim().toLowerCase();
  const isCorrect = userAns === current.word.trim().toLowerCase();

  if (isCorrect) {
    spellScore++;
    $("#spellingFeedback").textContent = `✅ Perfect spelling! (${current.word})`;
    $("#spellingFeedback").className = "spelling-feedback correct";
  } else {
    $("#spellingFeedback").textContent = `❌ Incorrect! Correct spelling: ${current.word}`;
    $("#spellingFeedback").className = "spelling-feedback wrong";
  }

  handleQuizAttempt(current, isCorrect);
  $("#spellingScore").textContent = `${spellScore} / ${spellTotal} Correct`;
  renderSpellingProgress();
  $("#btnNextSpelling").style.display = "inline-block";
}

// ── 5D. Speed Match Game (6 Pairs = 12 Tiles) ──
function startMatchGame() {
  const words = getActiveWords();
  const grid = $("#matchGridBox");
  grid.innerHTML = "";
  matchSelectedTile = null;
  matchLocked = false;

  if (words.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--text-secondary);padding:36px;">${
      state.activeUnitId === "mistakes" ? "🎉 No mistakes recorded! Great job!" : "Add words to play Speed Match!"
    }</div>`;
    updateArenaHeader("Waiting for words");
    return;
  }

  const subset = shuffle([...words]).slice(0, 6);
  matchRemainingPairs = subset.length;
  updateArenaHeader(`${matchRemainingPairs} pairs left`);

  const tiles = [];
  subset.forEach((w) => {
    tiles.push({ id: w.id, unitId: w._unitId, text: w.word, lang: "en", wordObj: w });
    tiles.push({ id: w.id, unitId: w._unitId, text: w.meaning, lang: "ar", wordObj: w });
  });

  shuffle(tiles).forEach((t) => {
    const btn = document.createElement("button");
    btn.className = `match-tile ${t.lang === "ar" ? "ar-tile" : ""}`;
    btn.textContent = t.text;
    btn.addEventListener("click", () => handleMatchClick(btn, t));
    grid.appendChild(btn);
  });
}

function handleMatchClick(btn, tile) {
  if (btn.disabled || matchLocked) return;
  if (tile.lang === "en") playSpeech(tile.text);

  if (!matchSelectedTile) {
    matchSelectedTile = { btn, tile };
    btn.classList.add("selected");
    return;
  }

  if (matchSelectedTile.btn === btn) {
    btn.classList.remove("selected");
    matchSelectedTile = null;
    return;
  }

  const first = matchSelectedTile;
  matchSelectedTile = null;
  first.btn.classList.remove("selected");

  const isMatch = first.tile.id === tile.id && first.tile.lang !== tile.lang;

  if (isMatch) {
    btn.disabled = true;
    first.btn.disabled = true;
    btn.classList.add("matched");
    first.btn.classList.add("matched");
    handleQuizAttempt(tile.wordObj, true);
    matchRemainingPairs--;
    updateArenaHeader(`${matchRemainingPairs} pairs left`);

    if (matchRemainingPairs === 0) {
      toast("🎉 Board Cleared! +Bonus!", "success");
      setTimeout(() => startMatchGame(), 950);
    }
  } else {
    matchLocked = true;
    btn.classList.add("wrong-flash");
    first.btn.classList.add("wrong-flash");

    const targetWordObj = tile.lang === "en" ? tile.wordObj : first.tile.wordObj;
    handleQuizAttempt(targetWordObj, false);

    setTimeout(() => {
      btn.classList.remove("wrong-flash");
      first.btn.classList.remove("wrong-flash");
      matchLocked = false;
    }, 550);
  }
}

// ════════════════════════════════════════════════════
//  6. WORD MANAGER (ADD, BULK, IMPORT/EXPORT, BENTO + TABLE EXPLORER)
// ════════════════════════════════════════════════════

function addSingleWord(wordText, type, meaning, example, exampleAr, targetUnitId) {
  const unitId = targetUnitId || (state.activeUnitId === "all" || state.activeUnitId === "mistakes" ? getFirstAvailableUnitId() : state.activeUnitId);
  const unit = state.units[unitId];
  if (!unit) return toast("⚠️ Please create a unit / folder first (+ New Unit)!", "error");

  const newWord = {
    id: "w_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
    word: wordText.trim(),
    type: type || "Noun",
    meaning: meaning.trim(),
    example: example ? example.trim() : "",
    exampleAr: exampleAr ? exampleAr.trim() : "",
    mastery: 0
  };

  unit.words.push(newWord);
  saveState();
  renderUnitsToolbar();
  renderExplorer();
  renderFlashcard();
  toast(`✅ Added "${newWord.word}" to "${unit.name}"`, "success");
}

function deleteWord(wordId, unitId) {
  const unit = state.units[unitId];
  if (!unit) return;

  delete state.mistakes[wordId];
  unit.words = unit.words.filter((w) => w.id !== wordId);
  saveState();
  renderUnitsToolbar();
  renderExplorer();
  renderFlashcard();
  toast("🗑️ Word deleted", "info");
}

function handleBulkAdd(text) {
  if (!text || !text.trim()) return toast("Paste words using format: word = meaning", "error");

  const selectedPart = $("#selBulkPart") && $("#selBulkPart").value;
  const selectedUnit = $("#selBulkUnit") && $("#selBulkUnit").value;
  const targetUnitId = selectedPart || selectedUnit || (state.activeUnitId === "all" || state.activeUnitId === "mistakes" ? getFirstAvailableUnitId() : state.activeUnitId);
  const unit = state.units[targetUnitId];
  if (!unit) return toast("⚠️ Please create a unit / folder first (+ New Unit)!", "error");

  let count = 0;
  text.split("\n").forEach((line) => {
    if (!line.includes("=")) return;
    const parts = line.split("=");
    const w = parts[0].trim();
    const m = parts.slice(1).join("=").trim();
    if (w && m) {
      unit.words.push({
        id: "w_" + Date.now().toString(36) + "_" + count + "_" + Math.random().toString(36).slice(2, 5),
        word: w,
        type: "Noun",
        meaning: m,
        example: "",
        exampleAr: "",
        mastery: 0
      });
      count++;
    }
  });

  if (count > 0) {
    $("#bulkInput").value = "";
    saveState();
    renderUnitsToolbar();
    renderExplorer();
    renderFlashcard();
    populateAddWordUnitSelect();
  populateBulkUnitSelect();
    populateBulkUnitSelect();
    toast(`📥 Added ${count} words to "${unit.name}"`, "success");
  } else {
    toast("No lines matched the format: word = meaning", "error");
  }
}

function handleStrictJsonImport(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const text = e.target.result;
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (e) {}

      // 1. Full Database Backup Restore (e.g. VocabMaster_V3_Backup_*.json)
      if (parsed && parsed.units && typeof parsed.units === "object" && Object.keys(parsed.units).length > 0) {
        state.units = parsed.units;
        if (parsed.mistakes && typeof parsed.mistakes === "object") {
          state.mistakes = parsed.mistakes;
        }
        const keys = Object.keys(state.units);
        state.activeUnitId = keys.length > 0 ? keys[0] : null;
        saveState();
        renderUnitsToolbar();
        renderExplorer();
        renderFlashcard();
        const totalWords = getAllWordsWithUnit().length;
        return toast(`✅ Full Backup Restored! Loaded ${keys.length} units & ${totalWords} words!`, "success");
      }

      // 2. Single Unit or List Import
      let incoming = [];
      if (Array.isArray(parsed)) {
        incoming = parsed;
      } else if (parsed && Array.isArray(parsed.words)) {
        incoming = parsed.words;
      } else {
        // Fallback: Parse plain text lines (word = meaning or word - meaning)
        text.split("\n").forEach((line) => {
          let delimiter = line.includes("=") ? "=" : line.includes("-") ? "-" : line.includes(":") ? ":" : null;
          if (delimiter) {
            const parts = line.split(delimiter);
            const w = parts[0].trim();
            const m = parts.slice(1).join(delimiter).trim();
            if (w && m) {
              incoming.push({ word: w, meaning: m, type: "Noun" });
            }
          }
        });
      }

      const valid = incoming
        .filter((w) => w && (w.word || w.Word) && (w.meaning || w.Meaning))
        .map((w, idx) => ({
          id: "w_" + Date.now().toString(36) + "_" + idx + "_" + Math.random().toString(36).slice(2, 5),
          word: (w.word || w.Word).trim(),
          type: w.type || w.Type || "Noun",
          meaning: (w.meaning || w.Meaning).trim(),
          example: (w.example || w.Example || "").trim(),
          exampleAr: (w.exampleAr || w.example_ar || w.ExampleAr || "").trim(),
          mastery: typeof w.mastery === "number" ? w.mastery : 0
        }));

      if (valid.length === 0) throw new Error("No valid words found in file");

      // Auto-target or auto-create unit
      let targetUnit = state.units[state.activeUnitId];
      if (!targetUnit || state.activeUnitId === "all" || state.activeUnitId === "mistakes") {
        const firstId = getFirstAvailableUnitId();
        targetUnit = state.units[firstId];
      }
      if (!targetUnit) {
        const uName = (parsed && parsed.unitName) ? parsed.unitName : "Imported Unit";
        const uKey = "unit_" + Date.now().toString(36);
        state.units[uKey] = { id: uKey, name: uName, createdAt: Date.now(), words: [] };
        state.activeUnitId = uKey;
        targetUnit = state.units[uKey];
      }

      targetUnit.words.push(...valid);
      saveState();
      renderUnitsToolbar();
      renderExplorer();
      renderFlashcard();
      toast(`📂 Successfully imported ${valid.length} words into "${targetUnit.name}"!`, "success");
    } catch (err) {
      toast("❌ Import error: " + err.message, "error");
    }
  };
  reader.readAsText(file);
}

function exportActiveUnit() {
  if (state.activeUnitId === "all") return exportAllData();
  const words = getActiveWords();
  const name = getActiveUnitName().replace(/[^a-zA-Z0-9_-]+/g, "_");
  const payload = {
    unitName: getActiveUnitName(),
    exportedAt: new Date().toISOString(),
    totalWords: words.length,
    words: words.map(({ _unitName, _unitId, _isMistake, _mistakeStreak, ...clean }) => clean)
  };
  downloadJsonFile(payload, `VocabMaster_${name}.json`);
  toast(`📤 Exported "${getActiveUnitName()}"`, "success");
}

function exportAllData() {
  const payload = {
    app: "VocabMaster_Ultra_V3",
    version: "3.0",
    exportedAt: new Date().toISOString(),
    units: state.units,
    mistakes: state.mistakes
  };
  downloadJsonFile(payload, `VocabMaster_V3_Backup_${new Date().toISOString().slice(0, 10)}.json`);
  toast("💾 Exported full backup for all units!", "success");
}

function downloadJsonFile(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function resetAllData() {
  if (!confirm("⚠️ Warning: Delete all custom units and words and reset to default?")) return;
  if (!confirm("Final Confirmation: All local data in V3 will be wiped.")) return;

  localStorage.removeItem(STORAGE_KEY);
  seedInitialState();
  renderUnitsToolbar();
  renderExplorer();
  renderFlashcard();
  toast("🔄 Reset all data to default", "info");
}

function getSmartFiller(word, type) {
  const t = {
    Noun: { en: `The ${word.toLowerCase()} played a crucial role in our progress.`, ar: `لعب/لعبت ${word.toLowerCase()} دوراً حاسماً في تقدمنا.` },
    Verb: { en: `She was able to ${word.toLowerCase()} without hesitation.`, ar: `تمكنت من أن ${word.toLowerCase()} دون تردد.` },
    Adjective: { en: `This strategy produced a truly ${word.toLowerCase()} outcome.`, ar: `أنتجت هذه الاستراتيجية نتيجة ${word.toLowerCase()} حقاً.` },
    Adverb: { en: `The task was executed ${word.toLowerCase()} by the team.`, ar: `تم تنفيذ المهمة ${word.toLowerCase()} بواسطة الفريق.` },
    Phrase: { en: `It is always wise to ${word.toLowerCase()} in daily life.`, ar: `من الحكمة دائماً ${word.toLowerCase()} في الحياة اليومية.` },
    Other: { en: `Here is an example demonstrating "${word}".`, ar: `مثال يوضح استخدام "${word}".` }
  };
  return t[type] || t.Other;
}

// ────────────────────── DUAL WORD EXPLORER (BENTO CARDS + TABLE) ──────────────────────

function setExplorerView(view) {
  state.explorerView = view;
  saveState();
  $("#btnViewCards").classList.toggle("active", view === "cards");
  $("#btnViewTable").classList.toggle("active", view === "table");
  $("#wordCardsGrid").classList.toggle("hidden", view !== "cards");
  $("#wordlistScrollBox").classList.toggle("hidden", view !== "table");
  renderExplorer();
}

function getFilteredExplorerList() {
  const scope = $("#listScopeFilter").value;
  const masteryFilter = $("#filterMastery").value;
  const search = $("#searchInput").value.trim().toLowerCase();

  let list = [];
  if (scope === "mistakes" || (scope === "active" && state.activeUnitId === "mistakes")) {
    list = getAllWordsWithUnit().filter((w) => !!state.mistakes[w.id]);
  } else if (scope === "all" || (scope === "active" && state.activeUnitId === "all")) {
    list = getAllWordsWithUnit();
  } else if (activeExplorerFolder && activeExplorerFolder !== "__all__") {
    const targetId = activeExplorerFolder === "__main__" ? state.activeUnitId : activeExplorerFolder;
    const targetUnit = state.units[targetId];
    if (targetUnit && Array.isArray(targetUnit.words)) {
      const parent = targetUnit.parentId && state.units[targetUnit.parentId] ? state.units[targetUnit.parentId] : null;
      const displayName = parent ? `${parent.name} › ${targetUnit.name}` : targetUnit.name;
      list = targetUnit.words.map((w) => ({
        ...w,
        _unitName: displayName,
        _unitId: targetUnit.id,
        _isMistake: !!state.mistakes[w.id]
      }));
    }
  } else {
    list = getActiveWords();
  }

  if (masteryFilter === "low") list = list.filter((w) => (w.mastery || 0) < 40);
  else if (masteryFilter === "mid") list = list.filter((w) => (w.mastery || 0) >= 40 && (w.mastery || 0) < 80);
  else if (masteryFilter === "high") list = list.filter((w) => (w.mastery || 0) >= 80);

  if (search) {
    list = list.filter((w) =>
      w.word.toLowerCase().includes(search) ||
      w.meaning.toLowerCase().includes(search) ||
      (w.type || "").toLowerCase().includes(search)
    );
  }

  return list;
}

function renderExplorerFolders(unit) {
  const foldersGrid = $("#explorerFoldersGrid");
  const breadcrumb = $("#explorerBreadcrumb");
  const cardsGrid = $("#wordCardsGrid");
  const tableBox = $("#wordlistScrollBox");
  const emptyEl = $("#emptyMsg");

  breadcrumb.classList.add("hidden");
  cardsGrid.classList.add("hidden");
  tableBox.classList.add("hidden");
  emptyEl.style.display = "none";
  foldersGrid.classList.remove("hidden");
  foldersGrid.innerHTML = "";

  const parts = getChildParts(unit.id);
  const totalUnitWords = getUnitTotalWordCount(unit.id);
  $("#listCount").textContent = totalUnitWords;

  const calcAvgMastery = (words) => {
    if (!words || words.length === 0) return 0;
    return Math.round(words.reduce((sum, w) => sum + (w.mastery || 0), 0) / words.length);
  };

  // 1. Sub-folders (Parts inside the unit)
  parts.forEach((part) => {
    const avg = calcAvgMastery(part.words);
    const card = document.createElement("button");
    card.className = "explorer-folder-card";
    card.innerHTML = `
      <div class="folder-card-top">
        <svg class="folder-card-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
        <span class="folder-card-count">${part.words.length} words</span>
      </div>
      <div class="folder-card-title">${escapeHTML(part.name)}</div>
      <div class="folder-card-meta">Avg Mastery: ${avg}% • Click to open words</div>
    `;
    card.addEventListener("click", () => {
      activeExplorerFolder = part.id;
      renderExplorer();
    });
    foldersGrid.appendChild(card);
  });

  // 2. Main/Direct words folder (if unit has direct words OR no parts yet)
  if (unit.words.length > 0 || parts.length === 0) {
    const avg = calcAvgMastery(unit.words);
    const mainCard = document.createElement("button");
    mainCard.className = "explorer-folder-card";
    mainCard.innerHTML = `
      <div class="folder-card-top">
        <svg class="folder-card-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
        <span class="folder-card-count">${unit.words.length} words</span>
      </div>
      <div class="folder-card-title">${parts.length > 0 ? "Main Words" : escapeHTML(unit.name)}</div>
      <div class="folder-card-meta">Avg Mastery: ${avg}% • Click to open words</div>
    `;
    mainCard.addEventListener("click", () => {
      activeExplorerFolder = "__main__";
      renderExplorer();
    });
    foldersGrid.appendChild(mainCard);
  }

  // 3. Combined All Folder (when there are parts)
  if (parts.length > 0) {
    const allCard = document.createElement("button");
    allCard.className = "explorer-folder-card all-folder";
    allCard.innerHTML = `
      <div class="folder-card-top">
        <svg class="folder-card-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
          <polyline points="2 12 12 17 22 12"></polyline>
          <polyline points="2 17 12 22 22 17"></polyline>
        </svg>
        <span class="folder-card-count">${totalUnitWords} words</span>
      </div>
      <div class="folder-card-title">All ${escapeHTML(unit.name)} Words</div>
      <div class="folder-card-meta">Combined view of all folders in this unit</div>
    `;
    allCard.addEventListener("click", () => {
      activeExplorerFolder = "__all__";
      renderExplorer();
    });
    foldersGrid.appendChild(allCard);
  }

  // 4. + New Folder Card
  const addCard = document.createElement("button");
  addCard.className = "explorer-folder-card add-folder";
  addCard.innerHTML = `
    <svg class="folder-card-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"></line>
      <line x1="5" y1="12" x2="19" y2="12"></line>
    </svg>
    <div class="folder-card-title" style="color:#6ee7b7;">+ New Folder</div>
    <div class="folder-card-meta">Add a part/folder inside ${escapeHTML(unit.name)}</div>
  `;
  addCard.addEventListener("click", () => createNewPart(unit.id));
  foldersGrid.appendChild(addCard);
}

function renderExplorer() {
  const scope = $("#listScopeFilter").value;
  const search = $("#searchInput").value.trim();
  const activeUnit = state.units[state.activeUnitId];
  const isMainUnit =
    state.activeUnitId !== "all" &&
    state.activeUnitId !== "mistakes" &&
    activeUnit &&
    (!activeUnit.parentId || !state.units[activeUnit.parentId]);

  const foldersGrid = $("#explorerFoldersGrid");
  const breadcrumb = $("#explorerBreadcrumb");

  const hasChildParts = isMainUnit && getChildParts(activeUnit.id).length > 0;
  if (isMainUnit && hasChildParts && scope === "active" && !search && activeExplorerFolder === null) {
    renderExplorerFolders(activeUnit);
    return;
  }

  if (foldersGrid) foldersGrid.classList.add("hidden");

  const isChildPartActive = activeUnit && activeUnit.parentId && state.units[activeUnit.parentId];
  if (isMainUnit && scope === "active" && activeExplorerFolder !== null && !search) {
    breadcrumb.classList.remove("hidden");
    let folderLabel = "Main Words";
    if (activeExplorerFolder === "__all__") folderLabel = `All ${activeUnit.name} Words`;
    else if (activeExplorerFolder !== "__main__" && state.units[activeExplorerFolder]) {
      folderLabel = state.units[activeExplorerFolder].name;
    }
    breadcrumb.innerHTML = `
      <button class="btn-back-folders" id="btnBackToFolders">← Back to ${escapeHTML(activeUnit.name)} Folders</button>
      <span class="breadcrumb-folder-name">/ ${escapeHTML(folderLabel)}</span>
    `;
    const partsForMove = getChildParts(activeUnit.id);
    if (activeExplorerFolder === "__main__" && activeUnit.words.length > 0 && partsForMove.length > 0) {
      const moveBtn = document.createElement("button");
      moveBtn.className = "btn-back-folders";
      moveBtn.style.marginLeft = "auto";
      moveBtn.textContent = `📦 Move ${activeUnit.words.length} words to ${partsForMove[0].name}`;
      moveBtn.addEventListener("click", () => {
        const targetPart = partsForMove[0];
        const count = activeUnit.words.length;
        targetPart.words.push(...activeUnit.words.splice(0, count));
        activeExplorerFolder = targetPart.id;
        saveState();
        renderUnitsToolbar();
        renderExplorer();
        toast(`📦 Moved ${count} words into "${targetPart.name}"`, "success");
      });
      breadcrumb.appendChild(moveBtn);
    }
    $("#btnBackToFolders").addEventListener("click", () => {
      activeExplorerFolder = null;
      renderExplorer();
    });
  } else if (isChildPartActive && scope === "active" && !search) {
    const parentUnit = state.units[activeUnit.parentId];
    breadcrumb.classList.remove("hidden");
    breadcrumb.innerHTML = `
      <button class="btn-back-folders" id="btnBackToFolders">← Back to ${escapeHTML(parentUnit.name)}</button>
      <span class="breadcrumb-folder-name">/ ${escapeHTML(activeUnit.name)}</span>
    `;
    $("#btnBackToFolders").addEventListener("click", () => {
      selectUnit(parentUnit.id);
    });
  } else if (breadcrumb) {
    breadcrumb.classList.add("hidden");
  }

  $("#wordCardsGrid").classList.toggle("hidden", state.explorerView !== "cards");
  $("#wordlistScrollBox").classList.toggle("hidden", state.explorerView !== "table");

  const list = getFilteredExplorerList();
  $("#listCount").textContent = list.length;

  const emptyEl = $("#emptyMsg");
  if (list.length === 0) {
    emptyEl.style.display = "block";
    emptyEl.textContent = state.activeUnitId === "mistakes" || $("#listScopeFilter").value === "mistakes"
      ? "🎉 No mistakes recorded! Great job!"
      : "No words match your current filter.";
    $("#wordCardsGrid").innerHTML = "";
    $("#wordlistBody").innerHTML = "";
    return;
  }
  emptyEl.style.display = "none";

  if (state.explorerView === "cards") {
    renderBentoGrid(list);
  } else {
    renderWordTable(list);
  }
}

function renderBentoGrid(list) {
  const grid = $("#wordCardsGrid");
  grid.innerHTML = "";

  list.forEach((w) => {
    const m = w.mastery || 0;
    const tier = m >= 80 ? "high" : m >= 40 ? "mid" : "low";
    const isMistake = !!state.mistakes[w.id];

    const card = document.createElement("div");
    card.className = `bento-word-card ${isMistake ? "mistake-card" : ""}`;
    card.innerHTML = `
      <div>
        <div class="bento-card-top">
          <div class="bento-word-title-group">
            <button class="btn-speak" title="Pronounce">🔊</button>
            <div>
              <div class="bento-word-name">${escapeHTML(w.word)}</div>
              <div class="bento-word-meta">${escapeHTML(w.type || "Word")} • ${escapeHTML(w._unitName)}</div>
            </div>
          </div>
          <span class="bento-mastery-badge ${tier}">${m}%</span>
        </div>

        <div class="bento-meaning-box">${escapeHTML(w.meaning)}</div>
        <p class="bento-example">"${escapeHTML(w.example || "No example provided.")}"</p>
      </div>

      <div class="bento-card-footer">
        <div class="bento-progress-track">
          <div class="bento-progress-fill ${tier}" style="width:${m}%"></div>
        </div>
        <div class="bento-footer-actions">
          <button class="btn-mistake-toggle ${isMistake ? "in-mistakes" : ""}">
            ${isMistake ? "⚠️ In Mistakes" : "⚑ Mark Hard"}
          </button>
          <button class="btn-delete-word" title="Delete Word">🗑️</button>
        </div>
      </div>
    `;

    card.querySelector(".btn-speak").addEventListener("click", () => playSpeech(w.word));
    card.querySelector(".btn-mistake-toggle").addEventListener("click", () => toggleManualMistake(w.id));
    card.querySelector(".btn-delete-word").addEventListener("click", () => deleteWord(w.id, w._unitId));
    grid.appendChild(card);
  });
}

function renderWordTable(list) {
  const tbody = $("#wordlistBody");
  tbody.innerHTML = "";

  list.forEach((w, idx) => {
    const m = w.mastery || 0;
    const tier = m >= 80 ? "high" : m >= 40 ? "mid" : "low";
    const mc = m < 40 ? "mastery-low" : m < 80 ? "mastery-mid" : "mastery-high";
    const isMistake = !!state.mistakes[w.id];

    const tr = document.createElement("tr");
    if (isMistake) tr.className = "mistake-row";
    tr.innerHTML = `
      <td class="num-cell">${idx + 1}</td>
      <td class="word-cell">
        <span class="queue-dot ${tier}" style="display:inline-block; vertical-align:middle; margin-right:8px; width:9px; height:9px; border-radius:50%;"></span>
        ${escapeHTML(w.word)}
        ${isMistake ? '<span class="needs-practice-badge">⚠️ Needs Practice</span>' : ""}
      </td>
      <td class="type-cell">${escapeHTML(w.type || "Noun")}</td>
      <td dir="rtl" style="text-align:right;">${escapeHTML(w.meaning)}</td>
      <td class="unit-cell">${escapeHTML(w._unitName || "—")}</td>
      <td class="${mc}">
        <span class="mastery-bar"><span class="mastery-bar-fill" style="width:${m}%"></span></span>
        <span class="mastery-pct">${m}%</span>
      </td>
      <td>
        <button class="btn-delete-word" title="Delete Word">✕</button>
      </td>
    `;
    tr.querySelector(".btn-delete-word").addEventListener("click", () => deleteWord(w.id, w._unitId));
    tbody.appendChild(tr);
  });
}

// ════════════════════════════════════════════════════
//  7. MODE NAVIGATION & EVENT BINDINGS
// ════════════════════════════════════════════════════

function switchAppMode(mode) {
  stopPocketLoop();
  currentMode = mode;
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $$(".mode-panel").forEach((p) => p.classList.remove("active"));

  if (mode === "flashcards") {
    $("#flashcardsPanel").classList.add("active");
    renderFlashcard();
  } else if (mode === "quiz") {
    $("#quizPanel").classList.add("active");
    startActiveQuiz();
  } else if (mode === "context") {
    $("#contextPanel").classList.add("active");
    if (contextTargetWords.length === 0) rollContextTargetWords();
    else renderContextBuilder();
  } else if (mode === "manage") {
    $("#managePanel").classList.add("active");
    const isMistakes = state.activeUnitId === "mistakes";
    const manageAddGrid = $("#manageAddGrid") || document.querySelector(".manage-grid");
    const mistakesBanner = $("#mistakesHeaderBanner");
    if (manageAddGrid) manageAddGrid.style.display = isMistakes ? "none" : "";
    if (mistakesBanner) mistakesBanner.style.display = isMistakes ? "flex" : "none";
    populateAddWordUnitSelect();
  populateBulkUnitSelect();
    setExplorerView(state.explorerView);
  }
}

function bindAllEvents() {
  // Sidebar navigation
  $$(".nav-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      switchAppMode(btn.dataset.mode);
      closeMobileSidebar();
    })
  );

  // Sidebar special decks & controls
  const sideMistakes = $("#side-mistakes");
  const sideAll = $("#side-all");
  if (sideMistakes) {
    sideMistakes.addEventListener("click", () => {
      selectUnit("mistakes");
      closeMobileSidebar();
    });
  }
  if (sideAll) {
    sideAll.addEventListener("click", () => {
      selectUnit("all");
      closeMobileSidebar();
    });
  }

  const btnToggleSidebar = $("#btnToggleSidebar");
  if (btnToggleSidebar) {
    if (localStorage.getItem("vm_sidebar_collapsed") === "1") {
      $("#appSidebar").classList.add("collapsed");
    }
    btnToggleSidebar.addEventListener("click", () => {
      const isCollapsed = $("#appSidebar").classList.toggle("collapsed");
      localStorage.setItem("vm_sidebar_collapsed", isCollapsed ? "1" : "0");
    });
  }

  const btnMobileSidebar = $("#btnMobileSidebar");
  const sidebarBackdrop = $("#sidebarBackdrop");
  if (btnMobileSidebar) {
    btnMobileSidebar.addEventListener("click", () => {
      $("#appSidebar").classList.toggle("mobile-open");
      if (sidebarBackdrop) sidebarBackdrop.classList.toggle("open");
    });
  }
  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener("click", closeMobileSidebar);
  }

  // Units toolbar
  $("#btnQuickAddUnit").addEventListener("click", () => {
    createNewUnit();
    closeMobileSidebar();
  });
  const btnAddPartToUnit = $("#btnAddPartToUnit");
  if (btnAddPartToUnit) {
    btnAddPartToUnit.addEventListener("click", () => createNewPart(state.activeUnitId));
  }
  $("#btnRenameActiveUnit").addEventListener("click", renameActiveUnit);
  $("#btnClearActiveUnitWords").addEventListener("click", clearActiveUnitWords);
  $("#btnDeleteActiveUnit").addEventListener("click", deleteActiveUnit);
  $("#btnClearAllMistakes").addEventListener("click", clearAllMistakes);

  // Flashcards studio - only flip if clicking the card surface, NOT buttons or audio controls
  $("#cardScene").addEventListener("click", (e) => {
    if (e.target.closest("button") || e.target.closest(".btn-speak") || e.target.closest(".card-action-plane") || e.target.closest(".card-face-actions")) {
      return;
    }
    flipFlashcard();
  });

  window.playSpeechFromCard = function (e, rate = 1.0, isExample = false) {
    if (e) {
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
    }
    const btn = e && e.currentTarget ? e.currentTarget : null;
    if (btn) {
      btn.style.transform = "scale(0.85)";
      btn.style.borderColor = "#00d4ff";
      btn.style.boxShadow = "0 0 16px rgba(0, 212, 255, 0.85)";
      setTimeout(() => {
        btn.style.transform = "";
        btn.style.borderColor = "";
        btn.style.boxShadow = "";
      }, 180);
    }
    const words = getActiveWords();
    if (!words || !words.length || !words[flashcardIndex]) return;
    const current = words[flashcardIndex];
    const text = isExample && current.example ? current.example : current.word;
    playSpeech(text, rate);
  };

  const setupCardAudioBtn = (id, rateFn, isExample = false) => {
    const el = $(id);
    if (!el) return;
    const play = (e) => {
      window.playSpeechFromCard(e, typeof rateFn === "function" ? rateFn() : 1.0, isExample);
    };
    el.addEventListener("click", play);
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("mousedown", (e) => e.stopPropagation());
  };

  setupCardAudioBtn("#btnSpeak", () => 1.0);
  setupCardAudioBtn("#btnSpeakSlow", () => 0.58);
  setupCardAudioBtn("#btnSpeakExample", () => 0.88, true);
  setupCardAudioBtn("#btnSpeakBack", () => 1.0);
  $("#btnAutoAudio").addEventListener("click", toggleAutoPlayAudio);
  $("#btnPocketLoop").addEventListener("click", togglePocketLoop);

  // Context Builder events
  const btnRollCtx = $("#btnRollContextWords");
  if (btnRollCtx) btnRollCtx.addEventListener("click", rollContextTargetWords);
  const inpCtx = $("#contextSentenceInput");
  const bdropCtx = $("#contextHighlightBackdrop");
  if (inpCtx) {
    inpCtx.addEventListener("input", renderContextBuilder);
    if (bdropCtx) {
      inpCtx.addEventListener("scroll", () => {
        bdropCtx.scrollTop = inpCtx.scrollTop;
      });
    }
  }
  const btnSaveCtx = $("#btnSaveContextSentence");
  if (btnSaveCtx) btnSaveCtx.addEventListener("click", saveContextBuilderSentence);

  // Custom Unit Modal events
  const btnConfirmUnit = $("#btnConfirmUnitModal");
  const btnCancelUnit = $("#btnCancelUnitModal");
  const btnCloseUnit = $("#btnCloseUnitModal");
  const inpUnitModal = $("#unitModalInput");
  if (btnConfirmUnit) {
    btnConfirmUnit.addEventListener("click", () => {
      const val = inpUnitModal ? inpUnitModal.value.trim() : "";
      if (!val) return toast("⚠️ Please enter a name", "warning");
      const cb = unitModalCallback;
      closeUnitDialog();
      if (cb) cb(val);
    });
  }
  if (btnCancelUnit) btnCancelUnit.addEventListener("click", closeUnitDialog);
  if (btnCloseUnit) btnCloseUnit.addEventListener("click", closeUnitDialog);
  if (inpUnitModal) {
    inpUnitModal.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        btnConfirmUnit.click();
      } else if (e.key === "Escape") {
        closeUnitDialog();
      }
    });
  }
  $("#btnShuffleCards").addEventListener("click", shuffleFlashcards);
  $("#btnPrev").addEventListener("click", () => navigateCard(-1));
  $("#btnNext").addEventListener("click", () => navigateCard(1));
  $$(".rate-btn").forEach((btn) => btn.addEventListener("click", () => rateFlashcard(btn.dataset.rating)));

  // Quiz mode switcher
  $$(".quiz-type-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".quiz-type-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeQuizType = btn.dataset.quiz;

      $("#mcqArea").classList.add("hidden");
      $("#translateArea").classList.add("hidden");
      $("#spellingArea").classList.add("hidden");
      $("#matchArea").classList.add("hidden");

      $(`#${activeQuizType}Area`).classList.remove("hidden");
      const arenaView = $("#arenaView");
      if (arenaView) {
        arenaView.classList.toggle("spelling-mode-active", activeQuizType === "spelling");
      }
      startActiveQuiz();
    });
  });

  // MCQ
  $("#btnNextMcq").addEventListener("click", () => { mcqIndex++; showMcqQuestion(); });
  $("#btnResetMcq").addEventListener("click", startMcqQuiz);

  // Translate
  $("#btnCheckTranslate").addEventListener("click", checkTranslateAnswer);
  $("#btnTranslateHint").addEventListener("click", provideTranslateHint);
  $("#btnTranslateListen").addEventListener("click", () => {
    if (transList[transIndex]) playSpeech(transList[transIndex].word);
  });
  $("#translateInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!transAnswered) checkTranslateAnswer();
      else { transIndex++; showTranslateQuestion(); }
    }
  });
  $("#btnNextTranslate").addEventListener("click", () => { transIndex++; showTranslateQuestion(); });
  $("#btnResetTranslate").addEventListener("click", startTranslateQuiz);

  // Spelling (Cyber-Acoustic 3D Studio)
  $("#btnSpellListen").addEventListener("click", () => {
    if (spellList[spellIndex]) playSpeech(spellList[spellIndex].word);
  });
  const btnNorm = $("#btnListenNormal");
  if (btnNorm) btnNorm.addEventListener("click", () => {
    if (spellList[spellIndex]) playSpeech(spellList[spellIndex].word, 0.9);
  });
  const btnSlow = $("#btnListenSlow");
  if (btnSlow) btnSlow.addEventListener("click", () => {
    if (spellList[spellIndex]) playSpeech(spellList[spellIndex].word, 0.6);
  });
  const spkStage = $("#speakerStage");
  if (spkStage) {
    spkStage.addEventListener("click", (e) => {
      if (e.target.closest("#btnSpellListen")) return;
      if (spellList[spellIndex]) playSpeech(spellList[spellIndex].word, 0.9);
    });
  }
  $("#btnCheckSpelling").addEventListener("click", checkSpellingAnswer);
  $("#spellingInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!spellAnswered) checkSpellingAnswer();
      else { spellIndex++; showSpellingQuestion(); }
    } else if (e.code === "Space" && e.ctrlKey) {
      e.preventDefault();
      if (spellList[spellIndex]) playSpeech(spellList[spellIndex].word, 0.9);
    }
  });
  $("#btnNextSpelling").addEventListener("click", () => { spellIndex++; showSpellingQuestion(); });
  $("#btnResetSpelling").addEventListener("click", startSpellingQuiz);

  // Match
  $("#btnNewMatchBoard").addEventListener("click", startMatchGame);

  // Word Manager
  $$(".pos-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      $$(".pos-pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      const inputTypeEl = $("#inputType");
      if (inputTypeEl) inputTypeEl.value = pill.dataset.pos;
    });
  });

  const btnGear = $("#btnDataSettingsGear");
  const popover = $("#dataSettingsPopover");
  if (btnGear && popover) {
    const closeSettingsPopover = () => {
      btnGear.classList.remove("active");
      btnGear.setAttribute("aria-expanded", "false");
      popover.classList.remove("open");
    };

    btnGear.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = popover.classList.toggle("open");
      btnGear.classList.toggle("active", isOpen);
      btnGear.setAttribute("aria-expanded", String(isOpen));
    });

    document.addEventListener("click", (e) => {
      if (!popover.contains(e.target) && e.target !== btnGear && !btnGear.contains(e.target)) {
        closeSettingsPopover();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeSettingsPopover();
    });

    const fileInp = $("#fileImportCurrentUnit");
    if (fileInp) fileInp.addEventListener("change", () => closeSettingsPopover());
    const expUnitBtn = $("#btnExportActiveUnit");
    if (expUnitBtn) expUnitBtn.addEventListener("click", () => closeSettingsPopover());
    const expAllBtn = $("#btnExportAllData");
    if (expAllBtn) expAllBtn.addEventListener("click", () => closeSettingsPopover());
    const resetBtn = $("#btnResetAllApp");
    if (resetBtn) resetBtn.addEventListener("click", () => closeSettingsPopover());
  }

  $("#addWordForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const w = $("#inputWord").value;
    const t = $("#inputType").value;
    const m = $("#inputMeaning").value;
    const ex = $("#inputExample").value;
    const ea = $("#inputExampleAr").value;
    const uid = ($("#inputTargetPart") && $("#inputTargetPart").value) || ($("#inputTargetUnit") && $("#inputTargetUnit").value) || ($("#inputUnitSelect") ? $("#inputUnitSelect").value : getFirstAvailableUnitId());
    if (!w || !m) return toast("Word and Meaning are required!", "error");
    addSingleWord(w, t, m, ex, ea, uid);
    e.target.reset();
    const inputTypeEl = $("#inputType");
    if (inputTypeEl) inputTypeEl.value = "Noun";
    $$(".pos-pill").forEach((p) => p.classList.toggle("active", p.dataset.pos === "Noun"));
    populateAddWordUnitSelect();
  populateBulkUnitSelect();
  });

  $("#btnAutoFill").addEventListener("click", () => {
    const w = $("#inputWord").value.trim();
    const t = $("#inputType").value;
    if (!w) return toast("Enter an English word first!", "error");
    const f = getSmartFiller(w, t);
    if (!$("#inputExample").value) $("#inputExample").value = f.en;
    if (!$("#inputExampleAr").value) $("#inputExampleAr").value = f.ar;
    toast("✨ Example generated", "info");
  });

  $("#btnBulkAdd").addEventListener("click", () => handleBulkAdd($("#bulkInput").value));
  $("#fileImportCurrentUnit").addEventListener("change", (e) => {
    if (e.target.files[0]) handleStrictJsonImport(e.target.files[0]);
    e.target.value = "";
  });
  $("#btnExportActiveUnit").addEventListener("click", exportActiveUnit);
  const expAllBtn = $("#btnExportAllData");
  if (expAllBtn) expAllBtn.addEventListener("click", exportAllData);
  $("#btnResetAllApp").addEventListener("click", resetAllData);

  // Explorer filters & view toggle
  const filterMasteryEl = $("#filterMastery");
  function syncFilterMasteryColor() {
    if (!filterMasteryEl) return;
    filterMasteryEl.setAttribute("data-color", filterMasteryEl.value);
  }
  if (filterMasteryEl) {
    filterMasteryEl.addEventListener("change", () => {
      syncFilterMasteryColor();
      renderExplorer();
    });
    syncFilterMasteryColor();
  }
  const listScopeFilterEl = $("#listScopeFilter");
  function syncListScopeFilterTheme() {
    if (!listScopeFilterEl) return;
    listScopeFilterEl.setAttribute("data-scope", listScopeFilterEl.value);
  }
  if (listScopeFilterEl) {
    listScopeFilterEl.addEventListener("change", () => {
      syncListScopeFilterTheme();
      renderExplorer();
    });
    syncListScopeFilterTheme();
  }
  $("#searchInput").addEventListener("input", renderExplorer);
  $("#btnViewCards").addEventListener("click", () => setExplorerView("cards"));
  $("#btnViewTable").addEventListener("click", () => setExplorerView("table"));

  // Keyboard shortcuts (Seamless English & Arabic support via physical e.code & Arabic fallbacks)
  document.addEventListener("keydown", (e) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) || e.target.isContentEditable) return;

    const code = e.code;
    const key = e.key;

    // Audio Spelling Mode Shortcuts
    if (currentMode === "arena" && activeQuizType === "spelling") {
      // Replay normal audio: Space, KeyR, 'r', 'R', or 'ق'
      if (code === "Space" || key === " " || key === "Spacebar" || code === "KeyR" || key === "r" || key === "R" || key === "ق") {
        e.preventDefault();
        if (spellList[spellIndex]) playSpeech(spellList[spellIndex].word, 0.9);
        return;
      }
      // Slow audio: KeyS, 's', 'S', or 'س'
      if (code === "KeyS" || key === "s" || key === "S" || key === "س") {
        e.preventDefault();
        if (spellList[spellIndex]) playSpeech(spellList[spellIndex].word, 0.6);
        return;
      }
    }

    if (currentMode !== "flashcards") return;

    // Flip card (Space)
    if (code === "Space" || key === " " || key === "Spacebar") {
      e.preventDefault();
      flipFlashcard();
    }
    // Navigate cards (Arrows)
    else if (code === "ArrowRight" || key === "ArrowRight") {
      e.preventDefault();
      navigateCard(1);
    }
    else if (code === "ArrowLeft" || key === "ArrowLeft") {
      e.preventDefault();
      navigateCard(-1);
    }
    // Hard rating (1 / ١)
    else if (code === "Digit1" || code === "Numpad1" || key === "1" || key === "١") {
      e.preventDefault();
      rateFlashcard("hard");
    }
    // Good rating (2 / ٢)
    else if (code === "Digit2" || code === "Numpad2" || key === "2" || key === "٢") {
      e.preventDefault();
      rateFlashcard("good");
    }
    // Easy rating (3 / ٣)
    else if (code === "Digit3" || code === "Numpad3" || key === "3" || key === "٣") {
      e.preventDefault();
      rateFlashcard("easy");
    }
    // Replay normal voice 1.0x (KeyR or r / R or ق)
    else if (code === "KeyR" || key === "r" || key === "R" || key === "ق") {
      e.preventDefault();
      const w = getActiveWords();
      if (w[flashcardIndex]) playSpeech(w[flashcardIndex].word, 1.0);
    }
    // Play slow voice 0.6x (KeyS or s / S or س)
    else if (code === "KeyS" || key === "s" || key === "S" || key === "س") {
      e.preventDefault();
      const w = getActiveWords();
      if (w[flashcardIndex]) playSpeech(w[flashcardIndex].word, 0.6);
    }
  });
}

// ══════════════════════════════════════════════════════════════
//  8. UTILITIES, AUTO-UPDATER & BOOTSTRAP
// ══════════════════════════════════════════════════════════════

const GITHUB_REPO = "George-F-63S/vocabmaster";
const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/`;
const UPDATER_PORT = 49555;
const UPDATER_BASE = `http://127.0.0.1:${UPDATER_PORT}/api`;
let appCurrentVersion = "1.4.6";
let appCurrentBuild = 38;

function startUpdaterHeartbeat() {
  // Ping local C# launcher every 15 seconds to keep it informed the app is open
  setInterval(() => {
    fetch(`${UPDATER_BASE}/heartbeat`, { method: "POST" }).catch(() => {});
  }, 15000);
}

async function fetchCurrentVersion() {
  try {
    const res = await fetch(`${UPDATER_BASE}/version`);
    if (res.ok) {
      const data = await res.json();
      if (data) {
        if (data.version) appCurrentVersion = data.version;
        if (data.build) appCurrentBuild = Number(data.build) || appCurrentBuild;
      }
    }
  } catch (e) {
    try {
      const resLocal = await fetch("./version.json?t=" + Date.now());
      if (resLocal.ok) {
        const data = await resLocal.json();
        if (data.version) appCurrentVersion = data.version;
        if (data.build) appCurrentBuild = Number(data.build) || appCurrentBuild;
      }
    } catch (_) {}
  }
  const pill = $("#sidebarVersionPill");
  if (pill) pill.textContent = `v${appCurrentVersion}`;
  const desc = $("#popoverVersionDesc");
  if (desc) desc.textContent = `Current version: v${appCurrentVersion}`;
}

let latestCachedUpdateData = null;

function setUpdateBadgeNotification(hasUpdate, updateData = null) {
  const btnSide = $("#btnSidebarCheckUpdate");
  const btnGear = $("#btnDataSettingsGear");
  const rowPop = $("#btnCheckUpdatePopover");
  const desc = $("#popoverVersionDesc");
  const verDot = document.querySelector("#sidebarVersionBadge .version-dot");

  // Remove any previous dynamic red dot
  const oldDot = $("#sidebarUpdateRedDot");
  if (oldDot) oldDot.remove();
  const oldGearDot = $("#gearUpdateRedDot");
  if (oldGearDot) oldGearDot.remove();

  if (hasUpdate) {
    latestCachedUpdateData = updateData;
    if (btnSide) {
      btnSide.classList.add("has-update");
      btnSide.style.position = "relative";
      btnSide.style.borderColor = "rgba(239, 68, 68, 0.6)";
      btnSide.style.color = "#f87171";
      btnSide.setAttribute("title", `🚀 تحديث جديد متوفر (${updateData?.latestVersion || ""})! اضغط لتثبيته`);

      // Real DOM dot with inline styles
      const dot = document.createElement("span");
      dot.id = "sidebarUpdateRedDot";
      dot.style.cssText = "position:absolute; top:-3px; right:-3px; width:10px; height:10px; background:#ef4444; border:2px solid #0f172a; border-radius:50%; box-shadow:0 0 10px #ef4444; pointer-events:none; z-index:99; animation: pulseUpdateRedDot 1.8s infinite ease-in-out;";
      btnSide.appendChild(dot);
    }
    if (verDot) {
      verDot.style.background = "#ef4444";
      verDot.style.boxShadow = "0 0 10px rgba(239, 68, 68, 0.9)";
    }
    if (btnGear) {
      btnGear.classList.add("has-update");
      btnGear.style.position = "relative";
      const gearDot = document.createElement("span");
      gearDot.id = "gearUpdateRedDot";
      gearDot.style.cssText = "position:absolute; top:1px; right:1px; width:9px; height:9px; background:#ef4444; border:2px solid #0f172a; border-radius:50%; box-shadow:0 0 10px #ef4444; pointer-events:none; z-index:99;";
      btnGear.appendChild(gearDot);
    }
    if (rowPop) rowPop.classList.add("has-update");
    if (desc && updateData?.latestVersion) {
      desc.innerHTML = `<span style="color:#f87171; font-weight:700;">🚀 New update ready: v${updateData.latestVersion}</span>`;
    }
  } else {
    latestCachedUpdateData = null;
    if (btnSide) {
      btnSide.classList.remove("has-update");
      btnSide.style.borderColor = "";
      btnSide.style.color = "";
      btnSide.setAttribute("title", "Check for updates");
    }
    if (verDot) {
      verDot.style.background = "#10b981";
      verDot.style.boxShadow = "0 0 8px rgba(16, 185, 129, 0.6)";
    }
    if (btnGear) {
      btnGear.classList.remove("has-update");
    }
    if (rowPop) rowPop.classList.remove("has-update");
    if (desc) {
      desc.textContent = `Current version: v${appCurrentVersion}`;
    }
  }
}

function isNewerSemver(remote, current) {
  try {
    const r = (remote || "").replace(/^v/i, "").split(".").map(n => parseInt(n, 10) || 0);
    const c = (current || "").replace(/^v/i, "").split(".").map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(r.length, c.length); i++) {
      const rv = r[i] || 0;
      const cv = c[i] || 0;
      if (rv > cv) return true;
      if (rv < cv) return false;
    }
  } catch (_) {}
  return false;
}

async function checkForUpdates(isManual = false) {
  if (isManual) {
    toast("🔍 جاري التحقق من وجود تحديثات على GitHub...", "info");
  }

  let updateData = null;

  // 1. First try checking through local C# launcher if active
  try {
    const res = await fetch(`${UPDATER_BASE}/check-update`);
    if (res.ok) {
      const data = await res.json();
      if (data && !data.error) {
        updateData = data;
      }
    }
  } catch (e) {
    // Local server not running or busy; fallback to direct GitHub check
  }

  // 2. Fallback: Query GitHub directly from browser
  if (!updateData || updateData.offline || updateData.error) {
    try {
      let remoteVer = "1.0.0";
      let remoteBuild = 1;
      let notes = "";
      let date = "";

      try {
        const remoteRes = await fetch(`${GITHUB_RAW_BASE}version.json?_nocache=${Date.now()}`, {
          cache: "no-store",
          headers: { "Pragma": "no-cache", "Cache-Control": "no-cache" }
        });
        if (remoteRes.ok) {
          const remote = await remoteRes.json();
          remoteVer = remote.version || "1.0.0";
          remoteBuild = Number(remote.build) || 1;
          notes = remote.notes || "";
          date = remote.date || "";
        } else {
          throw new Error("Raw fetch failed");
        }
      } catch (_) {
        const relRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest?_nocache=${Date.now()}`, {
          headers: { "Accept": "application/vnd.github.v3+json" }
        });
        if (relRes.ok) {
          const rel = await relRes.json();
          remoteVer = (rel.tag_name || "1.0.0").replace(/^v/i, "");
          notes = rel.body || "";
        } else {
          throw new Error("GitHub unreachable");
        }
      }

      // STRICT: Only update if remote is strictly NEWER! NEVER downgrade!
      const isNewer = isNewerSemver(remoteVer, appCurrentVersion);
      const isHigherBuild = remoteBuild > appCurrentBuild;
      const hasUpdate = (isHigherBuild || isNewer) && !isNewerSemver(appCurrentVersion, remoteVer);

      updateData = {
        hasUpdate: hasUpdate,
        currentVersion: appCurrentVersion,
        latestVersion: remoteVer,
        notes: notes,
        date: date
      };
    } catch (err) {
      if (isManual) {
        toast("⚠️ تعذر الاتصال بـ GitHub. تأكد من اتصال الإنترنت.", "error");
      }
      return;
    }
  }

  if (updateData.hasUpdate) {
    setUpdateBadgeNotification(true, updateData);
    if (isManual) {
      showUpdateModal(updateData);
    } else {
      setTimeout(() => {
        showUpdateModal(updateData);
      }, 1000);
    }
  } else {
    setUpdateBadgeNotification(false);
    if (isManual) {
      toast(`✨ أنت تستخدم أحدث إصدار بالفعل (v${updateData.currentVersion || appCurrentVersion})`, "success");
    }
  }
}

let isApplyingUpdate = false;
let progressPollTimer = null;

function setUpdateProgressUI(percent, statusText, detailsText) {
  const lblPercent = $("#lblUpdatePercent");
  const fill = $("#updateProgressFill");
  const lblStatus = $("#lblUpdateProgressStatus");
  const lblDetails = $("#lblUpdateFileDetails");

  const safePercent = Math.min(100, Math.max(0, Math.round(percent)));
  if (lblPercent) lblPercent.textContent = `${safePercent}%`;
  if (fill) fill.style.width = `${safePercent}%`;
  if (lblStatus && statusText) lblStatus.textContent = statusText;
  if (lblDetails && detailsText) lblDetails.textContent = detailsText;
}

function showUpdateModal(data) {
  const modal = $("#updateModalBackdrop");
  if (!modal) return;

  if (progressPollTimer) {
    clearInterval(progressPollTimer);
    progressPollTimer = null;
  }
  isApplyingUpdate = false;
  const lblCur = $("#lblCurrentVersion");
  const lblLat = $("#lblLatestVersion");
  const lblNotes = $("#lblUpdateNotes");
  const progressBox = $("#updateProgressBox");
  const footer = $("#updateDialogFooter");
  const btnClose = $("#btnCloseUpdateModal");
  const btnConfirm = $("#btnConfirmApplyUpdate");

  if (lblCur) lblCur.textContent = `v${data.currentVersion || appCurrentVersion}`;
  if (lblLat) lblLat.textContent = `v${data.latestVersion || "New"}`;
  if (lblNotes) lblNotes.textContent = data.notes || "تحسينات عامة وإصلاحات وتحديثات جديدة.";

  setUpdateProgressUI(0, "جاري بدء التحديث...", "جاري الاتصال بـ GitHub...");

  if (progressBox) {
    progressBox.classList.add("hidden");
    progressBox.style.display = "none";
  }
  if (footer) {
    footer.classList.remove("hidden");
    footer.style.display = "flex";
  }
  if (btnConfirm) {
    btnConfirm.disabled = false;
    btnConfirm.style.pointerEvents = "";
    btnConfirm.style.opacity = "";
  }
  if (btnClose) btnClose.style.display = "";

  modal.classList.remove("hidden");
}

function hideUpdateModal() {
  if (isApplyingUpdate) return;
  if (progressPollTimer) {
    clearInterval(progressPollTimer);
    progressPollTimer = null;
  }
  const modal = $("#updateModalBackdrop");
  if (modal) modal.classList.add("hidden");
}

async function applyUpdateNow() {
  if (isApplyingUpdate) return;
  isApplyingUpdate = true;

  const btnConfirm = $("#btnConfirmApplyUpdate");
  const progressBox = $("#updateProgressBox");
  const footer = $("#updateDialogFooter");
  const btnClose = $("#btnCloseUpdateModal");

  if (btnConfirm) {
    btnConfirm.disabled = true;
    btnConfirm.style.pointerEvents = "none";
    btnConfirm.style.opacity = "0.5";
  }
  if (footer) {
    footer.classList.add("hidden");
    footer.style.display = "none";
  }
  if (progressBox) {
    progressBox.classList.remove("hidden");
    progressBox.style.display = "flex";
  }
  if (btnClose) btnClose.style.display = "none";

  let simulatedPercent = 10;
  setUpdateProgressUI(simulatedPercent, "⏳ جاري بدء تنزيل ملفات التحديث...", "جاري الاتصال بـ GitHub...");

  // Start polling update progress (with smooth fallback)
  progressPollTimer = setInterval(async () => {
    let gotLiveProgress = false;
    try {
      const res = await fetch(`${UPDATER_BASE}/update-progress?t=${Date.now()}`);
      if (res.ok) {
        const prog = await res.json();
        if (prog && prog.isUpdating) {
          gotLiveProgress = true;
          const detail = prog.file ? `الملف: ${prog.file} (${prog.completed || 0}/${prog.total || 8})` : "جاري تنزيل الملفات...";
          setUpdateProgressUI(prog.percent || 15, prog.status || "جاري التنزيل...", detail);
        }
      }
    } catch (_) {}

    if (!gotLiveProgress) {
      if (simulatedPercent < 88) {
        simulatedPercent += Math.floor(Math.random() * 7) + 5;
        if (simulatedPercent > 88) simulatedPercent = 88;
        setUpdateProgressUI(
          simulatedPercent,
          "⏳ جاري تنزيل ملفات التحديث وتثبيتها...",
          `جاري تنزيل الملفات (${simulatedPercent}%)...`
        );
      }
    }
  }, 220);

  try {
    const res = await fetch(`${UPDATER_BASE}/apply-update`, { method: "POST" });
    if (!res.ok) throw new Error("تعذر الاتصال بمركز التحديثات في البرنامج");
    const data = await res.json();

    if (progressPollTimer) {
      clearInterval(progressPollTimer);
      progressPollTimer = null;
    }

    if (data.success) {
      if (data.restarting) {
        setUpdateProgressUI(
          100,
          "✅ تم اكتمال التحديث وتثبيت الملفات 100%!",
          "🚀 جاري إغلاق التطبيق وإعادة تشغيله تلقائياً بالنسخة الجديدة..."
        );
        toast("🚀 جاري إعادة تشغيل VocabMaster بالنسخة الجديدة...", "success");
      } else {
        setUpdateProgressUI(100, "✅ تم اكتمال التحديث وتثبيت الملفات 100%!", "جاري تحديث واجهة التطبيق...");
        toast("🚀 تم تثبيت التحديث بنجاح (100%)!", "success");
        setTimeout(() => {
          window.location.reload();
        }, 1200);
      }
    } else {
      throw new Error(data.error || "فشل تنزيل ملفات التحديث");
    }
  } catch (err) {
    if (progressPollTimer) {
      clearInterval(progressPollTimer);
      progressPollTimer = null;
    }
    isApplyingUpdate = false;
    if (btnConfirm) {
      btnConfirm.disabled = false;
      btnConfirm.style.pointerEvents = "";
      btnConfirm.style.opacity = "";
    }
    const statusLbl = $("#lblUpdateProgressStatus");
    if (statusLbl) {
      statusLbl.innerHTML = `
        <div style="font-size:0.88rem; line-height:1.6; margin-bottom:12px; color:#cbd5e1;">
          ⚠️ تعذر التحديث التلقائي: ${escapeHTML(err.message)}<br>
          يمكنك المحاولة مجدداً أو تحميل التحديث يدوياً من GitHub:
        </div>
        <div style="display:flex; gap:10px; justify-content:center; flex-wrap:wrap; margin-top:8px;">
          <button type="button" id="btnRetryUpdate" style="padding:8px 16px; border-radius:10px; background:#38bdf8; color:#0f172a; font-weight:700; border:none; cursor:pointer;">
            🔄 إعادة المحاولة
          </button>
          <a href="https://github.com/${GITHUB_REPO}/releases" target="_blank" style="display:inline-block; padding:8px 16px; border-radius:10px; background:rgba(255,255,255,0.1); color:#fff; font-weight:600; text-decoration:none;">
            ⬇️ GitHub Releases
          </a>
        </div>
      `;
      const btnRetry = $("#btnRetryUpdate");
      if (btnRetry) btnRetry.addEventListener("click", applyUpdateNow);
    }
    toast(`⚠️ ${err.message}`, "error");
    if (footer) {
      footer.classList.remove("hidden");
      footer.style.display = "flex";
    }
    if (btnClose) btnClose.style.display = "";
  }
}

function initUpdaterEvents() {
  const btnSide = $("#btnSidebarCheckUpdate");
  const verBadge = $("#sidebarVersionBadge");

  const triggerUpdateModal = () => {
    if (latestCachedUpdateData && latestCachedUpdateData.hasUpdate) {
      showUpdateModal(latestCachedUpdateData);
    } else {
      checkForUpdates(true);
    }
  };

  if (btnSide) {
    btnSide.addEventListener("click", triggerUpdateModal);
  }

  if (verBadge) {
    verBadge.style.cursor = "pointer";
    verBadge.setAttribute("title", "اضغط للتحقق من التحديثات");
    verBadge.addEventListener("click", triggerUpdateModal);
  }

  const btnPop = $("#btnCheckUpdatePopover");
  if (btnPop) {
    btnPop.addEventListener("click", () => {
      const popover = $("#dataSettingsPopover");
      const btnGear = $("#btnDataSettingsGear");
      if (popover) popover.classList.remove("open");
      if (btnGear) {
        btnGear.classList.remove("active");
        btnGear.setAttribute("aria-expanded", "false");
      }
      if (latestCachedUpdateData && latestCachedUpdateData.hasUpdate) {
        showUpdateModal(latestCachedUpdateData);
      } else {
        checkForUpdates(true);
      }
    });
  }

  const btnConfirm = $("#btnConfirmApplyUpdate");
  if (btnConfirm) btnConfirm.addEventListener("click", applyUpdateNow);

  const btnDismiss = $("#btnDismissUpdate");
  if (btnDismiss) btnDismiss.addEventListener("click", hideUpdateModal);

  const btnClose = $("#btnCloseUpdateModal");
  if (btnClose) btnClose.addEventListener("click", hideUpdateModal);
}

function showGuideModal() {
  const modal = $("#guideModalBackdrop");
  if (modal) modal.classList.remove("hidden");
}

function hideGuideModal() {
  const modal = $("#guideModalBackdrop");
  if (modal) modal.classList.add("hidden");
}

function initGuideEvents() {
  const btnSide = $("#btnSidebarHowToUse");
  if (btnSide) btnSide.addEventListener("click", showGuideModal);

  const btnHeader = $("#btnHeaderHowToUse");
  if (btnHeader) btnHeader.addEventListener("click", showGuideModal);

  const btnPop = $("#btnHowToUsePopover");
  if (btnPop) {
    btnPop.addEventListener("click", () => {
      const popover = $("#dataSettingsPopover");
      const btnGear = $("#btnDataSettingsGear");
      if (popover) popover.classList.remove("open");
      if (btnGear) {
        btnGear.classList.remove("active");
        btnGear.setAttribute("aria-expanded", "false");
      }
      showGuideModal();
    });
  }

  const btnClose = $("#btnCloseGuideModal");
  if (btnClose) btnClose.addEventListener("click", hideGuideModal);

  const btnGotIt = $("#btnGotItGuide");
  if (btnGotIt) btnGotIt.addEventListener("click", hideGuideModal);

  const backdrop = $("#guideModalBackdrop");
  if (backdrop) {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) hideGuideModal();
    });
  }

  // Close guide modal on Escape (Esc) key
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || e.key === "Esc" || e.code === "Escape") {
      const modal = $("#guideModalBackdrop");
      if (modal && !modal.classList.contains("hidden")) {
        hideGuideModal();
      }
    }
  });
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escapeHTML(str) {
  if (!str) return "";
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function toast(msg, type = "info") {
  const c = $("#toastContainer");
  if (!c) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ══════════════════════════════════════════════════════════════
//  9. 3D TILT WITH GLARE & MAGNETIC HOVER MOTION
// ══════════════════════════════════════════════════════════════

function initCard3DTiltAndMagneticHover() {
  const cardScene = $("#cardScene");
  const cardBody = $("#cardBody");
  const glareFront = $("#cardGlareFront");
  const glareBack = $("#cardGlareBack");

  if (cardScene && cardBody) {
    let targetTiltX = 0;
    let targetTiltY = 0;
    let currentTiltX = 0;
    let currentTiltY = 0;
    let currentScale = 1;
    let targetScale = 1;
    let isHovering = false;
    let tiltRafId = null;
    const maxTilt = 4.0; // Smooth, gentle tilt angle

    function animateTilt() {
      const ease = isHovering ? 0.22 : 0.14;
      currentTiltX += (targetTiltX - currentTiltX) * ease;
      currentTiltY += (targetTiltY - currentTiltY) * ease;
      currentScale += (targetScale - currentScale) * ease;

      if (!isHovering && Math.abs(currentTiltX) < 0.05 && Math.abs(currentTiltY) < 0.05 && Math.abs(currentScale - 1) < 0.005) {
        currentTiltX = 0;
        currentTiltY = 0;
        currentScale = 1;
        cardBody.style.transform = isCardFlipped ? "rotateY(180deg)" : "rotateY(0deg)";
        tiltRafId = null;
        return;
      }

      const sScale = currentScale.toFixed(3);

      // Flip Compatibility Math:
      // When back face is facing user (isCardFlipped = true), rotateY(180 - currentTiltY) preserves natural cursor tilt
      if (isCardFlipped) {
        cardBody.style.transform = `rotateX(${currentTiltX.toFixed(2)}deg) rotateY(${(180 - currentTiltY).toFixed(2)}deg) scale3d(${sScale}, ${sScale}, 1)`;
      } else {
        cardBody.style.transform = `rotateX(${currentTiltX.toFixed(2)}deg) rotateY(${currentTiltY.toFixed(2)}deg) scale3d(${sScale}, ${sScale}, 1)`;
      }

      tiltRafId = requestAnimationFrame(animateTilt);
    }

    // Edge activation curve ("تبقا من عند الاطراف"):
    // Inner 32% center zone stays completely flat and steady.
    // Progressively tilts as cursor approaches the edges/perimeter.
    function getEdgeResponse(normVal) {
      const abs = Math.abs(normVal);
      const sign = Math.sign(normVal);
      const deadzone = 0.32;
      if (abs <= deadzone) return 0;
      const t = (abs - deadzone) / (1 - deadzone);
      return sign * (t * t); // Smooth quadratic curve towards edges
    }

    cardScene.addEventListener("mousemove", (e) => {
      const rect = cardScene.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const normX = (mouseX / rect.width) * 2 - 1; // -1 to +1
      const normY = (mouseY / rect.height) * 2 - 1; // -1 to +1

      // Edge-based activation
      const edgeX = getEdgeResponse(normX);
      const edgeY = getEdgeResponse(normY);

      targetTiltX = -edgeY * maxTilt;
      targetTiltY = edgeX * maxTilt;
      targetScale = 1.015;

      const glarePercentX = Math.max(0, Math.min(100, (mouseX / rect.width) * 100));
      const glarePercentY = Math.max(0, Math.min(100, (mouseY / rect.height) * 100));

      if (glareFront) {
        glareFront.style.setProperty("--glare-x", `${glarePercentX.toFixed(1)}%`);
        glareFront.style.setProperty("--glare-y", `${glarePercentY.toFixed(1)}%`);
      }
      if (glareBack) {
        glareBack.style.setProperty("--glare-x", `${(100 - glarePercentX).toFixed(1)}%`);
        glareBack.style.setProperty("--glare-y", `${glarePercentY.toFixed(1)}%`);
      }

      if (!isHovering) {
        isHovering = true;
        cardBody.style.transition = "none";
        if (!tiltRafId) tiltRafId = requestAnimationFrame(animateTilt);
      }
    });

    cardScene.addEventListener("mouseleave", () => {
      isHovering = false;
      targetTiltX = 0;
      targetTiltY = 0;
      targetScale = 1;
      cardBody.style.transition = "transform 0.5s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.5s ease";
      if (!tiltRafId) tiltRafId = requestAnimationFrame(animateTilt);
    });

    cardScene.addEventListener("mouseenter", () => {
      isHovering = true;
      cardBody.style.transition = "none";
      targetScale = 1.035;
      if (!tiltRafId) tiltRafId = requestAnimationFrame(animateTilt);
    });
  }

  // Subtle magnetic cursor pull for key interactive buttons outside the card
  const magneticSelectors = [
    "#btnHard",
    "#btnGood",
    "#btnEasy",
    "#btnPocketLoop",
    "#btnAutoAudio",
    "#btnPrev",
    "#btnNext",
    "#btnAddPartToUnit",
    "#btnRenameActiveUnit",
    "#btnClearActiveUnitWords",
    "#btnDeleteActiveUnit"
  ];

  magneticSelectors.forEach((sel) => {
    const btn = $(sel);
    if (!btn) return;

    btn.classList.add("magnetic-btn");
    let magRaf = null;
    let targetX = 0;
    let targetY = 0;
    let curX = 0;
    let curY = 0;
    let isHovered = false;
    const maxPull = 5; // max 5px pull

    function updateMag() {
      const damping = isHovered ? 0.25 : 0.2;
      curX += (targetX - curX) * damping;
      curY += (targetY - curY) * damping;

      if (!isHovered && Math.abs(curX) < 0.08 && Math.abs(curY) < 0.08) {
        curX = 0;
        curY = 0;
        btn.style.transform = "";
        magRaf = null;
        return;
      }

      btn.style.transform = `translate3d(${curX.toFixed(2)}px, ${curY.toFixed(2)}px, 0)`;
      magRaf = requestAnimationFrame(updateMag);
    }

    btn.addEventListener("mousemove", (e) => {
      const rect = btn.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      const relX = Math.max(-1, Math.min(1, (e.clientX - centerX) / (rect.width / 2)));
      const relY = Math.max(-1, Math.min(1, (e.clientY - centerY) / (rect.height / 2)));

      targetX = relX * maxPull;
      targetY = relY * maxPull;

      if (!isHovered) {
        isHovered = true;
        if (!magRaf) magRaf = requestAnimationFrame(updateMag);
      }
    });

    btn.addEventListener("mouseleave", () => {
      isHovered = false;
      targetX = 0;
      targetY = 0;
      if (!magRaf) magRaf = requestAnimationFrame(updateMag);
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadState();
  bindAllEvents();
  initUpdaterEvents();
  initGuideEvents();
  initCard3DTiltAndMagneticHover();
  startUpdaterHeartbeat();
  fetchCurrentVersion();
  renderUnitsToolbar();
  switchAppMode("flashcards");

  // Check for updates in background on startup (after 800ms) and periodically
  setTimeout(() => {
    checkForUpdates(false);
  }, 800);
  setInterval(() => {
    checkForUpdates(false);
  }, 60000);
});