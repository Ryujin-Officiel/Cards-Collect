const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const { initCloudSchema, isCloudDbEnabled, getCloudPool } = require('./cloud_db');

async function seedCloudDatabase() {
  if (!isCloudDbEnabled()) {
    console.error('ERREUR : Aucune variable DATABASE_URL définie dans le fichier .env !');
    console.log('Exemple de format : DATABASE_URL=postgresql://user:password@ep-xyz.neon.tech/neondb?sslmode=require');
    process.exit(1);
  }

  // 1. Initialiser le schéma des 23 tables
  await initCloudSchema();

  const pool = getCloudPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 2. Paramètres économiques du jeu (§4.2, §5.3)
    const settings = [
      ['reward_facile', '5'],
      ['reward_intermediaire', '10'],
      ['reward_difficile', '20'],
      ['reward_expert', '35'],
      ['recycling_enabled', '0'],
      ['repeat_quiz_multiplier', '0'],
      ['max_trade_points', '1000'],
    ];

    for (const [k, v] of settings) {
      await client.query(
        `INSERT INTO game_settings (key, value)
         VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [k, v]
      );
    }

    // 3. Procédure d'installation sécurisée du premier administrateur (§2.3)
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@collection-cartes.local';
    const adminPassword = process.env.ADMIN_PASSWORD || 'AdminCartes2026!';
    const adminUsername = 'admin_principal';

    const checkAdmin = await client.query('SELECT id FROM users WHERE email = $1', [adminEmail]);
    let adminId;

    if (checkAdmin.rows.length === 0) {
      adminId = uuidv4();
      const hash = bcrypt.hashSync(adminPassword, 10);
      await client.query(
        'INSERT INTO users (id, email, password_hash, username) VALUES ($1, $2, $3, $4)',
        [adminId, adminEmail, hash, adminUsername]
      );
      await client.query(
        'INSERT INTO user_roles (id, user_id, role) VALUES ($1, $2, $3)',
        [uuidv4(), adminId, 'administrateur']
      );
      await client.query(
        'INSERT INTO profiles (id, user_id, display_name, bio) VALUES ($1, $2, $3, $4)',
        [uuidv4(), adminId, 'Administrateur Principal', 'Compte administratif officiel cloud']
      );
      await client.query(
        'INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, details) VALUES ($1, $2, $3, $4, $5, $6)',
        [uuidv4(), adminId, 'INITIAL_INSTALL_CLOUD', 'system', adminId, 'Installation initiale sur cloud PostgreSQL']
      );
      console.log(`[SUCCÈS] Premier compte administrateur créé sur la base Cloud :`);
      console.log(`Email : ${adminEmail}`);
      console.log(`Mot de passe : ${adminPassword}`);
    } else {
      adminId = checkAdmin.rows[0].id;
      console.log(`[INFO] Compte administrateur déjà existant sur le cloud (ID: ${adminId})`);
    }

    // 4. Collections initiales (§3.1)
    const checkCols = await client.query('SELECT COUNT(*) as count FROM collections');
    if (parseInt(checkCols.rows[0].count, 10) === 0) {
      const colCreaturesId = uuidv4();
      const colCyberpunkId = uuidv4();

      await client.query(
        `INSERT INTO collections (id, name, description, cover_image_url, banner_image_url, status, published_at)
         VALUES ($1, $2, $3, $4, $5, 'publiee', NOW())`,
        [
          colCreaturesId,
          'Créatures Fantastiques',
          'Collection dédiée aux créatures légendaires et mystiques des contes et mythes.',
          'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=500',
          'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=1200',
        ]
      );

      await client.query(
        `INSERT INTO collections (id, name, description, cover_image_url, banner_image_url, status, published_at)
         VALUES ($1, $2, $3, $4, $5, 'publiee', NOW())`,
        [
          colCyberpunkId,
          'Univers Cyberpunk & Sci-Fi',
          'Les héros et technologies futuristes des mégapoles de demain.',
          'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=500',
          'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=1200',
        ]
      );

      // 5. Cartes (§3.2, §3.4)
      const cards = [
        [colCreaturesId, 'Dragon Solaire', 'Maître des cieux incandescents.', 'https://images.unsplash.com/photo-1563089145-599997674d42?w=500', 'legendaire', 1, 'holographique'],
        [colCreaturesId, 'Phénix d\'Ambre', 'Renaît perpétuellement de ses cendres.', 'https://images.unsplash.com/photo-1579783902614-a3fb3927b675?w=500', 'epique', 2, 'brillante'],
        [colCreaturesId, 'Griffon des Tempêtes', 'Garde les cimes battues par les vents.', 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=500', 'rare', 3, 'reflet'],
        [colCreaturesId, 'Loup Spectral', 'Rôde silencieusement dans la forêt.', 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=500', 'peu commune', 4, null],
        [colCreaturesId, 'Gobelin Sylvestre', 'Farceur des sous-bois.', 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=500', 'commune', 5, null],

        [colCyberpunkId, 'Nexus IA Suprême', 'Conscience artificielle de la mégalopole.', 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=500', 'legendaire', 1, 'holographique'],
        [colCyberpunkId, 'Cyborg Infiltrateur', 'Spécialiste de la discrétion.', 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=500', 'epique', 2, 'brillante'],
        [colCyberpunkId, 'Drone Sentinelle MK-IV', 'Patrouilleur haute précision.', 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=500', 'rare', 3, 'reflet'],
        [colCyberpunkId, 'Hacker Nomade', 'Déchiffre les flux de données.', 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=500', 'peu commune', 4, null],
        [colCyberpunkId, 'Agent Urbain', 'Maintient la sécurité du secteur.', 'https://images.unsplash.com/photo-1485827404703-89b55fcc595e?w=500', 'commune', 5, null],
      ];

      for (const [colId, name, desc, img, rarity, num, eff] of cards) {
        await client.query(
          `INSERT INTO cards (id, collection_id, name, description, main_image_url, rarity, card_number, frame_style, visual_effects, availability, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'permanente', 'publiee')`,
          [uuidv4(), colId, name, desc, img, rarity, num, rarity, eff]
        );
      }

      // 6. Boosters (§5.2)
      const boosterData = [
        { name: 'Booster Découverte', price: 50, cards: 3, img: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=300', rates: { commune: 70, 'peu commune': 20, rare: 8, epique: 1.8, legendaire: 0.2 } },
        { name: 'Booster Classique', price: 100, cards: 5, img: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=300', rates: { commune: 60, 'peu commune': 25, rare: 10, epique: 4, legendaire: 1 } },
        { name: 'Booster Premium', price: 250, cards: 5, img: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=300', rates: { commune: 40, 'peu commune': 30, rare: 18, epique: 9, legendaire: 3 } },
      ];

      for (const b of boosterData) {
        const bid = uuidv4();
        await client.query(
          `INSERT INTO boosters (id, name, description, illustration_url, price_points, cards_per_pack, is_active)
           VALUES ($1, $2, 'Pack de cartes aléatoires', $3, $4, $5, 1)`,
          [bid, b.name, b.img, b.price, b.cards]
        );
        for (const [r, rate] of Object.entries(b.rates)) {
          await client.query(
            'INSERT INTO booster_rarity_rates (id, booster_id, rarity, rate_percentage) VALUES ($1, $2, $3, $4)',
            [uuidv4(), bid, r, rate]
          );
        }
      }

      // 7. Questions de quiz (§4.1, §4.2)
      const questions = [
        {
          prompt: 'Combien de cartes composent généralement une main de départ standard au tarot ?',
          difficulty: 'facile',
          category: 'Jeux',
          points: 5,
          answers: [
            ['18 cartes', 1],
            ['12 cartes', 0],
            ['7 cartes', 0],
            ['21 cartes', 0],
          ],
        },
        {
          prompt: 'Quelle créature possède un corps de lion et une tête d\'aigle ?',
          difficulty: 'facile',
          category: 'Mythologie',
          points: 5,
          answers: [
            ['Le Griffon', 1],
            ['La Chimère', 0],
            ['Le Sphinx', 0],
            ['La Harpie', 0],
          ],
        },
        {
          prompt: 'Quel métal précieux sert traditionnellement à désigner les cartes les plus recherchées ?',
          difficulty: 'intermediaire',
          category: 'Collection',
          points: 10,
          answers: [
            ['L\'or (Gold Foil)', 1],
            ['Le cuivre', 0],
            ['Le bronze', 0],
            ['Le plomb', 0],
          ],
        },
      ];

      for (const q of questions) {
        const qid = uuidv4();
        await client.query(
          `INSERT INTO questions (id, prompt, difficulty, category, points_reward, status)
           VALUES ($1, $2, $3, $4, $5, 'publiee')`,
          [qid, q.prompt, q.difficulty, q.category, q.points]
        );
        for (const [ans, isCor] of q.answers) {
          await client.query(
            'INSERT INTO question_answers (id, question_id, answer_text, is_correct) VALUES ($1, $2, $3, $4)',
            [uuidv4(), qid, ans, isCor]
          );
        }
      }

      console.log('[SUCCÈS] Données initiales injectées sur le Cloud PostgreSQL !');
    }

    await client.query('COMMIT');
    console.log('[TERMINÉ] Base de données externe tiers initialisée et prête à l\'emploi.');
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erreur seed cloud database:', err);
    process.exit(1);
  } finally {
    client.release();
  }
}

if (require.main === module) {
  seedCloudDatabase();
}

module.exports = { seedCloudDatabase };
