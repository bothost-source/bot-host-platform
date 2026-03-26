const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

class TelegramHandler {
  constructor(config) {
    this.botId = config.botId;
    this.token = config.token;
    this.botDir = config.botDir;
    this.onLog = config.onLog;
    this.onError = config.onError;
    this.bot = null;
    this.userModule = null;
  }

  async start() {
    try {
      this.bot = new Telegraf(this.token);
      
      // Load user's custom bot.js if exists
      const userBotPath = path.join(this.botDir, 'bot.js');
      if (fs.existsSync(userBotPath)) {
        this.onLog('info', 'Loading custom bot.js...');
        try {
          // Clear require cache
          delete require.cache[require.resolve(userBotPath)];
          this.userModule = require(userBotPath);
          
          // If user exports a function, call it with bot instance
          if (typeof this.userModule === 'function') {
            this.userModule(this.bot);
          }
        } catch (e) {
          this.onLog('warn', `Failed to load custom bot.js: ${e.message}`);
        }
      }
      
      // Default handlers
      this.setupDefaultHandlers();
      
      // Error handling
      this.bot.catch((err, ctx) => {
        this.onLog('error', `Bot error: ${err.message}`, { ctx: ctx?.update?.update_id });
      });
      
      // Start in webhook mode for serverless compatibility
      // Note: Actual webhook is set at platform level, bot runs in polling mode internally
      // but we control it via the wrapper
      this.bot.launch({
        polling: {
          timeout: 30,
          limit: 100,
          retryAfter: 5000
        }
      });
      
      this.onLog('success', 'Telegram bot polling started');
      
    } catch (error) {
      this.onLog('error', `Failed to start: ${error.message}`);
      throw error;
    }
  }

  setupDefaultHandlers() {
    this.bot.start((ctx) => {
      ctx.reply('🤖 Bot hosted on BotHost Platform\n\nUse /help for commands');
    });
    
    this.bot.command('help', (ctx) => {
      ctx.reply(`
Available commands:
/start - Start bot
/help - Show help
/status - Check bot status
/info - Bot information
      `);
    });
    
    this.bot.command('status', (ctx) => {
      const uptime = process.uptime();
      ctx.reply(`✅ Bot is running\nUptime: ${Math.floor(uptime / 60)}m ${Math.floor(uptime % 60)}s`);
    });
    
    this.bot.command('info', (ctx) => {
      ctx.reply(`Bot ID: ${this.botId}\nPlatform: Telegram\nHosted on: BotHost`);
    });
  }

  handleUpdate(update) {
    // Process webhook update manually if needed
    if (this.bot) {
      this.bot.handleUpdate(update);
    }
  }

  stop() {
    if (this.bot) {
      this.bot.stop();
      this.onLog('info', 'Telegram bot stopped');
    }
  }
}

module.exports = TelegramHandler;
