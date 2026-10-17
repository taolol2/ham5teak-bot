require('dotenv').config();
const mineflayer = require('mineflayer');
const http = require('http');
const https = require('https');

/* ====================================================================
   CONFIG
   ==================================================================== */
const SERVER_IP = 'play.ham5teak.net';
const SERVER_PORT = 25565;
const BOT_USERNAME = 'RockyRidge';
const AUTH_PASSWORD = process.env.MC_PASSWORD;

// 1.21.4 is the version that worked for you. The others are only used if the
// connection fails with a protocol/version error.
const VERSION_LIST = [process.env.MC_VERSION || '1.21.4', '1.21.1', '1.20.4']
  .filter((v, i, a) => a.indexOf(v) === i);
let versionIdx = 0;

const ATTACK_REACH = 3.5;          // lower to 3.0 if Vulcan ever flags reach
const MIN_CHAT_GAP = 2000;         // min ms between ANY two chat/commands sent
const JITTER = 4000;               // +/- ms randomness on the repeating tasks
const LOG_CHAT = process.env.LOG_CHAT !== 'false'; // set LOG_CHAT=false on Render to quiet logs

// Teleporting to /spawn pulls the bot OFF your grinder spot and it never goes back,
// so this is OFF by default. Death + /dback already handles the dangerous case.
const LOW_HEALTH_ESCAPE = false;

const T = {
  loginDelay: [5000, 7000],        // wait after spawn before /login
  afterLogin: [4000, 5500],        // wait after /login before /server survival
  transferTimeout: 25000,          // max wait for the survival welcome message
  survivalIdle: 20000,             // idle after joining survival
  swing: 2000,                     // sword hit interval (every 2 seconds)
  sell: 4 * 60 * 1000,             // /sellgui
  chat: 4.5 * 60 * 1000,           // random chat
  pay: 10 * 60 * 1000,             // /pay mcpa all
  respawnDelay: [1500, 2500],      // before clicking respawn
  dbackDelay: [2000, 3000],        // after respawn, before /dback
  dbackIdle: 10000,                // exactly 10s idle after /dback
};

const SURVIVAL_WELCOME = /Glad to have you with us/i;
const HUB_BANNER = /ᴛᴏ ʜᴀᴍ5ᴛᴇᴀᴋ/;
const LOGIN_PROMPT = /(please|must)\s+(log\s?in|login)|\/login\s*</i;

const CHAT_PHRASES = [
  'lol', 'anyone selling keys?', 'lag', 'oof', 'damn', 'gg', 'wow', 'bruh', 'true', 'wait',
  'anyone got food?', 'so true', 'yikes', 'rip', 'lets go', 'oh', 'nope', 'yep', 'nice', 'ok',
  'hm', 'why', 'idk', 'bro', 'help', 'afk', 'back', 'reloading', 'fast', 'slow',
  'anyone online?', 'base', 'home', 'shop', 'sell', 'buy', 'trade', 'money', 'rich', 'poor',
  'ggs', 'ez', 'cmon', 'task', 'work', 'grind', 'farm', 'mob', 'raid', 'spawn',
  'warp', 'tp', 'home sweet home', 'lagging', 'ping', 'fps', 'smooth', 'hard', 'easy', 'cool',
  'nice armor', 'nice sword', 'epic', 'legend', 'team', 'party', 'koth', 'event', 'vote', 'keys',
  'crate', 'open', 'win', 'lose', 'dead', 'alive', 'heal', 'food', 'potion', 'bottle', 'bad',
  'good', 'best', 'worst', 'clean', 'dirty', 'time', 'day', 'night', 'sun', 'rain', 'storm',
  'mining', 'builder', 'miner', 'player', 'yo', 'sup', 'brb', 'wb', 'ty', 'np', 'pls', 'thx'
];

/* ====================================================================
   HELPERS
   ==================================================================== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randIn = (pair) => rand(pair[0], pair[1]);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let botStatus = 'starting';
let currentBot = null;
let reconnectAttempts = 0;

/* ====================================================================
   KEEP-ALIVE HTTP SERVER (Render) + SELF PING
   ==================================================================== */
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`RockyRidge bot status: ${botStatus}`);
}).listen(PORT, () => log(`[HTTP] Keep-alive server on port ${PORT}`));

// Render sets RENDER_EXTERNAL_URL automatically. Pinging ourselves every 4 min
// counts as inbound traffic, so the free instance doesn't spin down.
// (Keep UptimeRobot too - it's a second layer.)
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(() => {
    try {
      const lib = SELF_URL.startsWith('https') ? https : http;
      lib.get(SELF_URL, (r) => r.resume()).on('error', () => {});
    } catch (e) {}
  }, 4 * 60 * 1000);
}

process.on('uncaughtException', (e) => log('[SYS ERROR] Uncaught:', e && e.message));
process.on('unhandledRejection', (e) => log('[SYS ERROR] Unhandled:', e && e.message));

// Clean logout when Render redeploys/restarts so we don't leave a ghost session
process.on('SIGTERM', () => {
  log('[SYS] SIGTERM received, quitting cleanly...');
  try { if (currentBot) currentBot.quit('restart'); } catch (e) {}
  setTimeout(() => process.exit(0), 1500);
});

/* ====================================================================
   RECONNECT LOGIC (exponential backoff so we never hammer the proxy)
   ==================================================================== */
function scheduleReconnect(ranForMs, kickText, reason) {
  if (ranForMs > 3 * 60 * 1000) reconnectAttempts = 0;
  else reconnectAttempts++;

  let delay = 15000 * 2 ** (Math.max(1, reconnectAttempts) - 1);
  delay = Math.min(delay, 5 * 60 * 1000) + rand(0, 5000);

  if (/already (connected|online|logged)|duplicate/i.test(kickText)) delay = Math.max(delay, 60000);
  if (/\bban/i.test(kickText)) delay = 30 * 60 * 1000;

  botStatus = 'reconnecting';
  log(`[SYS] Disconnected (${reason || 'no reason'}). Attempt #${reconnectAttempts}, reconnecting in ${Math.round(delay / 1000)}s...`);
  setTimeout(startBot, delay);
}

/* ====================================================================
   BOT SESSION
   ==================================================================== */
function startBot() {
  const version = VERSION_LIST[versionIdx % VERSION_LIST.length];
  const sessionStart = Date.now();
  botStatus = 'connecting';
  log(`[SYS] Connecting to ${SERVER_IP}:${SERVER_PORT} as ${BOT_USERNAME} (MC ${version})...`);

  let bot;
  try {
    bot = mineflayer.createBot({
      host: SERVER_IP,
      port: SERVER_PORT,
      username: BOT_USERNAME,
      auth: 'offline',
      version,
      hideErrors: true,        // hides harmless proxy packet-parse spam
      viewDistance: 'tiny'     // far less RAM/CPU, important on Render free (512MB)
    });
  } catch (e) {
    log('[SYS] createBot threw:', e.message);
    scheduleReconnect(0, '', e.message);
    return;
  }
  currentBot = bot;

  // HARD LOCK: nothing in this script can ever rotate the bot or make it walk.
  // Even if some internal helper tries, these calls do nothing. The bot only
  // keeps the facing/position the server gave it when it joined survival.
  bot.look = async () => {};
  bot.lookAt = async () => {};
  bot.setControlState = () => {};

  // ---------- per-session state ----------
  let closed = false;
  let state = 'connecting'; // connecting | login | switching | idle | running
  let dead = false;
  let busy = false;         // true while /sellgui is in progress
  let sequenceStarted = false;
  let routinesStarted = false;
  let reentering = false;
  let runningSince = 0;
  let lastKick = '';
  let lastSent = 0;
  let lastLoginAttempt = 0;
  let lastPacket = Date.now();
  let lastPhrase = '';
  let lastSwordWarn = 0;
  let lastHealthEscape = 0;
  const timers = new Set();
  let chatChain = Promise.resolve();

  const setState = (s) => { state = s; botStatus = s; };

  // Recurring task with jitter. Awaits each run so tasks never overlap themselves.
  function every(name, baseMs, jitterMs, fn) {
    const tick = () => {
      if (closed) return;
      const delay = Math.max(1000, baseMs + rand(-jitterMs, jitterMs));
      const t = setTimeout(async () => {
        timers.delete(t);
        if (closed) return;
        try { await fn(); } catch (e) { log(`[ERROR] ${name}:`, e.message); }
        tick();
      }, delay);
      timers.add(t);
    };
    tick();
  }

  // Every outgoing chat/command goes through one queue with a minimum gap,
  // so two timers firing together can never spam the server.
  function say(msg) {
    chatChain = chatChain.then(async () => {
      if (closed) return;
      const gap = lastSent + MIN_CHAT_GAP - Date.now();
      if (gap > 0) await sleep(gap + rand(0, 400));
      if (closed) return;
      try { bot.chat(msg); lastSent = Date.now(); } catch (e) { log('[ERROR] chat failed:', e.message); }
    });
    return chatChain;
  }

  function waitForChat(re, timeoutMs) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { bot.removeListener('messagestr', h); resolve(false); }, timeoutMs);
      function h(str) {
        if (re.test(str)) { clearTimeout(t); bot.removeListener('messagestr', h); resolve(true); }
      }
      bot.on('messagestr', h);
    });
  }

  function waitForSpawn(timeoutMs) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { bot.removeListener('spawn', h); resolve(false); }, timeoutMs);
      function h() { clearTimeout(t); resolve(true); }
      bot.once('spawn', h);
    });
  }

  const canAct = () => !closed && state === 'running' && !dead && !busy && !!bot.entity;

  // Tasks that must not be lost wait (up to 90s) until the bot is free
  async function whenFree(maxMs = 90000) {
    const t0 = Date.now();
    while (!closed && !canAct() && Date.now() - t0 < maxMs) await sleep(500);
    return canAct();
  }

  /* ---------- SWORD HITS (no movement, no rotation) ---------- */
  function isHostile(e) {
    if (!e || e === bot.entity || e.type === 'player') return false;
    if (e.type === 'hostile') return true;
    return e.type === 'mob' && /hostile/i.test(e.kind || '');
  }

  function doSwing() {
    if (!canAct()) return;

    if (bot.quickBarSlot !== 0) bot.setQuickBarSlot(0);

    const held = bot.inventory.slots[bot.QUICK_BAR_START];
    if ((!held || !/sword/i.test(held.name)) && Date.now() - lastSwordWarn > 60000) {
      lastSwordWarn = Date.now();
      log('[WARN] Hotbar slot 1 is not a sword (broken/missing?)');
    }

    const me = bot.entity;
    const target = bot.nearestEntity((e) => isHostile(e) && e.position.distanceTo(me.position) <= ATTACK_REACH);
    try {
      if (target) bot.attack(target); // real attack packet -> Sweeping Edge hits the pile
      else bot.swingArm('right');
    } catch (e) {}
  }

  /* ---------- /sellgui ----------
     Layout of this server's SellGUI (6-row chest):
       slots 0-44   rows 1-5  = the sell area (items go here)
       slots 45-53  row 6     = reserved button row (star in the middle) - NEVER touched
       then the player inventory, hotbar slot 1 (the sword) is never moved.
     Closing the GUI (same as pressing E) is what sells everything. */
  async function runSell() {
    if (!(await whenFree())) return;
    busy = true;
    let win = null;
    const onOpen = (w) => { win = w; };
    try {
      log('[SELL] Opening /sellgui');
      bot.once('windowOpen', onOpen); // listen BEFORE sending the command
      await say('/sellgui');

      const t0 = Date.now();
      while (!win && !closed && Date.now() - t0 < 7000) await sleep(100);
      if (!win) { log('[SELL] Window never opened, skipping this round'); return; }

      await sleep(rand(700, 1200));

      const invStart = win.inventoryStart;   // 54 for a 6-row chest
      const invEnd = win.inventoryEnd;       // 90
      const sellEnd = Math.max(0, invStart - 9); // 45 -> excludes the bottom button row
      const swordSlot = invEnd - 9;          // hotbar slot 1

      const leftovers = () => {
        const out = [];
        for (let s = invStart; s < invEnd; s++) if (s !== swordSlot && win.slots[s]) out.push(s);
        return out;
      };
      const firstFreeSellSlot = () => {
        for (let i = 0; i < sellEnd; i++) if (!win.slots[i]) return i;
        return -1;
      };
      const alive = () => !closed && !dead && bot.currentWindow === win;

      // PASS 1: shift-click every stack into the sell area
      const first = leftovers();
      for (const s of first) {
        if (!alive()) break;
        try { await bot.clickWindow(s, 0, 1); } catch (e) {}
        await sleep(rand(200, 350));
      }

      // let the server answer, then see what it refused to take
      await sleep(rand(900, 1300));

      // PASS 2: anything still in the inventory gets placed by hand into a free sell slot
      let manual = 0;
      for (const s of leftovers()) {
        if (!alive()) break;
        const free = firstFreeSellSlot();
        if (free === -1) { log('[SELL] Sell area is full, stopping'); break; }
        try {
          await bot.clickWindow(s, 0, 0);        // pick the stack up
          await sleep(rand(150, 260));
          await bot.clickWindow(free, 0, 0);     // drop it into a free sell slot
          await sleep(rand(150, 260));
          if (win.selectedItem) {                // refused? put it back
            await bot.clickWindow(s, 0, 0);
            await sleep(rand(150, 260));
          }
          manual++;
        } catch (e) {}
      }

      await sleep(rand(600, 1000));
      const left = leftovers().length;
      try { bot.closeWindow(win); } catch (e) {} // = pressing E, this sells everything
      log(`[SELL] Closed the GUI. ${first.length} stacks sent (${manual} placed by hand), ${left} left over`);
    } catch (e) {
      log('[ERROR] Sell routine:', e.message);
    } finally {
      bot.removeListener('windowOpen', onOpen);
      busy = false;
    }
  }

  /* ---------- /pay and chat ---------- */
  async function doPay() {
    if (!(await whenFree())) return;
    log('[PAY] /pay mcpa all');
    await say('/pay mcpa all');
  }

  async function doChat() {
    if (!(await whenFree())) return;
    let phrase;
    do { phrase = CHAT_PHRASES[rand(0, CHAT_PHRASES.length - 1)]; } while (phrase === lastPhrase);
    lastPhrase = phrase;
    log(`[CHAT] Saying "${phrase}"`);
    await say(phrase);
  }

  function healthCheck() {
    if (!canAct()) return;
    if (bot.health <= 6 && Date.now() - lastHealthEscape > 120000) {
      lastHealthEscape = Date.now();
      log(`[FAILSAFE] Health ${bot.health}/20, running /spawn`);
      say('/spawn');
    }
  }

  function startRoutines() {
    if (routinesStarted) return;
    routinesStarted = true;
    every('swing', T.swing, 100, doSwing);
    every('sell', T.sell, JITTER, runSell);
    every('pay', T.pay, JITTER, doPay);
    every('chat', T.chat, JITTER, doChat);
    if (LOW_HEALTH_ESCAPE) every('health', 5000, 0, healthCheck);
  }

  /* ---------- LOGIN -> SURVIVAL -> IDLE ---------- */
  async function enterSurvival() {
    setState('switching');
    log('[SERVER] Sending /server survival');
    const arrived = waitForChat(SURVIVAL_WELCOME, T.transferTimeout);
    await say('/server survival');
    const ok = await arrived;
    if (closed) return;
    log(ok ? '[SERVER] Arrived in survival' : '[SERVER] No welcome message seen, continuing anyway');

    setState('idle');
    log('[STATE] Idling 20 seconds...');
    await sleep(T.survivalIdle);
    if (closed) return;

    runningSince = Date.now();
    setState('running');
    log('[STATE] Running: sword hits, /sellgui, /pay and chat are active');
    startRoutines();
  }

  async function beginSequence() {
    if (sequenceStarted) return;
    sequenceStarted = true;
    setState('login');
    await sleep(randIn(T.loginDelay));
    if (closed) return;

    if (AUTH_PASSWORD) {
      log('[AUTH] Sending /login');
      lastLoginAttempt = Date.now();
      await say(`/login ${AUTH_PASSWORD}`);
    } else {
      log('[AUTH] MC_PASSWORD is not set, skipping /login');
    }

    await sleep(randIn(T.afterLogin));
    if (closed) return;
    await enterSurvival();
  }

  /* ---------- EVENTS ---------- */
  bot.on('messagestr', (text) => {
    if (LOG_CHAT) {
      const t = text.replace(/\s+/g, ' ').trim();
      if (t) log('[MC]', t.slice(0, 220));
    }

    // Server asks us to log in again (after a lobby bounce etc.)
    if (AUTH_PASSWORD && state !== 'connecting' && state !== 'login' &&
        LOGIN_PROMPT.test(text) && Date.now() - lastLoginAttempt > 20000) {
      lastLoginAttempt = Date.now();
      log('[FAILSAFE] Login prompt detected, sending /login again');
      say(`/login ${AUTH_PASSWORD}`);
    }

    // We got bounced back to the hub -> go back to survival
    if (state === 'running' && !reentering && Date.now() - runningSince > 60000 && HUB_BANNER.test(text)) {
      reentering = true;
      log('[FAILSAFE] Back in the hub, re-entering survival');
      enterSurvival().catch((e) => log('[ERROR] re-enter:', e.message)).finally(() => { reentering = false; });
    }
  });

  bot.once('spawn', () => {
    log('[SYS] Spawned');
    beginSequence().catch((e) => log('[ERROR] Login sequence:', e.message));
  });

  bot.on('death', async () => {
    if (dead) return;
    dead = true;
    log('[DEATH] Bot died');
    try {
      await sleep(randIn(T.respawnDelay));
      if (closed) return;
      const spawned = waitForSpawn(6000);
      bot.respawn();
      await spawned;
      await sleep(randIn(T.dbackDelay));
      if (closed) return;
      await say('/dback');
      log('[DEATH] /dback sent, staying idle for exactly 10 seconds');
      await sleep(T.dbackIdle);
      log('[DEATH] Idle finished, resuming');
    } catch (e) {
      log('[ERROR] Respawn/dback failed:', e.message);
    } finally {
      dead = false;
    }
  });

  bot.on('kicked', (reason) => {
    lastKick = typeof reason === 'string' ? reason : JSON.stringify(reason);
    log('[KICK]', lastKick.slice(0, 300));
  });

  bot.on('error', (err) => {
    log('[NET ERROR]', err && err.message);
    if (err && /unsupported|protocol|version/i.test(err.message)) {
      versionIdx++;
      log(`[SYS] Version problem, next attempt will use ${VERSION_LIST[versionIdx % VERSION_LIST.length]}`);
    }
  });

  bot.on('end', (reason) => {
    if (closed) return;
    closed = true;
    timers.forEach((t) => clearTimeout(t));
    timers.clear();
    if (currentBot === bot) currentBot = null;
    scheduleReconnect(Date.now() - sessionStart, lastKick, reason);
  });

  // Watchdog: if the connection silently freezes, force a reconnect
  try { bot._client.on('packet', () => { lastPacket = Date.now(); }); } catch (e) {}
  every('watchdog', 15000, 0, () => {
    if (Date.now() - lastPacket > 60000) {
      log('[FAILSAFE] No packets for 60s, forcing reconnect');
      bot.end('watchdog');
    }
  });
}

startBot();