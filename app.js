require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const pool = require('./db');

console.log('Starting Gym app...');

const app = express();

// Views and static
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Session store (in MySQL)
const sessionStore = new MySQLStore({
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'gymdb',
  createDatabaseTable: true,
  clearExpired: true,
  checkExpirationInterval: 15 * 60 * 1000,
  expiration: 7 * 24 * 60 * 60 * 1000,
});
app.use(
  session({
    key: 'gym.sid',
    secret: process.env.SESSION_SECRET || 'secret',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
  })
);

// Mailer
const EMAIL_ENABLED = String(process.env.EMAIL_ENABLED || 'false').toLowerCase() === 'true';
let transporter = null;
if (EMAIL_ENABLED) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'localhost',
    port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 25,
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
  });
  transporter
    .verify()
    .then(() => console.log('Mail: SMTP verified'))
    .catch((e) => console.error('Mail verify failed:', e.message));
}
async function sendEmail(to, subject, text, html) {
  if (!transporter || !to) return;
  try {
    await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER || 'no-reply@gym.local',
      to,
      subject,
      text: text || (html ? html.replace(/<[^>]+>/g, ' ') : ''),
      html,
    });
    console.log('Mail sent to', to, '-', subject);
  } catch (e) {
    console.error('Mail send failed:', e.message);
  }
}
function genToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}
async function sendVerificationEmail(email, name, token) {
  const baseUrl = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
  const url = `${baseUrl}/verify?token=${encodeURIComponent(token)}`;
  const subject = 'Verify your email';
  const html = `
    <div style="font-family:Arial,sans-serif">
      <p>Hi ${name || 'there'},</p>
      <p>Thanks for signing up. Please verify your email address by clicking the button below:</p>
      <p><a href="${url}" style="display:inline-block;padding:10px 14px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none">Verify Email</a></p>
      <p>If the button doesn't work, copy and paste this link:</p>
      <p><a href="${url}">${url}</a></p>
      <hr>
      <small>This link expires in 24 hours.</small>
    </div>`;
  await sendEmail(email, subject, null, html);
}

// Expose user + unread count
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});
app.use(async (req, res, next) => {
  if (!req.session.user) {
    res.locals.unreadCount = 0;
    return next();
  }
  try {
    const [[row]] = await pool.execute(
      'SELECT COUNT(*) AS cnt FROM notifications WHERE user_id=? AND is_read=0',
      [req.session.user.id]
    );
    res.locals.unreadCount = row?.cnt || 0;
  } catch {
    res.locals.unreadCount = 0;
  }
  next();
});

// Kick out deactivated users (if admin deactivates mid-session)
app.use(async (req, res, next) => {
  if (!req.session.user) return next();
  try {
    const [[u]] = await pool.execute('SELECT is_active FROM users WHERE id=?', [req.session.user.id]);
    if (!u || u.is_active === 0) {
      return req.session.destroy(() => res.redirect('/login?error=Your+account+is+deactivated'));
    }
  } catch (e) {
    console.error('Active-check failed:', e.message);
  }
  next();
});

// Auto-inject main.js into all rendered pages
app.use((req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = (view, locals, callback) => {
    if (typeof locals === 'function') {
      callback = locals;
      locals = undefined;
    }
    originalRender(view, locals, (err, html) => {
      if (err) {
        if (callback) return callback(err);
        return next(err);
      }
      try {
        const tag = '<script src="/public/js/main.js" defer></script>';
        if (!html.includes('/public/js/main.js')) {
          if (html.includes('</body>')) {
            html = html.replace('</body>', `${tag}\n</body>`);
          } else {
            html += `\n${tag}\n`;
          }
        }
      } catch {}
      if (callback) return callback(null, html);
      res.send(html);
    });
  };
  next();
});

// Guards
const isAuth = (req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  next();
};
const isAdmin = (req, res, next) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).send('Forbidden');
  next();
};

// Helpers
const calcBMI = (height_cm, weight_kg) => {
  if (!height_cm || !weight_kg) return null;
  const h = Number(height_cm) / 100;
  if (!h) return null;
  return Number((Number(weight_kg) / (h * h)).toFixed(2));
};
async function addNotification(userId, type, message) {
  await pool.execute('INSERT INTO notifications (user_id, type, message) VALUES (?, ?, ?)', [
    userId,
    type,
    message,
  ]);
  try {
    const [[u]] = await pool.execute('SELECT email, name FROM users WHERE id=?', [userId]);
    if (u?.email) {
      const subject =
        type === 'renewal'
          ? 'Membership Renewal Reminder'
          : type === 'attendance'
          ? 'We miss you at the gym'
          : type === 'health'
          ? 'Health Tip'
          : 'Gym Notification';
      const html = `
        <div style="font-family:Arial,sans-serif">
          <p>Hi ${u.name || 'Member'},</p>
          <p>${message}</p>
          <p><a href="http://127.0.0.1:${process.env.PORT || 3000}/dashboard">Open your dashboard</a></p>
          <hr>
          <small>This is an automated message from Gym Management System.</small>
        </div>`;
      await sendEmail(u.email, subject, null, html);
    }
  } catch (e) {
    console.error('Email-on-notification failed:', e.message);
  }
}

// Auth routes
app.get('/', (req, res) => (req.session.user ? res.redirect('/dashboard') : res.redirect('/login')));
app.get('/register', (req, res) => res.render('register', { errors: [], data: {} }));
app.post(
  '/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be 6+ chars'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    const { name, email, password } = req.body;
    if (!errors.isEmpty()) {
      return res.status(400).render('register', { errors: errors.array(), data: req.body });
    }
    try {
      const [existing] = await pool.execute('SELECT id FROM users WHERE email=?', [email]);
      if (existing.length) {
        return res.status(400).render('register', { errors: [{ msg: 'Email already registered' }], data: req.body });
      }
      const hash = await bcrypt.hash(password, 10);
      const [result] = await pool.execute(
        'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
        [name, email, hash, 'member']
      );
      const userId = result.insertId;

      const token = genToken(24);
      await pool.execute(
        'UPDATE users SET verification_token=?, verification_expires=DATE_ADD(NOW(), INTERVAL 24 HOUR) WHERE id=?',
        [token, userId]
      );
      try {
        await sendVerificationEmail(email, name, token);
      } catch (e) {
        console.error('Send verification email failed:', e.message);
      }
      res.redirect('/login?message=We%20sent%20you%20a%20verification%20link.%20Please%20check%20your%20email.');
    } catch (e) {
      console.error(e);
      res.status(500).send('Server error');
    }
  }
);

// Login
app.get('/login', (req, res) =>
  res.render('login', {
    error: req.query.error || null,
    message: req.query.message || null,
    email: req.query.email || '',
    notVerified: false,
  })
);
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [rows] = await pool.execute('SELECT * FROM users WHERE email=?', [email]);
    if (!rows.length)
      return res.status(400).render('login', { error: 'Invalid email or password', message: null, email, notVerified: false });

    const user = rows[0];
    if (user.is_active === 0)
      return res.status(403).render('login', { error: 'Account is deactivated', message: null, email, notVerified: false });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match)
      return res.status(400).render('login', { error: 'Invalid email or password', message: null, email, notVerified: false });

    if (!user.email_verified) {
      return res
        .status(403)
        .render('login', {
          error: 'Your email is not verified.',
          message: 'We can resend the verification link.',
          email,
          notVerified: true
        });
    }

    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    res.redirect('/dashboard');
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// Email verification + resend
app.get('/verify', async (req, res) => {
  const token = (req.query.token || '').trim();
  if (!token) return res.status(400).render('verify_result', { ok: false, message: 'Missing token.' });

  try {
    const [[user]] = await pool.execute(
      'SELECT id, email_verified FROM users WHERE verification_token=? AND verification_expires >= NOW() LIMIT 1',
      [token]
    );
    if (!user) {
      return res.status(400).render('verify_result', { ok: false, message: 'Invalid or expired verification link.' });
    }

    if (user.email_verified) {
      await pool.execute('UPDATE users SET verification_token=NULL, verification_expires=NULL WHERE id=?', [user.id]);
      return res.render('verify_result', { ok: true, message: 'Email already verified. You can sign in now.' });
    }

    await pool.execute(
      'UPDATE users SET email_verified=1, verification_token=NULL, verification_expires=NULL WHERE id=?',
      [user.id]
    );
    res.render('verify_result', { ok: true, message: 'Email verified! You can sign in now.' });
  } catch (e) {
    console.error(e);
    res.status(500).render('verify_result', { ok: false, message: 'Server error while verifying email.' });
  }
});
app.get('/resend-verification', (req, res) => {
  res.render('resend_verification', { email: req.query.email || '', message: null, error: null });
});
app.post('/resend-verification', async (req, res) => {
  const email = (req.body.email || '').trim();
  if (!email) {
    return res.render('resend_verification', { email: '', message: null, error: 'Please enter your email.' });
  }
  try {
    const [[user]] = await pool.execute('SELECT id, name, email_verified FROM users WHERE email=? LIMIT 1', [email]);
    if (user && !user.email_verified) {
      const token = genToken(24);
      await pool.execute(
        'UPDATE users SET verification_token=?, verification_expires=DATE_ADD(NOW(), INTERVAL 24 HOUR) WHERE id=?',
        [token, user.id]
      );
      try {
        await sendVerificationEmail(email, user.name, token);
      } catch (e) {
        console.error('Resend verification email failed:', e.message);
      }
    }
    res.render('resend_verification', {
      email,
      message: 'If an account exists for that email and is unverified, we sent a new verification link.',
      error: null
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('resend_verification', { email, message: null, error: 'Server error.' });
  }
});

// Member pages
app.get('/dashboard', isAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const [mRows] = await pool.execute(
      `SELECT m.*, p.name AS plan_name
       FROM memberships m
       JOIN membership_plans p ON p.id = m.plan_id
       WHERE m.user_id=?
       ORDER BY CASE WHEN m.status='active' THEN 0 WHEN m.status='pending' THEN 1 ELSE 2 END, m.end_date DESC
       LIMIT 1`,
      [userId]
    );
    const membership = mRows[0] || null;

    const [[att]] = await pool.execute(
      `SELECT COUNT(*) AS cnt
       FROM attendance
       WHERE user_id=? AND DATE(check_in) >= (CURDATE() - INTERVAL 7 DAY)`,
      [userId]
    );
    const weeklyCheckins = att ? att.cnt : 0;

    const [hRows] = await pool.execute(
      `SELECT * FROM health_metrics WHERE user_id=? ORDER BY entry_date DESC LIMIT 1`,
      [userId]
    );
    const latestHealth = hRows[0] || null;

    res.render('dashboard', { membership, weeklyCheckins, latestHealth });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

app.get('/profile', isAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM users WHERE id=?', [req.session.user.id]);
    res.render('profiles', { userProfile: rows[0], message: null, error: null });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});
app.post('/profile', isAuth, async (req, res) => {
  const { name, phone, gender, date_of_birth } = req.body;
  try {
    await pool.execute(
      'UPDATE users SET name=?, phone=?, gender=?, date_of_birth=? WHERE id=?',
      [name, phone || null, gender || null, date_of_birth || null, req.session.user.id]
    );
    req.session.user.name = name;
    const [rows] = await pool.execute('SELECT * FROM users WHERE id=?', [req.session.user.id]);
    res.render('profiles', { userProfile: rows[0], message: 'Profile updated', error: null });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

app.get('/plans', isAuth, async (req, res) => {
  try {
    const [plans] = await pool.execute('SELECT * FROM membership_plans ORDER BY duration_days');
    res.render('plans', { plans, message: null, error: null });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});
app.post('/subscribe', isAuth, async (req, res) => {
  const userId = req.session.user.id;
  const { plan_id } = req.body;
  try {
    const [[plan]] = await pool.query('SELECT * FROM membership_plans WHERE id=?', [plan_id]);
    if (!plan) return res.status(400).send('Plan not found');

    const [[active]] = await pool.query(
      `SELECT * FROM memberships
       WHERE user_id=? AND status='active' AND end_date >= CURDATE()
       ORDER BY end_date DESC LIMIT 1`,
      [userId]
    );

    if (active) {
      await pool.execute(
        `INSERT INTO memberships (user_id, plan_id, start_date, end_date, status)
         VALUES (?, ?, DATE_ADD(?, INTERVAL 1 DAY), DATE_ADD(DATE_ADD(?, INTERVAL 1 DAY), INTERVAL ? DAY), 'pending')`,
        [userId, plan.id, active.end_date, active.end_date, Number(plan.duration_days) - 1]
      );
    } else {
      await pool.execute(
        `INSERT INTO memberships (user_id, plan_id, start_date, end_date, status)
         VALUES (?, ?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL ? DAY), 'active')`,
        [userId, plan.id, Number(plan.duration_days) - 1]
      );
    }
    res.redirect('/dashboard');
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

app.get('/attendance', isAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM attendance WHERE user_id=? ORDER BY check_in DESC LIMIT 50`,
      [userId]
    );
    const [[open]] = await pool.execute(
      `SELECT * FROM attendance WHERE user_id=? AND check_out IS NULL ORDER BY check_in DESC LIMIT 1`,
      [userId]
    );
    res.render('attendance', { entries: rows, openEntry: open || null, message: null, error: null });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});
app.post('/attendance/checkin', isAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const [[open]] = await pool.execute(
      'SELECT * FROM attendance WHERE user_id=? AND check_out IS NULL ORDER BY check_in DESC LIMIT 1',
      [userId]
    );
    if (open) return res.redirect('/attendance');
    await pool.execute('INSERT INTO attendance (user_id, check_in, method) VALUES (?, NOW(), ?)', [
      userId,
      'manual',
    ]);
    res.redirect('/attendance');
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});
app.post('/attendance/checkout', isAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const [[open]] = await pool.execute(
      'SELECT * FROM attendance WHERE user_id=? AND check_out IS NULL ORDER BY check_in DESC LIMIT 1',
      [userId]
    );
    if (!open) return res.redirect('/attendance');
    await pool.execute('UPDATE attendance SET check_out=NOW() WHERE id=?', [open.id]);
    res.redirect('/attendance');
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

app.get('/health', isAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const [rows] = await pool.execute(
      `SELECT entry_date, weight_kg, height_cm, bmi, heart_rate_bpm, calories_intake
       FROM health_metrics
       WHERE user_id=?
       ORDER BY entry_date ASC`,
      [userId]
    );
    res.render('health', { metrics: rows, message: null, error: null });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});
app.post('/health', isAuth, async (req, res) => {
  const userId = req.session.user.id;
  let { entry_date, weight_kg, height_cm, heart_rate_bpm, calories_intake } = req.body;

  if (!entry_date) {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    entry_date = `${yyyy}-${mm}-${dd}`;
  }
  weight_kg = weight_kg ? Number(weight_kg) : null;
  height_cm = height_cm ? Number(height_cm) : null;
  heart_rate_bpm = heart_rate_bpm ? Number(heart_rate_bpm) : null;
  calories_intake = calories_intake ? Number(calories_intake) : null;

  try {
    if (!height_cm) {
      const [[last]] = await pool.execute(
        'SELECT height_cm FROM health_metrics WHERE user_id=? AND height_cm IS NOT NULL ORDER BY entry_date DESC LIMIT 1',
        [userId]
      );
      height_cm = last?.height_cm || null;
    }
    const bmi = calcBMI(height_cm, weight_kg);

    await pool.execute(
      `INSERT INTO health_metrics (user_id, entry_date, weight_kg, height_cm, bmi, heart_rate_bpm, calories_intake)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE weight_kg=VALUES(weight_kg), height_cm=VALUES(height_cm), bmi=VALUES(bmi),
         heart_rate_bpm=VALUES(heart_rate_bpm), calories_intake=VALUES(calories_intake)`,
      [userId, entry_date, weight_kg, height_cm, bmi, heart_rate_bpm, calories_intake]
    );

    res.redirect('/health');
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

app.get('/tips', isAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const [[latest]] = await pool.execute(
      'SELECT * FROM health_metrics WHERE user_id=? ORDER BY entry_date DESC LIMIT 1',
      [userId]
    );
    const [[att]] = await pool.execute(
      `SELECT COUNT(*) AS cnt FROM attendance WHERE user_id=? AND DATE(check_in) >= (CURDATE() - INTERVAL 7 DAY)`,
      [userId]
    );

    const tips = [];
    if (latest?.bmi) {
      if (latest.bmi >= 30) tips.push('Aim for 150–300 minutes of moderate cardio weekly and prioritize whole foods.');
      else if (latest.bmi >= 25) tips.push('Try 3x/week strength + 2x/week cardio with a small calorie deficit (200–300/day).');
      else if (latest.bmi < 18.5) tips.push('Increase protein and healthy carbs; focus on progressive overload 3–4x/week.');
      else tips.push('Great BMI range — maintain with balanced training and adequate protein intake.');
    } else {
      tips.push('Add height and weight to calculate BMI for better recommendations.');
    }

    const weekly = att ? att.cnt : 0;
    if (weekly < 2) tips.push('Your attendance is low. Try scheduling sessions or going with a buddy.');
    else tips.push('Nice consistency! Keep at least 3 sessions per week for steady progress.');

    if (latest?.heart_rate_bpm && latest.heart_rate_bpm > 100) {
      tips.push('Resting heart rate seems high — more low-intensity cardio and better sleep may help. If persistent, consult a doctor.');
    }

    if (latest?.calories_intake && latest.calories_intake > 2800) {
      tips.push('High intake today — add a walk or swap sugary drinks for water.');
    }

    res.render('tips', { tips });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

app.get('/notifications', isAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, type, message, is_read, created_at
       FROM notifications
       WHERE user_id=?
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.session.user.id]
    );
    res.render('notifications', { notifications: rows });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});
app.post('/notifications/mark-all-read', isAuth, async (req, res) => {
  try {
    await pool.execute('UPDATE notifications SET is_read=1 WHERE user_id=? AND is_read=0', [req.session.user.id]);
    res.redirect('/notifications');
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

// Admin: dashboard
app.get('/admin/dashboard', isAdmin, async (req, res) => {
  try {
    const [[stats]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE role='member') AS members,
        (SELECT COUNT(*) FROM memberships WHERE status='active') AS active_memberships,
        (SELECT COUNT(*) FROM memberships WHERE status='active' AND end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)) AS expiring_7d,
        (SELECT COUNT(*) FROM attendance WHERE DATE(check_in)=CURDATE()) AS checkins_today,
        (SELECT IFNULL(SUM(p.price),0) FROM memberships m JOIN membership_plans p ON p.id=m.plan_id WHERE m.start_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) AS revenue_30d
    `);

    const [topMembers] = await pool.query(
      `SELECT u.name, COUNT(*) AS visits
       FROM attendance a
       JOIN users u ON u.id=a.user_id
       WHERE a.check_in >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY u.id
       ORDER BY visits DESC
       LIMIT 10`
    );

    const [upcomingExpiries] = await pool.query(
      `SELECT u.name, p.name AS plan_name, m.end_date
       FROM memberships m
       JOIN users u ON u.id=m.user_id
       JOIN membership_plans p ON p.id=m.plan_id
       WHERE m.status='active' AND m.end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)
       ORDER BY m.end_date ASC
       LIMIT 20`
    );

    const [latestMembers] = await pool.query(
      `SELECT id, name, email, is_active, created_at
       FROM users
       WHERE role='member'
       ORDER BY created_at DESC
       LIMIT 10`
    );

    res.render('admin_dashboard', { stats, topMembers, upcomingExpiries, latestMembers });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

// Admin: drill-down pages for clickable KPIs
app.get('/admin/memberships/active', isAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.id, u.name, u.email, p.name AS plan_name, m.start_date, m.end_date, m.status
       FROM memberships m
       JOIN users u ON u.id=m.user_id
       JOIN membership_plans p ON p.id=m.plan_id
       WHERE m.status='active'
       ORDER BY m.end_date ASC
       LIMIT 1000`
    );
    res.render('admin_memberships_active', { items: rows });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

app.get('/admin/memberships/expiring', isAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.id, u.name, u.email, p.name AS plan_name, m.start_date, m.end_date, m.status
       FROM memberships m
       JOIN users u ON u.id=m.user_id
       JOIN membership_plans p ON p.id=m.plan_id
       WHERE m.status='active'
         AND m.end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)
       ORDER BY m.end_date ASC
       LIMIT 1000`
    );
    res.render('admin_memberships_expiring', { items: rows });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

app.get('/admin/checkins/today', isAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.id, u.name, u.email, a.check_in, a.check_out, a.method
       FROM attendance a
       JOIN users u ON u.id=a.user_id
       WHERE DATE(a.check_in)=CURDATE()
       ORDER BY a.check_in DESC
       LIMIT 1000`
    );
    res.render('admin_checkins_today', { items: rows });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

// Admin: CSV export
app.get('/admin/export/attendance.csv', isAdmin, async (req, res) => {
  try {
    let { from, to } = req.query;
    if (!from || !to) {
      const d = new Date();
      const toY = d.getFullYear(), toM = String(d.getMonth() + 1).padStart(2, '0'), toD = String(d.getDate()).padStart(2, '0');
      to = `${toY}-${toM}-${toD}`;
      d.setDate(d.getDate() - 29);
      const frY = d.getFullYear(), frM = String(d.getMonth() + 1).padStart(2, '0'), frD = String(d.getDate()).padStart(2, '0');
      from = `${frY}-${frM}-${frD}`;
    }
    const [rows] = await pool.query(
      `SELECT u.name AS member, a.check_in, a.check_out, a.method
       FROM attendance a
       JOIN users u ON u.id=a.user_id
       WHERE DATE(a.check_in) BETWEEN ? AND ?
       ORDER BY a.check_in ASC`,
      [from, to]
    );
    const header = 'Member,Check In,Check Out,Method\r\n';
    const csv = rows
      .map((r) => {
        const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
        return [q(r.member), q(r.check_in), q(r.check_out), q(r.method)].join(',');
      })
      .join('\r\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${from}_to_${to}.csv"`);
    res.send(header + csv + '\r\n');
  } catch (e) {
    console.error(e);
    res.status(500).send('Export failed');
  }
});

// Admin: manage plans
app.get('/admin/plans', isAdmin, async (req, res) => {
  try {
    const [plans] = await pool.execute('SELECT * FROM membership_plans ORDER BY duration_days');
    const msg = req.query.msg || null;
    res.render('admin_plans_list', { plans, msg });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});
app.get('/admin/plans/new', isAdmin, (req, res) => {
  res.render('admins_plans_form', {
    mode: 'new',
    plan: { name: '', duration_days: '', price: '', description: '' },
    error: null,
  });
});
app.post('/admin/plans/new', isAdmin, async (req, res) => {
  try {
    const { name, duration_days, price, description } = req.body;
    if (!name || !duration_days || Number(duration_days) <= 0) {
      return res.render('admins_plans_form', {
        mode: 'new',
        plan: { name, duration_days, price, description },
        error: 'Name and positive duration are required',
      });
    }
    await pool.execute(
      'INSERT INTO membership_plans (name, duration_days, price, description) VALUES (?, ?, ?, ?)',
      [name.trim(), Number(duration_days), price ? Number(price) : 0, description || null]
    );
    res.redirect('/admin/plans?msg=Plan+created');
  } catch (e) {
    console.error(e);
    res.render('admins_plans_form', {
      mode: 'new',
      plan: req.body,
      error: 'Error creating plan (name might be duplicate)',
    });
  }
});
app.get('/admin/plans/:id/edit', isAdmin, async (req, res) => {
  try {
    const [[plan]] = await pool.execute('SELECT * FROM membership_plans WHERE id=?', [req.params.id]);
    if (!plan) return res.status(404).send('Plan not found');
    res.render('admins_plans_form', { mode: 'edit', plan, error: null });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});
app.post('/admin/plans/:id/edit', isAdmin, async (req, res) => {
  try {
    const { name, duration_days, price, description } = req.body;
    if (!name || !duration_days || Number(duration_days) <= 0) {
      const plan = { id: req.params.id, name, duration_days, price, description };
      return res.render('admins_plans_form', {
        mode: 'edit',
        plan,
        error: 'Name and positive duration are required',
      });
    }
    await pool.execute(
      'UPDATE membership_plans SET name=?, duration_days=?, price=?, description=? WHERE id=?',
      [name.trim(), Number(duration_days), price ? Number(price) : 0, description || null, req.params.id]
    );
    res.redirect('/admin/plans?msg=Plan+updated');
  } catch (e) {
    console.error(e);
    const plan = { id: req.params.id, ...req.body };
    res.render('admins_plans_form', { mode: 'edit', plan, error: 'Error updating plan' });
  }
});
app.post('/admin/plans/:id/delete', isAdmin, async (req, res) => {
  try {
    await pool.execute('DELETE FROM membership_plans WHERE id=?', [req.params.id]);
    res.redirect('/admin/plans?msg=Plan+deleted');
  } catch (e) {
    console.error(e);
    res.redirect('/admin/plans?msg=Delete+failed');
  }
});

// Admin: user management
app.get('/admin/users', isAdmin, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const status = req.query.status || 'all';
    const role = req.query.role || 'all';

    const where = [];
    const params = [];

    if (q) {
      where.push('(u.name LIKE ? OR u.email LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    if (status === 'active') where.push('u.is_active=1');
    else if (status === 'inactive') where.push('u.is_active=0');

    if (role === 'member' || role === 'admin') {
      where.push('u.role=?');
      params.push(role);
    }

    const sql = `
      SELECT u.id, u.name, u.email, u.role, u.phone, u.is_active, u.created_at, u.email_verified
      FROM users u
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY u.created_at DESC
      LIMIT 200
    `;
    const [users] = await pool.execute(sql, params);
    res.render('admin_users', {
      users, q, status, role, msg: req.query.msg || null
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});
app.post('/admin/users/:id/deactivate', isAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send('Invalid id');
  if (id === req.session.user.id) {
    return res.redirect('/admin/users?msg=Cannot+deactivate+yourself');
  }
  try {
    const [[target]] = await pool.execute('SELECT id, role, is_active FROM users WHERE id=?', [id]);
    if (!target) return res.redirect('/admin/users?msg=User+not+found');
    if (target.role !== 'member') return res.redirect('/admin/users?msg=Cannot+deactivate+admins');
    if (target.is_active === 0) return res.redirect('/admin/users?msg=Already+inactive');

    await pool.execute('UPDATE users SET is_active=0 WHERE id=?', [id]);
    res.redirect('/admin/users?msg=User+deactivated');
  } catch (e) {
    console.error(e);
    res.redirect('/admin/users?msg=Action+failed');
  }
});
app.post('/admin/users/:id/reactivate', isAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).send('Invalid id');
  try {
    const [[target]] = await pool.execute('SELECT id, role, is_active FROM users WHERE id=?', [id]);
    if (!target) return res.redirect('/admin/users?msg=User+not+found');
    if (target.role !== 'member') return res.redirect('/admin/users?msg=Cannot+modify+admins');
    if (target.is_active === 1) return res.redirect('/admin/users?msg=Already+active');

    await pool.execute('UPDATE users SET is_active=1 WHERE id=?', [id]);
    res.redirect('/admin/users?msg=User+reactivated');
  } catch (e) {
    console.error(e);
    res.redirect('/admin/users?msg=Action+failed');
  }
});

// Scheduler
const DAILY_RUN_HOUR = process.env.DAILY_RUN_HOUR ? Number(process.env.DAILY_RUN_HOUR) : 9;
let lastDailyRunKey = null;
const todayKey = (d = new Date()) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
async function activateExpireTasks() {
  await pool.execute(`UPDATE memberships SET status='active' WHERE status='pending' AND start_date <= CURDATE()`);
  await pool.execute(`UPDATE memberships SET status='expired' WHERE status='active' AND end_date < CURDATE()`);
}
async function dailyNotificationTasks() {
  const [expiring] = await pool.execute(
    `SELECT m.id, u.id AS user_id, p.name AS plan_name, m.end_date
     FROM memberships m
     JOIN users u ON u.id=m.user_id
     JOIN membership_plans p ON p.id=m.plan_id
     WHERE u.is_active=1 AND m.status='active' AND DATEDIFF(m.end_date, CURDATE()) IN (3,1,0)`
  );
  for (const row of expiring) {
    const [[recent]] = await pool.execute(
      `SELECT id FROM notifications
       WHERE user_id=? AND type='renewal' AND DATE(created_at)=CURDATE() LIMIT 1`,
      [row.user_id]
    );
    if (!recent) {
      await addNotification(
        row.user_id,
        'renewal',
        `Your ${row.plan_name} membership expires on ${row.end_date}. Consider renewing.`
      );
    }
  }
  const [members] = await pool.execute(`SELECT id FROM users WHERE role='member' AND is_active=1`);
  for (const u of members) {
    const [[count]] = await pool.execute(
      `SELECT COUNT(*) AS cnt FROM attendance WHERE user_id=? AND DATE(check_in) >= (CURDATE() - INTERVAL 7 DAY)`,
      [u.id]
    );
    if ((count?.cnt || 0) < 2) {
      const [[recent]] = await pool.execute(
        `SELECT id FROM notifications
         WHERE user_id=? AND type='attendance' AND created_at >= (NOW() - INTERVAL 7 DAY) LIMIT 1`,
        [u.id]
      );
      if (!recent) {
        await addNotification(u.id, 'attendance', 'We miss you! Try to visit at least twice this week.');
      }
    }
  }
  console.log('Daily notifications complete');
}
async function runHourlyTasks() {
  try {
    await activateExpireTasks();
    const now = new Date();
    const hour = now.getHours();
    const key = todayKey(now);
    if (hour >= DAILY_RUN_HOUR && lastDailyRunKey !== key) {
      await dailyNotificationTasks();
      lastDailyRunKey = key;
    }
  } catch (e) {
    console.error('Hourly tasks error:', e);
  }
}
app.get('/admin/run-daily', isAdmin, async (req, res) => {
  await activateExpireTasks();
  await dailyNotificationTasks();
  lastDailyRunKey = todayKey();
  res.redirect('/notifications');
});
cron.schedule('0 * * * *', () => {
  console.log('Cron: hourly tick');
  runHourlyTasks();
});

// Seed admin if none (verified)
(async () => {
  try {
    const [rows] = await pool.execute("SELECT id FROM users WHERE role='admin' LIMIT 1");
    if (!rows.length) {
      const hash = await bcrypt.hash('admin123', 10);
      await pool.execute(
        'INSERT INTO users (name, email, password_hash, role, email_verified) VALUES (?, ?, ?, ?, ?)',
        ['Admin', 'admin@gym.com', hash, 'admin', 1]
      );
      console.log('Seeded admin user: admin@gym.com / admin123');
    }
  } catch (e) {
    console.error('Admin seed error:', e);
  }
})();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Gym app running at http://127.0.0.1:${PORT}`));