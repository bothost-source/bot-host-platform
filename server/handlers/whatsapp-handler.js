const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason,
  fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

class WhatsAppHandler {
  constructor(config) {
    this.botId = config.botId;
    this.botDir = config.botDir;
    this.onLog = config.onLog;
    this.onError = config.onError;
    this.onQR = config.onQR;
    this.sock = null;
    this.authDir = path.join(this.botDir, 'auth');
    this.qrDisplayed = false;
    this.connectionState = 'disconnected';
  }

  async start() {
    try {
      this.onLog('info', 'Initializing WhatsApp connection...');
      
      // Ensure auth directory exists
      fs.ensureDirSync(this.authDir);
      
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version } = await fetchLatestBaileysVersion();
      
      this.onLog('info', `Using Baileys v${version.join('.')}`);
      
      this.sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }), // Reduce noise
        printQRInTerminal: false, // We handle QR differently
        auth: state,
        browser: ['BotHost', 'Chrome', '1.0.0'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        emitOwnEvents: true,
        fireInitQueries: true,
        shouldIgnoreJid: (jid) => {
          // Ignore status broadcasts
          return jid?.endsWith('@broadcast');
        },
        getMessage: async (key) => {
          // Return message for retry purposes
          return { conversation: 'hello' };
        }
      });
      
      // Connection events
      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
          this.qrDisplayed = true;
          this.onLog('info', 'QR Code received, scan with WhatsApp');
          
          // Generate QR data URL for frontend
          try {
            const qrDataUrl = await QRCode.toDataURL(qr);
            this.onQR(qrDataUrl);
          } catch (e) {
            this.onLog('warn', 'Could not generate QR image');
          }
        }
        
        if (connection === 'close') {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          this.onLog('warn', `Connection closed: ${lastDisconnect?.error?.message || 'Unknown'}`);
          
          if (shouldReconnect) {
            this.onLog('info', 'Reconnecting...');
            setTimeout(() => this.start(), 5000);
          } else {
            this.onLog('error', 'Logged out, need to re-scan QR');
            this.connectionState = 'logged_out';
          }
        } else if (connection === 'open') {
          this.connectionState = 'connected';
          this.qrDisplayed = false;
          this.onLog('success', 'WhatsApp connected successfully!');
          
          // Send test message to owner if configured
          const userBotPath = path.join(this.botDir, 'bot.js');
          if (fs.existsSync(userBotPath)) {
            this.loadUserHandlers();
          }
        }
      });
      
      // Credentials update
      this.sock.ev.on('creds.update', saveCreds);
      
      // Message handler
      this.sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        
        for (const msg of m.messages) {
          if (msg.key.fromMe) continue; // Skip own messages
          
          this.onLog('info', `Message from ${msg.key.remoteJid}`, {
            message: msg.message?.conversation || '[media]'
          });
          
          // Process with user handlers
          await this.processMessage(msg);
        }
      });
      
      // Group participants update
      this.sock.ev.on('group-participants.update', (update) => {
        this.onLog('info', `Group update: ${update.action}`, { group: update.id });
      });
      
    } catch (error) {
      this.onLog('error', `WhatsApp init failed: ${error.message}`);
      this.onError(error);
    }
  }

  loadUserHandlers() {
    try {
      const userBotPath = path.join(this.botDir, 'bot.js');
      delete require.cache[require.resolve(userBotPath)];
      const userModule = require(userBotPath);
      
      if (typeof userModule === 'function') {
        this.userHandler = userModule;
        this.onLog('info', 'Custom handlers loaded');
      }
    } catch (e) {
      this.onLog('warn', `Custom handlers error: ${e.message}`);
    }
  }

  async processMessage(msg) {
    try {
      // Default auto-reply for hosting verification
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      const jid = msg.key.remoteJid;
      
      if (text.toLowerCase() === 'ping') {
        await this.sock.sendMessage(jid, { text: 'Pong! 🏓\nBot hosted on BotHost' });
      }
      
      // Call user handler if exists
      if (this.userHandler) {
        await this.userHandler(this.sock, msg);
      }
      
    } catch (error) {
      this.onLog('error', `Message processing error: ${error.message}`);
    }
  }

  async sendMessage(jid, content) {
    try {
      await this.sock.sendMessage(jid, content);
      return true;
    } catch (error) {
      this.onLog('error', `Send failed: ${error.message}`);
      return false;
    }
  }

  stop() {
    try {
      if (this.sock) {
        this.sock.end();
        this.onLog('info', 'WhatsApp connection closed');
      }
    } catch (e) {
      this.onLog('error', `Stop error: ${e.message}`);
    }
  }
}

module.exports = WhatsAppHandler;
