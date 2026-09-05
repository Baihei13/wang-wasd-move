/**
 * wang-wasd-move
 * Players: keyboard-only token movement outside combat; mouse free in combat.
 * GMs are never restricted.
 */

const MODULE_ID = "wang-wasd-move";

/** @type {Set<string>} */
const heldKeys = new Set();
let stepQueued = false;
let lastBlockNotify = 0;
let dragWrapped = false;
let combatWasStarted = false;

function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

function combatStarted() {
  return Boolean(game.combat?.started);
}

/**
 * True when this client should block mouse-based token moves.
 */
export function isMouseMoveRestricted() {
  if (!game.user || game.user.isGM) return false;
  if (!setting("enabled")) return false;
  if (setting("allowInCombat") && combatStarted()) return false;
  return true;
}

function notifyBlocked() {
  if (!setting("notifyBlocked")) return;
  const now = Date.now();
  if (now - lastBlockNotify < 2500) return;
  lastBlockNotify = now;
  ui.notifications.warn(game.i18n.localize("WANGWASD.Notify.Blocked"));
}

function getTokenClass() {
  return CONFIG.Token?.objectClass
    ?? CONFIG.Token?.objectClass?.prototype?.constructor
    ?? foundry?.canvas?.placeables?.Token
    ?? globalThis.Token;
}

function wrapDragGuards() {
  if (dragWrapped) return;
  const TokenClass = getTokenClass();
  if (!TokenClass?.prototype) {
    console.error(`${MODULE_ID} | Token class not found`);
    return;
  }

  const proto = TokenClass.prototype;
  const methods = ["_canDrag", "_canDragLeftStart"].filter((m) => typeof proto[m] === "function");
  if (!methods.length) {
    console.warn(`${MODULE_ID} | No drag methods to wrap`);
    return;
  }

  const useLib = Boolean(game.modules.get("lib-wrapper")?.active && globalThis.libWrapper);
  for (const method of methods) {
    const target = `Token.prototype.${method}`;
    if (useLib) {
      try {
        libWrapper.register(
          MODULE_ID,
          target,
          function (wrapped, ...args) {
            if (isMouseMoveRestricted()) {
              notifyBlocked();
              return false;
            }
            return wrapped(...args);
          },
          "MIXED"
        );
        continue;
      } catch (err) {
        // V13+ may need fully-qualified path
        try {
          libWrapper.register(
            MODULE_ID,
            `foundry.canvas.placeables.Token.prototype.${method}`,
            function (wrapped, ...args) {
              if (isMouseMoveRestricted()) {
                notifyBlocked();
                return false;
              }
              return wrapped(...args);
            },
            "MIXED"
          );
          continue;
        } catch (err2) {
          console.warn(`${MODULE_ID} | libWrapper failed for ${method}, falling back`, err2);
        }
      }
    }

    const original = proto[method];
    proto[method] = function (...args) {
      if (isMouseMoveRestricted()) {
        notifyBlocked();
        return false;
      }
      return original.apply(this, args);
    };
  }

  dragWrapped = true;
}

function shiftedTopLeft(x, y, sx, sy) {
  const grid = canvas.grid;
  if (!grid) {
    return { x: x + sx * 100, y: y + sy * 100 };
  }

  if (typeof grid.getOffset === "function" && typeof grid.getTopLeftPoint === "function") {
    try {
      const o = grid.getOffset({ x, y });
      if (o && Number.isFinite(o.i) && Number.isFinite(o.j)) {
        const p = grid.getTopLeftPoint({ i: o.i + sy, j: o.j + sx });
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
      }
    } catch {
      /* fall through */
    }
  }

  if (typeof grid.getShiftedPoint === "function") {
    try {
      const p = grid.getShiftedPoint({ x, y }, { di: sy, dj: sx });
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
    } catch {
      /* fall through */
    }
  }

  const w = Number(grid.sizeX ?? grid.size ?? 100) || 100;
  const h = Number(grid.sizeY ?? grid.size ?? 100) || 100;
  return { x: x + sx * w, y: y + sy * h };
}

function getControlledOwnedToken() {
  const list = canvas.tokens?.controlled ?? [];
  const owned = list.find((t) => t.isOwner) ?? (game.user.isGM ? list[0] : null);
  return owned ?? null;
}

async function nudgeOwnedToken(sx, sy) {
  if (!canvas?.ready) return false;
  if (!sx && !sy) return false;

  const token = getControlledOwnedToken();
  if (!token) {
    ui.notifications.warn(
      game.i18n.localize("CONTROLS.NoControlledToken") || "请先选中自己的 Token"
    );
    return false;
  }
  if (!token.isOwner && !game.user.isGM) return false;

  const doc = token.document;
  const from = { x: doc.x, y: doc.y };
  const next = shiftedTopLeft(from.x, from.y, sx, sy);
  if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) return false;
  if (Math.abs(next.x - from.x) < 0.5 && Math.abs(next.y - from.y) < 0.5) return false;

  try {
    // Prefer Foundry movement API when present (handles walls / constrained path better)
    if (typeof doc.move === "function") {
      await doc.move(next, { constrainOptions: { ignoreWalls: false } });
    } else {
      await doc.update({ x: next.x, y: next.y }, { animate: true });
    }
    return true;
  } catch (err) {
    console.warn(`${MODULE_ID} | move failed`, err);
    try {
      await doc.update({ x: next.x, y: next.y }, { animate: true });
      return true;
    } catch (err2) {
      console.error(`${MODULE_ID} | update failed`, err2);
      return false;
    }
  }
}

function directionFromHeldKeys() {
  let sx = 0;
  let sy = 0;
  if (heldKeys.has("KeyA")) sx -= 1;
  if (heldKeys.has("KeyD")) sx += 1;
  if (heldKeys.has("KeyW")) sy -= 1;
  if (heldKeys.has("KeyS")) sy += 1;

  // Without diagonals, prefer horizontal when both axes held
  if (!setting("stepDiagonals") && sx && sy) {
    return { sx, sy: 0 };
  }
  return { sx, sy };
}

function queueStep() {
  if (stepQueued) return;
  stepQueued = true;
  queueMicrotask(async () => {
    stepQueued = false;
    if (document.activeElement?.closest?.("input, textarea, [contenteditable='true'], .ProseMirror")) {
      return;
    }
    const { sx, sy } = directionFromHeldKeys();
    if (!sx && !sy) return;
    await nudgeOwnedToken(sx, sy);
  });
}

function registerKeybindings() {
  // Only WASD here — Foundry core already provides arrow-key token movement.
  const dirs = [
    { id: "moveNorth", label: "WANGWASD.Key.MoveNorth", keys: ["KeyW"], sx: 0, sy: -1 },
    { id: "moveSouth", label: "WANGWASD.Key.MoveSouth", keys: ["KeyS"], sx: 0, sy: 1 },
    { id: "moveWest", label: "WANGWASD.Key.MoveWest", keys: ["KeyA"], sx: -1, sy: 0 },
    { id: "moveEast", label: "WANGWASD.Key.MoveEast", keys: ["KeyD"], sx: 1, sy: 0 },
  ];

  for (const d of dirs) {
    game.keybindings.register(MODULE_ID, d.id, {
      name: d.label,
      editable: d.keys.map((key) => ({ key })),
      precedence: CONST.KEYBINDING_PRECEDENCE?.PRIORITY ?? 0,
      onDown: () => {
        for (const k of d.keys) heldKeys.add(k);
        queueStep();
        return true;
      },
      onUp: () => {
        for (const k of d.keys) heldKeys.delete(k);
        return true;
      },
      repeat: true,
      restricted: false,
    });
  }
}

function ensureHintElement() {
  let el = document.getElementById("wang-wasd-hint");
  if (el) return el;
  el = document.createElement("div");
  el.id = "wang-wasd-hint";
  document.body.appendChild(el);
  return el;
}

function refreshHint() {
  if (!game.user || game.user.isGM || !setting("showHint") || !setting("enabled")) {
    document.getElementById("wang-wasd-hint")?.classList.remove("visible", "combat");
    return;
  }
  const el = ensureHintElement();
  const inCombat = setting("allowInCombat") && combatStarted();
  el.textContent = game.i18n.localize(inCombat ? "WANGWASD.Hud.CombatFree" : "WANGWASD.Hud.Restricted");
  el.classList.toggle("combat", inCombat);
  el.classList.add("visible");
}

function onCombatStateChanged(notifyPlayers = false) {
  const started = combatStarted();
  refreshHint();
  if (!notifyPlayers || game.user.isGM) {
    combatWasStarted = started;
    return;
  }
  if (started && !combatWasStarted && setting("allowInCombat") && setting("enabled")) {
    ui.notifications.info(game.i18n.localize("WANGWASD.Notify.CombatOpen"));
  } else if (!started && combatWasStarted && setting("allowInCombat") && setting("enabled")) {
    ui.notifications.info(game.i18n.localize("WANGWASD.Notify.CombatClosed"));
  }
  combatWasStarted = started;
}

function registerSettings() {
  game.settings.register(MODULE_ID, "enabled", {
    name: "WANGWASD.Settings.Enabled.Name",
    hint: "WANGWASD.Settings.Enabled.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => refreshHint(),
  });

  game.settings.register(MODULE_ID, "allowInCombat", {
    name: "WANGWASD.Settings.AllowInCombat.Name",
    hint: "WANGWASD.Settings.AllowInCombat.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => refreshHint(),
  });

  game.settings.register(MODULE_ID, "notifyBlocked", {
    name: "WANGWASD.Settings.NotifyBlocked.Name",
    hint: "WANGWASD.Settings.NotifyBlocked.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, "showHint", {
    name: "WANGWASD.Settings.ShowHint.Name",
    hint: "WANGWASD.Settings.ShowHint.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => refreshHint(),
  });

  game.settings.register(MODULE_ID, "stepDiagonals", {
    name: "WANGWASD.Settings.StepDiagonals.Name",
    hint: "WANGWASD.Settings.StepDiagonals.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
}

Hooks.once("init", () => {
  registerSettings();
  registerKeybindings();
});

Hooks.once("setup", () => {
  wrapDragGuards();
});

Hooks.once("ready", () => {
  wrapDragGuards();
  combatWasStarted = combatStarted();
  refreshHint();
  console.log(`${MODULE_ID} | ready (mouse restricted outside combat for players)`);
});

Hooks.on("canvasReady", () => refreshHint());
Hooks.on("combatStart", () => onCombatStateChanged(true));
Hooks.on("deleteCombat", () => onCombatStateChanged(true));
Hooks.on("updateCombat", (combat, changed) => {
  if ("started" in changed || "round" in changed || "turn" in changed) {
    onCombatStateChanged(true);
  }
});

// Extra safety: cancel in-progress player token drag if combat ends mid-drag
Hooks.on("refreshToken", (token) => {
  if (!isMouseMoveRestricted()) return;
  if (!token?.isOwner || game.user.isGM) return;
  if (token._dragPassthrough || token.interactionState === undefined) return;
});

globalThis.wangWasdMove = {
  isMouseMoveRestricted,
  nudgeOwnedToken,
  refreshHint,
};
