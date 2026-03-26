const TelegramHandler = require('./telegram-handler');
const WhatsAppHandler = require('./whatsapp-handler');

function createHandler(platform, config) {
  switch (platform) {
    case 'telegram':
      return new TelegramHandler(config);
    case 'whatsapp':
      return new WhatsAppHandler(config);
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

module.exports = { createHandler };
