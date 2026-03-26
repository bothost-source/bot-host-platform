const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const unzipper = require('unzipper');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const UPLOAD_DIR = path.join(__dirname, '../uploads');

fs.ensureDirSync(UPLOAD_DIR);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('No token'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    next();
  } catch (e) {
    next(new Error('Invalid token'));
  }
});

const activeBots = new Map();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('subscribe_bot', (botId) => {
    socket.join(`bot_${botId}`);
    socket.emit('subscribed', botId);
  });
});

function broadcastLog(botId, level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, level, message, ...meta };
  db.addLog(botId, level, message).catch(() => {});
  io.to(`bot_${botId}`).emit('log', entry);
}

// ==========================================
// AUTO-EXTRACT BOT TOKEN FROM FILES
// ==========================================

function extractTokenFromContent(content) {
  // Match various token formats
  const patterns = [
    /['"]BOT_TOKEN['"]\s*[:=]\s*['"](\d+:[A-Za-z0-9_-]{35,})['"]/,
    /['"]token['"]\s*[:=]\s*['"](\d+:[A-Za-z0-9_-]{35,})['"]/,
    /new Telegraf\s*\(\s*['"](\d+:[A-Za-z0-9_-]{35,})['"]\s*\)/,
    /Telegraf\s*\(\s*['"](\d+:[A-Za-z0-9_-]{35,})['"]\s*\)/,
    /bot\s*=\s*new\s+Telegraf\s*\(\s*['"](\d+:[A-Za-z0-9_-]{35,})['"]\s*\)/,
    /['"](\d+:[A-Za-z0-9_-]{35,})['"]/,
    /(\d{9,10}:[A-Za-z0-9_-]{35})/
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function findBotToken(botDir) {
  const files = await listAllFiles(botDir);
  let token = null;
  
  // Priority: token.js, config.js, .env, then any .js
  const priorityFiles = ['token.js', 'config.js', 'config.json', '.env', 'index.js', 'bot.js', 'app.js'];
  
  // Check priority files first
  for (const priority of priorityFiles) {
    const filePath = path.join(botDir, priority);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      token = extractTokenFromContent(content);
      if (token) {
        broadcastLog(path.basename(botDir), 'info', `Found token in ${priority}`);
        return { token, sourceFile: priority };
      }
    }
  }
  
  // Search all JS files
  for (const file of files) {
    if (file.endsWith('.js') || file.endsWith('.json') || file.endsWith('.env')) {
      const filePath = path.join(botDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        token = extractTokenFromContent(content);
        if (token) {
          broadcastLog(path.basename(botDir), 'info', `Found token in ${file}`);
          return { token, sourceFile: file };
        }
      } catch (e) {}
    }
  }
  
  return null;
}

function detectPlatform(botDir, files) {
  // Check for Telegram indicators
  const telegramIndicators = ['telegraf', 'node-telegram-bot-api', 'grammy'];
  const whatsappIndicators = ['baileys', 'whatsapp-web.js', '@whiskeysockets/baileys'];
  
  const allContent = files
    .filter(f => f.endsWith('.js') || f.endsWith('.json'))
    .map(f => {
      try {
        return fs.readFileSync(path.join(botDir, f), 'utf8').toLowerCase();
      } catch (e) { return ''; }
    })
    .join(' ');
  
  for (const indicator of telegramIndicators) {
    if (allContent.includes(indicator)) return 'telegram';
  }
  for (const indicator of whatsappIndicators) {
    if (allContent.includes(indicator)) return 'whatsapp';
  }
  
  // Default to telegram if Telegraf found in code
  return 'telegram';
}

// ==========================================
// UPLOAD & FILE HANDLING
// ==========================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const botId = crypto.randomUUID();
    const botDir = path.join(UPLOAD_DIR, botId);
    fs.ensureDirSync(botDir);
    req.botId = botId;
    req.botDir = botDir;
    cb(null, botDir);
  },
  filename: (req, file, cb) => cb(null, file.originalname)
});

const upload = multer({ 
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, true)
});

async function listAllFiles(dir, basePath = '') {
  const items = await fs.readdir(dir, { withFileTypes: true });
  let files = [];
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    const relPath = path.join(basePath, item.name);
    if (item.isDirectory()) {
      const subFiles = await listAllFiles(fullPath, relPath);
      files = files.concat(subFiles);
    } else {
      files.push(relPath);
    }
  }
  return files;
}

async function extractZip(botDir) {
  const files = await fs.readdir(botDir);
  const zipFile = files.find(f => f.toLowerCase().endsWith('.zip'));
  
  if (!zipFile) return false;
  
  const zipPath = path.join(botDir, zipFile);
  broadcastLog(path.basename(botDir), 'info', `Extracting ${zipFile}...`);
  
  try {
    await fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: botDir }))
      .promise();
    
    await fs.remove(zipPath);
    
    // Flatten if single subfolder
    const items = await fs.readdir(botDir, { withFileTypes: true });
    const folders = items.filter(i => i.isDirectory());
    
    if (folders.length === 1 && items.length === 1) {
      const subDir = path.join(botDir, folders[0].name);
      const subItems = await fs.readdir(subDir);
      for (const item of subItems) {
        await fs.move(path.join(subDir, item), path.join(botDir, item), { overwrite: true });
      }
      await fs.remove(subDir);
    }
    
    return true;
  } catch (error) {
    broadcastLog(path.basename(botDir), 'error', `Extract failed: ${error.message}`);
    throw error;
  }
}

function findEntryPoint(botDir) {
  const candidates = ['index.js', 'bot.js', 'app.js', 'server.js', 'main.js', 'start.js'];
  for (const file of candidates) {
    if (fs.existsSync(path.join(botDir, file))) return file;
  }
  const files = fs.readdirSync(botDir);
  const jsFile = files.find(f => f.endsWith('.js') && !f.includes('wrapper'));
  return jsFile || null;
}

// ==========================================
// AUTH ROUTES
// ==========================================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await db.createUser(email, password);
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, api_key: user.api_key });
  } catch (error) {
    if (error.message.includes('UNIQUE')) return res.status(400).json({ error: 'Email exists' });
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await db.validateUser(email, password);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, api_key: user.api_key, max_bots: user.max_bots });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// ==========================================
// BOT UPLOAD - NO TOKEN REQUIRED!
// ==========================================

app.post('/api/bots', authenticate, upload.array('files', 50), async (req, res) => {
  const { botId, botDir } = req;
  
  try {
    const { name } = req.body;
    const userId = req.userId;
    
    // Check limits
    const userBots = await db.getBotsByUser(userId);
    const user = await new Promise((resolve, reject) => {
      db.db.get('SELECT max_bots FROM users WHERE id = ?', [userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (userBots.length >= (user?.max_bots || 3)) {
      await fs.remove(botDir);
      return res.status(403).json({ error: 'Bot limit reached' });
    }
    
    broadcastLog(botId, 'info', 'Processing upload...');
    
    // Extract ZIP
    await extractZip(botDir);
    
    const allFiles = await listAllFiles(botDir);
    broadcastLog(botId, 'info', `Found ${allFiles.length} files`);
    
    // AUTO-FIND TOKEN!
    broadcastLog(botId, 'info', 'Searching for bot token...');
    const tokenData = await findBotToken(botDir);
    
    if (!tokenData || !tokenData.token) {
      await fs.remove(botDir);
      return res.status(400).json({ 
        error: 'No bot token found in files. Please include token.js or config with BOT_TOKEN' 
      });
    }
    
    const { token, sourceFile } = tokenData;
    broadcastLog(botId, 'success', `Token found in ${sourceFile}`);
    
    // Detect platform
    const platform = detectPlatform(botDir, allFiles);
    broadcastLog(botId, 'info', `Detected platform: ${platform}`);
    
    // Find entry point
    const entryFile = findEntryPoint(botDir);
    if (!entryFile) {
      await fs.remove(botDir);
      return res.status(400).json({ error: 'No entry file found (index.js, bot.js, etc.)' });
    }
    broadcastLog(botId, 'info', `Entry point: ${entryFile}`);
    
    // Save to DB
    await db.createBot({
      id: botId,
      userId,
      name: name || `Bot-${botId.slice(0, 8)}`,
      platform,
      token,
      config: { entryFile, sourceFile, files: allFiles }
    });
    
    // Install deps
    if (fs.existsSync(path.join(botDir, 'package.json'))) {
      broadcastLog(botId, 'info', 'Installing dependencies...');
      await installDeps(botId, botDir);
    }
    
    // Start bot
    broadcastLog(botId, 'info', 'Starting bot...');
    const botConfig = await db.getBot(botId);
    await startBot(botConfig, entryFile);
    await db.updateBotStatus(botId, 'running');
    
    broadcastLog(botId, 'success', 'Bot is running!');
    
    res.json({ 
      success: true, 
      botId, 
      platform,
      tokenSource: sourceFile,
      status: 'running',
      entryFile
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    broadcastLog(botId, 'error', `Failed: ${error.message}`);
    await fs.remove(botDir).catch(() => {});
    res.status(500).json({ error: error.message });
  }
});

async function installDeps(botId, botDir) {
  return new Promise((resolve, reject) => {
    const npm = spawn('npm', ['install', '--production'], {
      cwd: botDir,
      stdio: 'pipe',
      env: { ...process.env, npm_config_loglevel: 'error' }
    });
    
    npm.stdout.on('data', d => {
      const line = d.toString().trim();
      if (line.includes('added') || line.includes('removed')) {
        broadcastLog(botId, 'info', line);
      }
    });
    
    npm.stderr.on('data', d => {
      const line = d.toString().trim();
      if (!line.includes('WARN')) broadcastLog(botId, 'warn', line);
    });
    
    npm.on('close', (code) => {
      if (code === 0) {
        broadcastLog(botId, 'success', 'Dependencies installed');
        resolve();
      } else {
        reject(new Error(`npm install failed`));
      }
    });
  });
}

// ==========================================
// START BOT
// ==========================================

async function startBot(botConfig, entryFile) {
  const botId = botConfig.id;
  const botDir = path.join(UPLOAD_DIR, botId);
  
  stopBot(botId);
  
  const isTelegram = botConfig.platform === 'telegram';
  const logFile = path.join(botDir, 'runtime.log');
  
  // Create wrapper
  const wrapperPath = path.join(botDir, '.wrapper.js');
  const wrapperCode = isTelegram 
    ? createTelegramWrapper(botConfig.token, entryFile, botDir)
    : createWhatsAppWrapper(entryFile);
  
  fs.writeFileSync(wrapperPath, wrapperCode);
  
  // Start process
  const out = fs.openSync(logFile, 'a');
  const err = fs.openSync(logFile, 'a');
  
  const proc = spawn('node', ['.wrapper.js'], {
    cwd: botDir,
    env: {
      ...process.env,
      BOT_TOKEN: botConfig.token,
      BOT_ID: botId,
      NODE_ENV: 'production'
    },
    stdio: ['ignore', out, err],
    detached: true
  });
  
  proc.unref();
  
  // Stream logs
  const streamLogs = () => {
    try {
      const stats = fs.statSync(logFile);
      const stream = fs.createReadStream(logFile, { start: stats.size - 5000 });
      stream.on('data', (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        lines.forEach(line => {
          const level = line.toLowerCase().includes('error') ? 'error' 
            : line.toLowerCase().includes('warn') ? 'warn' 
            : 'info';
          broadcastLog(botId, level, line.slice(0, 200));
        });
      });
    } catch (e) {}
  };
  
  setTimeout(streamLogs, 1000);
  const logInterval = setInterval(streamLogs, 2000);
  
  proc.on('exit', (code) => {
    clearInterval(logInterval);
    broadcastLog(botId, code === 0 ? 'info' : 'error', `Process exited (code ${code})`);
    activeBots.delete(botId);
    db.updateBotStatus(botId, 'stopped').catch(() => {});
  });
  
  activeBots.set(botId, {
    process: proc,
    userId: botConfig.user_id,
    config: botConfig,
    startTime: Date.now()
  });
  
  // Set webhook for Telegram
  if (isTelegram) {
    try {
      const axios = require('axios');
      const webhookUrl = `${process.env.RENDER_EXTERNAL_URL || `https://bot-host-platform.onrender.com`}/webhook/${botId}`;
      await axios.get(`https://api.telegram.org/bot${botConfig.token}/setWebhook?url=${webhookUrl}`);
      broadcastLog(botId, 'info', 'Webhook active');
    } catch (e) {
      broadcastLog(botId, 'info', 'Using polling mode');
    }
  }
}

function createTelegramWrapper(token, entryFile, botDir) {
  // Read user's package.json to check dependencies
  const pkgPath = path.join(botDir, 'package.json');
  let useTelegraf = true;
  
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['node-telegram-bot-api']) useTelegraf = false;
    } catch (e) {}
  }
  
  if (useTelegraf) {
    return `
const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');

// Use token from env or extracted token
const bot = new Telegraf(process.env.BOT_TOKEN);

// Default commands
bot.start((ctx) => ctx.reply('🤖 Bot is live on BotHost!'));
bot.help((ctx) => ctx.reply('Bot is running\\n/status - Check status'));
bot.command('status', (ctx) => ctx.reply('✅ Running normally'));

// Load user's bot - try multiple methods
try {
  const userPath = path.join(__dirname, '${entryFile}');
  if (fs.existsSync(userPath)) {
    console.log('Loading:', '${entryFile}');
    
    // Clear cache for hot reload
    delete require.cache[require.resolve(userPath)];
    const userBot = require(userPath);
    
    // Method 1: Function that receives bot
    if (typeof userBot === 'function') {
      userBot(bot);
      console.log('Loaded as function');
    }
    // Method 2: Object with commands
    else if (userBot && typeof userBot === 'object') {
      Object.keys(userBot).forEach(key => {
        if (typeof userBot[key] === 'function') {
          bot.command(key, userBot[key]);
        }
      });
      console.log('Loaded as command object');
    }
    // Method 3: Already initialized bot (they used new Telegraf)
    else {
      console.log('Using default handlers');
    }
  }
} catch(e) {
  console.error('Load error:', e.message);
}

bot.catch((err, ctx) => console.error('Error:', err.message));

console.log('Starting bot...');
bot.launch({
  polling: {
    timeout: 30,
    limit: 100
  }
}).then(() => console.log('Bot running!'))
.catch(err => {
  console.error('Start failed:', err);
  process.exit(1);
});
`;
  } else {
    // node-telegram-bot-api wrapper
    return `
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

bot.onText(/\\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '🤖 Bot is live on BotHost!');
});

// Load user bot
try {
  require(path.join(__dirname, '${entryFile}'));
} catch(e) {
  console.error('User bot error:', e.message);
}

console.log('Bot started');
`;
  }
}

function createWhatsAppWrapper(entryFile) {
  return `
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

async function start() {
  console.log('Starting WhatsApp...');
  
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['BotHost', 'Chrome', '1.0.0']
  });
  
  sock.ev.on('creds.update', saveCreds);
  
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(start, 5000);
    } else if (connection === 'open') {
      console.log('WhatsApp connected!');
    }
  });
  
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    for (const msg of m.messages) {
      if (msg.key.fromMe) continue;
      const text = msg.message?.conversation || '';
      const jid = msg.key.remoteJid;
      
      if (text.toLowerCase() === 'ping') {
        await sock.sendMessage(jid, { text: 'Pong! 🏓' });
      }
      
      try {
        const userPath = path.join(__dirname, '${entryFile}');
        if (fs.existsSync(userPath)) {
          delete require.cache[require.resolve(userPath)];
          const userMod = require(userPath);
          if (typeof userMod === 'function') await userMod(sock, msg);
        }
      } catch(e) {}
    }
  });
}

start().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
`;
}

// ==========================================
// ROUTES
// ==========================================

app.get('/api/bots', authenticate, async (req, res) => {
  try {
    const bots = await db.getBotsByUser(req.userId);
    const enriched = bots.map(b => ({
      ...b,
      isRunning: activeBots.has(b.id),
      uptime: activeBots.get(b.id)?.startTime ? Date.now() - activeBots.get(b.id).startTime : 0
    }));
    res.json(enriched);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:botId/start', authenticate, async (req, res) => {
  try {
    const { botId } = req.params;
    const bot = await db.getBot(botId);
    if (!bot || bot.user_id !== req.userId) return res.status(404).json({ error: 'Not found' });
    
    const entryFile = bot.config?.entryFile || findEntryPoint(path.join(UPLOAD_DIR, botId));
    await startBot(bot, entryFile);
    await db.updateBotStatus(botId, 'running');
    res.json({ success: true, status: 'running' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:botId/stop', authenticate, async (req, res) => {
  const { botId } = req.params;
  const bot = await db.getBot(botId);
  if (!bot || bot.user_id !== req.userId) return res.status(404).json({ error: 'Not found' });
  
  stopBot(botId);
  await db.updateBotStatus(botId, 'stopped');
  res.json({ success: true });
});

function stopBot(botId) {
  const active = activeBots.get(botId);
  if (active) {
    try { process.kill(-active.process.pid, 'SIGTERM'); } catch (e) {
      try { active.process.kill('SIGKILL'); } catch (e2) {}
    }
    activeBots.delete(botId);
  }
}

app.get('/api/bots/:botId/logs', authenticate, async (req, res) => {
  try {
    const { botId } = req.params;
    const bot = await db.getBot(botId);
    if (!bot || bot.user_id !== req.userId) return res.status(404).json({ error: 'Not found' });
    const logs = await db.getLogs(botId, 100);
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/bots/:botId', authenticate, async (req, res) => {
  try {
    const { botId } = req.params;
    const bot = await db.getBot(botId);
    if (!bot || bot.user_id !== req.userId) return res.status(404).json({ error: 'Not found' });
    stopBot(botId);
    await fs.remove(path.join(UPLOAD_DIR, botId));
    await db.deleteBot(botId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/webhook/:botId', express.json(), async (req, res) => {
  try {
    const active = activeBots.get(req.params.botId);
    if (active?.handler) active.handler.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'BotHost Running', bots: activeBots.size, uptime: process.uptime() });
});

process.on('SIGTERM', async () => {
  for (const [botId] of activeBots) stopBot(botId);
  await db.close();
  server.close();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`🚀 BotHost running on port ${PORT}`);
});
