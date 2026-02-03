(function () {
  function normalizeBaseStats(bs) {
    if (!bs) return null;

    // Supports both array [hp, atk, def, spa, spd, spe]
    // and object { hp, atk, def, spa, spd, spe, ... }
    if (Array.isArray(bs)) {
      return {
        hp: Number(bs[0]),
        atk: Number(bs[1]),
        def: Number(bs[2]),
        spa: Number(bs[3]),
        spd: Number(bs[4]),
        spe: Number(bs[5]),
      };
    }

    const stats = bs || {};
    return {
      hp: Number(stats.hp ?? stats.HP ?? stats[0] ?? 0),
      atk: Number(stats.atk ?? stats.attack ?? stats.ATK ?? stats[1] ?? 0),
      def: Number(stats.def ?? stats.defense ?? stats.DEF ?? stats[2] ?? 0),
      spa: Number(stats.spa ?? stats.spAtk ?? stats.sp_atk ?? stats[3] ?? 0),
      spd: Number(stats.spd ?? stats.spDef ?? stats.sp_def ?? stats[4] ?? 0),
      spe: Number(stats.spe ?? stats.speed ?? stats[5] ?? 0),
    };
  }

  function normalizeCurrentStats(stats) {
    if (!stats) return null;
    if (Array.isArray(stats)) {
      return {
        hp: Number(stats[0] ?? 0),
        atk: Number(stats[1] ?? 0),
        def: Number(stats[2] ?? 0),
        spa: Number(stats[3] ?? 0),
        spd: Number(stats[4] ?? 0),
        spe: Number(stats[5] ?? 0),
      };
    }

    return {
      hp: Number(stats.hp ?? stats[0] ?? 0),
      atk: Number(stats.atk ?? stats.attack ?? stats[1] ?? 0),
      def: Number(stats.def ?? stats.defense ?? stats[2] ?? 0),
      spa: Number(stats.spa ?? stats.spAtk ?? stats.sp_atk ?? stats[3] ?? 0),
      spd: Number(stats.spd ?? stats.spDef ?? stats.sp_def ?? stats[4] ?? 0),
      spe: Number(stats.spe ?? stats.speed ?? stats[5] ?? 0),
    };
  }

  setInterval(() => {
    const arc = parent?.ARC;
    const enemies = arc?.State?.enemies;
    const db = arc?.DB;
    const biome = arc?.State?.biome ?? null; 

    if (!Array.isArray(enemies) || enemies.length === 0) return;

    const payloadEnemies = enemies.map((e, idx) => {
      const speciesId = e.speciesId ?? e.speciesID;
      let speciesName = null;
      let baseStats = null;

            // Try to get name + base stats from ARC.DB.getSpecies
      if (db && typeof db.getSpecies === "function" && speciesId != null) {
        try {
          const speciesData = db.getSpecies(speciesId);

          // For alternate forms this "name" can be ".", which we want to keep
          if (speciesData && typeof speciesData === "object") {
            if (typeof speciesData.name === "string") {
              speciesName = speciesData.name.trim();
            } else {
              speciesName = null;
            }

            if (speciesData.baseStats) {
              baseStats = normalizeBaseStats(speciesData.baseStats);
            }
          }
        } catch (err) {
          console.warn("ARC.DB.getSpecies failed:", err);
        }
      }
      // Ability & passive from the live enemy state
      let abilityName = null;
      let passiveName = null;

      try {
        if (e.abilityName) {
          abilityName = String(e.abilityName).trim();
        } else if (e.ability && typeof e.ability === "object") {
          if (e.ability.name) abilityName = String(e.ability.name).trim();
          else if (e.ability.abilityName) abilityName = String(e.ability.abilityName).trim();
        }

        if (!abilityName && db && typeof db.getAbility === "function") {
          const abilityId = e.abilityId ?? e.abilityID ?? (typeof e.ability === "number" ? e.ability : null);
          if (abilityId != null) {
            try {
              const ability = db.getAbility(abilityId);
              if (ability?.name) abilityName = String(ability.name).trim();
            } catch (err) {
              console.warn("ARC.DB.getAbility failed:", err);
            }
          }
        }
      } catch (err) {
        console.warn("Failed to read abilityName from enemy:", err);
      }

      try {
        if (e.passiveName != null) {
          passiveName = String(e.passiveName).trim();
        } else if (e.passive && typeof e.passive === "object") {
          if (e.passive.name) passiveName = String(e.passive.name).trim();
          else if (e.passive.passiveName) passiveName = String(e.passive.passiveName).trim();
        } else if (e.passive != null) {
          passiveName = String(e.passive).trim();
        }

        if (!passiveName && db && typeof db.getAbility === "function") {
          const passiveId = e.passiveId ?? e.passiveID ?? (typeof e.passive === "number" ? e.passive : null);
          if (passiveId != null) {
            try {
              const passive = db.getAbility(passiveId);
              if (passive?.name) passiveName = String(passive.name).trim();
            } catch (err) {
              console.warn("ARC.DB.getAbility failed (passive):", err);
            }
          }
        }
      } catch (err) {
        console.warn("Failed to read passiveName from enemy:", err);
      }


      // Moves: enemy's known moves as names (we still send them,
      // but the matching logic in content.js no longer uses them)
      let knownMoves = [];
      try {
        const moveset = e.moveset;
        const moveNames = [];

        if (Array.isArray(moveset)) {
          for (const m of moveset) {
            if (!m) continue;

            // Common patterns:
            if (m.name) {
              moveNames.push(String(m.name).trim());
              continue;
            }
            if (m.moveName) {
              moveNames.push(String(m.moveName).trim());
              continue;
            }

            // Fallback: resolve via ARC.DB.getMove + an ID
            if (db && typeof db.getMove === "function") {
              const id = m.id ?? m.move ?? m.moveId;
              if (id != null) {
                try {
                  const mv = db.getMove(id);
                  if (mv && mv.name) {
                    moveNames.push(String(mv.name).trim());
                  }
                } catch (err) {
                  console.warn("ARC.DB.getMove failed:", err);
                }
              }
            }
          }
        }

        knownMoves = [...new Set(moveNames.filter(Boolean))];
      } catch (err) {
        console.warn("Failed to parse enemy moveset:", err);
      }

      return {
        id: e.id ?? `${speciesId}-${idx}`,
        speciesId,
        speciesName,
        biome,
        level: e.level,
        hp: e.hp,
        maxHp: e.maxHp,
        baseStats,                       // from ARC.DB.getSpecies (if available)
        currentStats: normalizeCurrentStats(e.stats), // current in-battle stats
        abilityName,
        passiveName,
        knownMoves,
      };
    });

    window.postMessage(
      {
        type: "POKEROGUE_ENEMY_SPECIES",
        enemies: payloadEnemies,
      },
      "*"
    );
  }, 300);
})();