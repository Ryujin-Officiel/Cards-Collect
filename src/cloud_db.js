const { Pool } = require('pg');
require('dotenv').config();

let pool = null;

function isCloudDbEnabled() {
  return !!process.env.DATABASE_URL;
}

function getCloudPool() {
  if (!pool && isCloudDbEnabled()) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost')
        ? false
        : { rejectUnauthorized: false }, // Requis pour Neon, Supabase, Render
    });
  }
  return pool;
}

// Initialisation des 23 entités du Cahier des Charges sur PostgreSQL Cloud (§10.3)
async function initCloudSchema() {
  const p = getCloudPool();
  if (!p) return;

  console.log('Connexion à la base de données PostgreSQL Cloud externe...');
  const client = await p.connect();

  try {
    await client.query('BEGIN');

    await client.query(`
      -- 1. users
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(64) PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        username VARCHAR(100) UNIQUE NOT NULL,
        is_suspended INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- 2. user_roles
      CREATE TABLE IF NOT EXISTS user_roles (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(50) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- 3. profiles
      CREATE TABLE IF NOT EXISTS profiles (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        display_name VARCHAR(150),
        avatar_url TEXT,
        bio TEXT,
        is_public INTEGER NOT NULL DEFAULT 1,
        trading_enabled INTEGER NOT NULL DEFAULT 1,
        featured_cards TEXT DEFAULT '[]',
        trade_wishlist TEXT DEFAULT '[]',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- 4. collections
      CREATE TABLE IF NOT EXISTS collections (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        cover_image_url TEXT,
        banner_image_url TEXT,
        status VARCHAR(50) NOT NULL DEFAULT 'brouillon',
        published_at TIMESTAMP WITH TIME ZONE,
        start_date TIMESTAMP WITH TIME ZONE,
        end_date TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- 5. cards
      CREATE TABLE IF NOT EXISTS cards (
        id VARCHAR(64) PRIMARY KEY,
        collection_id VARCHAR(64) NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        main_image_url TEXT NOT NULL,
        alt_image_url TEXT,
        rarity VARCHAR(50) NOT NULL DEFAULT 'commune',
        card_number INTEGER NOT NULL,
        frame_style VARCHAR(50) NOT NULL DEFAULT 'simple',
        visual_effects VARCHAR(100),
        availability VARCHAR(50) NOT NULL DEFAULT 'permanente',
        status VARCHAR(50) NOT NULL DEFAULT 'brouillon',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- 6. card_variants
      CREATE TABLE IF NOT EXISTS card_variants (
        id VARCHAR(64) PRIMARY KEY,
        card_id VARCHAR(64) NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        variant_name VARCHAR(100) NOT NULL,
        image_url TEXT NOT NULL,
        visual_effect VARCHAR(100)
      );

      -- 7. user_cards
      CREATE TABLE IF NOT EXISTS user_cards (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        card_id VARCHAR(64) NOT NULL REFERENCES cards(id) ON DELETE RESTRICT,
        source VARCHAR(50) NOT NULL,
        obtained_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        is_locked_for_trade INTEGER NOT NULL DEFAULT 0
      );

      -- 8. boosters
      CREATE TABLE IF NOT EXISTS boosters (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        illustration_url TEXT,
        price_points INTEGER NOT NULL,
        cards_per_pack INTEGER NOT NULL DEFAULT 5,
        collection_id VARCHAR(64) REFERENCES collections(id) ON DELETE SET NULL,
        start_date TIMESTAMP WITH TIME ZONE,
        end_date TIMESTAMP WITH TIME ZONE,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- 9. booster_card_pools
      CREATE TABLE IF NOT EXISTS booster_card_pools (
        id VARCHAR(64) PRIMARY KEY,
        booster_id VARCHAR(64) NOT NULL REFERENCES boosters(id) ON DELETE CASCADE,
        card_id VARCHAR(64) NOT NULL REFERENCES cards(id) ON DELETE CASCADE
      );

      -- 10. booster_rarity_rates
      CREATE TABLE IF NOT EXISTS booster_rarity_rates (
        id VARCHAR(64) PRIMARY KEY,
        booster_id VARCHAR(64) NOT NULL REFERENCES boosters(id) ON DELETE CASCADE,
        rarity VARCHAR(50) NOT NULL,
        rate_percentage REAL NOT NULL
      );

      -- 11. booster_openings
      CREATE TABLE IF NOT EXISTS booster_openings (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        booster_id VARCHAR(64) NOT NULL REFERENCES boosters(id) ON DELETE RESTRICT,
        points_spent INTEGER NOT NULL,
        cards_obtained TEXT NOT NULL,
        opened_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- 12. questions
      CREATE TABLE IF NOT EXISTS questions (
        id VARCHAR(64) PRIMARY KEY,
        prompt TEXT NOT NULL,
        explanation TEXT,
        difficulty VARCHAR(50) NOT NULL,
        category VARCHAR(100) NOT NULL,
        points_reward INTEGER NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'publiee',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- 13. question_answers
      CREATE TABLE IF NOT EXISTS question_answers (
        id VARCHAR(64) PRIMARY KEY,
        question_id VARCHAR(64) NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        answer_text TEXT NOT NULL,
        is_correct INTEGER NOT NULL DEFAULT 0
      );

      -- 14. quiz_attempts
      CREATE TABLE IF NOT EXISTS quiz_attempts (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        question_id VARCHAR(64) NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        selected_answer_id VARCHAR(64),
        is_correct INTEGER NOT NULL,
        points_awarded INTEGER NOT NULL,
        attempted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- 15. point_transactions
      CREATE TABLE IF NOT EXISTS point_transactions (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount INTEGER NOT NULL,
        reason VARCHAR(100) NOT NULL,
        reference_id VARCHAR(64),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- 16. conversations
      CREATE TABLE IF NOT EXISTS conversations (
        id VARCHAR(64) PRIMARY KEY,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- 17. conversation_members
      CREATE TABLE IF NOT EXISTS conversation_members (
        id VARCHAR(64) PRIMARY KEY,
        conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        is_blocked INTEGER NOT NULL DEFAULT 0,
        joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- 18. messages
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(64) PRIMARY KEY,
        conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        shared_card_id VARCHAR(64) REFERENCES cards(id) ON DELETE SET NULL,
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- 19. trades
      CREATE TABLE IF NOT EXISTS trades (
        id VARCHAR(64) PRIMARY KEY,
        initiator_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        receiver_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(50) NOT NULL DEFAULT 'en_attente',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- 20. trade_items
      CREATE TABLE IF NOT EXISTS trade_items (
        id VARCHAR(64) PRIMARY KEY,
        trade_id VARCHAR(64) NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
        party VARCHAR(50) NOT NULL,
        user_card_id VARCHAR(64) REFERENCES user_cards(id) ON DELETE SET NULL,
        points_amount INTEGER DEFAULT 0
      );

      -- 21. notifications
      CREATE TABLE IF NOT EXISTS notifications (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        type VARCHAR(50) NOT NULL,
        data_payload TEXT,
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- 22. reports
      CREATE TABLE IF NOT EXISTS reports (
        id VARCHAR(64) PRIMARY KEY,
        reporter_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reported_user_id VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
        reported_message_id VARCHAR(64) REFERENCES messages(id) ON DELETE SET NULL,
        reason TEXT NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'en_attente',
        moderator_notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- 23. audit_logs
      CREATE TABLE IF NOT EXISTS audit_logs (
        id VARCHAR(64) PRIMARY KEY,
        actor_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action VARCHAR(100) NOT NULL,
        target_type VARCHAR(50) NOT NULL,
        target_id VARCHAR(64),
        details TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- game_settings
      CREATE TABLE IF NOT EXISTS game_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    await client.query('COMMIT');
    console.log('[SUCCÈS] Les 23 tables PostgreSQL Cloud ont été créées avec succès !');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erreur initialisation cloud PostgreSQL:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  isCloudDbEnabled,
  getCloudPool,
  initCloudSchema,
};
