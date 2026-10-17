const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');

function setupInitialData() {
  console.log('--- Initialisation sécurisée du système ---');

  // 1. Initialiser les paramètres économiques du jeu (§4.2, §5.3)
  const defaultSettings = [
    { key: 'reward_facile', value: '5' },
    { key: 'reward_intermediaire', value: '10' },
    { key: 'reward_difficile', value: '20' },
    { key: 'reward_expert', value: '35' },
    { key: 'recycling_enabled', value: '0' }, // Par défaut désactivé (§5.5)
    { key: 'repeat_quiz_multiplier', value: '0' }, // Pas de points indus sur répétition (§4.3)
    { key: 'max_trade_points', value: '1000' }
  ];

  const insertSetting = db.prepare('INSERT OR REPLACE INTO game_settings (key, value) VALUES (?, ?)');
  for (const s of defaultSettings) {
    insertSetting.run(s.key, s.value);
  }

  // 2. Création sécurisée du compte administrateur initial (§2.3)
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@collection-cartes.local';
  const adminPassword = process.env.ADMIN_PASSWORD || 'AdminCartes2026!';
  const adminUsername = 'admin_principal';

  const checkAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  let adminId;

  if (!checkAdmin) {
    adminId = uuidv4();
    const hash = bcrypt.hashSync(adminPassword, 10);
    db.prepare(`
      INSERT INTO users (id, email, password_hash, username)
      VALUES (?, ?, ?, ?)
    `).run(adminId, adminEmail, hash, adminUsername);

    // Rôle Administrateur explicite côté serveur
    db.prepare(`
      INSERT INTO user_roles (id, user_id, role)
      VALUES (?, ?, 'administrateur')
    `).run(uuidv4(), adminId);

    // Profil public
    db.prepare(`
      INSERT INTO profiles (id, user_id, display_name, bio)
      VALUES (?, ?, ?, ?)
    `).run(uuidv4(), adminId, 'Administrateur Principal', 'Compte administratif officiel');

    // Journal d'audit (§7.6, §11.2)
    db.prepare(`
      INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, details)
      VALUES (?, ?, 'INITIAL_INSTALL', 'system', ?, 'Création sécurisée du premier administrateur')
    `).run(uuidv4(), adminId, adminId);

    console.log(`[SUCCÈS] Premier compte administrateur créé :`);
    console.log(`Email : ${adminEmail}`);
    console.log(`Mot de passe : ${adminPassword}`);
  } else {
    adminId = checkAdmin.id;
    console.log(`[INFO] Compte administrateur déjà existant (ID: ${adminId})`);
  }

  // 3. Création des collections initiales (§3.1)
  const collCheck = db.prepare('SELECT COUNT(*) as count FROM collections').get();
  if (collCheck.count === 0) {
    const colCreatures = {
      id: uuidv4(),
      name: 'Créatures Fantastiques',
      description: 'Collection dédiée aux créatures légendaires et mystiques des contes et mythes.',
      cover_image_url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=500',
      banner_image_url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=1200',
      status: 'publiee',
      published_at: new Date().toISOString()
    };

    const colCyberpunk = {
      id: uuidv4(),
      name: 'Univers Cyberpunk & Sci-Fi',
      description: 'Les héros et technologies futuristes des mégapoles de demain.',
      cover_image_url: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=500',
      banner_image_url: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=1200',
      status: 'publiee',
      published_at: new Date().toISOString()
    };

    db.prepare(`
      INSERT INTO collections (id, name, description, cover_image_url, banner_image_url, status, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(colCreatures.id, colCreatures.name, colCreatures.description, colCreatures.cover_image_url, colCreatures.banner_image_url, colCreatures.status, colCreatures.published_at);

    db.prepare(`
      INSERT INTO collections (id, name, description, cover_image_url, banner_image_url, status, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(colCyberpunk.id, colCyberpunk.name, colCyberpunk.description, colCyberpunk.cover_image_url, colCyberpunk.banner_image_url, colCyberpunk.status, colCyberpunk.published_at);

    // 4. Cartes initiales avec raretés (§3.2, §3.4)
    const cardsData = [
      // Créatures
      { col: colCreatures.id, name: 'Dragon Solaire', desc: 'Maître des cieux incandescents crachant des flammes astrales.', rarity: 'legendaire', num: 1, img: 'https://images.unsplash.com/photo-1563089145-599997674d42?w=500', eff: 'holographique' },
      { col: colCreatures.id, name: 'Phénix d\'Ambre', desc: 'Renaît perpétuellement de ses cendres scintillantes.', rarity: 'epique', num: 2, img: 'https://images.unsplash.com/photo-1579783902614-a3fb3927b675?w=500', eff: 'brillante' },
      { col: colCreatures.id, name: 'Griffon des Tempêtes', desc: 'Garde les cimes battues par les ouragans.', rarity: 'rare', num: 3, img: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=500', eff: 'reflet' },
      { col: colCreatures.id, name: 'Loup Spectral', desc: 'Rôde silencieusement à la lisière du monde éthéré.', rarity: 'peu commune', num: 4, img: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=500', eff: null },
      { col: colCreatures.id, name: 'Gobelin Sylvestre', desc: 'Petit farceur des bois friand d\'objets brillants.', rarity: 'commune', num: 5, img: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=500', eff: null },
      { col: colCreatures.id, name: 'Fée des Sources', desc: 'Protège les eaux pures des vallées cachées.', rarity: 'commune', num: 6, img: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=500', eff: null },

      // Sci-Fi
      { col: colCyberpunk.id, name: 'Nexus IA Suprême', desc: 'Conscience artificielle veillant sur la mégalopole.', rarity: 'legendaire', num: 1, img: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=500', eff: 'holographique' },
      { col: colCyberpunk.id, name: 'Cyborg Infiltrateur', desc: 'Spécialiste de la furtivité aux réflexes amplifiés.', rarity: 'epique', num: 2, img: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=500', eff: 'brillante' },
      { col: colCyberpunk.id, name: 'Drone Sentinelle MK-IV', desc: 'Balaye les ruelles sombres de ses faisceaux laser.', rarity: 'rare', num: 3, img: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=500', eff: 'reflet' },
      { col: colCyberpunk.id, name: 'Hacker Nomade', desc: 'Déniche les secrets cryptés du cyberespace.', rarity: 'peu commune', num: 4, img: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=500', eff: null },
      { col: colCyberpunk.id, name: 'Agent de Sécurité Urbain', desc: 'Maintient l\'ordre dans les corridors sous néons.', rarity: 'commune', num: 5, img: 'https://images.unsplash.com/photo-1485827404703-89b55fcc595e?w=500', eff: null },
      { col: colCyberpunk.id, name: 'Puce de Données Perdue', desc: 'Contient des fragments d\'archives oubliées.', rarity: 'commune', num: 6, img: 'https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=500', eff: null }
    ];

    const insertCard = db.prepare(`
      INSERT INTO cards (id, collection_id, name, description, main_image_url, rarity, card_number, frame_style, visual_effects, availability, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'permanente', 'publiee')
    `);

    for (const c of cardsData) {
      insertCard.run(uuidv4(), c.col, c.name, c.desc, c.img, c.rarity, c.num, c.rarity, c.eff);
    }

    // 5. Création des boosters par défaut (§5.2)
    const boostersData = [
      {
        id: uuidv4(),
        name: 'Booster Découverte',
        desc: 'Idéal pour débuter votre collection avec 3 cartes.',
        price: 50,
        cards_per_pack: 3,
        col_id: null,
        rates: { commune: 70, 'peu commune': 20, rare: 8, epique: 1.8, legendaire: 0.2 },
        img: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=300'
      },
      {
        id: uuidv4(),
        name: 'Booster Classique',
        desc: 'Le booster standard contenant 5 cartes variées.',
        price: 100,
        cards_per_pack: 5,
        col_id: null,
        rates: { commune: 60, 'peu commune': 25, rare: 10, epique: 4, legendaire: 1 },
        img: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=300'
      },
      {
        id: uuidv4(),
        name: 'Booster Thématique : Créatures',
        desc: '5 cartes exclusives issues de la collection Créatures Fantastiques.',
        price: 150,
        cards_per_pack: 5,
        col_id: colCreatures.id,
        rates: { commune: 55, 'peu commune': 28, rare: 11, epique: 5, legendaire: 1 },
        img: 'https://images.unsplash.com/photo-1563089145-599997674d42?w=300'
      },
      {
        id: uuidv4(),
        name: 'Booster Premium',
        desc: 'Taux considérablement augmenté pour les raretés Épiques et Légendaires.',
        price: 250,
        cards_per_pack: 5,
        col_id: null,
        rates: { commune: 40, 'peu commune': 30, rare: 18, epique: 9, legendaire: 3 },
        img: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=300'
      }
    ];

    const insertBooster = db.prepare(`
      INSERT INTO boosters (id, name, description, illustration_url, price_points, cards_per_pack, collection_id, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);

    const insertRate = db.prepare(`
      INSERT INTO booster_rarity_rates (id, booster_id, rarity, rate_percentage)
      VALUES (?, ?, ?, ?)
    `);

    for (const b of boostersData) {
      insertBooster.run(b.id, b.name, b.desc, b.img, b.price, b.cards_per_pack, b.col_id);
      for (const [rarity, rate] of Object.entries(b.rates)) {
        insertRate.run(uuidv4(), b.id, rarity, rate);
      }
    }

    // 6. Questions de quiz par défaut (§4.1, §4.2)
    const questionsData = [
      {
        prompt: 'Combien de cartes composent généralement une main de départ standard au tarot ?',
        explanation: 'Au tarot classique à 4 joueurs, chaque joueur reçoit 18 cartes.',
        difficulty: 'facile',
        category: 'Jeux & Cartes',
        points: 5,
        answers: [
          { text: '18 cartes', correct: 1 },
          { text: '12 cartes', correct: 0 },
          { text: '7 cartes', correct: 0 },
          { text: '21 cartes', correct: 0 }
        ]
      },
      {
        prompt: 'Quelle créature mythologique possède un corps de lion et une tête d\'aigle ?',
        explanation: 'Le griffon est une créature légendaire ailée alliant la force du lion et la vue perçante de l\'aigle.',
        difficulty: 'facile',
        category: 'Mythologie',
        points: 5,
        answers: [
          { text: 'Le Griffon', correct: 1 },
          { text: 'La Chimère', correct: 0 },
          { text: 'Le Sphinx', correct: 0 },
          { text: 'La Harpie', correct: 0 }
        ]
      },
      {
        prompt: 'En quelle année la toute première extension du jeu Magic: The Gathering est-elle sortie ?',
        explanation: 'Arabian Nights est parue en décembre 1993.',
        difficulty: 'intermediaire',
        category: 'Histoire du Jeu',
        points: 10,
        answers: [
          { text: '1993', correct: 1 },
          { text: '1995', correct: 0 },
          { text: '1990', correct: 0 },
          { text: '1998', correct: 0 }
        ]
      },
      {
        prompt: 'Quel métal précieux sert traditionnellement à désigner le cadre ou le reflet des cartes les plus recherchées ?',
        explanation: 'Le traitement holographique et doré (Gold Foil) est l\'emblème des cartes d\'exception.',
        difficulty: 'intermediaire',
        category: 'Collection',
        points: 10,
        answers: [
          { text: 'L\'or (Gold Foil)', correct: 1 },
          { text: 'Le cuivre', correct: 0 },
          { text: 'Le bronze', correct: 0 },
          { text: 'Le plomb', correct: 0 }
        ]
      },
      {
        prompt: 'Dans la mythologie nordique, quel arbre gigantesque relie les neuf mondes cosmologiques ?',
        explanation: 'Yggdrasil est le frêne cosmique qui soutient les différents royaumes.',
        difficulty: 'difficile',
        category: 'Mythologie',
        points: 20,
        answers: [
          { text: 'Yggdrasil', correct: 1 },
          { text: 'Mimir', correct: 0 },
          { text: 'Valhalla', correct: 0 },
          { text: 'Bifrost', correct: 0 }
        ]
      },
      {
        prompt: 'Quel algorithme de hachage cryptographique produit une empreinte de 256 bits couramment utilisée pour garantir l\'intégrité ?',
        explanation: 'SHA-256 (Secure Hash Algorithm 256 bits) est le standard mondial éprouvé.',
        difficulty: 'expert',
        category: 'Informatique',
        points: 35,
        answers: [
          { text: 'SHA-256', correct: 1 },
          { text: 'MD5', correct: 0 },
          { text: 'ROT13', correct: 0 },
          { text: 'DES-56', correct: 0 }
        ]
      }
    ];

    const insertQ = db.prepare(`
      INSERT INTO questions (id, prompt, explanation, difficulty, category, points_reward, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertA = db.prepare(`
      INSERT INTO question_answers (id, question_id, answer_text, is_correct)
      VALUES (?, ?, ?, ?)
    `);

    for (const q of questionsData) {
      const qid = uuidv4();
      insertQ.run(qid, q.prompt, q.explanation, q.difficulty, q.category, q.points, 'publiee');
      for (const a of q.answers) {
        insertA.run(uuidv4(), qid, a.text, a.correct);
      }
    }

    console.log('[SUCCÈS] Données initiales (collections, cartes, boosters, questions) injectées.');
  }
}

if (require.main === module) {
  setupInitialData();
}

module.exports = { setupInitialData };
