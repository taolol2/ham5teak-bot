require("dotenv").config();
const mineflayer = require('mineflayer');
const http = require('http');

// ---------------- KEEP-ALIVE HTTP SERVER ----------------
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('RockyRidge Minecraft Bot is running 24/7!');
}).listen(PORT, () => {
  console.log(`[HTTP] Keep-alive server active on port ${PORT}`);
});

process.on('uncaughtException', (e) => console.log('[SYS ERROR] Uncaught:', e.message));
process.on('unhandledRejection', (e) => console.log('[SYS ERROR] Unhandled:', e && e.message));

// ---------------- SETTINGS ----------------
const SERVER_IP = 'play.ham5teak.net';
const SERVER_PORT = 25565;
const BOT_USERNAME = 'RockyRidge';
const AUTH_PASSWORD = process.env.MC_PASSWORD;

// 100 Natural human chat phrases
const RANDOM_CHAT_PHRASES = [
  "lol", "anyone selling keys?", "lag", "oof", "damn", "gg", "wow", "bruh", "true", "wait",
  "anyone got food?", "so true", "yikes", "rip", "lets go", "oh", "nope", "yep", "nice", "ok",
  "hm", "why", "idk", "bro", "help", "afk", "back", "reloading", "fast", "slow",
  "anyone online?", "base", "home", "shop", "sell", "buy", "trade", "money", "rich", "poor",
  "ggs", "ez", "cmon", "task", "work", "grind", "farm", "mob", "raid", "spawn",
  "warp", "tp", "home sweet home", "lagging", "ping", "fps", "smooth", "hard", "easy", "cool",
  "nice armor", "nice sword", "epic", "legend", "team", "party", "koth", "event", "vote", "keys",
  "crate", "open", "win", "lose", "dead", "alive", "heal", "food", "potion", "bottle", "bad",
  "good", "best", "worst", "clean", "dirty", "time", "day", "night", "sun", "rain", "storm",
  "mining", "builder", "miner", "player", "yo", "sup", "brb", "wb", "ty", "np", "pls", "thx"
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let runId = 0;

function startBot() {
  const myId = ++runId;
  const stillMe = () => myId === runId;

  console.log(`[SYS] Connecting to ${SERVER_IP}...`);

  const bot = mineflayer.createBot({
    host: SERVER_IP,
    port: SERVER_PORT,
    username: BOT_USERNAME,
    auth: 'offline',
    version: false // Enables auto-version negotiation to fix ECONNRESET/EPIPE errors
  });

  let loggedIn = false;
  let onSurvival = false;
  let isIdle = false;
  let isBusyWithGui = false;
  let ended = false;

  let attackInterval = null;
  let sellInterval = null;
  let chatInterval = null;
  let payInterval = null;
  let healthCheckInterval = null;

  const say = (msg) => {
    try { bot.chat(msg); } catch (e) {}
  };

  function ensureSwordEquipped() {
    if (bot.quickBarSlot !== 0) {
      bot.setQuickBarSlot(0);
    }
  }

  // --- ATTACK LOOP (Sweeping Edge mob targeting) ---
  function startAttackLoop() {
    if (attackInterval) clearInterval(attackInterval);

    const scheduleNextSwing = () => {
      if (ended || !stillMe()) return;

      const delay = 3850 + Math.floor(Math.random() * 300);

      attackInterval = setTimeout(() => {
        if (loggedIn && onSurvival && !isIdle && !isBusyWithGui) {
          ensureSwordEquipped();

          const targetMob = bot.nearestEntity((entity) => {
            return (
              (entity.type === 'mob' || entity.type === 'hostile') &&
              entity.position.distanceTo(bot.entity.position) <= 3.5
            );
          });

          try {
            if (targetMob) {
              bot.attack(targetMob);
            } else {
              bot.swingArm('right');
            }
          } catch (e) {}
        }
        scheduleNextSwing();
      }, delay);
    };

    scheduleNextSwing();
  }

  // --- SELLGUI ROUTINE (Every 4 minutes) ---
  function startSellRoutine() {
    if (sellInterval) clearInterval(sellInterval);

    sellInterval = setInterval(async () => {
      if (!loggedIn || !onSurvival || isIdle || isBusyWithGui || ended) return;

      console.log("[ACTION] Starting /sellgui routine...");
      isBusyWithGui = true;

      try {
        say('/sellgui');

        const window = await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            bot.removeListener('windowOpen', handler);
            resolve(null);
          }, 5000);

          const handler = (win) => {
            clearTimeout(timeout);
            resolve(win);
          };
          bot.once('windowOpen', handler);
        });

        if (window) {
          await sleep(600 + Math.floor(Math.random() * 300));

          const hotbarSlot0 = window.inventoryStart + 27;

          const itemsToSell = window.slots.filter(
            (item) => item && item.slot >= window.inventoryStart && item.slot < window.inventoryEnd && item.slot !== hotbarSlot0
          );

          for (const item of itemsToSell) {
            if (!stillMe() || ended) break;
            try {
              await bot.clickWindow(item.slot, 0, 1);
            } catch (e) {}
            await sleep(180 + Math.floor(Math.random() * 120));
          }

          await sleep(400 + Math.floor(Math.random() * 200));
          try {
            bot.closeWindow(window);
          } catch (e) {}
          console.log("[ACTION] /sellgui completed and closed.");
        }
      } catch (err) {
        console.log("[ERROR] Sellgui routine error:", err.message);
      } finally {
        isBusyWithGui = false;
      }
    }, 4 * 60 * 1000);
  }

  // --- PAY MCPA ROUTINE (Every 10 minutes) ---
  function startPayRoutine() {
    if (payInterval) clearInterval(payInterval);

    payInterval = setInterval(() => {
      if (!loggedIn || !onSurvival || isIdle || ended) return;
      console.log("[ACTION] Executing /pay mcpa all...");
      say('/pay mcpa all');
    }, 10 * 60 * 1000);
  }

  // --- NATURAL CHAT LOOP (Every 4 minutes 30 seconds) ---
  function startChatRoutine() {
    if (chatInterval) clearInterval(chatInterval);

    chatInterval = setInterval(() => {
      if (!loggedIn || !onSurvival || isIdle || ended) return;

      const phrase = RANDOM_CHAT_PHRASES[Math.floor(Math.random() * RANDOM_CHAT_PHRASES.length)];
      say(phrase);
      console.log(`[CHAT] Spoke: "${phrase}"`);
    }, 4.5 * 60 * 1000);
  }

  // --- FAILSAFE: HEALTH & HUNGER MONITOR ---
  function startHealthAndHungerFailsafe() {
    if (healthCheckInterval) clearInterval(healthCheckInterval);

    healthCheckInterval = setInterval(() => {
      if (!loggedIn || !onSurvival || isIdle || ended || !bot.entity) return;

      if (bot.health <= 12) {
        console.log(`[FAILSAFE] Low health detected (${bot.health}/20). Executing emergency /spawn escape!`);
        say('/spawn');
      }

      if (bot.food <= 4) {
        console.log(`[FAILSAFE] Critical hunger detected (${bot.food}/20). Executing /suicide to reset attributes!`);
        say('/suicide');
      }
    }, 5000);
  }

  // --- INITIAL LOGIN & SURVIVAL TIMELINE ---
  async function handleLoginSequence() {
    console.log("[SYS] Waiting before initial login...");
    await sleep(6000 + Math.floor(Math.random() * 2000));

    if (AUTH_PASSWORD) {
      console.log("[AUTH] Sending /login command...");
      say(`/login ${AUTH_PASSWORD}`);
    }

    await sleep(5000);
    console.log("[SERVER] Switching to /server survival...");
    say('/server survival');

    console.log("[STATE] Joined Survival. Entering mandatory 20 second idle phase...");
    isIdle = true;
    await sleep(20000);
    
    isIdle = false;
    onSurvival = true;
    console.log("[STATE] Idle phase finished. Commencing fixed-direction routines with active failsafes.");

    startAttackLoop();
    startSellRoutine();
    startPayRoutine();
    startChatRoutine();
    startHealthAndHungerFailsafe();
  }

  // --- EVENT LISTENERS ---
  bot.on('message', (m) => {
    const text = m.toString();
    console.log('[CHAT]', text);
    if (!/please|not logged|must|before/i.test(text) && /(success|logged in|authenticated|welcome back)/i.test(text)) {
      loggedIn = true;
    }
  });

  bot.on('spawn', () => {
    if (loggedIn) return;
    loggedIn = true;
    handleLoginSequence().catch((e) => console.log('[ERROR] Sequence error:', e.message));
  });

  bot.on('death', () => {
    console.log("[DEATH] Bot died. Respawning...");
    isIdle = true;

    setTimeout(async () => {
      if (!stillMe() || ended) return;
      try {
        bot.respawn();
        console.log("[DEATH] Respawned. Waiting 3 seconds before executing /dback...");
        await sleep(3000);

        say('/dback');
        console.log("[DEATH] Executed /dback. Sitting completely idle for exactly 10 seconds...");

        await sleep(10000);

        isIdle = false;
        console.log("[STATE] Post-death 10 second idle complete. Resuming sword attacks.");
      } catch (e) {
        console.log("[ERROR] Respawn/dback failed:", e.message);
        isIdle = false;
      }
    }, 2000);
  });

  bot.on('error', (err) => {
    console.log('[NET ERROR]', err.message);
  });

  bot.on('end', () => {
    ended = true;
    if (attackInterval) clearInterval(attackInterval);
    if (sellInterval) clearInterval(sellInterval);
    if (payInterval) clearInterval(payInterval);
    if (chatInterval) clearInterval(chatInterval);
    if (healthCheckInterval) clearInterval(healthCheckInterval);

    console.log('[SYS] Disconnected. Reconnecting in 15 seconds...');
    setTimeout(createBot, 15000);
  });
}

function createBot() {
  try {
    startBot();
  } catch (e) {
    setTimeout(createBot, 5000);
  }
}

createBot();