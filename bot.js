require("dotenv").config();
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Client, GatewayIntentBits } = require('discord.js');
const Vec3 = require('vec3');
const http = require('http');

// ---------------- SETTINGS ----------------
const SERVER_IP = 'play.ham5teak.net';
const SERVER_PORT = 25565;
const BOT_USERNAME = 'RockyRidge';
const AUTH_PASSWORD = process.env.MC_PASSWORD;
const USE_GUI_LOGIN = process.env.USE_GUI_LOGIN === '1';

const VERSIONS = process.env.MC_VERSION
  ? [process.env.MC_VERSION]
  : ['1.21.4', '1.21.11', '1.21.1', '26.1'];

const RAID_MINUTES = Number(process.env.RAID_MINUTES || 10);
const CHEST_SEARCH_DISTANCE = 64;
const HOPPER_POS = { x: -5756, y: 63, z: -5259 };
const FARM_CENTER = { x: -5757, z: -5257 }; // Proximity center

// Only keep Ominous bottles in inventory/chest processing
const isOminousBottle = (it) => it && it.name.includes('ominous');

// 100 Random Chat Phrases for Natural Anti-AFK Pacing
const RANDOM_CHAT_PHRASES = [
  "lol", "anyone selling keys?", "lag", "oof", "damn", "gg", "wow", "bruh", "true", "wait",
  "anyone got food?", "so true", "yikes", "rip", "lets go", "oh", "nope", "yep", "nice", "ok",
  "hm", "why", "idk", "bro", "help", "afk", "back", "reloading", "fast", "slow",
  "anyone online?", "base", "home", "shop", "sell", "buy", "trade", "money", "rich", "poor",
  "ggs", "ez", "cmon", "task", "work", "grind", "farm", "mob", "raid", "spawn",
  "warp", "tp", "home sweet home", "lagging", "ping", "fps", "smooth", "hard", "easy", "cool",
  "nice armor", "nice sword", "epic", "legend", "vortex", "h5u", "geforce", "team", "party", "koth",
  "event", "vote", "keys", "crate", "open", "win", "lose", "dead", "alive", "heal",
  "food", "potion", "bottle", "omni", "bad", "good", "best", "worst", "clean", "dirty",
  "time", "day", "night", "sun", "rain", "storm", "mining", "builder", "miner", "player"
];

// ---------------- KEEP-ALIVE WEB SERVER ----------------
http
  .createServer((req, res) => res.end('RockyRidge is alive'))
  .listen(process.env.PORT || 3000);

process.on('uncaughtException', (e) => console.log('Uncaught:', e.message));
process.on('unhandledRejection', (e) => console.log('Unhandled:', e && e.message));

// ---------------- DISCORD ----------------
let discordClient = null;
if (process.env.DISCORD_TOKEN) {
  discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
  discordClient.login(process.env.DISCORD_TOKEN).catch((e) => {
    console.log('Discord login error:', e.message);
    discordClient = null;
  });
}
const lastAlert = {};
function sendDiscordAlert(message, cooldownMs = 30 * 60 * 1000) {
  console.log(`[ALERT] ${message}`);
  const now = Date.now();
  if (lastAlert[message] && now - lastAlert[message] < cooldownMs) return;
  lastAlert[message] = now;
  if (!discordClient || !process.env.DISCORD_CHANNEL_ID) return;
  const ping = process.env.DISCORD_PING_USER || '';
  discordClient.channels
    .fetch(process.env.DISCORD_CHANNEL_ID)
    .then((ch) => ch && ch.send(`${ping} ${message}`))
    .catch((e) => console.log('Discord send failed:', e.message));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let runId = 0;
let versionIndex = 0;
let reconnectDelay = 15000;
let stopReconnect = false;

// ---------------- THE BOT ----------------
function startBot() {
  const myId = ++runId;
  const stillMe = () => myId === runId;
  const version = VERSIONS[versionIndex % VERSIONS.length];
  console.log(`Connecting with Minecraft version ${version}...`);

  const bot = mineflayer.createBot({
    host: SERVER_IP,
    port: SERVER_PORT,
    username: BOT_USERNAME,
    auth: 'offline',
    version,
    hideErrors: false,
  });
  bot.loadPlugin(pathfinder);
  bot.setMaxListeners(50);

  let started = false;
  let acceptAuthGui = USE_GUI_LOGIN;
  let abort = false;
  let lastPromptAt = 0;
  let loggedIn = false;
  let loginRejected = false;
  let guiTries = 0;
  let gotAnyChat = false;
  let ended = false;
  let onSurvivalServer = false;

  let manualStopWork = false;
  let isProximityPaused = false;
  let stopHeadTracking = false;
  let currentTaskState = 'STARTUP';

  const say = (m) => {
    try { bot.chat(m); } catch (e) { console.log('chat failed:', e.message); }
  };

  const wait = async (ms) => {
    await sleep(ms);
    if (!stillMe() || ended) throw new Error('old-bot');
    if (abort) throw new Error('aborted');
    
    while ((manualStopWork || isProximityPaused) && stillMe() && !ended && !abort) {
      await sleep(500);
    }
    if (!stillMe() || ended) throw new Error('old-bot');
    if (abort) throw new Error('aborted');
  };

  async function humanLookAt(targetVec, forceStep = false) {
    if (!bot.entity) return;
    try {
      const startYaw = bot.entity.yaw;
      const startPitch = bot.entity.pitch;
      
      bot.lookAt(targetVec, true);
      const endYaw = bot.entity.yaw;
      const endPitch = bot.entity.pitch;
      bot.look(startYaw, startPitch, true);
      
      const steps = forceStep ? 1 : Math.floor(Math.random() * 4) + 6;
      for (let i = 1; i <= steps; i++) {
        if (!stillMe() || ended) break;
        const ratio = i / steps;
        const eased = ratio * (2 - ratio);
        const currYaw = startYaw + (endYaw - startYaw) * eased + (Math.random() - 0.5) * 0.02;
        const currPitch = startPitch + (endPitch - startPitch) * eased + (Math.random() - 0.5) * 0.02;
        bot.look(currYaw, currPitch, true);
        await sleep(25 + Math.floor(Math.random() * 20));
      }
    } catch (e) {}
  }

  bot.on('windowOpen', async (win) => {
    if (!acceptAuthGui) return;
    guiTries++;
    if (guiTries > 6) return;
    await sleep(1200 + Math.floor(Math.random() * 400));
    try {
      if (String(win.type).includes('anvil')) {
        if (!AUTH_PASSWORD) return;
        bot._client.write('name_item', { name: AUTH_PASSWORD });
        for (let i = 0; i < 20 && !win.slots[2]; i++) await sleep(150);
        if (win.slots[2]) await bot.clickWindow(2, 0, 0);
      } else {
        const btn =
          win.slots.find((it) => it && it.name === 'writable_book') ||
          win.slots.find((it) => it && (/lime|green/.test(it.name) || /login|confirm|submit/i.test(it.displayName || '')));
        if (btn) await bot.clickWindow(btn.slot, 0, 0);
      }
    } catch (e) {}
  });

  function setupMovements() {
    const movements = new Movements(bot);
    movements.canDig = false;
    bot.pathfinder.setMovements(movements);
  }

  async function openNearestChest() {
    const block = bot.findBlock({
      matching: (b) => b.name === 'chest' || b.name === 'trapped_chest',
      maxDistance: CHEST_SEARCH_DISTANCE,
    });
    if (!block) throw new Error('No chest found nearby');
    setupMovements();
    await bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 3));
    return await bot.openContainer(block);
  }

  function waitForWindow(ms) {
    return new Promise((resolve) => {
      const h = (w) => { clearTimeout(t); resolve(w); };
      const t = setTimeout(() => { bot.removeListener('windowOpen', h); resolve(null); }, ms);
      bot.once('windowOpen', h);
    });
  }

  function equipSword() {
    bot.setQuickBarSlot(0);
  }

  async function doLogin() {
    if (!AUTH_PASSWORD) {
      sendDiscordAlert('⚠️ RockyRidge has no MC_PASSWORD set.');
      throw new Error('login failed');
    }
    await wait(4000 + Math.floor(Math.random() * 1000));

    if (USE_GUI_LOGIN) {
      await wait(10000);
      acceptAuthGui = false;
      loggedIn = true;
      return;
    }

    for (let attempt = 1; attempt <= 3 && !loggedIn; attempt++) {
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch (e) {}
      const sentAt = Date.now();
      say(`/login ${AUTH_PASSWORD}`);
      for (let i = 0; i < 40 && !loggedIn && !loginRejected; i++) await wait(200);

      if (loginRejected) throw new Error('login failed');
      if (loggedIn) break;
      if (lastPromptAt < sentAt + 1500) {
        loggedIn = true;
      }
    }
    if (!loggedIn) throw new Error('login failed');
  }

  async function startup() {
    currentTaskState = 'STARTUP';
    await doLogin();
    reconnectDelay = 15000;
    await wait(5000 + Math.floor(Math.random() * 2000));
    say('/server survival');
    await wait(20000);
    onSurvivalServer = true;
  }

  // Obtain ominous potion: Checks inventory first; if missing, pulls from chest
  async function obtainOminousPotion() {
    currentTaskState = 'TAKING_POTION';
    const existingPotion = bot.inventory.items().find(isOminousBottle);
    if (existingPotion) return;

    let chest = await openNearestChest();
    try {
      await sleep(800 + Math.floor(Math.random() * 300));
      let potion = chest.containerItems().find(isOminousBottle);
      
      while (!potion && stillMe() && !ended && !abort) {
        console.log('[POTION] Out of ominous potions in chest. Waiting for restock...');
        chest.close();
        await sleep(15000);
        const reOpenedChest = await openNearestChest();
        potion = reOpenedChest.containerItems().find(isOminousBottle);
        if (potion) {
          await reOpenedChest.withdraw(potion.type, null, 1);
          reOpenedChest.close();
          return;
        }
        chest = reOpenedChest;
      }
      
      if (potion) {
        await chest.withdraw(potion.type, null, 1);
      }
    } finally {
      try { chest.close(); } catch (e) {}
    }
  }

  async function drinkPotion() {
    currentTaskState = 'DRINKING_POTION';
    const potion = bot.inventory.items().find(isOminousBottle);
    if (!potion) throw new Error('No ominous potion in inventory');
    await bot.equip(potion, 'hand');
    
    bot.activateItem();
    await sleep(2000 + Math.floor(Math.random() * 200));
    bot.deactivateItem();
    
    bot.setQuickBarSlot(0);
  }

  async function attackLoop(ms) {
    currentTaskState = 'ATTACKING_RAID';
    console.log(`Executing randomized anti-detection attack loop for ${ms / 60000} minutes...`);
    const end = Date.now() + ms;
    
    while (Date.now() < end) {
      if (manualStopWork || isProximityPaused) {
        bot.setControlState('sneak', false);
        while ((manualStopWork || isProximityPaused) && stillMe() && !ended && !abort) {
          await sleep(500);
        }
        if (!stillMe() || ended) throw new Error('old-bot');
        if (abort) throw new Error('aborted');
      }
      
      bot.setControlState('sneak', true);
      
      const stand = bot.nearestEntity(
        (e) => e.name === 'armor_stand' && e.position.distanceTo(bot.entity.position) < 4
      );
      
      if (stand) {
        await humanLookAt(stand.position.offset(0, 0.9 + Math.random() * 0.2, 0));
        bot.attack(stand);
      } else {
        bot.swingArm('right');
      }
      
      const randomInterval = 950 + Math.floor(Math.random() * 400);
      await wait(randomInterval);
    }
    bot.setControlState('sneak', false);
  }

  // ---------- COMPREHENSIVE CLEANUP & PAY PROTOCOL ----------
// ---------- COMPREHENSIVE CLEANUP & PAY PROTOCOL ----------
  async function cleanup() {
    currentTaskState = 'CLEANUP';
    
    let chest = await openNearestChest();
    try {
      await sleep(800);
      const all = chest.containerItems();
      
      // Check if the chest is ACTUALLY FULL (all slots occupied) and every single slot is an ominous bottle
      const chestIsFull = all.length >= chest.inventoryStart;
      const onlyBottles = all.every(isOminousBottle);

      if (chestIsFull && onlyBottles) {
        sendDiscordAlert('⚠️ Farm chest is full ONLY with ominous bottles! Bot is idling.');
        chest.close();
        while (stillMe() && !ended && !abort) {
          await sleep(30000);
        }
        return;
      }

      for (const it of all) {
        if (isOminousBottle(it)) continue; // Never touch ominous bottles
        try {
          await chest.withdraw(it.type, null, it.count);
        } catch (e) {
          break;
        }
        await sleep(350 + Math.floor(Math.random() * 150));
      }
    } finally {
      try { chest.close(); } catch (e) {}
    }

    // Sell ALL inventory items using /sellgui (except ominous bottles)
    say('/sellgui');
    const win = await waitForWindow(6000);
    if (win) {
      await sleep(900);
      const hotbar0 = win.inventoryStart + 27;
      const mine = win.slots.filter(
        (it) => it && it.slot >= win.inventoryStart && it.slot < win.inventoryEnd
      );
      for (const it of mine) {
        if (it.slot === hotbar0 || isOminousBottle(it)) continue;
        try { await bot.clickWindow(it.slot, 0, 1); } catch (e) {}
        await sleep(250 + Math.floor(Math.random() * 100));
      }
      await sleep(500);
      bot.closeWindow(win);
    }
    await sleep(1000);

    // Deposit remaining unsellable items into hopper patiently
    const leftovers = () => bot.inventory.items().filter((it) => !isOminousBottle(it) && it.slot !== 36);
    if (leftovers().length > 0) {
      setupMovements();
      await bot.pathfinder.goto(new goals.GoalNear(HOPPER_POS.x, HOPPER_POS.y, HOPPER_POS.z, 3));
      let hopperBlock = bot.blockAt(new Vec3(HOPPER_POS.x, HOPPER_POS.y, HOPPER_POS.z));
      if (!hopperBlock || hopperBlock.name !== 'hopper') {
        hopperBlock = bot.findBlock({ matching: (b) => b.name === 'hopper', maxDistance: 8 });
      }
      if (hopperBlock) {
        const hopper = await bot.openContainer(hopperBlock);
        try {
          let fails = 0;
          while (leftovers().length && fails < 30) {
            const batch = leftovers().slice(0, 5);
            for (const it of batch) {
              try {
                await hopper.deposit(it.type, null, it.count);
                await sleep(600 + Math.floor(Math.random() * 300));
              } catch (e) {
                fails++;
              }
            }
            await sleep(1000);
          }
        } finally {
          try { hopper.close(); } catch (e) {}
        }
      }
    }

    // Pay all money to mcpa
    say('/pay mcpa *');
    await sleep(1500);
  }

  async function resumeTaskState() {
    console.log(`[MEMORY] Resuming task state from: ${currentTaskState}`);
    try {
      if (currentTaskState === 'TAKING_POTION' || currentTaskState === 'STARTUP') {
        say('/pw go raidfarm'); await wait(10000);
        equipSword();
        await obtainOminousPotion();
        say('/pw go tafarm'); await wait(10000);
        await drinkPotion(); await wait(10000);
        say('/pw go raidfarm'); await wait(10000);
        equipSword();
        await attackLoop(RAID_MINUTES * 60 * 1000);
        await cleanup();
      } else if (currentTaskState === 'DRINKING_POTION') {
        await drinkPotion(); await wait(10000);
        say('/pw go raidfarm'); await wait(10000);
        equipSword();
        await attackLoop(RAID_MINUTES * 60 * 1000);
        await cleanup();
      } else if (currentTaskState === 'ATTACKING_RAID') {
        say('/pw go raidfarm'); await wait(10000);
        equipSword();
        await attackLoop(RAID_MINUTES * 60 * 1000);
        await cleanup();
      } else if (currentTaskState === 'CLEANUP') {
        await cleanup();
      } else {
        await raidCycle();
      }
    } catch (e) {
      console.log('Resume task error:', e.message);
    }
  }

  async function raidCycle() {
    if (!loggedIn) throw new Error('Not logged in');
    say('/pw go raidfarm'); await wait(10000);
    equipSword();
    await obtainOminousPotion();

    say('/pw go tafarm'); await wait(10000);
    await drinkPotion(); await wait(10000);

    say('/pw go raidfarm'); await wait(10000);
    equipSword();

    await attackLoop(RAID_MINUTES * 60 * 1000);
    await cleanup();
  }

  async function mainLoop() {
    await startup();
    while (stillMe()) {
      try {
        await raidCycle();
      } catch (e) {
        if (!stillMe()) return;
        console.log('Cycle error:', e.message);
        await sleep(e.message === 'aborted' ? 15000 : 30000);
        abort = false;
      }
    }
  }

  // ---------- PROXIMITY WATCHER (50-BLOCK RADIUS OF FARM CENTER ONLY) ----------
  let proximityCheckTimer = null;
  function startProximityWatcher() {
    if (proximityCheckTimer) clearInterval(proximityCheckTimer);
    let hasSaidWhat = false;

    proximityCheckTimer = setInterval(async () => {
      if (!bot || !bot.entity || !loggedIn || ended || !onSurvivalServer) return;

      const distanceFromFarm = Math.hypot(bot.entity.position.x - FARM_CENTER.x, bot.entity.position.z - FARM_CENTER.z);
      if (distanceFromFarm > 50) {
        if (isProximityPaused && !manualStopWork) {
          isProximityPaused = false;
        }
        return;
      }

      const filterPlayer = (p) => {
        if (!p || p.username === bot.username || p.username === 'mcpa') return false;
        return bot.entity.position.distanceTo(p.position) <= 10;
      };

      const targetPlayer = Object.values(bot.entities).find(
        (e) => e.type === 'player' && filterPlayer(e)
      );

      if (targetPlayer) {
        if (!isProximityPaused) {
          console.log(`[PROXIMITY] Player ${targetPlayer.username} within 10 blocks (near farm)! Pausing.`);
          isProximityPaused = true;
          hasSaidWhat = false;
          bot.setControlState('sneak', false);
          if (bot.pathfinder) bot.pathfinder.stop();
        }

        if (!stopHeadTracking) {
          try {
            await humanLookAt(targetPlayer.position.offset(0, targetPlayer.height * 0.8, 0), true);
          } catch (e) {}
        }

        if (!hasSaidWhat) {
          hasSaidWhat = true;
          await sleep(400 + Math.floor(Math.random() * 300));
          say('what');
        }

      } else {
        if (isProximityPaused && !manualStopWork) {
          console.log('[PROXIMITY] Player left radius. Resuming task.');
          isProximityPaused = false;
          hasSaidWhat = false;
          stopHeadTracking = false;
        }
      }
    }, 1000);
  }

  // ---------- RANDOM CHAT LOOP (EVERY 4 TO 5 MINUTES FROM 100 WORDS) ----------
  let randomChatTimer = null;
  function startRandomChatLoop() {
    if (randomChatTimer) clearTimeout(randomChatTimer);
    const nextInterval = 240000 + Math.floor(Math.random() * 60000);
    
    randomChatTimer = setTimeout(async () => {
      if (bot && loggedIn && !ended) {
        const randomWord = RANDOM_CHAT_PHRASES[Math.floor(Math.random() * RANDOM_CHAT_PHRASES.length)];
        say(randomWord);
        console.log(`[RANDOM CHAT] Said: "${randomWord}"`);
      }
      startRandomChatLoop();
    }, nextInterval);
  }

  // ---------- HUNGER MONITOR (1 BAR FAILSAFE -> /SUICIDE) ----------
  let hungerCheckTimer = null;
  function startHungerMonitor() {
    if (hungerCheckTimer) clearInterval(hungerCheckTimer);
    hungerCheckTimer = setInterval(async () => {
      if (!bot || !loggedIn || ended) return;
      if (bot.food <= 2) {
        console.log(`[HUNGER] Hunger dropped to ${bot.food}/20 (1 bar). Executing /suicide failsafe...`);
        sendDiscordAlert('⚠️ Hunger reached 1 bar! Executing /suicide to reset and resume work.');
        say('/suicide');
        await sleep(5000);
      }
    }, 3000);
  }

  // ---------- EVENTS & IN-GAME PM COMMANDS ----------
  bot.on('spawn', () => {
    if (started) return;
    started = true;
    console.log(`Spawned securely! Version ${version} works.`);
    startProximityWatcher();
    startRandomChatLoop();
    startHungerMonitor();
    mainLoop().catch((e) => {
      if (e.message === 'old-bot') return;
      if (e.message === 'login failed') {
        reconnectDelay = Math.min(reconnectDelay * 2, 5 * 60 * 1000);
        try { bot.quit(); } catch (err) {}
      }
    });
  });

  bot.on('death', () => {
    sendDiscordAlert('⚠️ RockyRidge died in-game. Respawning and recovering memory state...');
    abort = true;
    setTimeout(async () => {
      try {
        bot.respawn();
        await sleep(5000);
        abort = false;
        resumeTaskState();
      } catch (e) {}
    }, 3000);
  });

  bot.on('whisper', async (username, message) => {
    if (username !== 'mcpa') return;
    const lower = message.trim().toLowerCase();
    console.log(`[WHISPER FROM MCPA] ${message}`);

    try {
      if (lower === 'stopwork') {
        manualStopWork = true;
        bot.setControlState('sneak', false);
        if (bot.pathfinder) bot.pathfinder.stop();
        say('Stopped work.');
      } 
      else if (lower === 'continuework') {
        manualStopWork = false;
        isProximityPaused = false;
        stopHeadTracking = false;
        say('Resuming work.');
        resumeTaskState();
      } 
      else if (lower.startsWith('say ')) {
        const msgText = message.slice(4).trim();
        say(msgText);
      } 
      else if (lower === 'jump') {
        bot.setControlState('jump', true);
        await sleep(200);
        bot.setControlState('jump', false);
      } 
      else if (lower === 'moveforward') {
        bot.setControlState('forward', true);
        await sleep(500);
        bot.setControlState('forward', false);
      } 
      else if (lower === 'moveleft') {
        bot.setControlState('left', true);
        await sleep(500);
        bot.setControlState('left', false);
      } 
      else if (lower === 'moveright') {
        bot.setControlState('right', true);
        await sleep(500);
        bot.setControlState('right', false);
      } 
      else if (lower === 'movebackward') {
        bot.setControlState('back', true);
        await sleep(500);
        bot.setControlState('back', false);
      } 
      else if (lower === 'stopfollow') {
        stopHeadTracking = true;
        say('Stopped eye tracking.');
      }
    } catch (e) {
      console.log('Command execution error:', e.message);
    }
  });

  bot.on('message', (m) => {
    const t = m.toString();
    gotAnyChat = true;
    if (/please/i.test(t) && /\/(login|register)/i.test(t)) lastPromptAt = Date.now();
    if (!/please|not logged|must|before/i.test(t) && /(success|logged in|authenticated|welcome back)/i.test(t)) {
      loggedIn = true;
    }
    if (/(wrong|incorrect|invalid|not match).{0,20}password/i.test(t)) {
      loginRejected = true;
    }
    console.log('[CHAT]', t);
  });

  bot.on('kicked', (r) => {
    const text = typeof r === 'string' ? r : JSON.stringify(r);
    if (/(wrong|incorrect|invalid|not match).{0,20}password/i.test(text)) {
      loginRejected = true;
      stopReconnect = true;
      sendDiscordAlert('⚠️ RockyRidge: wrong password. Bot stopped.');
    }
  });

  bot.on('error', (e) => {
    if (/unsupported|PartialRead|protocol/i.test(e.message)) {
      versionIndex++;
    }
  });

  bot.on('end', (reason) => {
    ended = true;
    onSurvivalServer = false;
    if (proximityCheckTimer) clearInterval(proximityCheckTimer);
    if (randomChatTimer) clearTimeout(randomChatTimer);
    if (hungerCheckTimer) clearInterval(hungerCheckTimer);
    if (stopReconnect) return;
    if (started && !gotAnyChat && !process.env.MC_VERSION) {
      versionIndex++;
    }
    setTimeout(createBot, reconnectDelay);
  });
}

function createBot() {
  try {
    startBot();
  } catch (e) {
    versionIndex++;
    setTimeout(createBot, 3000);
  }
}

createBot();