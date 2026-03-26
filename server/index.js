const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { exec, spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./database');
const { createHandler } = require('./handlers');

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

// Active bot processes & connections
const activeBots = new Map();
const userSockets = new Map(); // userId -> Set of sockets

// ==========================================
// WEBSOCKET HANDLING
// ==========================================

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id, 'User:', socket.userId);
  
  // Track user connections
  if (!userSockets.has(socket.userId)) {
    userSockets.set(socket.userId, new Set());
  }
  userSockets.get(socket.userId).add(socket);
  
  // Join bot-specific rooms
  socket.on('subscribe_bot', (botId) => {
    socket.join(`bot_${botId}`);
    socket.emit('subscribed', botId);
  });
  
  socket.on('disconnect', () => {
    const sockets = userSockets.get(socket.userId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) userSockets.delete(socket.userId);
    }
  });
});

// Broadcast log to bot subscribers
function broadcastLog(botId, level, message, metadata = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, level, message, ...metadata };
  
  // Save to database
  db.addLog(botId, level, message).catch(console.error);
  
  // Broadcast to WebSocket
  io.to(`bot_${botId}`).emit('log', logEntry);
  
  // Also emit to user's dashboard
  const bot = activeBots.get(botId);
  if (bot) {
    io.to(`user_${bot.userId}`).emit('bot_status', { botId, status: bot.status });
  }
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
// BOT MANAGEMENT ROUTES
// ==========================================

// Multer config
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
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.js', '.json', '.env', '.py'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// Upload bot
app.post('/api/bots', authenticate, upload.array('files', 10), async (req, res) => {
  try {
    const { botId, botDir } = req;
    const { name, platform, token } = req.body;
    const userId = req.userId;
    
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
    
    // Save bot record
    await db.createBot({
      id: botId,
      userId,
      name: name || `Bot-${botId.slice(0, 8)}`,
      platform,
      token,
      config: {}
    });
    
    // Install dependencies
    const pkgJson = path.join(botDir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      broadcastLog(botId, 'info', 'Installing dependencies...');
      await installDependencies(botId, botDir);
    }
    
    broadcastLog(botId, 'success', 'Bot uploaded successfully');
    
    res.json({ 
      success: true, 
      botId, 
      message: 'Bot uploaded',
      webhookUrl: `${req.protocol}://${req.get('host')}/webhook/${botId}`
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    broadcastLog(req.botId, 'error', `Upload failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get user's bots
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

// Start bot
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
    res.json({ success: true, message: 'Bot started' });
    
  } catch (error) {
    broadcastLog(req.params.botId, 'error', `Start failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Stop bot
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

// Get logs (WebSocket preferred, but HTTP fallback)
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

// Delete bot
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

// Webhook handler
app.post('/webhook/:botId', express.json(), async (req, res) => {
  try {
    const { botId } = req.params;
    const bot = await db.getBot(botId);
    
    if (!bot) return res.status(404).send('Bot not found');
    
    // Forward to active bot process via IPC or handle
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
    const npm = spawn('npm', ['install'], { 
      cwd: botDir,
      stdio: 'pipe'
    });
    
    let output = '';
    npm.stdout.on('data', d => {
      output += d;
      broadcastLog(botId, 'info', d.toString());
    });
    npm.stderr.on('data', d => {
      output += d;
      broadcastLog(botId, 'warn', d.toString());
    });
    
    npm.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install failed with code ${code}`));
    });
  });
}

async function startBotProcess(botConfig) {
  const botId = botConfig.id;
  const botDir = path.join(UPLOAD_DIR, botId);
  
  // Create appropriate handler
  const handler = createHandler(botConfig.platform, {
    botId,
    token: botConfig.token,
    botDir,
    onLog: (level, msg, meta) => broadcastLog(botId, level, msg, meta),
    onError: (err) => {
      broadcastLog(botId, 'error', err.message);
      stopBotProcess(botId);
    },
    onQR: (qr) => {
      // For WhatsApp QR code
      broadcastLog(botId, 'qr', 'Scan QR code to connect', { qr });
    }
  });
  
  // Start the handler
  await handler.start();
  
  activeBots.set(botId, {
    process: handler,
    userId: botConfig.user_id,
    config: botConfig,
    handler,
    startTime: Date.now()
  });
  
  broadcastLog(botId, 'success', 'Bot started successfully');
}

function stopBotProcess(botId) {
  const active = activeBots.get(botId);
  if (active) {
    try {
      active.handler.stop();
    } catch (e) {
      console.error('Error stopping bot:', e);
    }
    activeBots.delete(botId);
    broadcastLog(botId, 'info', 'Bot stopped');
  }
}

// Error handling & cleanup
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

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
  console.log(`🚀 BotHost MVP with WebSocket running on port ${PORT}`);
  console.log(`🔑 JWT Secret: ${JWT_SECRET.substring(0, 20)}...`);
});
