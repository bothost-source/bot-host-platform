const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '../database.sqlite');

class Database {
  constructor() {
    this.db = new sqlite3.Database(DB_PATH);
    this.init();
  }

  init() {
    // Users table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        api_key TEXT UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        max_bots INTEGER DEFAULT 3
      )
    `);

    // Bots table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        token TEXT,
        status TEXT DEFAULT 'stopped',
        config TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    // Logs table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        level TEXT DEFAULT 'info',
        message TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (bot_id) REFERENCES bots(id)
      )
    `);
  }

  // User methods
  async createUser(email, password) {
    const hash = await bcrypt.hash(password, 10);
    const apiKey = require('crypto').randomBytes(32).toString('hex');
    
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO users (email, password, api_key) VALUES (?, ?, ?)',
        [email, hash, apiKey],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID, email, api_key: apiKey });
        }
      );
    });
  }

  async validateUser(email, password) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
        if (err) return reject(err);
        if (!user) return resolve(null);
        
        const valid = await bcrypt.compare(password, user.password);
        resolve(valid ? { id: user.id, email: user.email, api_key: user.api_key, max_bots: user.max_bots } : null);
      });
    });
  }

  async getUserByApiKey(apiKey) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM users WHERE api_key = ?', [apiKey], (err, user) => {
        if (err) reject(err);
        else resolve(user);
      });
    });
  }

  // Bot methods
  async createBot(botData) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO bots (id, user_id, name, platform, token, config) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [botData.id, botData.userId, botData.name, botData.platform, botData.token, JSON.stringify(botData.config)],
        (err) => {
          if (err) reject(err);
          else resolve(botData);
        }
      );
    });
  }

  async getBotsByUser(userId) {
    return new Promise((resolve, reject) => {
      this.db.all('SELECT * FROM bots WHERE user_id = ? ORDER BY created_at DESC', [userId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map(r => ({ ...r, config: JSON.parse(r.config || '{}') })));
      });
    });
  }

  async getBot(botId) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM bots WHERE id = ?', [botId], (err, row) => {
        if (err) reject(err);
        else resolve(row ? { ...row, config: JSON.parse(row.config || '{}') } : null);
      });
    });
  }

  async updateBotStatus(botId, status) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE bots SET status = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?',
        [status, botId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async deleteBot(botId) {
    return new Promise((resolve, reject) => {
      this.db.run('DELETE FROM bots WHERE id = ?', [botId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // Logging
  async addLog(botId, level, message) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO logs (bot_id, level, message) VALUES (?, ?, ?)',
        [botId, level, message],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async getLogs(botId, limit = 100) {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM logs WHERE bot_id = ? ORDER BY timestamp DESC LIMIT ?',
        [botId, limit],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows.reverse());
        }
      );
    });
  }

  close() {
    this.db.close();
  }
}

module.exports = new Database();
