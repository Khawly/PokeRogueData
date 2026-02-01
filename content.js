// =======================
// Auto-zoom page to 90%
// =======================
(function autoZoomToNinety() {
  try {
    document.documentElement.style.zoom = "0.9";
  } catch (e) {
    console.warn("Failed to auto-zoom PokeRogue page:", e);
  }
})();

// =======================
// Inject pageHook.js
// =======================
(function injectPageHook() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("pageHook.js");
  script.onload = () => script.remove();
  document.documentElement.appendChild(script);
})();

// =======================
// Globals
// =======================
let moveDB = null;

let extensionAlive = true;
let panelVisible = true;

let lastEnemyHash = "";
let currentTabIndex = 0;

// Map<id, { id, speciesId, speciesName, level, lastHp, maxHp,
//           baseStats, currentStats, abilityName, passiveName, knownMoves, missingTicks }>
const revealedEnemies = new Map();

const MAX_MISSING_TICKS = 10;

window.addEventListener("beforeunload", () => {
  extensionAlive = false;
});

// =======================
// Helpers
// =======================
function capitalize(str) {
  if (!str) return "";
  return String(str)
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeAbilityName(name) {
  if (!name) return "";
  return String(name).trim().toLowerCase();
}

function normalizeMoveNameForId(name) {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeSpeciesNameForMatch(name) {
  if (!name) return "";
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/-/g, " ")
    .replace(/\s+/g, " ");
}

// Treat "Golem", "Golem (Alola)", "Alolan Golem" as same base species
function normalizeBaseSpeciesName(name) {
  let s = normalizeSpeciesNameForMatch(name);
  if (!s) return "";

  // Remove parentheses content e.g. "Golem (Alola)" -> "Golem"
  s = s.replace(/\([^)]*\)/g, " ");

  // Remove regional / form adjectives
  s = s.replace(
    /\b(alolan|alola|galarian|galar|hisuian|hisui|paldean|paldea|mega|gigantamax|gmax)\b/g,
    ""
  );

  return s.replace(/\s+/g, " ").trim();
}

function getMoveInfo(moveDBObj, moveName) {
  if (!moveDBObj || !moveName) return {};
  const id = normalizeMoveNameForId(moveName);
  // Try normalized key first, then fallback to original name
  return moveDBObj[id] || moveDBObj[moveName] || {};
}

// Compare the *shape* of current stats vs base stats (not used for ID right now,
// but kept if you want to use it later).
function computeShapeSimilarity(currentStats, baseStats) {
  if (!currentStats || !baseStats) return 0;

  const keys = ["hp", "atk", "def", "spa", "spd", "spe"];
  const v1 = [];
  const v2 = [];

  for (const k of keys) {
    const c = currentStats[k];
    const b = baseStats[k];

    if (c == null || b == null) continue;

    const cv = Number(c);
    const bv = Number(b);
    if (!Number.isFinite(cv) || !Number.isFinite(bv)) continue;

    v1.push(cv);
    v2.push(bv);
  }

  if (v1.length === 0 || v2.length === 0) return 0;

  let dot = 0;
  let mag1 = 0;
  let mag2 = 0;

  for (let i = 0; i < v1.length; i++) {
    dot += v1[i] * v2[i];
    mag1 += v1[i] * v1[i];
    mag2 += v2[i] * v2[i];
  }

  if (mag1 === 0 || mag2 === 0) return 0;
  return dot / (Math.sqrt(mag1) * Math.sqrt(mag2));
}

// =======================
// Core: find best Pokedex entry for an enemy
// =======================
//
// Uses:
// - ARC.DB.getSpecies(speciesId).name (arrives as enemy.speciesName)
// - speciesId ONLY when that name is "."
// - enemy.abilityName
// - enemy.passiveName
//
// Special case: Pikachu
// - All forms appear as "Pikachu" from getSpecies().name.
// - We gather ALL entries whose base species is Pikachu from POKEDEX,
//   then pick the correct one with passive (strongest signal) and ability.
//
function findBestPokedexEntryForEnemy(enemy) {
  if (typeof POKEDEX === "undefined" || !Array.isArray(POKEDEX)) {
    return null;
  }
  if (!enemy) return null;

  const speciesId = enemy.speciesId;
  const rawName = enemy.speciesName ? String(enemy.speciesName).trim() : "";
  const hasName = !!rawName;
  const isDotName = rawName === ".";
  const baseNameNorm = rawName ? normalizeBaseSpeciesName(rawName) : "";
  const biome = enemy.biome != null ? Number(enemy.biome) : null;
  const enemyAbilityNorm = enemy.abilityName ? normalizeAbilityName(enemy.abilityName) : null;
  const enemyPassiveNorm = enemy.passiveName ? normalizeAbilityName(enemy.passiveName) : null;

  const statKeys = ["hp", "atk", "def", "spa", "spd", "spe"];

  let candidates = [];

// 1) Normal case: use display name from ARC.DB.getSpecies(speciesId).name
if (hasName && !isDotName) {
  const targetNameNorm = normalizeSpeciesNameForMatch(rawName);
  const targetBaseNorm = baseNameNorm; // e.g. "florges", "golem"

  candidates = POKEDEX.filter((entry) => {
    if (!entry) return false;

    const entryName = entry.name || "";
    const entryDisplay = entry.displayName || "";

    const nameNorm = normalizeSpeciesNameForMatch(entryName);
    const dispNorm = normalizeSpeciesNameForMatch(entryDisplay);
    const baseNorm = normalizeBaseSpeciesName(entryDisplay || entryName);

    // Exact literal matches on name or displayName
    if (targetNameNorm &&
        (nameNorm === targetNameNorm || dispNorm === targetNameNorm)) {
      return true;
    }

    // Base-species match (so "Blue Florges", "Red Florges" etc all match "Florges")
    if (targetBaseNorm && baseNorm === targetBaseNorm) {
      return true;
    }

    return false;
  });
}

// --- Step 2: Pikachu special-case ---
// Add ALL forms of Pikachu (any entry whose name contains "pikachu")
if (baseNameNorm === "pikachu") {
  const pikCandidates = POKEDEX.filter((entry) => {
    if (!entry) return false;

    const dn = (entry.displayName || entry.name || "").toLowerCase();

    // includes: "pikachu", "partner pikachu", "pikachu (partner)", "cosplay pikachu", etc.
    return dn.includes("pikachu");
  });

  if (pikCandidates.length > 0) {
    candidates = pikCandidates;
  }
}

  // 3) Fallback to speciesId when name-based matching failed.
  //    This covers:
  //    - getSpecies(speciesId).name === "."
  //    - cosmetic / color forms where the in-game name
  //      doesn't match any displayName in POKEDEX,
  //      but the speciesId still lines up.
  if (speciesId != null && (!candidates || candidates.length === 0)) {
    candidates = POKEDEX.filter(
      (entry) => entry && entry.speciesId === speciesId
    );
  }

  if (!candidates || candidates.length === 0) {
    return null;
  }


  // --- Wormadam biome-based form selection ---
  // Wormadam's forms are determined by the current biome in PokeRogue:
  // - biome === 30 -> Trash form
  // - biome === 15 -> Plant form
  // - biome === 8  -> Sandy form
  // - otherwise    -> default Plant form
  if (baseNameNorm === "wormadam") {
    let desiredForm = "Plant";
    if (biome === 30) {
      desiredForm = "Trash";
    } else if (biome === 8) {
      desiredForm = "Sandy";
    } else if (biome === 5) {
      desiredForm = "Plant";
    }

    const wormCandidates = candidates.filter((entry) => {
      const formName = (entry.form || "").toLowerCase();
      return formName === desiredForm.toLowerCase();
    });

    if (wormCandidates.length > 0) {
      // Directly return the Wormadam form dictated by biome
      return wormCandidates[0];
    }
    // If somehow no matching form exists in POKEDEX,
    // fall through to the generic logic below.
  }


  if (candidates.length === 1) {
    return candidates[0];
  }

  // Prefer entries that share the exact same speciesId (forms of the same mon)
  const sameSpeciesCandidates = candidates.filter(
    (entry) => entry && entry.speciesId === speciesId
  );
  const pool =
    sameSpeciesCandidates.length > 0 ? sameSpeciesCandidates : candidates;

  // If we know passive and/or ability, use them FIRST to choose among forms.
  if (enemyPassiveNorm || enemyAbilityNorm) {
    let best = null;
    let bestScore = -1;

    for (const entry of pool) {
      let score = 0;

      // Strongest signal: passive match
      if (enemyPassiveNorm && entry.passive) {
        const entryPassiveNorm = normalizeAbilityName(entry.passive);
        if (entryPassiveNorm === enemyPassiveNorm) {
          score += 4; // higher weight than anything else
        }
      }

      // Next: ability match
      if (enemyAbilityNorm && Array.isArray(entry.abilities)) {
        const entryAbNorm = entry.abilities.map(normalizeAbilityName);
        if (entryAbNorm.includes(enemyAbilityNorm)) {
          score += 2;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }

    // If we found anything with a positive score, use it.
    if (best && bestScore >= 0) {
      return best;
    }
  }
  // Absolute last resort: first candidate overall.
  return pool[0];
}

// =======================
// Load move DB
// =======================
async function loadMoveDB() {
  if (!moveDB) {
    moveDB = await fetch(chrome.runtime.getURL("move_data.json")).then((r) =>
      r.json()
    );
  }
  return moveDB;
}

// =======================
// Panel setup
// =======================
function ensurePanel() {
  let panel = document.getElementById("pokerogue-helper-panel");
  if (panel) return panel;

  panel = document.createElement("div");
  panel.id = "pokerogue-helper-panel";
  panel.style.position = "relative";

  const gameContainer =
    document.querySelector("#game") ||
    document.querySelector("canvas")?.parentElement;

  if (gameContainer) {
    gameContainer.style.margin = "0";
    gameContainer.style.padding = "0";

    let wrapper = document.getElementById("pokerogue-helper-wrapper");
    if (!wrapper) {
      wrapper = document.createElement("div");
      wrapper.id = "pokerogue-helper-wrapper";
      wrapper.style.display = "flex";
      wrapper.style.alignItems = "flex-start";
      wrapper.style.gap = "0px";
      wrapper.style.margin = "0";
      wrapper.style.padding = "0";

      gameContainer.parentElement.insertBefore(wrapper, gameContainer);
      wrapper.appendChild(gameContainer);
    }

    wrapper.appendChild(panel);
  } else {
    document.body.appendChild(panel);
  }

  return panel;
}

function ensurePopupModalInPanel() {
  const panel = document.getElementById('pokerogue-helper-panel');
  if (!panel) return;
  // Remove any duplicate modals
  const existing = Array.from(document.querySelectorAll('#pr-popup-modal'));
  let modal = existing[0] || null;
  if (existing.length > 1) {
    existing.slice(1).forEach((m) => m.remove());
  }
  if (modal && modal.parentElement !== panel) {
    modal.remove();
    modal = null;
  }
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'pr-popup-modal';
    modal.style.display = 'none';
    modal.style.position = 'absolute';
    modal.style.zIndex = '1000';
    modal.style.top = '50%';
    modal.style.left = '50%';
    modal.style.transform = 'translate(-50%, -50%)';
    modal.style.background = 'rgba(0,0,0,0.15)';
    modal.style.width = '340px';
    modal.style.maxWidth = '95%';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
    panel.appendChild(modal);
  }
}
// Always ensure the popup modal is in the panel after panel creation
ensurePopupModalInPanel();

function initializePanelLayout(panel) {
  if (panel.dataset.initialized) return;

  panel.innerHTML = `
    <div id="pr-header" class="pr-header">
      <div id="pr-tabs" class="pr-tabs"></div>
    </div>
    <h3 id="pr-title">Loading enemy Pokémon...</h3>
    <div class="pr-layout">
      <div class="pr-left" id="pr-left"></div>
      <div class="pr-right" id="pr-right">
        <h4>Possible Moves</h4>
        <div class="pr-moves-wrapper">
          <table class="pr-moves" id="pr-moves">
            <thead>
              <tr>
                <th>Lv</th>
                <th>Move</th>
                <th>Type / Category</th>
                <th>Power / Acc</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  panel.dataset.initialized = "true";
}

// =======================
// Rendering a single enemy
// =======================
function renderEnemy(enemy, moveDB) {
    ensurePopupModalInPanel();
  ensurePanel();
  if (!enemy) return;

  const level = enemy.level;

  const entry = findBestPokedexEntryForEnemy(enemy);

  if (!entry) {
    document.getElementById("pr-title").textContent =
      `Unknown Pokémon (${enemy.speciesName || `ID ${enemy.speciesId}`})`;
    document.getElementById("pr-left").innerHTML = "";
    const tbodyEmpty = document.querySelector("#pr-moves tbody");
    if (tbodyEmpty) tbodyEmpty.innerHTML = "";
    return;
  }

  const displayName =
    entry.displayName ||
    entry.name ||
    enemy.speciesName ||
    `ID ${enemy.speciesId}`;

  const bs = entry.baseStats || {};

  const stats = {
    hp: Number(bs.hp ?? bs.HP ?? 0),
    attack: Number(bs.atk ?? bs.ATK ?? 0),
    defense: Number(bs.def ?? bs.DEF ?? 0),
    spAttack: Number(bs.spa ?? bs.SPA ?? 0),
    spDefense: Number(bs.spd ?? bs.SPD ?? 0),
    speed: Number(bs.spe ?? bs.SPE ?? 0),
  };

  const totalBaseStat =
    Number(
      bs.bst ??
        stats.hp +
          stats.attack +
          stats.defense +
          stats.spAttack +
          stats.spDefense +
          stats.speed
    );

  const abilities = Array.isArray(entry.abilities) ? entry.abilities : [];
  const passive = entry.passive || null;

  // ---------- Level-up moves ----------
  const rawLevelUp = Array.isArray(entry.levelUpMoves)
    ? entry.levelUpMoves.filter((m) => m.level <= level)
    : [];

  const levelUpMoves = Array.from(
    new Map(
      rawLevelUp.map((m) => {
        const moveInfo = getMoveInfo(moveDB, m.name);
        return [
          m.name,
          {
            level: m.level,
            name: m.name,
            type: moveInfo.type,
            category: moveInfo.category,
            power: moveInfo.power,
            accuracy: moveInfo.accuracy,
          },
        ];
      })
    ).values()
  ).sort((a, b) => (a.level || 0) - (b.level || 0));

  // ---------- Egg moves ----------
  const eggNames = Array.isArray(entry.eggMoves) ? entry.eggMoves : [];
  const eggMovesList = eggNames.map((ename) => {
    const moveInfo = getMoveInfo(moveDB, ename);
    return {
      level: "Egg",
      name: ename,
      type: moveInfo.type,
      category: moveInfo.category,
      power: moveInfo.power,
      accuracy: moveInfo.accuracy,
    };
  });

  // ---------- TM moves ----------
  const tmNames = Array.isArray(entry.tmMoves) ? entry.tmMoves : [];
  const tmMovesList = tmNames.map((tname) => {
    const moveInfo = getMoveInfo(moveDB, tname);
    return {
      level: "TM",
      name: tname,
      type: moveInfo.type,
      category: moveInfo.category,
      power: moveInfo.power,
      accuracy: moveInfo.accuracy,
    };
  });

  const possibleMoves = levelUpMoves.concat(eggMovesList, tmMovesList);

  document.getElementById(
    "pr-title"
  ).textContent = `${displayName} (Lv ${level})`;

  const prLeft = document.getElementById("pr-left");
  if (prLeft) {
    prLeft.innerHTML = `
    <div class="pr-stats">
      <h4>Base Stats</h4>
      <div class="pr-stats-grid">
        <ul>
        <li><span>HP: </span><span>${stats.hp}</span></li>
        <li><span>Attack: </span><span>${stats.attack}</span></li>
        <li><span>Defense: </span><span>${stats.defense}</span></li>
        <li><span>Sp.Atk: </span><span>${stats.spAttack}</span></li>
        <li><span>Sp.Def: </span><span>${stats.spDefense}</span></li>
        <li><span>Speed: </span><span>${stats.speed}</span></li>
        <li><span>Total: </span><span>${totalBaseStat}</span></li>
        <li><span>Weight: </span><span>${entry.weight ?? "—"} kg</span></li>
        </ul>
      </div>
    </div>

    <div class="pr-abilities">
      <h4>Possible Abilities</h4>
      <ul id="pr-abilities-list">
        ${
          abilities.length > 0
            ? abilities.map((a) => `<li class="pr-ability" data-ability="${a}">${a}</li>`).join("")
            : "<li>Unknown</li>"
        }
        ${
          passive
            ? `<li class="pr-ability" data-ability="${passive}">${passive} <span class="pr-passive-tag">(Passive)</span></li>`
            : ""
        }
      </ul>
    </div>
  `;
    // Add event listeners for ability popups
    setTimeout(() => {
      const abilityData = window.ABILITY_DATA || {};
      document.querySelectorAll('.pr-ability').forEach(el => {
        el.addEventListener('click', e => {
          e.stopPropagation();
          const ability = el.getAttribute('data-ability');
          let desc = abilityData[ability]?.description || 'No description found.';
          showPopup(ability, desc);
        });
      });
    }, 0);
  }

  const tbody = document.querySelector("#pr-moves tbody");
  if (tbody) {
    tbody.innerHTML = possibleMoves
      .map(
        (m) => `
      <tr class="type-${m.type ? m.type.toLowerCase() : ''}">
        <td>${m.level ?? "—"}</td>
        <td><span class="pr-move" data-move="${m.name}">${capitalize(m.name)}</span></td>
        <td>${m.type ? capitalize(m.type) : "—"} / ${m.category ? capitalize(m.category) : "—"}</td>
        <td>${m.power ?? "—"} / ${m.accuracy ?? "—"}</td>
      </tr>
    `
      )
      .join("");
    // Add event listeners for move popups
    setTimeout(() => {
      document.querySelectorAll('.pr-move').forEach(el => {
        el.addEventListener('click', e => {
          e.stopPropagation();
          const move = el.getAttribute('data-move');
          const moveInfo = getMoveInfo(moveDB, move);
          let desc = moveInfo.description || 'No description found.';
          showPopup(move, desc);
        });
      });
    }, 0);
  }

  // Helper to show popup
  function showPopup(title, desc) {
    ensurePopupModalInPanel();
    const modal = document.getElementById('pr-popup-modal');
    if (modal) {
      const safeTitle = title ? String(title) : "Unknown";
      const safeDesc = desc ? String(desc) : "No description found.";
      modal.innerHTML = `
        <div id="pr-popup-content" style="background:#000;padding:16px 18px 16px 18px;border-radius:8px;max-width:320px;box-shadow:0 2px 16px #0008;position:relative;">
          <button id="pr-popup-close" style="position:absolute;top:8px;right:8px;font-size:18px;background:none;border:none;cursor:pointer;color:#fff;">&times;</button>
          <div id="pr-popup-title" style="font-weight:bold;margin-bottom:8px;color:#fff;">${safeTitle}</div>
          <div id="pr-popup-desc" style="white-space:pre-wrap;color:#fff;">${safeDesc}</div>
        </div>
      `;
      // Reattach close handlers after rendering
      modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
      const closeBtn = modal.querySelector('#pr-popup-close');
      if (closeBtn) closeBtn.onclick = (ev) => { ev.stopPropagation(); modal.style.display = 'none'; };
      // Position modal relative to the panel
      modal.style.display = 'block';
      modal.style.position = 'absolute'; // Ensure modal is absolute within panel
    }
  }
// ===============
// Load ability_data.json for popups
// ===============
(async function loadAbilityDataForPanel() {
  if (!window.ABILITY_DATA) {
    try {
      const resp = await fetch(chrome.runtime.getURL('ability_data.json'));
      window.ABILITY_DATA = await resp.json();
    } catch (e) {
      window.ABILITY_DATA = {};
    }
  }
})();
}

// =======================
// Build tabs for enemies
// =======================
function buildEnemyTabs(enemies, moveDB) {
  const tabsContainer = document.getElementById("pr-tabs");
  if (!tabsContainer) return;

  const newHash = enemies
    .map(
      (e) =>
        `${e.id}:${e.speciesId}:${e.speciesName || ""}:${e.level}:${
          e.lastHp
        }:${e.missingTicks || 0}`
    )
    .join("|");

  if (newHash === lastEnemyHash) {
    if (enemies.length === 0) {
      document.getElementById("pr-title").textContent =
        "No enemy Pokémon present.";
      document.getElementById("pr-left").innerHTML = "";
      const tbodyEmpty = document.querySelector("#pr-moves tbody");
      if (tbodyEmpty) tbodyEmpty.innerHTML = "";
    } else if (enemies[currentTabIndex]) {
      renderEnemy(enemies[currentTabIndex], moveDB);
    }
    return;
  }

  lastEnemyHash = newHash;
  currentTabIndex = 0;
  tabsContainer.innerHTML = "";

  if (!enemies || enemies.length === 0) {
    document.getElementById("pr-title").textContent =
      "No enemy Pokémon present.";
    document.getElementById("pr-left").innerHTML = "";
    const tbodyEmpty = document.querySelector("#pr-moves tbody");
    if (tbodyEmpty) tbodyEmpty.innerHTML = "";
    return;
  }

  enemies.forEach((enemy, idx) => {
    const entry = findBestPokedexEntryForEnemy(enemy);
    const displayName = entry
      ? entry.displayName || entry.name || `ID ${enemy.speciesId}`
      : enemy.speciesName || `ID ${enemy.speciesId}`;

    const btn = document.createElement("button");
    btn.className = "pr-tab-button";
    btn.textContent = `Poké ${idx + 1}`;

    btn.addEventListener("click", () => {
      currentTabIndex = idx;
      [...tabsContainer.children].forEach((c) =>
        c.classList.remove("active")
      );
      btn.classList.add("active");
      renderEnemy(enemy, moveDB);
    });

    tabsContainer.appendChild(btn);
  });

  // If any of the provided enemies is Eternatus, append an Eternamax tab
  const hasEternatus = enemies.some((e) => {
    const name = e.speciesName || "";
    return (
      normalizeBaseSpeciesName(name) === "eternatus" ||
      String(name).toLowerCase().includes("eternatus")
    );
  });

  if (hasEternatus) {
    let eternamaxEntry = null;
    if (typeof POKEDEX !== "undefined" && Array.isArray(POKEDEX)) {
      eternamaxEntry = POKEDEX.find((entry) => {
        const dn = (entry.displayName || entry.name || "").toLowerCase();
        return dn.includes("eternamax");
      });
    }

    const emDisplayName =
      (eternamaxEntry && (eternamaxEntry.displayName || eternamaxEntry.name)) ||
      "Eternamax Eternatus";

    const emBtn = document.createElement("button");
    emBtn.className = "pr-tab-button pr-eternamax-button";
    emBtn.textContent = emDisplayName;

    const syntheticEnemy = {
      id: "eternamax",
      speciesId: eternamaxEntry ? eternamaxEntry.speciesId : enemies[0]?.speciesId,
      speciesName: emDisplayName,
      biome: enemies[0]?.biome ?? null,
      level: enemies[0]?.level ?? 100,
    };

    emBtn.addEventListener("click", () => {
      currentTabIndex = Array.from(tabsContainer.children).indexOf(emBtn);
      [...tabsContainer.children].forEach((c) => c.classList.remove("active"));
      emBtn.classList.add("active");
      renderEnemy(syntheticEnemy, moveDB);
    });

    tabsContainer.appendChild(emBtn);
  }

  // If Rotom is present among the enemies, append tabs for all Rotom forms
  const hasRotom = enemies.some((e) => {
    const name = e.speciesName || "";
    return (
      normalizeBaseSpeciesName(name) === "rotom" ||
      String(name).toLowerCase().includes("rotom")
    );
  });

  if (hasRotom) {
    let rotomEntries = [];
    if (typeof POKEDEX !== "undefined" && Array.isArray(POKEDEX)) {
      rotomEntries = POKEDEX.filter((entry) => {
        if (!entry) return false;
        const dn = (entry.displayName || entry.name || "").toLowerCase();
        return dn.includes("rotom");
      });
    }

    const seen = new Set();
    rotomEntries.forEach((entry) => {
      const label = (entry.displayName || entry.name || "").trim();
      const formName = (entry.form || "").trim();
      const isBaseRotom = label.toLowerCase() === "rotom" || formName === "";
      if (isBaseRotom) return;
      if (!label || seen.has(label)) return;
      seen.add(label);

      const rBtn = document.createElement("button");
      rBtn.className = "pr-tab-button pr-rotom-button";
      rBtn.textContent = label;

      const syntheticRotom = {
        id: `rotom-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        speciesId: entry.speciesId,
        speciesName: label,
        biome: enemies[0]?.biome ?? null,
        level: enemies[0]?.level ?? 50,
        baseStats: entry.baseStats || null,
      };

      rBtn.addEventListener("click", () => {
        currentTabIndex = Array.from(tabsContainer.children).indexOf(rBtn);
        [...tabsContainer.children].forEach((c) => c.classList.remove("active"));
        rBtn.classList.add("active");
        renderEnemy(syntheticRotom, moveDB);
      });

      tabsContainer.appendChild(rBtn);
    });
  }

  // If Paldea Tauros speciesId is present, append tabs for all Paldean Tauros forms
  const hasPaldeaTauros = enemies.some((e) => Number(e.speciesId) === 8128);
  if (hasPaldeaTauros) {
    let taurosEntries = [];
    if (typeof POKEDEX !== "undefined" && Array.isArray(POKEDEX)) {
      taurosEntries = POKEDEX.filter((entry) => {
        if (!entry) return false;
        const dn = (entry.displayName || entry.name || "").toLowerCase();
        const form = (entry.form || "").toLowerCase();
        const isTauros = dn.includes("tauros") || (entry.name || "").toLowerCase().includes("tauros");
        const isPaldeaForm =
          dn.includes("paldea") ||
          dn.includes("paldean") ||
          form.includes("paldea") ||
          form.includes("paldean") ||
          form.includes("combat") ||
          form.includes("blaze") ||
          form.includes("aqua");
        return isTauros && isPaldeaForm;
      });
    }

    const seenTauros = new Set();
    taurosEntries.forEach((entry) => {
      const label = (entry.displayName || entry.name || "").trim();
      if (!label || seenTauros.has(label)) return;
      seenTauros.add(label);

      const tBtn = document.createElement("button");
      tBtn.className = "pr-tab-button pr-tauros-pal";
      tBtn.textContent = label;

      const syntheticTauros = {
        id: `tauros-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        speciesId: entry.speciesId,
        speciesName: label,
        biome: enemies[0]?.biome ?? null,
        level: enemies[0]?.level ?? 50,
        baseStats: entry.baseStats || null,
      };

      tBtn.addEventListener("click", () => {
        currentTabIndex = Array.from(tabsContainer.children).indexOf(tBtn);
        [...tabsContainer.children].forEach((c) => c.classList.remove("active"));
        tBtn.classList.add("active");
        renderEnemy(syntheticTauros, moveDB);
      });

      tabsContainer.appendChild(tBtn);
    });
  }

    // If Eiscue is present, append a "No Ice" form tab
    const hasEiscue = enemies.some((e) => {
      const name = e.speciesName || "";
      return (
        normalizeBaseSpeciesName(name) === "eiscue" ||
        String(name).toLowerCase().includes("eiscue")
      );
    });

    if (hasEiscue) {
      let noIceEntry = null;
      if (typeof POKEDEX !== "undefined" && Array.isArray(POKEDEX)) {
        noIceEntry = POKEDEX.find((entry) => {
          if (!entry) return false;
          const dn = (entry.displayName || entry.name || "").toLowerCase();
          const form = (entry.form || "").toLowerCase();
          return (
            dn.includes("eiscue") &&
            (dn.includes("no ice") || dn.includes("no-ice") || dn.includes("noice") || form.includes("no ice") || form.includes("no-ice"))
          );
        });
      }

      const niDisplayName =
        (noIceEntry && (noIceEntry.displayName || noIceEntry.name)) ||
        "Eiscue (No Ice)";

      const niBtn = document.createElement("button");
      niBtn.className = "pr-tab-button pr-eiscue-noice";
      niBtn.textContent = niDisplayName;

      const syntheticNoIce = {
        id: "eiscue-noice",
        speciesId: noIceEntry ? noIceEntry.speciesId : enemies[0]?.speciesId,
        speciesName: niDisplayName,
        biome: enemies[0]?.biome ?? null,
        level: enemies[0]?.level ?? 50,
      };

      niBtn.addEventListener("click", () => {
        currentTabIndex = Array.from(tabsContainer.children).indexOf(niBtn);
        [...tabsContainer.children].forEach((c) => c.classList.remove("active"));
        niBtn.classList.add("active");
        renderEnemy(syntheticNoIce, moveDB);
      });

      tabsContainer.appendChild(niBtn);
    }

  if (tabsContainer.children.length > 0) {
    tabsContainer.children[0].classList.add("active");
  }

  renderEnemy(enemies[0], moveDB);
}

// =======================
// Hotkey: P to toggle panel + zoom
// =======================
document.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;

  if (e.key === "p" || e.key === "P") {
    const panel =
      document.getElementById("pokerogue-helper-panel") || ensurePanel();
    if (!panel) return;

    panelVisible = !panelVisible;
    panel.style.display = panelVisible ? "flex" : "none";

    try {
      document.documentElement.style.zoom = panelVisible ? "0.9" : "1";
    } catch (err) {
      console.warn("Failed to adjust zoom on panel toggle:", err);
    }
  }
});

// Hotkey: Q to cycle through tabs
document.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;

  if (e.key === "q" || e.key === "Q") {
    const tabsContainer = document.getElementById("pr-tabs");
    if (!tabsContainer) return;
    // If tabs hidden, do nothing
    if (tabsContainer.style.display === "none") return;

    const children = Array.from(tabsContainer.children);
    if (children.length === 0) return;

    const activeIndex = children.findIndex((c) => c.classList.contains("active"));
    const nextIndex = (activeIndex + 1) % children.length;

    // Trigger the existing click handler for the next tab/button
    children[nextIndex].click();
    try {
      children[nextIndex].focus();
    } catch (err) {
      /* ignore */
    }
  }
});

// =======================
// Listen for enemy Pokémon updates from pageHook
// =======================
window.addEventListener("message", async (event) => {
  if (!event.data || event.data.type !== "POKEROGUE_ENEMY_SPECIES") return;
  if (!extensionAlive) return;

  const panel = ensurePanel();
  initializePanelLayout(panel);

  try {
    let currentEnemies = [];

    if (Array.isArray(event.data.enemies) && event.data.enemies.length > 0) {
      currentEnemies = event.data.enemies.map((e, idx) => ({
        id: e.id || `${e.speciesId}-${idx}`,
        speciesId: e.speciesId,
        speciesName: e.speciesName || null,
        biome: e.biome ?? event.data.biome ?? null,
        level: e.level,
        hp: e.hp,
        maxHp: e.maxHp,
        baseStats: e.baseStats || null,
        currentStats: e.currentStats || null,
        abilityName: e.abilityName || null,
        passiveName: e.passiveName || null,
        knownMoves: Array.isArray(e.knownMoves) ? e.knownMoves.slice() : [],
      }));
    } else if (event.data.speciesId) {
      // Fallback shape if a single enemy is sent without an array
      currentEnemies = [
        {
          id: event.data.id ?? `${event.data.speciesId}-${event.data.level}`,
          speciesId: event.data.speciesId,
          speciesName: event.data.speciesName ?? null,
          biome: event.data.biome ?? null,
          level: event.data.level,
          hp: event.data.hp ?? 1,
          maxHp: event.data.maxHp ?? 1,
          baseStats: event.data.baseStats ?? null,
          currentStats: event.data.currentStats ?? null,
          abilityName: event.data.abilityName || null,
          passiveName: event.data.passiveName || null,
          knownMoves: Array.isArray(event.data.knownMoves)
            ? event.data.knownMoves.slice()
            : [],
        },
      ];
    }

    // Mark all known enemies as not seen this tick
    revealedEnemies.forEach((entry) => {
      entry._seenThisTick = false;
    });

    // Process current enemies
    for (const enemy of currentEnemies) {
      if (!enemy.id) {
        enemy.id = `${enemy.speciesId}-${enemy.level}`;
      }

      let entry = revealedEnemies.get(enemy.id);
      if (!entry) {
        entry = {
          id: enemy.id,
          speciesId: enemy.speciesId,
          speciesName: enemy.speciesName || null,
          biome: enemy.biome ?? null,
          level: enemy.level,
          lastHp: enemy.hp,
          maxHp: enemy.maxHp,
          baseStats: enemy.baseStats || null,
          currentStats: enemy.currentStats || null,
          abilityName: enemy.abilityName || null,
          passiveName: enemy.passiveName || null,
          knownMoves: Array.isArray(enemy.knownMoves)
            ? enemy.knownMoves.slice()
            : [],
          missingTicks: 0,
        };
        revealedEnemies.set(enemy.id, entry);
      } else {
        entry.speciesId = enemy.speciesId;
        entry.speciesName = enemy.speciesName || null;
        entry.level = enemy.level;
        entry.lastHp = enemy.hp;
        entry.maxHp = enemy.maxHp;
        entry.missingTicks = 0;

        if (enemy.biome != null) {  
          entry.biome = enemy.biome;
        }

        if (enemy.baseStats) {
          entry.baseStats = enemy.baseStats;
        }
        if (enemy.currentStats) {
          entry.currentStats = enemy.currentStats;
        }
        if (enemy.abilityName) {
          entry.abilityName = enemy.abilityName;
        }
        if (enemy.passiveName) {
          entry.passiveName = enemy.passiveName;
        }
        if (Array.isArray(enemy.knownMoves) && enemy.knownMoves.length > 0) {
          entry.knownMoves = enemy.knownMoves.slice();
        }
      }

      entry._seenThisTick = true;
    }

    // Remove fainted or long-gone enemies
    revealedEnemies.forEach((entry, id) => {
      if (!entry._seenThisTick) {
        if (entry.lastHp <= 0) {
          revealedEnemies.delete(id);
        } else {
          entry.missingTicks = (entry.missingTicks || 0) + 1;
          if (entry.missingTicks >= MAX_MISSING_TICKS) {
            revealedEnemies.delete(id);
          }
        }
      }
      delete entry._seenThisTick;
    });

    const moveData = await loadMoveDB();
    if (!extensionAlive) return;

    const revealedList = Array.from(revealedEnemies.values());
    const activeCount = currentEnemies.length;
      const tabsContainer = document.getElementById("pr-tabs");

      // Show tabs when two active enemies OR when Eternatus is present
      const isEternatusPresent = currentEnemies.some((e) => {
        const name = e.speciesName || "";
        return (
          normalizeBaseSpeciesName(name) === "eternatus" ||
          String(name).toLowerCase().includes("eternatus")
        );
      });
      const isEiscuePresent = currentEnemies.some((e) => {
        const name = e.speciesName || "";
        return (
          normalizeBaseSpeciesName(name) === "eiscue" ||
          String(name).toLowerCase().includes("eiscue")
        );
      });
      const isRotomPresent = currentEnemies.some((e) => {
        const name = e.speciesName || "";
        return (
          normalizeBaseSpeciesName(name) === "rotom" ||
          String(name).toLowerCase().includes("rotom")
        );
      });
      const isPaldeaTaurosPresent = currentEnemies.some((e) => Number(e.speciesId) === 8128);

      if (tabsContainer && (activeCount > 1 || isEternatusPresent || isEiscuePresent || isRotomPresent || isPaldeaTaurosPresent)) {
        // Two active enemies or Eternatus present: show tabs (Eternamax tab will be added)
        tabsContainer.style.display = "";
        // Use the live `currentEnemies` when there are two or more active enemies,
        // otherwise show tabs derived from revealedList (for single Eiscue/Eternatus cases)
        const tabSource = activeCount >= 2 ? currentEnemies : revealedList;
        buildEnemyTabs(tabSource, moveData);
      } else {
      // Single (or 0) enemy: no tabs, just show most relevant
      if (tabsContainer) {
        tabsContainer.innerHTML = "";
        tabsContainer.style.display = "none";
      }

      let enemyToRender = null;
      if (currentEnemies.length > 0) {
        enemyToRender = currentEnemies[0];
      } else if (revealedList.length > 0) {
        enemyToRender = revealedList[0];
      }

      if (enemyToRender) {
        renderEnemy(enemyToRender, moveData);
      } else {
        document.getElementById("pr-title").textContent =
          "No enemy Pokémon present.";
        document.getElementById("pr-left").innerHTML = "";
        const tbodyEmpty = document.querySelector("#pr-moves tbody");
        if (tbodyEmpty) tbodyEmpty.innerHTML = "";
      }
    }
  } catch (err) {
    if (err.message && err.message.includes("Extension context invalidated")) {
      return;
    }
    console.error("Pokerogue Helper error:", err);
    document.getElementById("pr-title").textContent =
      "Error loading Pokémon data.";
  }
});