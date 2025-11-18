// server.js — Sistema com roles, cadastro de usuários e recuperação de senha
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const PDFDocument = require('pdfkit');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 8080;
const DB_FILE = path.join(__dirname, 'database.sqlite');

// ---------- Basic setup ----------
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET || 'segredo-super-forte-123',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24*60*60*1000 } // 1d
}));

app.use((req, res, next) => { res.locals.session = req.session; next(); });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// ---------- Database ----------
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) return console.error('DB error:', err);
  console.log('SQLite conectado em', DB_FILE);
});

db.serialize(() => {
  // equipamentos, ordens (existentes)
  db.run(`CREATE TABLE IF NOT EXISTS equipamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT, codigo TEXT, local TEXT, descricao TEXT, imagem TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS ordens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    equipamento_id INTEGER, solicitante TEXT, tipo TEXT, descricao TEXT,
    status TEXT DEFAULT 'aberta', aberta_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    fechada_em DATETIME, resultado TEXT
  )`);
  // users table
  db.run(`CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT UNIQUE,
    senha TEXT,
    nome TEXT,
    role TEXT DEFAULT 'funcionario' -- admin | funcionario | operador
  )`);
  // password reset tokens
  db.run(`CREATE TABLE IF NOT EXISTS password_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER,
    token TEXT,
    expires_at DATETIME
  )`);
});

// ---------- Helpers (promises) ----------
const runAsync = (sql, p=[]) => new Promise((ok, err)=> db.run(sql,p,function(e){ e?err(e):ok(this) }));
const allAsync = (sql, p=[]) => new Promise((ok, err)=> db.all(sql,p,(e,r)=> e?err(e):ok(r) ));
const getAsync = (sql, p=[]) => new Promise((ok, err)=> db.get(sql,p,(e,r)=> e?err(e):ok(r) ));

// ---------- Uploads ----------
const uploadsDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, cb){ cb(null, uploadsDir); },
  filename(req, file, cb){
    const unique = Date.now() + "-" + Math.round(Math.random()*1e9);
    cb(null, file.fieldname + "-" + unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// ---------- Mailer setup (optional) ----------
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
} else {
  console.log('Aviso: SMTP não configurado. Links de reset serão exibidos no console.');
}

// ---------- Auth middlewares ----------
function authRequired(req, res, next) {
  if (!req.session.usuario) return res.redirect('/login');
  next();
}
function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.usuario) return res.redirect('/login');
    const userRole = req.session.role;
    if (userRole === 'admin') return next(); // admin can do everything
    if (Array.isArray(role) ? role.includes(userRole) : userRole === role) return next();
    return res.status(403).send('Acesso negado.');
  };
}

// ---------- LOGIN / LOGOUT / REGISTER (admin) ----------

// Render login
app.get('/login', (req, res) => {
  res.render('login', { layout: false, error: null });
});

// Handle login
app.post('/login', async (req, res) => {
  const { usuario, senha } = req.body;
  try {
    const row = await getAsync('SELECT * FROM usuarios WHERE usuario=?', [usuario]);
    if (!row) return res.render('login', { layout: false, error: 'Usuário ou senha incorretos' });

    const match = await bcrypt.compare(senha, row.senha);
    if (!match) return res.render('login', { layout: false, error: 'Usuário ou senha incorretos' });

    // set session
    req.session.usuario = row.usuario;
    req.session.userId = row.id;
    req.session.role = row.role;
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.render('login', { layout: false, error: 'Erro interno' });
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(()=> res.redirect('/login'));
});

// ---------- USERS ADMIN CRUD (only admin) ----------
app.get('/users', authRequired, requireRole('admin'), async (req, res) => {
  const users = await allAsync('SELECT id, usuario, nome, role FROM usuarios ORDER BY id DESC');
  res.render('users', { users });
});

app.get('/users/new', authRequired, requireRole('admin'), (req, res) => {
  res.render('users_new', { error: null });
});

app.post('/users/new', authRequired, requireRole('admin'), async (req, res) => {
  const { usuario, senha, nome, role } = req.body;
  if (!usuario || !senha) return res.render('users_new', { error: 'Preencha usuário e senha' });
  try {
    const hashed = await bcrypt.hash(senha, 10);
    await runAsync('INSERT INTO usuarios (usuario, senha, nome, role) VALUES (?,?,?,?)', [usuario, hashed, nome||usuario, role||'funcionario']);
    res.redirect('/users');
  } catch (err) {
    console.error(err);
    let message = 'Erro ao criar usuário';
    if (err && err.message && err.message.includes('UNIQUE')) message = 'Usuário já existe';
    res.render('users_new', { error: message });
  }
});

app.get('/users/:id/edit', authRequired, requireRole('admin'), async (req, res) => {
  const user = await getAsync('SELECT id, usuario, nome, role FROM usuarios WHERE id=?', [req.params.id]);
  if (!user) return res.redirect('/users');
  res.render('users_edit', { user, error: null });
});

app.post('/users/:id/edit', authRequired, requireRole('admin'), async (req, res) => {
  const { nome, role } = req.body;
  await runAsync('UPDATE usuarios SET nome=?, role=? WHERE id=?', [nome, role, req.params.id]);
  res.redirect('/users');
});

app.post('/users/:id/delete', authRequired, requireRole('admin'), async (req, res) => {
  if (parseInt(req.params.id,10) === req.session.userId) return res.status(400).send('Não pode excluir o próprio usuário');
  await runAsync('DELETE FROM usuarios WHERE id=?', [req.params.id]);
  res.redirect('/users');
});

// ---------- Password reset (forgot / reset) ----------
app.get('/forgot', (req, res) => {
  res.render('forgot', { error: null, info: null });
});

app.post('/forgot', async (req, res) => {
  const { usuario } = req.body;
  try {
    const user = await getAsync('SELECT id, usuario FROM usuarios WHERE usuario=?', [usuario]);
    if (!user) return res.render('forgot', { error: 'Usuário não encontrado', info: null });

    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 60*60*1000).toISOString(); // 1h
    await runAsync('INSERT INTO password_tokens (usuario_id, token, expires_at) VALUES (?,?,?)', [user.id, token, expiresAt]);

    const resetUrl = `${process.env.BASE_URL || ('http://'+(process.env.HOST || 'localhost') + ':' + (process.env.PORT || PORT))}/reset/${token}`;

    // send email if transporter configured, else print on console
    if (transporter) {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || 'no-reply@example.com',
        to: user.usuario,
        subject: 'Recuperação de senha - Sistema Manutenção',
        text: `Use esse link para recuperar sua senha: ${resetUrl}`,
        html: `<p>Use esse link para recuperar sua senha:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`
      });
      res.render('forgot', { error: null, info: 'E-mail de recuperação enviado (verifique sua caixa)' });
    } else {
      // print to console for dev / railway
      console.log('Password reset link:', resetUrl);
      res.render('forgot', { error: null, info: 'Link de recuperação gerado (verifique o console do servidor)' });
    }
  } catch (err) {
    console.error(err);
    res.render('forgot', { error: 'Erro interno', info: null });
  }
});

app.get('/reset/:token', (req, res) => {
  res.render('reset', { token: req.params.token, error: null });
});

app.post('/reset/:token', async (req, res) => {
  const { token } = req.params;
  const { senha } = req.body;
  try {
    const row = await getAsync('SELECT usuario_id, expires_at FROM password_tokens WHERE token = ?', [token]);
    if (!row) return res.render('reset', { token, error: 'Token inválido' });

    if (new Date(row.expires_at) < new Date()) {
      return res.render('reset', { token, error: 'Token expirado' });
    }

    const hashed = await bcrypt.hash(senha, 10);
    await runAsync('UPDATE usuarios SET senha = ? WHERE id = ?', [hashed, row.usuario_id]);
    await runAsync('DELETE FROM password_tokens WHERE token = ?', [token]);

    res.send('Senha atualizada. Você pode <a href="/login">entrar</a>.');
  } catch (err) {
    console.error(err);
    res.render('reset', { token, error: 'Erro interno' });
  }
});

// ---------- PROTECT existing routes (example: protect all routes except login/forgot/reset) ----------
app.use(['/','/equipamentos','/ordens','/users','/users/*','/equipamentos/*','/ordens/*'], (req,res,next) => {
  // allow login, forgot, reset, static files
  const openPaths = ['/login','/forgot','/reset'];
  if (openPaths.some(p=>req.path.startsWith(p))) return next();
  if (!req.session.usuario) return res.redirect('/login');
  next();
});

// ---------- DASHBOARD + existing CRUD routes (unchanged logic, but protected) ----------

// Dashboard
app.get('/', async (req, res) => {
  try {
    const totalEquip = await getAsync(`SELECT COUNT(*) c FROM equipamentos`);
    const totalAbertas = await getAsync(`SELECT COUNT(*) c FROM ordens WHERE status='aberta'`);
    const totalFechadas = await getAsync(`SELECT COUNT(*) c FROM ordens WHERE status='fechada'`);

    const ultimas = await allAsync(`
      SELECT o.id, o.tipo, e.nome AS equipamento_nome
      FROM ordens o
      LEFT JOIN equipamentos e ON e.id = o.equipamento_id
      ORDER BY o.aberta_em DESC
      LIMIT 5
    `);

    const tipos = await allAsync(`
      SELECT tipo, COUNT(*) c
      FROM ordens GROUP BY tipo
    `);

    res.render('admin/dashboard', {
      active: 'dashboard',
      totals: {
        equipamentos: totalEquip.c || 0,
        abertas: totalAbertas.c || 0,
        fechadas: totalFechadas.c || 0
      },
      ultimas,
      tipos: {
        labels: tipos.map(t => t.tipo || '—'),
        valores: tipos.map(t => t.c || 0)
      }
    });

  } catch (err) {
    console.error(err);
    res.send('Erro no dashboard');
  }
});

// ... (rest of your equipment/order routes remain the same)
// For brevity, re-use the routes you already had for equipamentos and ordens (they will work because we protected via middleware above).
// If you want, I can paste them again (they were provided earlier).

// ---------- START ----------
app.listen(PORT, () => console.log('Servidor ativo na porta', PORT));
