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

// Ensure directories
fs.ensureDirSync(UPLOAD_DIR);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// JWT Auth middleware
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// WebSocket auth
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

// Active bot processes
const activeBots = new Map();

// ==========================================
// WEBSOCKET HANDLING
// ==========================================

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('subscribe_bot', (botId) => {
    socket.join(`bot_${botId}`);
    socket.emit('subscribed', botId);
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

function broadcastLog(botId, level, message, metadata = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, level, message, ...metadata };
  
  db.addLog(botId, level, message).catch(console.error);
  io.to(`bot_${botId}`).emit('log', logEntry);
}

// ==========================================
// FILE UPLOAD CONFIG
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
  filename: (req, file, cb) => {
    // Keep original filename including extension
    cb(null, file.originalname);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    // Accept all files
    cb(null, true);
  }
});

// ==========================================
// ZIP EXTRACTION
// ==========================================

async function extractZipIfNeeded(botDir) {
  const files = await fs.readdir(botDir);
  const zipFile = files.find(f => f.toLowerCase().endsWith('.zip'));
  
  if (zipFile) {
    const zipPath = path.join(botDir, zipFile);
    broadcastLog(path.basename(botDir), 'info', `Extracting ${zipFile}...`);
    
    try {
      await fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: botDir }))
        .promise();
      
      await fs.remove(zipPath);
      broadcastLog(path.basename(botDir), 'success', 'ZIP extracted successfully');
      
      // Move files from subfolder if they were zipped in a folder
      const subdirs = await fs.readdir(botDir, { withFileTypes: true });
      const folders = subdirs.filter(d => d.isDirectory());
      
      if (folders.length === 1 && files.length <= 2) {
        const innerPath = path.join(botDir, folders[0].name);
        const innerFiles = await fs.readdir(innerPath);
        for (const file of innerFiles) {
          await fs.move(path.join(innerPath, file), path.join(botDir, file), { overwrite: true });
        }
        await fs.remove(innerPath);
      }
      
      return true;
    } catch (error) {
      broadcastLog(path.basename(botDir), 'error', `ZIP extraction failed: ${error.message}`);
      throw error;
    }
  }
  return false;
}

// ==========================================
// AUTH ROUTES
// ==========================================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const user = await db.createUser(email, password);
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({ success: true, token, api_key: user.api_key });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await db.validateUser(email, password);
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, api_key: user.api_key, max_bots: user.max_bots });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ==========================================
// BOT UPLOAD & DEPLOYMENT
// ==========================================

app.post('/api/bots', authenticate, upload.array('files', 20), async (req, res) => {
  const { botId, botDir } = req;
  
  try {
    const { name, platform, token } = req.body;
    const userId = req.userId;
    
    if (!platform || !token) {
      await fs.remove(botDir);
      return res.status(400).json({ error: 'Platform and token required' });
    }
    
    // Check bot limit
    const userBots = await db.getBotsByUser(userId);
    const user = await new Promise((resolve, reject) => {
      db.db.get('SELECT max_bots FROM users WHERE id = ?', [userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (userBots.length >= user.max_bots) {
      await fs.remove(botDir);
      return res.status(403).json({ error: `Bot limit reached (max ${user.max_bots})` });
    }
    
    broadcastLog(botId, 'info', 'Files uploaded, checking for ZIP...');
    
    // Extract ZIP if present
    await extractZipIfNeeded(botDir);
    
    // Check what files we have now
    const files = await fs.readdir(botDir);
    broadcastLog(botId, 'info', `Files in directory: ${files.join(', ')}`);
    
    // Save bot record
    await db.createBot({
      id: botId,
      userId,
      name: name || `Bot-${botId.slice(0, 8)}`,
      platform,
      token,
      config: { files }
    });
    
    // Install dependencies if package.json exists
    const pkgJson = path.join(botDir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      broadcastLog(botId, 'info', 'Installing dependencies...');
      await installDependencies(botId, botDir);
    }
    
    // Auto-start the bot immediately
    broadcastLog(botId, 'info', 'Auto-starting bot...');
    const botConfig = await db.getBot(botId);
    await startBotProcess(botConfig);
    await db.updateBotStatus(botId, 'running');
    
    broadcastLog(botId, 'success', 'Bot deployed and started!');
    
    res.json({ 
      success: true, 
      botId, 
      message: 'Bot uploaded and started',
      status: 'running',
      webhookUrl: `${req.protocol}://${req.get('host')}/webhook/${botId}`
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    broadcastLog(botId, 'error', `Deployment failed: ${error.message}`);
    await fs.remove(botDir).catch(() => {});
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// BOT MANAGEMENT
// ==========================================

app.get('/api/bots', authenticate, async (req, res) => {
  try {
    const bots = await db.getBotsByUser(req.userId);
    const botsWithStatus = bots.map(b => ({
      ...b,
      isRunning: activeBots.has(b.id),
      pid: activeBots.get(b.id)?.process?.pid
    }));
    res.json(botsWithStatus);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:botId/start', authenticate, async (req, res) => {
  try {
    const { botId } = req.params;
    const bot = await db.getBot(botId);
    
    if (!bot || bot.user_id !== req.userId) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    if (activeBots.has(botId)) {
      return res.json({ success: true, message: 'Bot already running' });
    }
    
    broadcastLog(botId, 'info', 'Starting bot...');
    await startBotProcess(bot);
    await db.updateBotStatus(botId, 'running');
    
    res.json({ success: true, message: 'Bot started', status: 'running' });
  } catch (error) {
    broadcastLog(req.params.botId, 'error', `Start failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:botId/stop', authenticate, async (req, res) => {
  try {
    const { botId } = req.params;
    const bot = await db.getBot(botId);
    
    if (!bot || bot.user_id !== req.userId) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    stopBotProcess(botId);
    await db.updateBotStatus(botId, 'stopped');
    
    res.json({ success: true, message: 'Bot stopped' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/bots/:botId/logs', authenticate, async (req, res) => {
  try {
    const { botId } = req.params;
    const bot = await db.getBot(botId);
    
    if (!bot || bot.user_id !== req.userId) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
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
    
    if (!bot || bot.user_id !== req.userId) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    stopBotProcess(botId);
    await fs.remove(path.join(UPLOAD_DIR, botId));
    await db.deleteBot(botId);
    
    res.json({ success: true, message: 'Bot deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// WEBHOOK HANDLER
// ==========================================

app.post('/webhook/:botId', express.json(), async (req, res) => {
  try {
    const { botId } = req.params;
    const bot = await db.getBot(botId);
    
    if (!bot) return res.status(404).send('Bot not found');
    
    const activeBot = activeBots.get(botId);
    if (activeBot && activeBot.handler) {
      activeBot.handler.handleUpdate(req.body);
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});

// ==========================================
// BOT PROCESS MANAGEMENT
// ==========================================

async function installDependencies(botId, botDir) {
  return new Promise((resolve, reject) => {
    // Check if node_modules exists
    if (fs.existsSync(path.join(botDir, 'node_modules'))) {
      broadcastLog(botId, 'info', 'Dependencies already installed');
      return resolve();
    }
    
    const npm = spawn('npm', ['install'], { 
      cwd: botDir,
      stdio: 'pipe',
      env: { ...process.env, npm_config_loglevel: 'error' }
    });
    
    let output = '';
    npm.stdout.on('data', d => {
      output += d;
      broadcastLog(botId, 'info', d.toString().trim());
    });
    npm.stderr.on('data', d => {
      output += d;
      broadcastLog(botId, 'warn', d.toString().trim());
    });
    
    npm.on('close', (code) => {
      if (code === 0) {
        broadcastLog(botId, 'success', 'Dependencies installed');
        resolve();
      } else {
        reject(new Error(`npm install failed with code ${code}`));
      }
    });
    
    npm.on('error', (err) => {
      reject(new Error(`Failed to start npm: ${err.message}`));
    });
  });
}

async function startBotProcess(botConfig) {
  const botId = botConfig.id;
  const botDir = path.join(UPLOAD_DIR, botId);
  
  try {
    // Stop existing if running
    stopBotProcess(botId);
    
    broadcastLog(botId, 'info', `Initializing ${botConfig.platform} bot...`);
    
    // Create wrapper script
    const wrapperPath = path.join(botDir, 'wrapper.js');
    const wrapperCode = generateWrapperCode(botConfig, botDir);
    fs.writeFileSync(wrapperPath, wrapperCode);
    
    // Start the process
    const logFile = path.join(botDir, 'process.log');
    const out = fs.openSync(logFile, 'a');
    const err = fs.openSync(logFile, 'a');
    
    const proc = spawn('node', ['wrapper.js'], {
      cwd: botDir,
      env: {
        ...process.env,
        BOT_TOKEN: botConfig.token,
        BOT_ID: botId,
        WEBHOOK_URL: botConfig.url || '',
        NODE_ENV: 'production'
      },
      stdio: ['ignore', out, err],
      detached: true
    });
    
    proc.unref();
    
    // Monitor process
    proc.on('error', (err) => {
      broadcastLog(botId, 'error', `Process error: ${err.message}`);
    });
    
    proc.on('exit', (code) => {
      if (code !== 0) {
        broadcastLog(botId, 'error', `Process exited with code ${code}`);
      }
      activeBots.delete(botId);
      db.updateBotStatus(botId, 'stopped').catch(() => {});
    });
    
    // Store active bot
    activeBots.set(botId, {
      process: proc,
      userId: botConfig.user_id,
      config: botConfig,
      startTime: Date.now()
    });
    
    // For Telegram, set webhook
    if (botConfig.platform === 'telegram') {
      await setTelegramWebhook(botConfig.token, `${process.env.RENDER_EXTERNAL_URL || `https://bot-host-platform.onrender.com`}/webhook/${botId}`);
    }
    
    broadcastLog(botId, 'success', 'Bot process started successfully!');
    
  } catch (error) {
    broadcastLog(botId, 'error', `Failed to start: ${error.message}`);
    throw error;
  }
}

function generateWrapperCode(config, botDir) {
  const userBotPath = path.join(botDir, 'bot.js');
  const hasUserBot = fs.existsSync(userBotPath);
  
  if (config.platform === 'telegram') {
    return `
const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');

const bot = new Telegraf(process.env.BOT_TOKEN);

// Default commands
bot.start((ctx) => ctx.reply('🤖 Bot is live on BotHost!\\n\\nCommands:\\n/help - Show help\\n/status - Check status'));
bot.help((ctx) => ctx.reply('Available commands:\\n/start - Start\\n/help - Help\\n/status - Check bot status\\n/info - Bot info'));
bot.command('status', (ctx) => ctx.reply('✅ Bot is running normally'));
bot.command('info', (ctx) => ctx.reply('Hosted on BotHost Platform'));

// Load user's bot.js if exists
const userBotPath = path.join(__dirname, 'bot.js');
if (fs.existsSync(userBotPath)) {
  try {
    console.log('Loading user bot.js...');
    const userModule = require(userBotPath);
    if (typeof userModule === 'function') {
      userModule(bot);
      console.log('User bot loaded successfully');
    }
  } catch(e) {
    console.error('User bot error:', e.message);
  }
}

// Error handling
bot.catch((err, ctx) => {
  console.error('Bot error:', err.message);
});

// Start bot
console.log('Starting Telegram bot...');
bot.launch({
  polling: {
    timeout: 30,
    limit: 100
  }
}).then(() => {
  console.log('Bot is running!');
}).catch(err => {
  console.error('Failed to start:', err);
});
`;
  } else {
    // WhatsApp wrapper
    return `
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

async function startWhatsApp() {
  console.log('Starting WhatsApp bot...');
  
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
      console.log('Connection closed, reconnecting:', shouldReconnect);
      if (shouldReconnect) setTimeout(startWhatsApp, 5000);
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
      
      console.log('Message from', jid, ':', text);
      
      if (text.toLowerCase() === 'ping') {
        await sock.sendMessage(jid, { text: 'Pong! 🏓\\nBot hosted on BotHost' });
      }
      
      // Load user handler
      const userPath = path.join(__dirname, 'bot.js');
      if (fs.existsSync(userPath)) {
        try {
          const userMod = require(userPath);
          if (typeof userMod === 'function') await userMod(sock, msg);
        } catch(e) {}
      }
    }
  });
}

startWhatsApp().catch(console.error);
`;
  }
}

async function setTelegramWebhook(token, url) {
  const axios = require('axios');
  try {
    await axios.get(\`https://api.telegram.org/bot\${token}/setWebhook?url=\${url}\`);
    console.log('Webhook set:', url);
  } catch (e) {
    console.error('Webhook failed:', e.message);
  }
}

function stopBotProcess(botId) {
  const active = activeBots.get(botId);
  if (active) {
    try {
      process.kill(-active.process.pid, 'SIGTERM');
    } catch (e) {
      try {
        active.process.kill('SIGKILL');
      } catch (e2) {}
    }
    activeBots.delete(botId);
    broadcastLog(botId, 'info', 'Bot stopped');
  }
}

// Cleanup
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  for (const [botId] of activeBots) {
    stopBotProcess(botId);
  }
  await db.close();
  server.close();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(\`🚀 BotHost running on port \${PORT}\`);
  console.log(\`📁 Upload directory: \${UPLOAD_DIR}\`);
});
