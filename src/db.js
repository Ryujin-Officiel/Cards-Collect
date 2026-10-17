const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

// Ensure data folder exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'app.db');
const db = new DatabaseSync(dbPath);

// Enable WAL and Foreign Keys
db.exec('PRAGMA foreign_keys = ON;');

// Initialize all 23 database entities as strictly specified in §10.3
function initSchema() {
  db.exec(`
    -- 1. users
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      is_suspended INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 2. user_roles (roles: 'joueur', 'moderateur', 'administrateur')
    CREATE TABLE IF NOT EXISTS user_roles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 3. profiles
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      bio TEXT,
      is_public INTEGER NOT NULL DEFAULT 1,
      trading_enabled INTEGER NOT NULL DEFAULT 1,
      featured_cards TEXT DEFAULT '[]',
      trade_wishlist TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 4. collections
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      cover_image_url TEXT,
      banner_image_url TEXT,
      status TEXT NOT NULL DEFAULT 'brouillon', -- 'brouillon', 'publiee', 'archivee'
      published_at TEXT,
      start_date TEXT,
      end_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 5. cards
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      main_image_url TEXT NOT NULL,
      alt_image_url TEXT,
      rarity TEXT NOT NULL DEFAULT 'commune', -- 'commune', 'peu commune', 'rare', 'epique', 'legendaire'
      card_number INTEGER NOT NULL,
      frame_style TEXT NOT NULL DEFAULT 'simple',
      visual_effects TEXT, -- 'holographique', 'brillante', 'reflet', etc.
      availability TEXT NOT NULL DEFAULT 'permanente', -- 'permanente', 'limitee', 'evenementielle'
      status TEXT NOT NULL DEFAULT 'brouillon', -- 'brouillon', 'publiee', 'archivee'
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE RESTRICT
    );

    -- 6. card_variants
    CREATE TABLE IF NOT EXISTS card_variants (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      variant_name TEXT NOT NULL,
      image_url TEXT NOT NULL,
      visual_effect TEXT,
      FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
    );

    -- 7. user_cards (Exemplaires détenus par les joueurs)
    CREATE TABLE IF NOT EXISTS user_cards (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      source TEXT NOT NULL, -- 'booster', 'echange', 'recompense'
      obtained_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_locked_for_trade INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE RESTRICT
    );

    -- 8. boosters
    CREATE TABLE IF NOT EXISTS boosters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      illustration_url TEXT,
      price_points INTEGER NOT NULL,
      cards_per_pack INTEGER NOT NULL DEFAULT 5,
      collection_id TEXT, -- Si lié à une collection spécifique
      start_date TEXT,
      end_date TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE SET NULL
    );

    -- 9. booster_card_pools
    CREATE TABLE IF NOT EXISTS booster_card_pools (
      id TEXT PRIMARY KEY,
      booster_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      FOREIGN KEY (booster_id) REFERENCES boosters(id) ON DELETE CASCADE,
      FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
    );

    -- 10. booster_rarity_rates
    CREATE TABLE IF NOT EXISTS booster_rarity_rates (
      id TEXT PRIMARY KEY,
      booster_id TEXT NOT NULL,
      rarity TEXT NOT NULL,
      rate_percentage REAL NOT NULL, -- somme doit faire 100
      FOREIGN KEY (booster_id) REFERENCES boosters(id) ON DELETE CASCADE
    );

    -- 11. booster_openings
    CREATE TABLE IF NOT EXISTS booster_openings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      booster_id TEXT NOT NULL,
      points_spent INTEGER NOT NULL,
      cards_obtained TEXT NOT NULL, -- JSON array of card IDs
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (booster_id) REFERENCES boosters(id) ON DELETE RESTRICT
    );

    -- 12. questions
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      explanation TEXT,
      difficulty TEXT NOT NULL, -- 'facile', 'intermediaire', 'difficile', 'expert'
      category TEXT NOT NULL,
      points_reward INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'publiee', -- 'brouillon', 'publiee', 'archivee'
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 13. question_answers
    CREATE TABLE IF NOT EXISTS question_answers (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL,
      answer_text TEXT NOT NULL,
      is_correct INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
    );

    -- 14. quiz_attempts
    CREATE TABLE IF NOT EXISTS quiz_attempts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      selected_answer_id TEXT,
      is_correct INTEGER NOT NULL,
      points_awarded INTEGER NOT NULL,
      attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
    );

    -- 15. point_transactions
    CREATE TABLE IF NOT EXISTS point_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL, -- positif (gain) ou négatif (dépense)
      reason TEXT NOT NULL, -- 'quiz_reward', 'booster_purchase', 'trade_transfer', 'admin_adjustment'
      reference_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 16. conversations
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 17. conversation_members
    CREATE TABLE IF NOT EXISTS conversation_members (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      is_blocked INTEGER NOT NULL DEFAULT 0,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 18. messages
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      content TEXT NOT NULL,
      shared_card_id TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (shared_card_id) REFERENCES cards(id) ON DELETE SET NULL
    );

    -- 19. trades
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      initiator_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'en_attente', -- 'en_attente', 'accepte', 'refuse', 'annule'
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (initiator_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 20. trade_items
    CREATE TABLE IF NOT EXISTS trade_items (
      id TEXT PRIMARY KEY,
      trade_id TEXT NOT NULL,
      party TEXT NOT NULL, -- 'initiator' ou 'receiver'
      user_card_id TEXT, -- si échange de carte
      points_amount INTEGER DEFAULT 0, -- si échange de points
      FOREIGN KEY (trade_id) REFERENCES trades(id) ON DELETE CASCADE,
      FOREIGN KEY (user_card_id) REFERENCES user_cards(id) ON DELETE SET NULL
    );

    -- 21. notifications
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      type TEXT NOT NULL, -- 'trade', 'message', 'quiz', 'system'
      data_payload TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 22. reports
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL,
      reported_user_id TEXT,
      reported_message_id TEXT,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'en_attente', -- 'en_attente', 'traite', 'rejete'
      moderator_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (reported_message_id) REFERENCES messages(id) ON DELETE SET NULL
    );

    -- 23. audit_logs
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Game Economics and Configuration settings table
    CREATE TABLE IF NOT EXISTS game_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

initSchema();

module.exports = { db, uploadsDir, dataDir };
