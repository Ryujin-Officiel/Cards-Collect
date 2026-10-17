const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { randomUUID: uuidv4 } = require('node:crypto');
const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs');
require('dotenv').config();

const { db } = require('./db_adapter');
const uploadsDir = process.env.VERCEL ? path.join('/tmp', 'uploads') : path.join(__dirname, '..', 'uploads');
try {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
} catch (err) {
  console.warn('Uploads directory creation warning:', err.message);
}

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'SecretSuperSecurisePourCollectDeCarte2026_JWT!';

// Middlewares
app.use(cors());
app.use(express.json());
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

// Multer Storage (§3.3, §7.3)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `img_${Date.now()}_${uuidv4().substring(0, 8)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Format d\'image non autorisé. Formats acceptés : PNG, JPG, JPEG, WEBP, GIF'));
    }
  },
});

// Helper: Calculate points balance (§4.4)
async function getUserPointsBalance(userId, customDb = db) {
  const row = await customDb.get(
    `SELECT COALESCE(SUM(amount), 0) as balance,
            COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) as total_earned,
            COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) as total_spent
     FROM point_transactions
     WHERE user_id = ?`,
    [userId]
  );
  return {
    balance: Number(row?.balance || 0),
    total_earned: Number(row?.total_earned || 0),
    total_spent: Number(row?.total_spent || 0),
  };
}

// Helper: Log audit action (§7.6, §11.2)
async function logAudit(actorId, action, targetType, targetId, details) {
  try {
    await db.run(
      `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), actorId, action, targetType, targetId, details]
    );
  } catch (err) {
    console.error('Erreur logAudit:', err);
  }
}

// Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Accès non autorisé : jeton requis' });

  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) return res.status(403).json({ error: 'Jeton invalide ou expiré' });

    const userDb = await db.get('SELECT id, is_suspended FROM users WHERE id = ?', [user.id]);
    if (!userDb) return res.status(401).json({ error: 'Utilisateur introuvable' });
    if (userDb.is_suspended === 1) {
      return res.status(403).json({ error: 'Votre compte est actuellement suspendu par la modération.' });
    }

    req.user = user;
    next();
  });
}

// Role Check Middleware (§7.7)
function requireRole(allowedRoles) {
  return async (req, res, next) => {
    const roleRows = await db.query('SELECT role FROM user_roles WHERE user_id = ?', [req.user.id]);
    const roles = roleRows.map((r) => r.role);
    const hasRole = allowedRoles.some((r) => roles.includes(r));
    if (!hasRole) {
      return res.status(403).json({ error: 'Permissions insuffisantes pour cette action.' });
    }
    req.userRoles = roles;
    next();
  };
}

// ==========================================
// 1. AUTHENTIFICATION & UTILISATEURS (§2.1, §11.1)
// ==========================================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, username, display_name } = req.body;
    if (!email || !password || !username) {
      return res.status(400).json({ error: 'Email, mot de passe et nom d\'utilisateur obligatoires' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit comporter au moins 6 caractères' });
    }

    const existing = await db.get('SELECT id FROM users WHERE email = ? OR username = ?', [email, username]);
    if (existing) {
      return res.status(409).json({ error: 'Cette adresse e-mail ou ce nom d\'utilisateur est déjà utilisé' });
    }

    const userId = uuidv4();
    const hash = bcrypt.hashSync(password, 10);

    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO users (id, email, password_hash, username) VALUES (?, ?, ?, ?)', [
        userId,
        email,
        hash,
        username,
      ]);
      await tx.run("INSERT INTO user_roles (id, user_id, role) VALUES (?, ?, 'joueur')", [uuidv4(), userId]);
      await tx.run(
        `INSERT INTO profiles (id, user_id, display_name, bio, avatar_url)
         VALUES (?, ?, ?, 'Nouveau collectionneur de cartes', ?)`,
        [uuidv4(), userId, display_name || username, `https://api.dicebear.com/7.x/bottts/svg?seed=${username}`]
      );
      // Don de bienvenue : 50 points (§8 Étape 1-4)
      await tx.run(
        "INSERT INTO point_transactions (id, user_id, amount, reason) VALUES (?, ?, 50, 'bonus_bienvenue')",
        [uuidv4(), userId]
      );
    });

    const token = jwt.sign({ id: userId, username, email }, JWT_SECRET, { expiresIn: '7d' });
    return res.status(201).json({
      message: 'Compte joueur créé avec succès !',
      token,
      user: { id: userId, email, username, display_name: display_name || username, roles: ['joueur'] },
    });
  } catch (err) {
    console.error('Erreur inscription:', err);
    return res.status(500).json({ error: 'Erreur lors de l\'inscription.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis' });

    const user = await db.get(
      `SELECT u.id, u.email, u.password_hash, u.username, u.is_suspended, p.display_name, p.avatar_url
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.email = ? OR u.username = ?`,
      [email, email]
    );

    if (!user) return res.status(401).json({ error: 'Identifiants incorrects' });
    if (user.is_suspended === 1) return res.status(403).json({ error: 'Ce compte a été suspendu par la modération.' });

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Identifiants incorrects' });

    const roleRows = await db.query('SELECT role FROM user_roles WHERE user_id = ?', [user.id]);
    const roles = roleRows.map((r) => r.role);
    const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        display_name: user.display_name || user.username,
        avatar_url: user.avatar_url,
        roles,
      },
    });
  } catch (err) {
    console.error('Erreur connexion:', err);
    return res.status(500).json({ error: 'Erreur lors de la connexion.' });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await db.get(
      `SELECT u.id, u.email, u.username, u.created_at,
              p.display_name, p.avatar_url, p.bio, p.is_public, p.trading_enabled,
              p.featured_cards, p.trade_wishlist
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.id = ?`,
      [req.user.id]
    );

    const roleRows = await db.query('SELECT role FROM user_roles WHERE user_id = ?', [req.user.id]);
    const roles = roleRows.map((r) => r.role);
    const wallet = await getUserPointsBalance(req.user.id);

    return res.json({
      ...user,
      roles,
      wallet,
      featured_cards: JSON.parse(user?.featured_cards || '[]'),
      trade_wishlist: JSON.parse(user?.trade_wishlist || '[]'),
    });
  } catch (err) {
    console.error('Erreur /me:', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

app.put('/api/auth/profile', authenticateToken, async (req, res) => {
  try {
    const { display_name, bio, avatar_url, is_public, trading_enabled, featured_cards, trade_wishlist } = req.body;

    await db.run(
      `UPDATE profiles
       SET display_name = COALESCE(?, display_name),
           bio = COALESCE(?, bio),
           avatar_url = COALESCE(?, avatar_url),
           is_public = COALESCE(?, is_public),
           trading_enabled = COALESCE(?, trading_enabled),
           featured_cards = COALESCE(?, featured_cards),
           trade_wishlist = COALESCE(?, trade_wishlist),
           updated_at = NOW()
       WHERE user_id = ?`,
      [
        display_name !== undefined ? display_name : null,
        bio !== undefined ? bio : null,
        avatar_url !== undefined ? avatar_url : null,
        is_public !== undefined ? (is_public ? 1 : 0) : null,
        trading_enabled !== undefined ? (trading_enabled ? 1 : 0) : null,
        featured_cards ? JSON.stringify(featured_cards) : null,
        trade_wishlist ? JSON.stringify(trade_wishlist) : null,
        req.user.id,
      ]
    );

    return res.json({ message: 'Profil mis à jour avec succès.' });
  } catch (err) {
    console.error('Erreur profil update:', err);
    return res.status(500).json({ error: 'Erreur lors de la mise à jour.' });
  }
});

// ==========================================
// 2. PORTEFEUILLE & POINTS (§4.4)
// ==========================================

app.get('/api/wallet/balance', authenticateToken, async (req, res) => {
  const wallet = await getUserPointsBalance(req.user.id);
  res.json(wallet);
});

app.get('/api/wallet/transactions', authenticateToken, async (req, res) => {
  const txs = await db.query(
    `SELECT id, amount, reason, reference_id, created_at
     FROM point_transactions
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 100`,
    [req.user.id]
  );
  res.json(txs);
});

// ==========================================
// 3. QUIZ & QUESTIONS (§4.1 - §4.3)
// ==========================================

app.get('/api/quiz/questions', authenticateToken, async (req, res) => {
  try {
    const questions = await db.query(
      `SELECT id, prompt, difficulty, category, points_reward
       FROM questions
       WHERE status = 'publiee'
       ORDER BY RANDOM()
       LIMIT 10`
    );

    const result = [];
    for (const q of questions) {
      const answers = await db.query(
        'SELECT id, answer_text FROM question_answers WHERE question_id = ? ORDER BY id ASC',
        [q.id]
      );
      const attempt = await db.get(
        'SELECT is_correct FROM quiz_attempts WHERE user_id = ? AND question_id = ? AND is_correct = 1',
        [req.user.id, q.id]
      );
      result.push({
        ...q,
        answers,
        already_completed: !!attempt,
      });
    }

    res.json(result);
  } catch (err) {
    console.error('Erreur quiz questions:', err);
    res.status(500).json({ error: 'Erreur récupération quiz.' });
  }
});

app.post('/api/quiz/submit', authenticateToken, async (req, res) => {
  try {
    const { question_id, answer_id } = req.body;
    if (!question_id || !answer_id) return res.status(400).json({ error: 'question_id et answer_id requis' });

    const question = await db.get(
      "SELECT id, prompt, points_reward, explanation FROM questions WHERE id = ? AND status = 'publiee'",
      [question_id]
    );
    if (!question) return res.status(404).json({ error: 'Question introuvable' });

    const answer = await db.get(
      'SELECT id, is_correct FROM question_answers WHERE id = ? AND question_id = ?',
      [answer_id, question_id]
    );
    if (!answer) return res.status(400).json({ error: 'Réponse invalide pour cette question' });

    const isCorrect = answer.is_correct === 1;
    const priorAttempt = await db.get(
      'SELECT id FROM quiz_attempts WHERE user_id = ? AND question_id = ? AND is_correct = 1',
      [req.user.id, question_id]
    );

    let pointsAwarded = 0;
    let message = 'Mauvaise réponse. Aucun point attribué.';

    if (isCorrect) {
      if (priorAttempt) {
        pointsAwarded = 0;
        message = 'Bonne réponse ! Déjà complétée précédemment (aucun point supplémentaire).';
      } else {
        pointsAwarded = question.points_reward;
        message = `Bravo ! Bonne réponse ! Vous gagnez ${pointsAwarded} points !`;
      }
    }

    await db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO quiz_attempts (id, user_id, question_id, selected_answer_id, is_correct, points_awarded)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), req.user.id, question_id, answer_id, isCorrect ? 1 : 0, pointsAwarded]
      );
      if (pointsAwarded > 0) {
        await tx.run(
          "INSERT INTO point_transactions (id, user_id, amount, reason, reference_id) VALUES (?, ?, ?, 'quiz_reward', ?)",
          [uuidv4(), req.user.id, pointsAwarded, question_id]
        );
      }
    });

    const newBalance = await getUserPointsBalance(req.user.id);
    return res.json({
      is_correct: isCorrect,
      points_awarded: pointsAwarded,
      explanation: question.explanation,
      message,
      wallet: newBalance,
    });
  } catch (err) {
    console.error('Erreur submit quiz:', err);
    res.status(500).json({ error: 'Erreur lors de la validation du quiz.' });
  }
});

// ==========================================
// 4. BOUTIQUE & BOOSTERS (§5.1 - §5.5)
// ==========================================

app.get('/api/shop/boosters', async (req, res) => {
  try {
    const boosters = await db.query(
      `SELECT b.id, b.name, b.description, b.illustration_url, b.price_points,
              b.cards_per_pack, b.collection_id, c.name as collection_name,
              b.opening_animation, b.daily_purchase_limit, b.original_price_points, b.available_until
       FROM boosters b
       LEFT JOIN collections c ON c.id = b.collection_id
       WHERE b.is_active = 1`
    );

    const result = [];
    for (const b of boosters) {
      const rates = await db.query(
        'SELECT rarity, rate_percentage FROM booster_rarity_rates WHERE booster_id = ?',
        [b.id]
      );
      result.push({ ...b, rarity_rates: rates });
    }

    res.json(result);
  } catch (err) {
    console.error('Erreur shop boosters:', err);
    res.status(500).json({ error: 'Erreur récupération boutique.' });
  }
});

app.post('/api/shop/buy-booster', authenticateToken, async (req, res) => {
  try {
    const { booster_id } = req.body;
    if (!booster_id) return res.status(400).json({ error: 'booster_id requis' });

    const booster = await db.get('SELECT * FROM boosters WHERE id = ? AND is_active = 1', [booster_id]);
    if (!booster) return res.status(404).json({ error: 'Booster non disponible' });

    const wallet = await getUserPointsBalance(req.user.id);
    if (wallet.balance < booster.price_points) {
      return res.status(400).json({
        error: `Solde insuffisant : vous avez ${wallet.balance} points, ce booster coûte ${booster.price_points} points.`,
      });
    }

    let eligibleCards;
    if (booster.collection_id) {
      eligibleCards = await db.query(
        "SELECT id, name, rarity, main_image_url, frame_style, visual_effects FROM cards WHERE status = 'publiee' AND collection_id = ?",
        [booster.collection_id]
      );
    } else {
      eligibleCards = await db.query(
        "SELECT id, name, rarity, main_image_url, frame_style, visual_effects FROM cards WHERE status = 'publiee'"
      );
    }

    if (eligibleCards.length === 0) {
      return res.status(400).json({ error: 'Aucune carte publiée disponible pour ce booster.' });
    }

    const cardsByRarity = {};
    for (const c of eligibleCards) {
      if (!cardsByRarity[c.rarity]) cardsByRarity[c.rarity] = [];
      cardsByRarity[c.rarity].push(c);
    }

    const rates = await db.query('SELECT rarity, rate_percentage FROM booster_rarity_rates WHERE booster_id = ?', [
      booster.id,
    ]);

    const drawnCards = [];
    const countToDraw = booster.cards_per_pack || 5;

    for (let i = 0; i < countToDraw; i++) {
      const roll = Math.random() * 100;
      let cumulative = 0;
      let selectedRarity = 'commune';

      for (const r of rates) {
        cumulative += Number(r.rate_percentage);
        if (roll <= cumulative) {
          selectedRarity = r.rarity;
          break;
        }
      }

      let pool = cardsByRarity[selectedRarity];
      if (!pool || pool.length === 0) pool = eligibleCards;
      const picked = pool[Math.floor(Math.random() * pool.length)];
      drawnCards.push(picked);
    }

    const openingId = uuidv4();
    const drawnCardIds = drawnCards.map((c) => c.id);

    await db.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO point_transactions (id, user_id, amount, reason, reference_id) VALUES (?, ?, ?, 'booster_purchase', ?)",
        [uuidv4(), req.user.id, -booster.price_points, booster.id]
      );

      for (const card of drawnCards) {
        await tx.run(
          "INSERT INTO user_cards (id, user_id, card_id, source) VALUES (?, ?, ?, 'booster')",
          [uuidv4(), req.user.id, card.id]
        );
      }

      await tx.run(
        'INSERT INTO booster_openings (id, user_id, booster_id, points_spent, cards_obtained) VALUES (?, ?, ?, ?, ?)',
        [openingId, req.user.id, booster.id, booster.price_points, JSON.stringify(drawnCardIds)]
      );
    });

    const newWallet = await getUserPointsBalance(req.user.id);

    return res.status(200).json({
      message: `Booster ouvert ! Vous avez reçu ${drawnCards.length} cartes.`,
      opening_id: openingId,
      cards: drawnCards,
      wallet: newWallet,
    });
  } catch (err) {
    console.error('Erreur achat booster:', err);
    res.status(500).json({ error: 'Erreur lors de l\'achat du booster.' });
  }
});

// ==========================================
// 5. COLLECTIONS & CARTES (§3.1 - §3.5)
// ==========================================

app.get('/api/collections', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    let currentUserId = null;
    if (authHeader) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        currentUserId = decoded.id;
      } catch (e) {}
    }

    const collections = await db.query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM cards WHERE collection_id = c.id AND status = 'publiee') as total_cards
       FROM collections c
       WHERE c.status = 'publiee'
       ORDER BY c.name ASC`
    );

    const result = [];
    for (const col of collections) {
      let ownedDistinctCount = 0;
      if (currentUserId) {
        const owned = await db.get(
          `SELECT COUNT(DISTINCT card_id) as count
           FROM user_cards uc
           JOIN cards cd ON cd.id = uc.card_id
           WHERE uc.user_id = ? AND cd.collection_id = ? AND cd.status = 'publiee'`,
          [currentUserId, col.id]
        );
        ownedDistinctCount = Number(owned?.count || 0);
      }
      const total = Number(col.total_cards || 0);
      const completionPercentage = total > 0 ? Math.round((ownedDistinctCount / total) * 100) : 0;
      result.push({
        ...col,
        owned_distinct_count: ownedDistinctCount,
        completion_percentage: completionPercentage,
      });
    }

    res.json(result);
  } catch (err) {
    console.error('Erreur get collections:', err);
    res.status(500).json({ error: 'Erreur récupération collections.' });
  }
});

app.get('/api/collections/:id', async (req, res) => {
  try {
    const collectionId = req.params.id;
    const authHeader = req.headers['authorization'];
    let currentUserId = null;
    if (authHeader) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        currentUserId = decoded.id;
      } catch (e) {}
    }

    const collection = await db.get('SELECT * FROM collections WHERE id = ?', [collectionId]);
    if (!collection) return res.status(404).json({ error: 'Collection introuvable' });

    const cards = await db.query(
      `SELECT id, name, description, main_image_url, alt_image_url, rarity,
              card_number, frame_style, visual_effects, availability
       FROM cards
       WHERE collection_id = ? AND status = 'publiee'
       ORDER BY card_number ASC, name ASC`,
      [collectionId]
    );

    const ownedMap = {};
    if (currentUserId) {
      const userCopies = await db.query(
        'SELECT card_id, COUNT(*) as copies_count FROM user_cards WHERE user_id = ? GROUP BY card_id',
        [currentUserId]
      );
      for (const row of userCopies) {
        ownedMap[row.card_id] = Number(row.copies_count);
      }
    }

    let distinctOwned = 0;
    const cardsWithStatus = cards.map((c) => {
      const copies = ownedMap[c.id] || 0;
      if (copies > 0) distinctOwned++;
      return {
        ...c,
        is_owned: copies > 0,
        copies_count: copies,
      };
    });

    const completion = cards.length > 0 ? Math.round((distinctOwned / cards.length) * 100) : 0;
    res.json({
      collection,
      cards: cardsWithStatus,
      total_cards: cards.length,
      owned_cards_count: distinctOwned,
      completion_percentage: completion,
    });
  } catch (err) {
    console.error('Erreur get collection details:', err);
    res.status(500).json({ error: 'Erreur détail collection.' });
  }
});

app.get('/api/cards/:id', async (req, res) => {
  try {
    const card = await db.get(
      `SELECT cd.*, c.name as collection_name
       FROM cards cd
       JOIN collections c ON c.id = cd.collection_id
       WHERE cd.id = ?`,
      [req.params.id]
    );
    if (!card) return res.status(404).json({ error: 'Carte introuvable' });

    const variants = await db.query('SELECT * FROM card_variants WHERE card_id = ?', [card.id]);
    res.json({ ...card, variants });
  } catch (err) {
    console.error('Erreur carte detail:', err);
    res.status(500).json({ error: 'Erreur détail carte.' });
  }
});

// ==========================================
// 6. INVENTAIRE DU JOUEUR (§3.5)
// ==========================================

app.get('/api/inventory', authenticateToken, async (req, res) => {
  try {
    const { collection_id, rarity, search, duplicates_only } = req.query;

    let sql = `
      SELECT uc.id as user_card_id, uc.source, uc.obtained_at, uc.is_locked_for_trade,
             cd.id as card_id, cd.name, cd.description, cd.main_image_url, cd.alt_image_url,
             cd.rarity, cd.card_number, cd.frame_style, cd.visual_effects,
             c.id as collection_id, c.name as collection_name
      FROM user_cards uc
      JOIN cards cd ON cd.id = uc.card_id
      JOIN collections c ON c.id = cd.collection_id
      WHERE uc.user_id = ?
    `;
    const params = [req.user.id];

    if (collection_id) {
      sql += ' AND c.id = ?';
      params.push(collection_id);
    }
    if (rarity) {
      sql += ' AND cd.rarity = ?';
      params.push(rarity);
    }
    if (search) {
      sql += ' AND cd.name ILIKE ?';
      params.push(`%${search}%`);
    }

    sql += ' ORDER BY cd.rarity DESC, cd.name ASC';

    const items = await db.query(sql, params);

    const grouped = {};
    for (const item of items) {
      if (!grouped[item.card_id]) {
        grouped[item.card_id] = {
          card_id: item.card_id,
          name: item.name,
          description: item.description,
          main_image_url: item.main_image_url,
          rarity: item.rarity,
          card_number: item.card_number,
          frame_style: item.frame_style,
          visual_effects: item.visual_effects,
          collection_id: item.collection_id,
          collection_name: item.collection_name,
          copies: [],
        };
      }
      grouped[item.card_id].copies.push({
        user_card_id: item.user_card_id,
        source: item.source,
        obtained_at: item.obtained_at,
        is_locked_for_trade: item.is_locked_for_trade === 1,
      });
    }

    let result = Object.values(grouped).map((g) => ({
      ...g,
      copies_count: g.copies.length,
      has_duplicates: g.copies.length > 1,
    }));

    if (duplicates_only === 'true' || duplicates_only === '1') {
      result = result.filter((g) => g.has_duplicates);
    }

    res.json({
      total_items: items.length,
      distinct_cards_count: result.length,
      inventory: result,
    });
  } catch (err) {
    console.error('Erreur inventaire:', err);
    res.status(500).json({ error: 'Erreur récupération inventaire.' });
  }
});

// ==========================================
// 7. PROFILS PUBLICS & RECHERCHE (§3.6, §6.1)
// ==========================================

app.get('/api/users/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const users = await db.query(
      `SELECT u.id, u.username, p.display_name, p.avatar_url, p.bio,
              (SELECT COUNT(*) FROM user_cards WHERE user_id = u.id) as total_cards_count
       FROM users u
       JOIN profiles p ON p.user_id = u.id
       WHERE p.is_public = 1 AND u.is_suspended = 0 AND (u.username ILIKE ? OR p.display_name ILIKE ?)
       LIMIT 20`,
      [`%${q}%`, `%${q}%`]
    );
    res.json(users);
  } catch (err) {
    console.error('Erreur recherche joueurs:', err);
    res.status(500).json({ error: 'Erreur recherche.' });
  }
});

app.get('/api/users/:id/profile', async (req, res) => {
  try {
    const profile = await db.get(
      `SELECT u.id, u.username, p.display_name, p.avatar_url, p.bio, p.trading_enabled,
              p.featured_cards, p.trade_wishlist,
              (SELECT COUNT(DISTINCT card_id) FROM user_cards WHERE user_id = u.id) as distinct_cards,
              (SELECT COUNT(*) FROM user_cards WHERE user_id = u.id) as total_copies
       FROM users u
       JOIN profiles p ON p.user_id = u.id
       WHERE u.id = ? AND p.is_public = 1 AND u.is_suspended = 0`,
      [req.params.id]
    );

    if (!profile) return res.status(404).json({ error: 'Profil non public ou introuvable.' });

    const completedCollections = await db.query(
      `SELECT c.id, c.name, c.cover_image_url
       FROM collections c
       WHERE c.status = 'publiee'
       AND (
         SELECT COUNT(DISTINCT uc.card_id)
         FROM user_cards uc
         JOIN cards cd ON cd.id = uc.card_id
         WHERE uc.user_id = ? AND cd.collection_id = c.id
       ) = (
         SELECT COUNT(*)
         FROM cards
         WHERE collection_id = c.id AND status = 'publiee'
       )
       AND (SELECT COUNT(*) FROM cards WHERE collection_id = c.id AND status = 'publiee') > 0`,
      [req.params.id]
    );

    res.json({
      ...profile,
      completed_collections: completedCollections,
      featured_cards: JSON.parse(profile.featured_cards || '[]'),
      trade_wishlist: JSON.parse(profile.trade_wishlist || '[]'),
    });
  } catch (err) {
    console.error('Erreur profil public:', err);
    res.status(500).json({ error: 'Erreur profil public.' });
  }
});

// ==========================================
// 8. MESSAGERIE PRIVÉE (§6.2)
// ==========================================

app.get('/api/messages/conversations', authenticateToken, async (req, res) => {
  try {
    const conversations = await db.query(
      `SELECT c.id, c.updated_at,
              other_u.id as other_user_id, other_u.username as other_username,
              other_p.display_name as other_display_name, other_p.avatar_url as other_avatar_url,
              cm.is_blocked,
              (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
              (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_date,
              (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_id != ? AND is_read = 0) as unread_count
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
       JOIN conversation_members other_cm ON other_cm.conversation_id = c.id AND other_cm.user_id != ?
       JOIN users other_u ON other_u.id = other_cm.user_id
       JOIN profiles other_p ON other_p.user_id = other_u.id
       ORDER BY c.updated_at DESC`,
      [req.user.id, req.user.id, req.user.id]
    );

    res.json(conversations);
  } catch (err) {
    console.error('Erreur get conversations:', err);
    res.status(500).json({ error: 'Erreur messagerie.' });
  }
});

app.post('/api/messages/start', authenticateToken, async (req, res) => {
  try {
    const { target_user_id } = req.body;
    if (!target_user_id) return res.status(400).json({ error: 'target_user_id requis' });
    if (target_user_id === req.user.id) return res.status(400).json({ error: 'Action impossible sur vous-même' });

    const existing = await db.get(
      `SELECT c.id
       FROM conversations c
       JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.user_id = ?
       JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id = ?`,
      [req.user.id, target_user_id]
    );

    if (existing) return res.json({ conversation_id: existing.id });

    const convId = uuidv4();
    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO conversations (id) VALUES (?)', [convId]);
      await tx.run('INSERT INTO conversation_members (id, conversation_id, user_id) VALUES (?, ?, ?)', [
        uuidv4(),
        convId,
        req.user.id,
      ]);
      await tx.run('INSERT INTO conversation_members (id, conversation_id, user_id) VALUES (?, ?, ?)', [
        uuidv4(),
        convId,
        target_user_id,
      ]);
    });

    res.json({ conversation_id: convId });
  } catch (err) {
    console.error('Erreur start conversation:', err);
    res.status(500).json({ error: 'Erreur création conversation.' });
  }
});

app.get('/api/messages/conversations/:id', authenticateToken, async (req, res) => {
  try {
    const convId = req.params.id;
    const membership = await db.get(
      'SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
      [convId, req.user.id]
    );
    if (!membership) return res.status(403).json({ error: 'Accès interdit à cette conversation' });

    await db.run('UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND sender_id != ?', [
      convId,
      req.user.id,
    ]);

    const messages = await db.query(
      `SELECT m.id, m.sender_id, m.content, m.shared_card_id, m.is_read, m.created_at,
              u.username as sender_username, p.display_name as sender_display_name, p.avatar_url as sender_avatar_url,
              cd.name as shared_card_name, cd.main_image_url as shared_card_image, cd.rarity as shared_card_rarity
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       JOIN profiles p ON p.user_id = u.id
       LEFT JOIN cards cd ON cd.id = m.shared_card_id
       WHERE m.conversation_id = ?
       ORDER BY m.created_at ASC`,
      [convId]
    );

    res.json(messages);
  } catch (err) {
    console.error('Erreur get messages:', err);
    res.status(500).json({ error: 'Erreur messages.' });
  }
});

app.post('/api/messages/conversations/:id/send', authenticateToken, async (req, res) => {
  try {
    const convId = req.params.id;
    const { content, shared_card_id } = req.body;

    if (!content && !shared_card_id) return res.status(400).json({ error: 'Message vide' });

    const member = await db.get(
      'SELECT is_blocked FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
      [convId, req.user.id]
    );
    if (!member) return res.status(403).json({ error: 'Non membre' });
    if (member.is_blocked === 1) return res.status(403).json({ error: 'Conversation bloquée' });

    const otherMember = await db.get(
      'SELECT user_id, is_blocked FROM conversation_members WHERE conversation_id = ? AND user_id != ?',
      [convId, req.user.id]
    );
    if (otherMember && otherMember.is_blocked === 1) {
      return res.status(403).json({ error: 'Impossible d\'envoyer un message à cet utilisateur.' });
    }

    const messageId = uuidv4();
    await db.transaction(async (tx) => {
      await tx.run(
        'INSERT INTO messages (id, conversation_id, sender_id, content, shared_card_id) VALUES (?, ?, ?, ?, ?)',
        [messageId, convId, req.user.id, content || '', shared_card_id || null]
      );
      await tx.run('UPDATE conversations SET updated_at = NOW() WHERE id = ?', [convId]);
      if (otherMember) {
        await tx.run(
          "INSERT INTO notifications (id, user_id, title, body, type, data_payload) VALUES (?, ?, 'Nouveau message', ?, 'message', ?)",
          [uuidv4(), otherMember.user_id, `${req.user.username} vous a envoyé un message.`, JSON.stringify({ conversation_id: convId })]
        );
      }
    });

    res.status(201).json({ message: 'Message envoyé', message_id: messageId });
  } catch (err) {
    console.error('Erreur send message:', err);
    res.status(500).json({ error: 'Erreur envoi message.' });
  }
});

// ==========================================
// 9. ÉCHANGES SÉCURISÉS (§6.3, §6.4, §6.5)
// ==========================================

app.get('/api/trades', authenticateToken, async (req, res) => {
  try {
    const trades = await db.query(
      `SELECT t.id, t.initiator_id, t.receiver_id, t.status, t.created_at, t.updated_at,
              init_u.username as initiator_username, init_p.display_name as initiator_display_name,
              rec_u.username as receiver_username, rec_p.display_name as receiver_display_name
       FROM trades t
       JOIN users init_u ON init_u.id = t.initiator_id
       JOIN profiles init_p ON init_p.user_id = init_u.id
       JOIN users rec_u ON rec_u.id = t.receiver_id
       JOIN profiles rec_p ON rec_p.user_id = rec_u.id
       WHERE t.initiator_id = ? OR t.receiver_id = ?
       ORDER BY t.created_at DESC`,
      [req.user.id, req.user.id]
    );

    const result = [];
    for (const t of trades) {
      const items = await db.query(
        `SELECT ti.id, ti.party, ti.user_card_id, ti.points_amount,
                cd.name as card_name, cd.main_image_url as card_image, cd.rarity as card_rarity
         FROM trade_items ti
         LEFT JOIN user_cards uc ON uc.id = ti.user_card_id
         LEFT JOIN cards cd ON cd.id = uc.card_id
         WHERE ti.trade_id = ?`,
        [t.id]
      );
      result.push({
        ...t,
        is_initiator: t.initiator_id === req.user.id,
        items,
      });
    }

    res.json(result);
  } catch (err) {
    console.error('Erreur get trades:', err);
    res.status(500).json({ error: 'Erreur récupération échanges.' });
  }
});

app.post('/api/trades/propose', authenticateToken, async (req, res) => {
  try {
    const { receiver_id, offered_user_card_ids, offered_points, requested_user_card_ids, requested_points } = req.body;

    if (!receiver_id) return res.status(400).json({ error: 'receiver_id requis' });
    if (receiver_id === req.user.id) return res.status(400).json({ error: 'Échange avec soi-même impossible' });

    const offPts = Number(offered_points || 0);
    const reqPts = Number(requested_points || 0);
    if (offPts < 0 || reqPts < 0) return res.status(400).json({ error: 'Montant de points invalide' });

    const initiatorWallet = await getUserPointsBalance(req.user.id);
    if (offPts > initiatorWallet.balance) return res.status(400).json({ error: 'Solde de points insuffisant.' });

    const cardIds = offered_user_card_ids || [];
    if (cardIds.length === 0 && offPts === 0) {
      return res.status(400).json({ error: 'Vous devez proposer au moins une carte ou des points.' });
    }

    for (const cid of cardIds) {
      const c = await db.get('SELECT id, is_locked_for_trade FROM user_cards WHERE id = ? AND user_id = ?', [
        cid,
        req.user.id,
      ]);
      if (!c) return res.status(400).json({ error: `La carte (${cid}) ne vous appartient pas.` });
      if (c.is_locked_for_trade === 1) return res.status(400).json({ error: `La carte (${cid}) est déjà réservée.` });
    }

    const tradeId = uuidv4();
    await db.transaction(async (tx) => {
      await tx.run("INSERT INTO trades (id, initiator_id, receiver_id, status) VALUES (?, ?, ?, 'en_attente')", [
        tradeId,
        req.user.id,
        receiver_id,
      ]);

      for (const cid of cardIds) {
        await tx.run('UPDATE user_cards SET is_locked_for_trade = 1 WHERE id = ?', [cid]);
        await tx.run("INSERT INTO trade_items (id, trade_id, party, user_card_id, points_amount) VALUES (?, ?, 'initiator', ?, 0)", [
          uuidv4(),
          tradeId,
          cid,
        ]);
      }
      if (offPts > 0) {
        await tx.run("INSERT INTO trade_items (id, trade_id, party, user_card_id, points_amount) VALUES (?, ?, 'initiator', NULL, ?)", [
          uuidv4(),
          tradeId,
          offPts,
        ]);
      }

      for (const rcid of requested_user_card_ids || []) {
        await tx.run("INSERT INTO trade_items (id, trade_id, party, user_card_id, points_amount) VALUES (?, ?, 'receiver', ?, 0)", [
          uuidv4(),
          tradeId,
          rcid,
        ]);
      }
      if (reqPts > 0) {
        await tx.run("INSERT INTO trade_items (id, trade_id, party, user_card_id, points_amount) VALUES (?, ?, 'receiver', NULL, ?)", [
          uuidv4(),
          tradeId,
          reqPts,
        ]);
      }

      await tx.run(
        "INSERT INTO notifications (id, user_id, title, body, type, data_payload) VALUES (?, ?, 'Nouvelle proposition d''échange', ?, 'trade', ?)",
        [uuidv4(), receiver_id, `${req.user.username} vous propose un échange de cartes/points.`, JSON.stringify({ trade_id: tradeId })]
      );
    });

    res.status(201).json({ message: 'Proposition d\'échange envoyée avec succès.', trade_id: tradeId });
  } catch (err) {
    console.error('Erreur propose trade:', err);
    res.status(500).json({ error: 'Erreur lors de la proposition.' });
  }
});

app.post('/api/trades/:id/accept', authenticateToken, async (req, res) => {
  try {
    const tradeId = req.params.id;
    const trade = await db.get("SELECT * FROM trades WHERE id = ? AND status = 'en_attente'", [tradeId]);
    if (!trade) return res.status(404).json({ error: 'Échange non trouvé ou déjà traité.' });

    if (trade.receiver_id !== req.user.id) return res.status(403).json({ error: 'Non autorisé.' });

    const items = await db.query('SELECT * FROM trade_items WHERE trade_id = ?', [tradeId]);
    const initiatorCards = items.filter((i) => i.party === 'initiator' && i.user_card_id).map((i) => i.user_card_id);
    const initiatorPoints = items
      .filter((i) => i.party === 'initiator' && i.points_amount > 0)
      .reduce((acc, cur) => acc + cur.points_amount, 0);

    const receiverCards = items.filter((i) => i.party === 'receiver' && i.user_card_id).map((i) => i.user_card_id);
    const receiverPoints = items
      .filter((i) => i.party === 'receiver' && i.points_amount > 0)
      .reduce((acc, cur) => acc + cur.points_amount, 0);

    const initWallet = await getUserPointsBalance(trade.initiator_id);
    if (initWallet.balance < initiatorPoints) {
      return res.status(400).json({ error: 'L\'initiateur ne possède plus les points nécessaires.' });
    }

    const recWallet = await getUserPointsBalance(trade.receiver_id);
    if (recWallet.balance < receiverPoints) {
      return res.status(400).json({ error: 'Votre solde de points est insuffisant.' });
    }

    // TRANSACTION ATOMIQUE INDIVISIBLE (§6.4 étape 6, §10.4)
    await db.transaction(async (tx) => {
      for (const cid of initiatorCards) {
        await tx.run("UPDATE user_cards SET user_id = ?, is_locked_for_trade = 0, source = 'echange' WHERE id = ?", [
          trade.receiver_id,
          cid,
        ]);
      }
      for (const cid of receiverCards) {
        await tx.run("UPDATE user_cards SET user_id = ?, is_locked_for_trade = 0, source = 'echange' WHERE id = ?", [
          trade.initiator_id,
          cid,
        ]);
      }

      if (initiatorPoints > 0) {
        await tx.run(
          "INSERT INTO point_transactions (id, user_id, amount, reason, reference_id) VALUES (?, ?, ?, 'echange_debit', ?)",
          [uuidv4(), trade.initiator_id, -initiatorPoints, trade.id]
        );
        await tx.run(
          "INSERT INTO point_transactions (id, user_id, amount, reason, reference_id) VALUES (?, ?, ?, 'echange_credit', ?)",
          [uuidv4(), trade.receiver_id, initiatorPoints, trade.id]
        );
      }

      if (receiverPoints > 0) {
        await tx.run(
          "INSERT INTO point_transactions (id, user_id, amount, reason, reference_id) VALUES (?, ?, ?, 'echange_debit', ?)",
          [uuidv4(), trade.receiver_id, -receiverPoints, trade.id]
        );
        await tx.run(
          "INSERT INTO point_transactions (id, user_id, amount, reason, reference_id) VALUES (?, ?, ?, 'echange_credit', ?)",
          [uuidv4(), trade.initiator_id, receiverPoints, trade.id]
        );
      }

      await tx.run("UPDATE trades SET status = 'accepte', updated_at = NOW() WHERE id = ?", [trade.id]);

      await tx.run(
        "INSERT INTO notifications (id, user_id, title, body, type, data_payload) VALUES (?, ?, 'Échange réussi !', 'Votre échange a été validé avec succès.', 'trade', ?)",
        [uuidv4(), trade.initiator_id, JSON.stringify({ trade_id: trade.id })]
      );
      await tx.run(
        "INSERT INTO notifications (id, user_id, title, body, type, data_payload) VALUES (?, ?, 'Échange réussi !', 'Vous avez accepté l''échange avec succès.', 'trade', ?)",
        [uuidv4(), trade.receiver_id, JSON.stringify({ trade_id: trade.id })]
      );
    });

    res.json({ message: 'Échange accepté et transféré avec succès !' });
  } catch (err) {
    console.error('Erreur accept trade:', err);
    res.status(500).json({ error: 'Erreur lors de l\'acceptation de l\'échange.' });
  }
});

app.post('/api/trades/:id/refuse', authenticateToken, async (req, res) => {
  try {
    const tradeId = req.params.id;
    const trade = await db.get("SELECT * FROM trades WHERE id = ? AND status = 'en_attente'", [tradeId]);
    if (!trade) return res.status(404).json({ error: 'Échange non trouvé.' });

    if (trade.receiver_id !== req.user.id && trade.initiator_id !== req.user.id) {
      return res.status(403).json({ error: 'Non autorisé.' });
    }

    await db.transaction(async (tx) => {
      const items = await tx.query(
        'SELECT user_card_id FROM trade_items WHERE trade_id = ? AND user_card_id IS NOT NULL',
        [tradeId]
      );
      for (const item of items) {
        await tx.run('UPDATE user_cards SET is_locked_for_trade = 0 WHERE id = ?', [item.user_card_id]);
      }
      await tx.run("UPDATE trades SET status = 'refuse', updated_at = NOW() WHERE id = ?", [tradeId]);
    });

    res.json({ message: 'Échange refusé et cartes déverrouillées.' });
  } catch (err) {
    console.error('Erreur refuse trade:', err);
    res.status(500).json({ error: 'Erreur refus échange.' });
  }
});

// ==========================================
// 10. NOTIFICATIONS (§10.3)
// ==========================================

app.get('/api/notifications', authenticateToken, async (req, res) => {
  try {
    const notifs = await db.query(
      `SELECT id, title, body, type, data_payload, is_read, created_at
       FROM notifications
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json(notifs);
  } catch (err) {
    res.status(500).json({ error: 'Erreur notifications.' });
  }
});

app.post('/api/notifications/:id/read', authenticateToken, async (req, res) => {
  try {
    await db.run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur mise à jour notification.' });
  }
});

// ==========================================
// 11. MODÉRATION & SIGNALEMENTS (§2.2, §6.6)
// ==========================================

app.post('/api/reports', authenticateToken, async (req, res) => {
  try {
    const { reported_user_id, reported_message_id, reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Motif du signalement requis' });

    await db.run(
      `INSERT INTO reports (id, reporter_id, reported_user_id, reported_message_id, reason)
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), req.user.id, reported_user_id || null, reported_message_id || null, reason]
    );

    res.status(201).json({ message: 'Signalement transmis à l\'équipe de modération.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors du signalement.' });
  }
});

app.get('/api/moderation/reports', authenticateToken, requireRole(['moderateur', 'administrateur']), async (req, res) => {
  try {
    const reports = await db.query(
      `SELECT r.*,
              rep.username as reporter_username,
              u.username as reported_username,
              m.content as reported_message_content
       FROM reports r
       JOIN users rep ON rep.id = r.reporter_id
       LEFT JOIN users u ON u.id = r.reported_user_id
       LEFT JOIN messages m ON m.id = r.reported_message_id
       ORDER BY r.created_at DESC`
    );
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: 'Erreur signalements.' });
  }
});

app.post('/api/moderation/reports/:id/resolve', authenticateToken, requireRole(['moderateur', 'administrateur']), async (req, res) => {
  try {
    const { status, moderator_notes } = req.body;
    await db.run('UPDATE reports SET status = ?, moderator_notes = ? WHERE id = ?', [
      status || 'traite',
      moderator_notes || '',
      req.params.id,
    ]);
    await logAudit(req.user.id, 'RESOLVE_REPORT', 'report', req.params.id, `Statut: ${status}`);
    res.json({ message: 'Signalement mis à jour.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur traitement signalement.' });
  }
});

app.post('/api/moderation/users/:id/suspend', authenticateToken, requireRole(['moderateur', 'administrateur']), async (req, res) => {
  try {
    const { suspend } = req.body;
    const val = suspend ? 1 : 0;
    await db.run('UPDATE users SET is_suspended = ? WHERE id = ?', [val, req.params.id]);
    await logAudit(req.user.id, val ? 'SUSPEND_USER' : 'UNSUSPEND_USER', 'user', req.params.id, `Action suspension: ${val}`);
    res.json({ message: val ? 'Compte suspendu' : 'Compte réactivé' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur suspension utilisateur.' });
  }
});

// ==========================================
// 12. ADMINISTRATION (§2.3, §7.1 - §7.7)
// ==========================================

app.get('/api/admin/dashboard', authenticateToken, requireRole(['administrateur']), async (req, res) => {
  try {
    const registeredUsers = (await db.get('SELECT COUNT(*) as count FROM users'))?.count || 0;
    const activeUsers =
      (
        await db.get(
          "SELECT COUNT(DISTINCT user_id) as count FROM quiz_attempts WHERE attempted_at >= NOW() - INTERVAL '7 days'"
        )
      )?.count || 0;
    const publishedCollections =
      (await db.get("SELECT COUNT(*) as count FROM collections WHERE status = 'publiee'"))?.count || 0;
    const availableCards =
      (await db.get("SELECT COUNT(*) as count FROM cards WHERE status = 'publiee'"))?.count || 0;
    const openedBoosters = (await db.get('SELECT COUNT(*) as count FROM booster_openings'))?.count || 0;

    const pointsStats = await db.get(
      `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) as total_earned,
              COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) as total_spent
       FROM point_transactions`
    );

    const tradesDone = (await db.get("SELECT COUNT(*) as count FROM trades WHERE status = 'accepte'"))?.count || 0;
    const pendingReports = (await db.get("SELECT COUNT(*) as count FROM reports WHERE status = 'en_attente'"))?.count || 0;

    res.json({
      registered_users: Number(registeredUsers),
      active_users_7d: Number(activeUsers),
      published_collections: Number(publishedCollections),
      available_cards: Number(availableCards),
      opened_boosters: Number(openedBoosters),
      points_earned: Number(pointsStats?.total_earned || 0),
      points_spent: Number(pointsStats?.total_spent || 0),
      trades_completed: Number(tradesDone),
      pending_reports: Number(pendingReports),
    });
  } catch (err) {
    console.error('Erreur dashboard admin:', err);
    res.status(500).json({ error: 'Erreur dashboard.' });
  }
});

app.post('/api/admin/upload-image', authenticateToken, requireRole(['administrateur']), upload.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
    const fullUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.json({ message: 'Illustration importée avec succès', file_name: req.file.filename, url: fullUrl });
  } catch (err) {
    res.status(500).json({ error: 'Erreur téléversement image.' });
  }
});

app.get('/api/admin/collections', authenticateToken, requireRole(['administrateur']), async (req, res) => {
  const collections = await db.query('SELECT * FROM collections ORDER BY created_at DESC');
  res.json(collections);
});

app.post('/api/admin/collections', authenticateToken, requireRole(['administrateur']), async (req, res) => {
  try {
    const { name, description, cover_image_url, banner_image_url, status, start_date, end_date, completion_reward_points, display_order, icon_symbol } = req.body;
    if (!name) return res.status(400).json({ error: 'Nom obligatoire' });

    const id = uuidv4();
    await db.run(
      `INSERT INTO collections (id, name, description, cover_image_url, banner_image_url, status, start_date, end_date, published_at, completion_reward_points, display_order, icon_symbol)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'publiee' THEN NOW() ELSE NULL END, ?, ?, ?)`,
      [
        id,
        name,
        description,
        cover_image_url,
        banner_image_url,
        status || 'brouillon',
        start_date || null,
        end_date || null,
        status,
        Number(completion_reward_points || 100),
        Number(display_order || 0),
        icon_symbol || '🎴',
      ]
    );

    await logAudit(req.user.id, 'CREATE_COLLECTION', 'collection', id, `Collection: ${name}`);
    res.status(201).json({ message: 'Collection créée', id });
  } catch (err) {
    res.status(500).json({ error: 'Erreur création collection.' });
  }
});

app.get('/api/admin/cards', authenticateToken, requireRole(['administrateur']), async (req, res) => {
  const cards = await db.query(
    `SELECT cd.*, c.name as collection_name
     FROM cards cd
     JOIN collections c ON c.id = cd.collection_id
     ORDER BY cd.created_at DESC`
  );
  res.json(cards);
});

app.post('/api/admin/cards', authenticateToken, requireRole(['administrateur']), async (req, res) => {
  try {
    const {
      collection_id,
      name,
      description,
      main_image_url,
      alt_image_url,
      rarity,
      card_number,
      frame_style,
      visual_effects,
      availability,
      status,
      border_color,
      special_finish,
      is_secret,
      is_hidden_rarity,
    } = req.body;
    if (!collection_id || !name || !main_image_url) {
      return res.status(400).json({ error: 'collection_id, nom et illustration principale requis' });
    }

    const id = uuidv4();
    await db.run(
      `INSERT INTO cards (id, collection_id, name, description, main_image_url, alt_image_url, rarity, card_number, frame_style, visual_effects, availability, status, border_color, special_finish, is_secret, is_hidden_rarity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        collection_id,
        name,
        description || '',
        main_image_url,
        alt_image_url || null,
        rarity || 'commune',
        card_number || 1,
        frame_style || 'simple',
        visual_effects || null,
        availability || 'permanente',
        status || 'brouillon',
        border_color || null,
        special_finish || 'standard',
        is_secret ? 1 : 0,
        is_hidden_rarity ? 1 : 0,
      ]
    );

    await logAudit(req.user.id, 'CREATE_CARD', 'card', id, `Carte: ${name} (${rarity})`);
    res.status(201).json({ message: 'Carte créée avec succès', id });
  } catch (err) {
    console.error('Erreur création carte:', err);
    res.status(500).json({ error: 'Erreur création carte.' });
  }
});

app.post('/api/admin/boosters', authenticateToken, requireRole(['administrateur']), async (req, res) => {
  try {
    const {
      name,
      description,
      illustration_url,
      price_points,
      cards_per_pack,
      collection_id,
      rarity_rates,
      opening_animation,
      daily_purchase_limit,
      original_price_points,
      available_until,
    } = req.body;
    if (!name || !price_points) {
      return res.status(400).json({ error: 'Nom et prix en points requis' });
    }

    const boosterId = uuidv4();
    await db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO boosters (id, name, description, illustration_url, price_points, cards_per_pack, collection_id, is_active, opening_animation, daily_purchase_limit, original_price_points, available_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        [
          boosterId,
          name,
          description || '',
          illustration_url || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=300',
          Number(price_points),
          Number(cards_per_pack || 5),
          collection_id || null,
          opening_animation || 'classique',
          Number(daily_purchase_limit || 0),
          original_price_points ? Number(original_price_points) : null,
          available_until || null,
        ]
      );

      const defaultRates = [
        { rarity: 'commune', rate_percentage: 60 },
        { rarity: 'peu commune', rate_percentage: 25 },
        { rarity: 'rare', rate_percentage: 10 },
        { rarity: 'epique', rate_percentage: 4 },
        { rarity: 'legendaire', rate_percentage: 1 },
      ];
      const ratesToApply = rarity_rates && rarity_rates.length > 0 ? rarity_rates : defaultRates;

      for (const r of ratesToApply) {
        await tx.run(
          'INSERT INTO booster_rarity_rates (id, booster_id, rarity, rate_percentage) VALUES (?, ?, ?, ?)',
          [uuidv4(), boosterId, r.rarity, Number(r.rate_percentage)]
        );
      }
    });

    await logAudit(req.user.id, 'CREATE_BOOSTER', 'booster', boosterId, `Pack créé: ${name} (${price_points} pts)`);
    res.status(201).json({ message: 'Booster créé avec succès', id: boosterId });
  } catch (err) {
    console.error('Erreur création booster:', err);
    res.status(500).json({ error: 'Erreur création booster.' });
  }
});

app.get('/api/admin/questions', authenticateToken, requireRole(['administrateur']), async (req, res) => {
  const questions = await db.query('SELECT * FROM questions ORDER BY created_at DESC');
  const result = [];
  for (const q of questions) {
    const answers = await db.query('SELECT * FROM question_answers WHERE question_id = ?', [q.id]);
    result.push({ ...q, answers });
  }
  res.json(result);
});

app.post('/api/admin/questions', authenticateToken, requireRole(['administrateur']), async (req, res) => {
  try {
    const { prompt, explanation, difficulty, category, points_reward, answers, time_limit_seconds } = req.body;
    if (!prompt || !difficulty || !category || !answers || answers.length < 2) {
      return res.status(400).json({ error: 'Énoncé, difficulté, catégorie et au moins 2 réponses requis' });
    }

    const qid = uuidv4();
    await db.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO questions (id, prompt, explanation, difficulty, category, points_reward, status, time_limit_seconds) VALUES (?, ?, ?, ?, ?, ?, 'publiee', ?)",
        [qid, prompt, explanation || null, difficulty, category, points_reward || 10, Number(time_limit_seconds || 20)]
      );
      for (const a of answers) {
        await tx.run('INSERT INTO question_answers (id, question_id, answer_text, is_correct) VALUES (?, ?, ?, ?)', [
          uuidv4(),
          qid,
          a.answer_text,
          a.is_correct ? 1 : 0,
        ]);
      }
    });

    await logAudit(req.user.id, 'CREATE_QUESTION', 'question', qid, `Question: ${prompt.substring(0, 30)}...`);
    res.status(201).json({ message: 'Question enregistrée', id: qid });
  } catch (err) {
    res.status(500).json({ error: 'Erreur création question.' });
  }
});

app.get('/api/admin/users', authenticateToken, requireRole(['administrateur']), async (req, res) => {
  try {
    const users = await db.query(
      `SELECT u.id, u.email, u.username, u.is_suspended, u.created_at,
              p.display_name, p.avatar_url,
              (SELECT role FROM user_roles WHERE user_id = u.id LIMIT 1) as role,
              (SELECT COUNT(*) FROM user_cards WHERE user_id = u.id) as cards_count
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       ORDER BY u.created_at DESC`
    );

    const result = [];
    for (const u of users) {
      const wallet = await getUserPointsBalance(u.id);
      result.push({ ...u, wallet });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Erreur liste utilisateurs.' });
  }
});

app.post('/api/admin/create-admin', authenticateToken, requireRole(['administrateur']), async (req, res) => {
  try {
    const { username, email, password, display_name } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Nom d\'utilisateur, email et mot de passe requis.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Le mot de passe doit comporter au moins 8 caractères.' });
    }

    const existing = await db.get('SELECT id FROM users WHERE email = ? OR username = ?', [email, username]);
    if (existing) {
      return res.status(400).json({ error: 'Un compte avec cet email ou nom d\'utilisateur existe déjà.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUserId = uuidv4();
    const avatarUrl = `https://api.dicebear.com/7.x/bottts/svg?seed=${username}`;

    await db.transaction(async (tx) => {
      await tx.run(
        'INSERT INTO users (id, email, password_hash, username, is_suspended) VALUES (?, ?, ?, ?, 0)',
        [newUserId, email, hashedPassword, username]
      );
      await tx.run(
        "INSERT INTO user_roles (id, user_id, role) VALUES (?, ?, 'administrateur')",
        [uuidv4(), newUserId]
      );
      await tx.run(
        'INSERT INTO profiles (id, user_id, display_name, avatar_url, bio, is_public) VALUES (?, ?, ?, ?, ?, 1)',
        [uuidv4(), newUserId, display_name || username, avatarUrl, 'Compte Administrateur']
      );
    });

    await logAudit(
      req.user.id,
      'CREATE_ADMIN',
      'user',
      newUserId,
      `Création du compte administrateur: ${username} (${email})`
    );

    res.status(201).json({ message: 'Compte administrateur créé avec succès', id: newUserId });
  } catch (err) {
    console.error('Erreur création admin:', err);
    res.status(500).json({ error: 'Erreur création administrateur.' });
  }
});

app.post('/api/admin/users/:id/adjust-balance', authenticateToken, requireRole(['administrateur']), async (req, res) => {
  try {
    const { amount, justification } = req.body;
    if (!amount || !justification) {
      return res.status(400).json({ error: 'Montant et justification obligatoires.' });
    }

    const txId = uuidv4();
    await db.run(
      "INSERT INTO point_transactions (id, user_id, amount, reason, reference_id) VALUES (?, ?, ?, 'admin_adjustment', ?)",
      [txId, req.params.id, Number(amount), justification]
    );

    await logAudit(req.user.id, 'ADJUST_BALANCE', 'user', req.params.id, `Correction: ${amount} pts. Justif: ${justification}`);
    res.json({ message: 'Solde ajusté et consigné dans le journal d\'audit.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur ajustement solde.' });
  }
});

app.get('/api/admin/audit-logs', authenticateToken, requireRole(['administrateur']), async (req, res) => {
  try {
    const logs = await db.query(
      `SELECT al.*, u.username as actor_username
       FROM audit_logs al
       JOIN users u ON u.id = al.actor_id
       ORDER BY al.created_at DESC
       LIMIT 100`
    );
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: 'Erreur audit logs.' });
  }
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur REST API connecté à Neon Cloud PostgreSQL sur http://localhost:${PORT}`);
    console.log(`Point d'accès réseau : http://0.0.0.0:${PORT}`);
  });
}

module.exports = app;
