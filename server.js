// server.js — PARTE 1/4
// Sistema de Manutenção — Configuração inicial, DB, helpers, auth, rotas públicas
// Requer: express, express-ejs-layouts, express-session, ejs, sqlite3, multer, pdfkit, bcrypt, nodemailer, uuid, qrcode

const path = require('path');
const fs = require('fs');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const PDFDocument = require('pdfkit');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const ejs = require('ejs');

// -------------------------- CONFIGURAÇÕES GERAIS --------------------------
const app = express();
const PORT = process.env.PORT || 8080;
const DB_FILE = path.join(__dirname, 'database.sqlite');

// Public (static), body parser
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Trust proxy (Heroku / Railway) — configura cookie secure se for HTTPS
app.set('trust proxy', 1);

// -------------------------- SESSÃO --------------------------
app.use(session({
  secret: process.env.SESSION_SECRET || 'segredo-super-forte-123',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: (process.env.COOKIE_SECURE === 'true') || false,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Expor sessão e variáveis padrão para views (evita undefined no layout)
app.use((req, res, next) => {
  res.locals.session = req.session;
  res.locals.error = null;
  next();
});

// -------------------------- VIEW ENGINE --------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout'); // default layout ejs/layout.ejs

// -------------------------- UPLOADS (Multer) --------------------------
const uploadsDir = path.join(__dirname, 'public', 'uploads');
try {
  if (fs.existsSync(uploadsDir) && !fs.lstatSync(uploadsDir).isDirectory()) {
    fs.unlinkSync(uploadsDir);
  }
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
} catch (e) {
  console.error("Erro ao garantir uploads dir:", e);
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, uploadsDir);
  },
  filename(req, file, cb) {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const safeName = file.fieldname + '-' + unique + path.extname(file.originalname);
    cb(null, safeName);
  }
});
const upload = multer({ storage });

// -------------------------- MAILER (opcional) --------------------------
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

// -------------------------- BANCO DE DADOS (SQLite) --------------------------
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) return console.error('Erro ao conectar no SQLite:', err);
  console.log('SQLite conectado em', DB_FILE);
});

// Criação das tabelas principais
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT UNIQUE,
      senha TEXT,
      nome TEXT,
      role TEXT DEFAULT 'funcionario',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS password_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER,
      token TEXT,
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS equipamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      codigo TEXT,
      local TEXT,
      descricao TEXT,
      imagem TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ordens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipamento_id INTEGER,
      solicitante TEXT,
      tipo TEXT,
      descricao TEXT,
      status TEXT DEFAULT 'aberta',
      aberta_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      fechada_em DATETIME,
      resultado TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS os_fotos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      os_id INTEGER,
      caminho TEXT,
      tipo TEXT,          -- 'abertura' ou 'fechamento'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS correias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      modelo TEXT,
      medida TEXT,
      quantidade INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS correias_equipamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipamento_id INTEGER,
      correia_id INTEGER,
      quantidade_usada INTEGER DEFAULT 1
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS consumo_correias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipamento_id INTEGER,
      correia_id INTEGER,
      quantidade INTEGER,
      data DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
});

// -------------------------- DB HELPERS (async) --------------------------
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}
function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}
function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

// -------------------------- SEED (executa seed.js automaticamente se presente) --------------------------
if (fs.existsSync(path.join(__dirname, 'seed.js'))) {
  try {
    console.log('➡ Executando seed.js automaticamente...');
    require('./seed.js');
    setTimeout(() => {
      try {
        fs.unlinkSync(path.join(__dirname, 'seed.js'));
        console.log('✔ seed.js executado e removido.');
      } catch (e) {
        console.log('Erro ao remover seed.js:', e);
      }
    }, 1500);
  } catch (e) {
    console.error('Erro executando seed.js:', e);
  }
}

// -------------------------- AUTH / ROLES MIDDLEWARES --------------------------
function authRequired(req, res, next) {
  if (!req.session.usuario) return res.redirect('/login');
  next();
}

/**
 * allowRoles(...roles)
 * - admin sempre permite
 * - roles é lista com 'funcionario', 'operador', etc.
 */
function allowRoles(...roles) {
  return (req, res, next) => {
    const r = req.session.role;
    if (!r) return res.redirect('/login');
    if (r === 'admin') return next();
    if (roles.includes(r)) return next();
    return res.status(403).send('Acesso negado.');
  };
}

// -------------------------- ROTAS PÚBLICAS / AUTENTICAÇÃO --------------------------

// Rota de entrada pública (sem layout padrão)
app.get('/inicio', (req, res) => res.render('inicio', { layout: false }));

// Login: mostrar formulário
app.get('/login', (req, res) => {
  res.render('login', { layout: false, error: null });
});

// Login: autenticar
app.post('/login', async (req, res) => {
  const { usuario, senha } = req.body;
  try {
    const user = await getAsync(`SELECT * FROM usuarios WHERE usuario = ?`, [usuario]);
    if (!user) return res.render('login', { layout: false, error: 'Usuário ou senha incorretos.' });

    const match = await bcrypt.compare(senha, user.senha);
    if (!match) return res.render('login', { layout: false, error: 'Usuário ou senha incorretos.' });

    req.session.usuario = user.usuario;
    req.session.userId = user.id;
    req.session.role = user.role;

    return res.redirect('/');
  } catch (err) {
    console.error(err);
    return res.render('login', { layout: false, error: 'Erro interno.' });
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Forgot password: form
app.get('/forgot', (req, res) => res.render('forgot', { layout: false, error: null, info: null }));

// Forgot password: gerar token e enviar por email (ou console)
app.post('/forgot', async (req, res) => {
  const { usuario } = req.body;
  try {
    const user = await getAsync(`SELECT id, usuario FROM usuarios WHERE usuario = ?`, [usuario]);
    if (!user) return res.render('forgot', { layout: false, error: 'Usuário não encontrado.', info: null });

    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await runAsync(`INSERT INTO password_tokens (usuario_id, token, expires_at) VALUES (?, ?, ?)`, [user.id, token, expiresAt]);

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.headers.host}`;
    const resetUrl = `${baseUrl}/reset/${token}`;

    if (transporter) {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || 'no-reply@sistema.com',
        to: user.usuario,
        subject: 'Recuperar senha - Sistema',
        html: `<p>Clique para resetar a senha: <a href="${resetUrl}">${resetUrl}</a></p>`
      });
      return res.render('forgot', { layout: false, error: null, info: 'E-mail enviado! Verifique sua caixa.' });
    }

    // Fallback: mostrar link no console e informar ao usuário
    console.log('Link de recuperação (console):', resetUrl);
    return res.render('forgot', { layout: false, error: null, info: 'Link gerado (verifique o console do servidor).' });
  } catch (err) {
    console.error(err);
    return res.render('forgot', { layout: false, error: 'Erro interno.', info: null });
  }
});

// Reset password: form
app.get('/reset/:token', (req, res) => {
  res.render('reset', { layout: false, token: req.params.token, error: null });
});

// Reset password: aplicar a nova senha
app.post('/reset/:token', async (req, res) => {
  const { token } = req.params;
  const { senha } = req.body;
  try {
    const row = await getAsync(`SELECT usuario_id, expires_at FROM password_tokens WHERE token = ?`, [token]);
    if (!row) return res.render('reset', { layout: false, token, error: 'Token inválido.' });
    if (new Date(row.expires_at) < new Date()) return res.render('reset', { layout: false, token, error: 'Token expirado.' });

    const hashed = await bcrypt.hash(senha, 10);
    await runAsync(`UPDATE usuarios SET senha = ? WHERE id = ?`, [hashed, row.usuario_id]);
    await runAsync(`DELETE FROM password_tokens WHERE token = ?`, [token]);

    return res.send(`<h2>Senha atualizada com sucesso!</h2><a href="/login">Ir para login</a>`);
  } catch (err) {
    console.error(err);
    return res.render('reset', { layout: false, token, error: 'Erro interno.' });
  }
});

// -------------------------- FIM PARTE 1/4 --------------------------
// Peça a Parte 2 para continuar (Usuários/Equipamentos/Correias/OS/...).
// server.js — PARTE 2/4
// Usuários (admin), Equipamentos, Correias, Associação e Baixas
// COLE esta parte imediatamente após a Parte 1/4

// =======================
// ROTAS: USERS (ADMIN)
// =======================
app.use('/users', authRequired, allowRoles('admin'));

app.get('/users', async (req, res) => {
  try {
    const users = await allAsync(`SELECT id, usuario, nome, role, created_at FROM usuarios ORDER BY id DESC`);
    res.render('users', { users, active: 'users' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao listar usuários.');
  }
});

app.get('/users/new', (req, res) => res.render('users_new', { error: null, active: 'users' }));

app.post('/users/new', async (req, res) => {
  const { usuario, senha, nome, role } = req.body;
  try {
    if (!usuario || !senha) return res.render('users_new', { error: 'Usuário e senha são obrigatórios.' });
    const hashed = await bcrypt.hash(senha, 10);
    await runAsync(`INSERT INTO usuarios (usuario, senha, nome, role) VALUES (?, ?, ?, ?)`, [usuario, hashed, nome || usuario, role || 'funcionario']);
    res.redirect('/users');
  } catch (err) {
    console.error(err);
    const msg = err.message && err.message.includes('UNIQUE') ? 'Este usuário já existe.' : 'Erro ao criar usuário.';
    res.render('users_new', { error: msg, active: 'users' });
  }
});

app.get('/users/:id/edit', async (req, res) => {
  try {
    const user = await getAsync(`SELECT id, usuario, nome, role FROM usuarios WHERE id = ?`, [req.params.id]);
    if (!user) return res.redirect('/users');
    res.render('users_edit', { user, error: null, active: 'users' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao carregar usuário.');
  }
});

app.post('/users/:id/edit', async (req, res) => {
  const { nome, role } = req.body;
  try {
    await runAsync(`UPDATE usuarios SET nome = ?, role = ? WHERE id = ?`, [nome, role, req.params.id]);
    res.redirect('/users');
  } catch (err) {
    console.error(err);
    res.send('Erro ao atualizar usuário.');
  }
});

app.post('/users/:id/delete', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.session.userId) return res.status(400).send('Você não pode excluir seu próprio usuário.');
    await runAsync(`DELETE FROM usuarios WHERE id = ?`, [id]);
    res.redirect('/users');
  } catch (err) {
    console.error(err);
    res.send('Erro ao excluir usuário.');
  }
});

// =======================
// ROTAS: EQUIPAMENTOS
// =======================
app.use('/equipamentos', authRequired, allowRoles('admin', 'funcionario'));

app.get('/equipamentos', async (req, res) => {
  try {
    const equipamentos = await allAsync(`SELECT * FROM equipamentos ORDER BY created_at DESC`);
    res.render('equipamentos', { equipamentos, active: 'equipamentos' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao listar equipamentos.');
  }
});

app.get('/equipamentos/novo', (req, res) => res.render('equipamentos_novo', { equipamento: null, active: 'equipamentos' }));

app.post('/equipamentos', upload.single('imagem'), async (req, res) => {
  try {
    const { nome, codigo, local, descricao } = req.body;
    const imagem = req.file ? path.join('uploads', req.file.filename) : null;
    await runAsync(`INSERT INTO equipamentos (nome, codigo, local, descricao, imagem) VALUES (?, ?, ?, ?, ?)`, [nome, codigo, local, descricao, imagem]);
    res.redirect('/equipamentos');
  } catch (err) {
    console.error(err);
    res.send('Erro ao criar equipamento.');
  }
});

app.get('/equipamentos/:id/editar', async (req, res) => {
  try {
    const equipamento = await getAsync(`SELECT * FROM equipamentos WHERE id = ?`, [req.params.id]);
    if (!equipamento) return res.send('Equipamento não encontrado.');
    res.render('equipamentos_novo', { equipamento, active: 'equipamentos' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao carregar formulário.');
  }
});

app.post('/equipamentos/:id', upload.single('imagem'), async (req, res) => {
  try {
    const id = req.params.id;
    const { nome, codigo, local, descricao } = req.body;
    const equipamento = await getAsync(`SELECT * FROM equipamentos WHERE id = ?`, [id]);
    if (!equipamento) return res.send('Equipamento não encontrado.');

    let novaImagem = equipamento.imagem;
    if (req.file) {
      if (novaImagem) {
        const oldPath = path.join(__dirname, 'public', novaImagem);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      novaImagem = path.join('uploads', req.file.filename);
    }

    await runAsync(`UPDATE equipamentos SET nome=?, codigo=?, local=?, descricao=?, imagem=? WHERE id=?`, [nome, codigo, local, descricao, novaImagem, id]);
    res.redirect('/equipamentos');
  } catch (err) {
    console.error(err);
    res.send('Erro ao atualizar o equipamento.');
  }
});

app.post('/equipamentos/:id/delete', async (req, res) => {
  try {
    const id = req.params.id;
    const equipamento = await getAsync(`SELECT * FROM equipamentos WHERE id = ?`, [id]);
    if (!equipamento) return res.send('Equipamento não encontrado.');
    if (equipamento.imagem) {
      const imgPath = path.join(__dirname, 'public', equipamento.imagem);
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    }
    await runAsync(`DELETE FROM equipamentos WHERE id = ?`, [id]);
    res.redirect('/equipamentos');
  } catch (err) {
    console.error(err);
    res.send('Erro ao deletar equipamento.');
  }
});

// QR CODE do equipamento (mostrar página com QR)
app.get('/equipamentos/:id/qrcode', async (req, res) => {
  try {
    const equipamento = await getAsync(`SELECT * FROM equipamentos WHERE id = ?`, [req.params.id]);
    if (!equipamento) return res.send('Equipamento não encontrado.');

    // Base URL sem forçar HTTPS (melhor para containers)
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.headers.host}`;
    const url = `${baseUrl}/equipamentos/${equipamento.id}/menu`;
    const qr = await QRCode.toDataURL(url);

    res.render('equipamento_qr', { equipamento, qr, url, active: 'equipamentos' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao gerar QR Code.');
  }
});

// MENU DO EQUIPAMENTO (acessado via QR)
app.get('/equipamentos/:id/menu', authRequired, async (req, res) => {
  try {
    const equipamento = await getAsync(`SELECT * FROM equipamentos WHERE id = ?`, [req.params.id]);
    if (!equipamento) return res.send("Equipamento não encontrado.");
    res.render('equipamento_menu', { equipamento, active: 'equipamentos' });
  } catch (err) {
    console.error(err);
    res.send("Erro ao carregar menu do equipamento.");
  }
});

// HISTÓRICO DO EQUIPAMENTO (OS + consumo de correias)
app.get('/equipamentos/:id/historico', authRequired, async (req, res) => {
  try {
    const id = req.params.id;
    const equipamento = await getAsync(`SELECT * FROM equipamentos WHERE id = ?`, [id]);
    if (!equipamento) return res.send("Equipamento não encontrado.");

    const ordens = await allAsync(`
      SELECT id, tipo, status, aberta_em, fechada_em, resultado
      FROM ordens
      WHERE equipamento_id = ?
      ORDER BY aberta_em DESC
    `, [id]);

    const correias = await allAsync(`
      SELECT c.nome AS correia, cc.quantidade, cc.data
      FROM consumo_correias cc
      LEFT JOIN correias c ON c.id = cc.correia_id
      WHERE cc.equipamento_id = ?
      ORDER BY cc.data DESC
    `, [id]);

    res.render('equipamento_historico', { equipamento, ordens, correias, active: 'equipamentos' });
  } catch (err) {
    console.error(err);
    res.send("Erro ao carregar histórico.");
  }
});

// =======================
// ROTAS: CORREIAS (ESTOQUE)
// =======================
app.use('/correias', authRequired, allowRoles('admin', 'funcionario'));

app.get('/correias', async (req, res) => {
  try {
    const correias = await allAsync(`SELECT * FROM correias ORDER BY nome`);
    res.render('correias', { correias, active: 'correias' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao listar correias.');
  }
});

app.get('/correias/novo', (req, res) => res.render('correias_novo', { correia: null, active: 'correias', error: null }));

app.post('/correias/novo', async (req, res) => {
  try {
    const { nome, modelo, medida, quantidade } = req.body;
    await runAsync(`INSERT INTO correias (nome, modelo, medida, quantidade) VALUES (?, ?, ?, ?)`, [nome, modelo, medida, parseInt(quantidade || 0, 10)]);
    res.redirect('/correias');
  } catch (err) {
    console.error(err);
    res.send('Erro ao criar correia.');
  }
});

app.get('/correias/:id/editar', async (req, res) => {
  try {
    const correia = await getAsync(`SELECT * FROM correias WHERE id = ?`, [req.params.id]);
    if (!correia) return res.redirect('/correias');
    res.render('correias_novo', { correia, active: 'correias', error: null });
  } catch (err) {
    console.error(err);
    res.send('Erro ao carregar correia.');
  }
});

app.post('/correias/:id/editar', async (req, res) => {
  try {
    const { nome, modelo, medida, quantidade } = req.body;
    await runAsync(`UPDATE correias SET nome=?, modelo=?, medida=?, quantidade=? WHERE id=?`, [nome, modelo, medida, parseInt(quantidade || 0, 10), req.params.id]);
    res.redirect('/correias');
  } catch (err) {
    console.error(err);
    res.send('Erro ao atualizar correia.');
  }
});

app.post('/correias/:id/delete', async (req, res) => {
  try {
    await runAsync(`DELETE FROM correias WHERE id = ?`, [req.params.id]);
    res.redirect('/correias');
  } catch (err) {
    console.error(err);
    res.send('Erro ao deletar correia.');
  }
});

// =======================
// ASSOCIAÇÃO Correias <-> Equipamento
// =======================
app.get('/equipamentos/:id/correias', authRequired, allowRoles('admin', 'funcionario'), async (req, res) => {
  try {
    const equipamento = await getAsync(`SELECT * FROM equipamentos WHERE id = ?`, [req.params.id]);
    if (!equipamento) return res.send('Equipamento não encontrado.');
    const correias = await allAsync(`SELECT * FROM correias ORDER BY nome`);
    const ligados = await allAsync(`SELECT correia_id, quantidade_usada FROM correias_equipamentos WHERE equipamento_id = ?`, [req.params.id]);
    const mapLigados = {};
    ligados.forEach(l => mapLigados[l.correia_id] = l.quantidade_usada);
    res.render('equipamento_correias', { equipamento, correias, mapLigados, active: 'equipamentos' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao carregar associação de correias.');
  }
});

app.post('/equipamentos/:id/correias', authRequired, allowRoles('admin', 'funcionario'), async (req, res) => {
  try {
    const equipamento_id = req.params.id;
    const correiaIds = Array.isArray(req.body.correia) ? req.body.correia : (req.body.correia ? [req.body.correia] : []);
    await runAsync(`DELETE FROM correias_equipamentos WHERE equipamento_id = ?`, [equipamento_id]);
    for (const cid of correiaIds) {
      const q = parseInt(req.body[`qtd_${cid}`] || 1, 10);
      await runAsync(`INSERT INTO correias_equipamentos (equipamento_id, correia_id, quantidade_usada) VALUES (?, ?, ?)`, [equipamento_id, cid, q]);
    }
    res.redirect('/equipamentos/' + equipamento_id);
  } catch (err) {
    console.error(err);
    res.send('Erro ao salvar associações.');
  }
});

// =======================
// BAIXA / CONSUMO DE CORREIAS
// =======================

// Mostrar formulário de baixa para um equipamento
app.get('/equipamentos/:id/baixar', authRequired, allowRoles('admin', 'funcionario'), async (req, res) => {
  try {
    const equipamento = await getAsync(`SELECT * FROM equipamentos WHERE id = ?`, [req.params.id]);
    if (!equipamento) return res.send('Equipamento não encontrado.');
    const correias = await allAsync(`SELECT * FROM correias ORDER BY nome`);
    res.render('equipamentos_baixar', { equipamento, correias, active: 'equipamentos' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao abrir formulário de baixa.');
  }
});

// Helper para registrar consumo e abater estoque
async function registrarConsumoCorreia(equipamento_id, correia_id, quantidade) {
  await runAsync(`UPDATE correias SET quantidade = quantidade - ? WHERE id = ?`, [quantidade, correia_id]);
  await runAsync(`INSERT INTO consumo_correias (equipamento_id, correia_id, quantidade) VALUES (?, ?, ?)`, [equipamento_id, correia_id, quantidade]);
}

// Rota de baixa – debita estoque e registra histórico
app.post('/equipamentos/:id/baixar-correia', authRequired, allowRoles('admin', 'funcionario'), async (req, res) => {
  try {
    const equipamento_id = req.params.id;
    const correia_id = parseInt(req.body.correia_id, 10);
    const quantidade = parseInt(req.body.quantidade, 10);

    if (!correia_id || !quantidade || quantidade <= 0) return res.send('Quantidade inválida.');
    const correia = await getAsync(`SELECT * FROM correias WHERE id = ?`, [correia_id]);
    if (!correia) return res.send('Correia não encontrada.');
    if (correia.quantidade < quantidade) return res.send('Estoque insuficiente. Atualize o estoque antes.');

    await registrarConsumoCorreia(equipamento_id, correia_id, quantidade);
    res.redirect('/equipamentos/' + equipamento_id);
  } catch (err) {
    console.error(err);
    res.send('Erro ao debitar correia.');
  }
});

// =======================
// RELATÓRIO DE CONSUMO (HTML) E PDF (render EJS -> PDF)
// =======================
app.get('/correias/relatorio', authRequired, allowRoles('admin', 'funcionario'), async (req, res) => {
  try {
    const mes = req.query.mes || (new Date()).toISOString().slice(0,7);
    const rel = await allAsync(`
      SELECT e.nome AS equipamento, c.nome AS correia, SUM(cc.quantidade) AS total
      FROM consumo_correias cc
      LEFT JOIN equipamentos e ON e.id = cc.equipamento_id
      LEFT JOIN correias c ON c.id = cc.correia_id
      WHERE strftime('%Y-%m', cc.data) = ?
      GROUP BY equipamento, correia
      ORDER BY equipamento, correia
    `, [mes]);
    res.render('relatorio_correias', { rel, mes, active: 'correias' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao gerar relatório.');
  }
});

// PDF do relatório (EJS -> HTML -> PDF)
app.get('/correias/relatorio/pdf', authRequired, async (req, res) => {
  try {
    const mes = req.query.mes || new Date().toISOString().slice(0,7);
    const rel = await allAsync(`
      SELECT e.nome AS equipamento, c.nome AS correia, SUM(cc.quantidade) AS total
      FROM consumo_correias cc
      LEFT JOIN equipamentos e ON e.id = cc.equipamento_id
      LEFT JOIN correias c ON c.id = cc.correia_id
      WHERE strftime('%Y-%m', cc.data) = ?
      GROUP BY equipamento, correia
      ORDER BY equipamento, correia
    `, [mes]);

    // Renderiza HTML via EJS (views/correias_relatorio_pdf.ejs)
    const htmlPath = path.join(__dirname, 'views', 'correias_relatorio_pdf.ejs');
    const html = await ejs.renderFile(htmlPath, { rel, mes });

    // Gerar PDF simples a partir do HTML gerado (usamos PDFKit para texto)
    // OBS: aqui apenas incluímos o HTML convertido de forma simples — para layouts complexos
    // pode-se usar puppeteer wkhtmltopdf em produção.
    const doc = new PDFDocument({ size: 'A4', margin: 28 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=relatorio_correias.pdf');
    doc.pipe(res);

    doc.fontSize(20).text('Relatório de Consumo de Correias', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Mês: ${mes}`);
    doc.moveDown();

    if (rel.length === 0) {
      doc.text('Nenhum consumo registrado neste mês.', { align: 'center' });
    } else {
      rel.forEach(r => {
        doc.fontSize(13).text(`Equipamento: ${r.equipamento || '—'}`);
        doc.fontSize(12).text(`Correia: ${r.correia} — Quantidade: ${r.total}`);
        doc.moveDown(0.5);
      });
    }

    doc.end();
  } catch (err) {
    console.error('PDF ERROR:', err);
    res.status(500).send('Erro ao gerar PDF.');
  }
});

// -------------------------- FIM PARTE 2/4 --------------------------
// Peça "Parte 3" para continuar (Ordens de Serviço, fotos, PDF OS, deletar fotos, etc.).
// server.js — PARTE 3/4
// Rotas de ORDENS DE SERVIÇO (OS), fotos, fechamento e PDF

// -------------------------------------------------------
// Middleware global para todas as rotas de ordens
// -------------------------------------------------------
app.use('/ordens', authRequired, allowRoles('admin', 'funcionario', 'operador'));

// -------------------------------------------------------
// LISTAR ORDENS
// - operador: vê somente as próprias
// - admin/funcionário: veem todas
// -------------------------------------------------------
app.get('/ordens', async (req, res) => {
  try {
    let ordens;

    if (req.session.role === 'operador') {
      ordens = await allAsync(`
        SELECT o.*, e.nome AS equipamento_nome
        FROM ordens o
        LEFT JOIN equipamentos e ON e.id = o.equipamento_id
        WHERE o.solicitante = ?
        ORDER BY o.aberta_em DESC
      `, [req.session.usuario]);
    } else {
      ordens = await allAsync(`
        SELECT o.*, e.nome AS equipamento_nome
        FROM ordens o
        LEFT JOIN equipamentos e ON e.id = o.equipamento_id
        ORDER BY o.aberta_em DESC
      `);
    }

    res.render('ordens', { ordens, active: 'ordens' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao listar ordens.');
  }
});

// -------------------------------------------------------
// FORM — ABRIR OS
// -------------------------------------------------------
app.get('/ordens/novo', async (req, res) => {
  try {
    const equipamentos = await allAsync(`SELECT id, nome FROM equipamentos ORDER BY nome ASC`);
    res.render('os_nova', { equipamentos, active: 'ordens' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao abrir formulário de OS.');
  }
});


// -------------------------------------------------------
// CRIAR OS (com fotos de abertura)
// -------------------------------------------------------
app.post('/ordens', upload.array('fotos', 10), async (req, res) => {
  try {
    const { equipamento_id, tipo, descricao } = req.body;
    const solicitante = req.session.usuario;

    const result = await runAsync(`
      INSERT INTO ordens (equipamento_id, solicitante, tipo, descricao, status)
      VALUES (?, ?, ?, ?, 'aberta')
    `, [equipamento_id || null, solicitante, tipo, descricao]);

    const osId = result.lastID;

    // Fotos de abertura
    if (req.files && req.files.length > 0) {
      for (const foto of req.files) {
        await runAsync(`
          INSERT INTO os_fotos (os_id, caminho, tipo)
          VALUES (?, ?, 'abertura')
        `, [osId, path.join('uploads', foto.filename)]);
      }
    }

    res.redirect('/ordens');
  } catch (err) {
    console.error(err);
    res.send('Erro ao criar OS.');
  }
});

// -------------------------------------------------------
// DELETAR UMA FOTO DA OS
// -------------------------------------------------------
app.post('/os_fotos/:id/delete', authRequired, allowRoles('admin', 'funcionario'), async (req, res) => {
  try {
    const fotoId = req.params.id;

    const foto = await getAsync(`SELECT * FROM os_fotos WHERE id = ?`, [fotoId]);
    if (!foto) return res.send('Foto não encontrada.');

    const filePath = path.join(__dirname, 'public', foto.caminho);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await runAsync(`DELETE FROM os_fotos WHERE id = ?`, [fotoId]);

    res.redirect('/ordens/' + foto.os_id);
  } catch (err) {
    console.error(err);
    res.send('Erro ao deletar foto.');
  }
});

// -------------------------------------------------------
// VER UMA OS (detalhe + fotos)
// -------------------------------------------------------
app.get('/ordens/:id', async (req, res) => {
  try {
    const ordem = await getAsync(`
      SELECT o.*, e.nome AS equipamento_nome, e.codigo AS equipamento_codigo
      FROM ordens o
      LEFT JOIN equipamentos e ON e.id = o.equipamento_id
      WHERE o.id = ?
    `, [req.params.id]);

    if (!ordem) return res.send('Ordem não encontrada.');

    // Operador só pode ver as próprias OS
    if (req.session.role === 'operador' && ordem.solicitante !== req.session.usuario) {
      return res.status(403).send('Acesso negado.');
    }

    const fotos = await allAsync(`
      SELECT * FROM os_fotos
      WHERE os_id = ?
      ORDER BY created_at ASC
    `, [req.params.id]);

    res.render('ordens_fechar', { ordem, fotos, active: 'ordens' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao carregar OS.');
  }
});

// -------------------------------------------------------
// FECHAR UMA OS (com fotos de fechamento)
// -------------------------------------------------------
app.post('/ordens/:id/fechar', upload.array('fotos', 10), async (req, res) => {
  try {
    const osId = req.params.id;
    const ordem = await getAsync(`
      SELECT solicitante FROM ordens WHERE id = ?
    `, [osId]);

    if (!ordem) return res.send('Ordem não encontrada.');

    // Operador só fecha as próprias OS
    if (req.session.role === 'operador' && ordem.solicitante !== req.session.usuario) {
      return res.status(403).send('Acesso negado.');
    }

    await runAsync(`
      UPDATE ordens
      SET status = 'fechada',
          resultado = ?,
          fechada_em = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [req.body.resultado, osId]);

    // Fotos de fechamento
    if (req.files && req.files.length > 0) {
      for (const foto of req.files) {
        await runAsync(`
          INSERT INTO os_fotos (os_id, caminho, tipo)
          VALUES (?, ?, 'fechamento')
        `, [osId, path.join('uploads', foto.filename)]);
      }
    }

    res.redirect('/ordens');
  } catch (err) {
    console.error(err);
    res.send('Erro ao fechar OS.');
  }
});

// -------------------------------------------------------
// PDF PROFISSIONAL DA OS (separado: abertura e fechamento)
// -------------------------------------------------------
app.get('/solicitacao/pdf/:id', authRequired, async (req, res) => {
  try {
    const ordem = await getAsync(`
      SELECT o.*, 
             e.nome AS equipamento_nome,
             e.codigo AS equipamento_codigo
      FROM ordens o
      LEFT JOIN equipamentos e ON e.id = o.equipamento_id
      WHERE o.id = ?
    `, [req.params.id]);

    if (!ordem) return res.send('Ordem não encontrada.');

    if (req.session.role === 'operador' && ordem.solicitante !== req.session.usuario) {
      return res.status(403).send('Acesso negado.');
    }

    const fotos = await allAsync(`
      SELECT * FROM os_fotos
      WHERE os_id = ?
      ORDER BY created_at ASC
    `, [req.params.id]);

    const doc = new PDFDocument({ margin: 40 });

    res.setHeader('Content-Disposition', `attachment; filename=OS_${ordem.id}.pdf`);
    res.setHeader('Content-Type', 'application/pdf');

    doc.pipe(res);

    // -------------------------
    // CABEÇALHO E DADOS DA OS
    // --------------------------
    doc.fontSize(22).text('Ordem de Serviço (OS)', { align: 'center' });
    doc.moveDown(2);

    doc.fontSize(13).text(`ID da OS: ${ordem.id}`);
    doc.text(`Solicitante: ${ordem.solicitante}`);
    doc.text(`Equipamento: ${ordem.equipamento_nome} (${ordem.equipamento_codigo || '-'})`);
    doc.text(`Tipo: ${ordem.tipo}`);
    doc.text(`Aberta em: ${ordem.aberta_em}`);
    if (ordem.status === 'fechada') {
      doc.text(`Fechada em: ${ordem.fechada_em}`);
    }
    doc.moveDown();

    doc.fontSize(12).text("Descrição:");
    doc.fontSize(11).text(ordem.descricao || "-", { indent: 15 });
    doc.moveDown(1.5);

    if (ordem.status === 'fechada') {
      doc.fontSize(12).text("Resultado:");
      doc.fontSize(11).text(ordem.resultado || "-", { indent: 15 });
    }

    // -------------------------
    // FOTOS — separadas
    // -------------------------
    const abertura = fotos.filter(f => f.tipo === "abertura");
    const fechamento = fotos.filter(f => f.tipo === "fechamento");

    // Forçar nova página
    doc.addPage();

    // ======== ABERTURA ========
    doc.fontSize(18).text("📌 Fotos de Abertura", { underline: true });
    doc.moveDown(1);

    if (abertura.length === 0) {
      doc.fontSize(12).text("Nenhuma foto de abertura enviada.");
    } else {
      for (const foto of abertura) {

        if (doc.y > 650) doc.addPage();

        doc.moveDown(1);

        try {
          doc.image(path.join(__dirname, 'public', foto.caminho), {
            fit: [500, 400],
            align: 'center',
            valign: 'center'
          });
        } catch (err) {
          doc.fontSize(10).text('(Erro ao carregar imagem)');
        }

        doc.moveDown(2);
      }
    }

    // ======== FECHAMENTO ========
    doc.addPage();
    doc.fontSize(18).text("📌 Fotos de Fechamento", { underline: true });
    doc.moveDown(1);

    if (fechamento.length === 0) {
      doc.fontSize(12).text("Nenhuma foto de fechamento enviada.");
    } else {
      for (const foto of fechamento) {

        if (doc.y > 650) doc.addPage();

        doc.moveDown(1);

        try {
          doc.image(path.join(__dirname, 'public', foto.caminho), {
            fit: [500, 400],
            align: 'center'
          });
        } catch (err) {
          doc.fontSize(10).text('(Erro ao carregar imagem)');
        }

        doc.moveDown(2);
      }
    }

    doc.end();
  } catch (err) {
    console.error(err);
    res.send('Erro ao gerar PDF.');
  }
});

// =======================
// RELATÓRIO DE EQUIPAMENTOS (PDF)
// =======================
app.get('/equipamentos/relatorio/pdf', authRequired, async (req, res) => {
  try {
    const equipamentos = await allAsync(`
      SELECT id, nome, codigo, local, descricao, created_at
      FROM equipamentos
      ORDER BY nome ASC
    `);

    const doc = new PDFDocument({ margin: 40 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=equipamentos_relatorio.pdf');

    doc.pipe(res);

    doc.fontSize(22).text('Relatório de Equipamentos', { align: 'center' });
    doc.moveDown(2);

    if (equipamentos.length === 0) {
      doc.fontSize(14).text("Nenhum equipamento encontrado.", { align: "center" });
    } else {
      equipamentos.forEach(eq => {
        doc.fontSize(14).text(`• ${eq.nome}`);
        doc.fontSize(11).text(`Código: ${eq.codigo || '-'}`);
        doc.text(`Local: ${eq.local || '-'}`);
        doc.text(`Descrição: ${eq.descricao || '-'}`);
        doc.text(`Criado em: ${eq.created_at}`);
        doc.moveDown(1);
      });
    }

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao gerar PDF.');
  }
});

// -------------------------- FIM PARTE 3/4 --------------------------
// Peça "Parte 4" para finalizar (Dashboard + Start do servidor).
// server.js — PARTE 4/4
// Dashboard avançado + Start
// =====================================================
// ================== DASHBOARD (VERSÃO COMPLETA) =====================
app.get('/', authRequired, async (req, res) => {
  try {
    // Totais
    const totalEquip = await getAsync(`SELECT COUNT(*) AS c FROM equipamentos`);
    const totalAbertas = await getAsync(`SELECT COUNT(*) AS c FROM ordens WHERE status='aberta'`);
    const totalFechadas = await getAsync(`SELECT COUNT(*) AS c FROM ordens WHERE status='fechada'`);
    const totalCorreias = await getAsync(`SELECT SUM(quantidade) AS total FROM correias`);

    const totais = {
      equipamentos: totalEquip?.c || 0,
      abertas: totalAbertas?.c || 0,
      fechadas: totalFechadas?.c || 0,
      correias: totalCorreias?.total || 0
    };

    // Últimas ordens
    const ultimas = await allAsync(`
      SELECT o.*, e.nome AS equipamento_nome
      FROM ordens o
      LEFT JOIN equipamentos e ON e.id = o.equipamento_id
      ORDER BY o.aberta_em DESC
      LIMIT 6
    `);

    // ORDENS POR TIPO — formato ARRAY para o gráfico
    const tipos = await allAsync(`
      SELECT tipo, COUNT(*) AS total
      FROM ordens
      GROUP BY tipo
    `);

    // TOP 10 CORREIAS — formato ARRAY para gráfico
    const correiasTop = await allAsync(`
      SELECT nome, quantidade AS total
      FROM correias
      ORDER BY total DESC
      LIMIT 10
    `);

    // Renderizar dashboard
    res.render('dashboard', {
      active: 'dashboard',
      totais,
      ultimas,
      tipos,          // array certo
      correiasTop,    // array certo
      chartjs: true
    });

  } catch (err) {
    console.error("Erro ao carregar dashboard:", err);
    res.send("Erro ao carregar dashboard.");
  }
});
// ----------------------------------------------------------
// RELATÓRIO COMPLETO DO DASHBOARD — VERSÃO FINAL (LOGO FIXA)
// ----------------------------------------------------------
app.get('/relatorios/gerar-pdf-dashboard', authRequired, async (req, res) => {
  try {
    const PDFDocument = require("pdfkit");
    const { ChartJSNodeCanvas } = require("chartjs-node-canvas");

    // ---------------------- CONFIG GERAL ----------------------
    const GREEN = "#0A5C2F";
    const chartJS = new ChartJSNodeCanvas({ width: 900, height: 450 });

    // ---------------------- DADOS DO SISTEMA ----------------------
    const totais = {
      equipamentos: (await getAsync(`SELECT COUNT(*) AS t FROM equipamentos`)).t,
      abertas:      (await getAsync(`SELECT COUNT(*) AS t FROM ordens WHERE status='aberta' AND aberta_em >= datetime('now','-30 days')`)).t,
      fechadas:     (await getAsync(`SELECT COUNT(*) AS t FROM ordens WHERE status='fechada' AND fechada_em >= datetime('now','-30 days')`)).t,
      correias:     (await getAsync(`SELECT COUNT(*) AS t FROM correias`)).t
    };

    const tipos = await allAsync(`
      SELECT tipo, COUNT(*) AS total
      FROM ordens
      WHERE aberta_em >= datetime('now','-30 days')
      GROUP BY tipo
      ORDER BY total DESC
    `);

    const correiasTop = await allAsync(`
      SELECT nome, quantidade
      FROM correias
      ORDER BY quantidade DESC
      LIMIT 10
    `);

    const equipamentos = await allAsync(`
      SELECT id, nome, codigo, local, created_at
      FROM equipamentos
      ORDER BY nome ASC
    `);

    const correias = await allAsync(`
      SELECT id, nome, modelo, medida, quantidade
      FROM correias
      ORDER BY nome ASC
    `);

    const ordens30 = await allAsync(`
      SELECT o.*, e.nome AS equipamento
      FROM ordens o
      LEFT JOIN equipamentos e ON e.id = o.equipamento_id
      WHERE o.aberta_em >= datetime('now','-30 days')
      ORDER BY e.nome, o.aberta_em DESC
    `);

    // ---------------------- GRÁFICOS ----------------------
    const palette = [
      "#0A5C2F", "#DBA800", "#A40000", "#0077CC", "#00A67A",
      "#F57C00", "#C2185B", "#7B1FA2", "#388E3C", "#1976D2"
    ];

    // Pizza
    const pieBuffer = await chartJS.renderToBuffer({
      type: "pie",
      data: {
        labels: tipos.map(t => t.tipo || "—"),
        datasets: [{ data: tipos.map(t => t.total), backgroundColor: palette }]
      },
      options: { plugins: { legend: { position: "bottom", labels: { font: { size: 12 } } } } }
    });

    // Barras
    const barBuffer = await chartJS.renderToBuffer({
      type: "bar",
      data: {
        labels: correiasTop.map(c => c.nome),
        datasets: [{ label: "Estoque", data: correiasTop.map(c => c.quantidade), backgroundColor: palette }]
      },
      options: {
        indexAxis: "y",
        scales: {
          x: { beginAtZero: true, ticks: { font: { size: 10 } } },
          y: { ticks: { font: { size: 10 } } }
        },
        plugins: { legend: { display: false } }
      }
    });

    // ---------------------- INICIAR PDF ----------------------
    const doc = new PDFDocument({ margin: 40 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline; filename=dashboard_completo.pdf");
    doc.pipe(res);
// Função para formatar a data em português
function formatarDataBrasil(dataObj) {
    const meses = [
        "Janeiro","Fevereiro","Março","Abril","Maio","Junho",
        "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"
    ];
    const dia = String(dataObj.getDate()).padStart(2, "0");
    const mes = meses[dataObj.getMonth()];
    const ano = dataObj.getFullYear();
    return `${dia} de ${mes} de ${ano}`;
}

// ---------------------- CAPA DO RELATÓRIO ----------------------
doc.addPage({ margin: 0 });

// Fundo
doc.rect(0, 0, doc.page.width, doc.page.height).fill("#FFFFFF");

// Logo central
try {
    doc.image(
      path.join(__dirname, "public/img/logo_campo_do_gado.png"),
      doc.page.width / 2 - 90,
      60,
      { width: 180 }
    );
} catch (e) {
    console.log("Erro ao carregar logo na capa:", e);
}

// Títulos da capa
doc.fillColor("#0A5C2F").fontSize(22)
   .text("FÁBRICA DE RECICLAGEM – CAMPO DO GADO", 0, 260, { align: "center" });

doc.fontSize(18)
   .text("SETOR DE MANUTENÇÃO INDUSTRIAL", { align: "center" });

doc.moveDown(1);

doc.fontSize(24).fillColor("#0A5C2F")
   .text("RELATÓRIO TÉCNICO DE ATIVIDADES", { align: "center" });

// Linha decorativa
doc.moveTo(150, 350)
   .lineTo(doc.page.width - 150, 350)
   .lineWidth(3)
   .stroke("#0A5C2F");

// 🔥 DATA ATUAL DO SISTEMA
const hoje = new Date();
const dataFormatada = formatarDataBrasil(hoje);

// Informações técnicas
doc.fillColor("#444").fontSize(14);

doc.text(`Data: ${dataFormatada}`, 0, 380, { align: "center" });
doc.text("Responsável Técnico: Ângelo G. da Silva", { align: "center" });
doc.text("Cargo: Técnico Mecânico / Encarregado de Manutenção", { align: "center" });

// Rodapé
doc.fontSize(11).fillColor("#777")
   .text("Campo do Gado — Sistema de Manutenção", 0, doc.page.height - 60, { align: "center" });

// Começa o relatório de verdade
doc.addPage({ margin: 40 });


    // ---------------------- CABEÇALHO ----------------------
    try {
      // LOGO FIXA (FUNCIONA NO RAILWAY)
      doc.image(path.join(__dirname, "public/img/logo_campo_do_gado.png"), 40, 40, { width: 70 });
    } catch(e) {
      console.log("Logo não encontrada:", e);
    }

    doc.fontSize(22).fillColor(GREEN).text("Relatório Completo — Dashboard", 130, 50);
    doc.fontSize(10).fillColor("#444").text(`Gerado em: ${new Date().toLocaleString()}`, 130, 80);
    doc.moveDown(3);

    // ---------------------- RESUMO GERAL ----------------------
    doc.fontSize(16).fillColor(GREEN).text("Resumo Geral", { underline: true });

    const resumo = [
      ["Total Equipamentos", totais.equipamentos],
      ["Ordens Abertas (30 dias)", totais.abertas],
      ["Ordens Fechadas (30 dias)", totais.fechadas],
      ["Correias no Estoque", totais.correias]
    ];

    resumo.forEach((linha, i) => {
      const y = doc.y;

      if (i % 2 === 0) {
        doc.rect(40, y, 520, 22).fill("#F3F3F3");
      }

      doc.fillColor(GREEN).fontSize(11).text(linha[0], 50, y + 6);
      doc.fillColor("#000").fontSize(11).text(String(linha[1]), 480, y + 6);

      doc.moveDown(1.6);
    });

    doc.moveDown(1);

    // ---------------------- GRÁFICOS NA MESMA PÁGINA ----------------------
    const leftX = 55;
    const rightX = 330;
    const topY = doc.y + 10;

    doc.fontSize(14).fillColor(GREEN).text("Ordens por Tipo", leftX, topY - 20);
    doc.image(pieBuffer, leftX, topY, { width: 230 });

    doc.fontSize(14).fillColor(GREEN).text("Top 10 Correias", rightX, topY - 20);
    doc.image(barBuffer, rightX, topY, { width: 230 });

    // ---------------------- PÁGINA 2 — EQUIPAMENTOS + CORREIAS ----------------------
    doc.addPage();

    function tableHeader(y, columns) {
      doc.fillColor(GREEN).rect(40, y, 515, 22).fill();
      doc.fillColor("#fff").fontSize(10);
      let x = 45;
      columns.forEach(col => {
        doc.text(col.label, x, y + 6, { width: col.width, align: col.align || "left" });
        x += col.width;
      });
      return y + 26;
    }

    function tableRow(y, cols, zebra) {
      if (zebra) {
        doc.rect(40, y, 515, 18).fill("#F3F3F3");
      }
      doc.fillColor("#000").fontSize(9);
      let x = 45;
      cols.forEach(col => {
        doc.text(col.text, x, y + 4, { width: col.width, align: col.align || "left" });
        x += col.width;
      });
      return y + 20;
    }

    // ---------------------- Equipamentos ----------------------
    doc.fontSize(16).fillColor(GREEN).text("Equipamentos", 40, 50, { underline: true });
    let y = doc.y + 10;

    const eqCols = [
      { label: "ID", width: 40 },
      { label: "Nome", width: 200 },
      { label: "Código", width: 70 },
      { label: "Local", width: 120 },
      { label: "Criado", width: 80 }
    ];

    y = tableHeader(y, eqCols);
    let zebra = false;

    equipamentos.forEach(e => {
      if (y > 740) {
        doc.addPage();
        y = tableHeader(40, eqCols);
      }

      y = tableRow(y, [
        { text: e.id, width: 40 },
        { text: e.nome, width: 200 },
        { text: e.codigo || "-", width: 70 },
        { text: e.local || "-", width: 120 },
        { text: e.created_at || "-", width: 80, align: "center" }
      ], zebra);

      zebra = !zebra;
    });

    doc.moveDown(1);

    // ---------------------- Correias ----------------------
    doc.fontSize(16).fillColor(GREEN).text("Correias", 40, doc.y + 20, { underline: true });
    y = doc.y + 10;

    const coCols = [
      { label: "ID", width: 40 },
      { label: "Nome", width: 200 },
      { label: "Modelo", width: 100 },
      { label: "Medida", width: 100 },
      { label: "Qtd", width: 75 }
    ];

    y = tableHeader(y, coCols);
    zebra = false;

    correias.forEach(c => {
      if (y > 740) {
        doc.addPage();
        y = tableHeader(40, coCols);
      }

      y = tableRow(y, [
        { text: c.id, width: 40 },
        { text: c.nome, width: 200 },
        { text: c.modelo || "-", width: 100 },
        { text: c.medida || "-", width: 100 },
        { text: String(c.quantidade), width: 75, align: "center" }
      ], zebra);

      zebra = !zebra;
    });

    // ---------------------- PÁGINA 3 — ORDENS DOS ÚLTIMOS 30 DIAS ----------------------
    doc.addPage();
    doc.fontSize(16).fillColor(GREEN).text("Ordens de Serviço (últimos 30 dias)", 40, 50, { underline: true });
    y = doc.y + 10;

    const osCols = [
      { label: "ID", width: 40 },
      { label: "Equipamento", width: 160 },
      { label: "Tipo", width: 80 },
      { label: "Status", width: 60 },
      { label: "Abertura", width: 100 },
      { label: "Fechamento", width: 100 },
      { label: "Técnico", width: 75 }
    ];

    y = tableHeader(y, osCols);
    zebra = false;

    ordens30.forEach(o => {
      if (y > 740) {
        doc.addPage();
        y = tableHeader(40, osCols);
      }

      y = tableRow(y, [
        { text: o.id, width: 40 },
        { text: o.equipamento || "-", width: 160 },
        { text: o.tipo || "-", width: 80 },
        { text: o.status || "-", width: 60 },
        { text: o.aberta_em || "-", width: 100 },
        { text: o.fechada_em || "-", width: 100 },
        { text: o.solicitante || "-", width: 75 }
      ], zebra);

      zebra = !zebra;
    });

    // ---------------------- RODAPÉ ----------------------
    doc.fontSize(10).fillColor("#777")
       .text("Campo do Gado — Sistema de Manutenção", 40, 800, { align: "center" });

    doc.end();

  } catch (err) {
    console.error("ERRO PDF DASHBOARD:", err);
    res.status(500).send("Erro ao gerar PDF do Dashboard");
  }
});


// =====================================================
//  RELATÓRIOS — Página principal
// =====================================================
app.get('/relatorios', authRequired, async (req, res) => {
  try {

    // Totais gerais
    const totalEquip = await getAsync(`SELECT COUNT(*) AS c FROM equipamentos`);
    const totalOrdens = await getAsync(`SELECT COUNT(*) AS c FROM ordens`);
    const totalAbertas = await getAsync(`SELECT COUNT(*) AS c FROM ordens WHERE status='aberta'`);
    const totalFechadas = await getAsync(`SELECT COUNT(*) AS c FROM ordens WHERE status='fechada'`);
    const totalCorreias = await getAsync(`SELECT COUNT(*) AS c FROM correias`);

    res.render('relatorios', {
      active: 'relatorios',
      totais: {
        equipamentos: totalEquip?.c || 0,
        ordens: totalOrdens?.c || 0,
        abertas: totalAbertas?.c || 0,
        fechadas: totalFechadas?.c || 0,
        correias: totalCorreias?.c || 0
      }
    });

  } catch (err) {
    console.error("Erro ao carregar relatórios:", err);
    res.send("Erro ao carregar relatórios.");
  }
});
  // -------------------------------------------------------
// PDF COMPLETO — EQUIPAMENTOS UM EMBAIXO DO OUTRO
// -------------------------------------------------------
app.get('/relatorios/gerar-pdf-completo', authRequired, async (req, res) => {
    try {

        const ordens = await allAsync(`
    SELECT 
        o.id,
        e.nome AS equipamento,
        o.tipo,
        o.status,
        o.aberta_em,
        o.fechada_em,
        o.solicitante
    FROM ordens o
    LEFT JOIN equipamentos e ON e.id = o.equipamento_id
    WHERE o.aberta_em >= datetime('now', '-30 days')
    ORDER BY e.nome ASC,
             CASE WHEN o.status='aberta' THEN 0 ELSE 1 END,
             o.id DESC
`);


        const grupos = {};
        ordens.forEach(o => {
            if (!grupos[o.equipamento]) grupos[o.equipamento] = [];
            grupos[o.equipamento].push(o);
        });

        const PDFDocument = require("pdfkit");
        const doc = new PDFDocument({ margin: 40 });

        res.setHeader('Content-Disposition', 'attachment; filename=Relatorio_OS.pdf');
        res.setHeader('Content-Type', 'application/pdf');

        doc.pipe(res);

        // -----------------------------------------
        // CABEÇALHO
        // -----------------------------------------
        try {
            doc.image(path.join(__dirname, 'public/img/logo_campo_do_gado.png'), 40, 40, { width: 90 });
        } catch {}

        doc.fontSize(22).fillColor('#0D6B33')
           .text("Relatório Completo de Ordens de Serviço", 150, 50);

        doc.fontSize(11).fillColor('#444')
           .text(`Gerado em: ${new Date().toLocaleString()}`, 150, 80);

        doc.moveDown(3);

        // -----------------------------------------
        // CABEÇALHO DA TABELA
        // -----------------------------------------
        function tableHeader(y) {
            doc.fillColor('#0D6B33')
               .rect(40, y, 515, 22)
               .fill();

            doc.fillColor('#fff').fontSize(11)
               .text("ID", 45, y + 4)
               .text("Tipo", 90, y + 4)
               .text("Status", 150, y + 4)
               .text("Abertura", 230, y + 4)
               .text("Fechamento", 330, y + 4)
               .text("Técnico", 450, y + 4);

            return y + 26;
        }

        // -----------------------------------------
        // LISTAGEM — UM EQUIPAMENTO DEPOIS DO OUTRO
        // -----------------------------------------
        let y = doc.y;

        for (const equip in grupos) {

            // Quebra de página automática APENAS se faltar espaço
            if (y > 700) {
                doc.addPage();
                y = 40;
            }

            // Título do Equipamento
            doc.fontSize(16).fillColor('#0D6B33');
            doc.text(`Equipamento: ${equip}`, 40, y, { underline: true });

            y += 28;

            // Cabeçalho da tabela
            y = tableHeader(y);

            let zebra = false;

            for (const o of grupos[equip]) {

                // Quebra automática dentro de um equipamento
                if (y > 740) {
                    doc.addPage();
                    y = 40;
                    y = tableHeader(y);
                }

                // Zebra
                if (zebra) {
                    doc.fillColor('#F3F3F3')
                       .rect(40, y, 515, 20)
                       .fill();
                }
                zebra = !zebra;

                doc.fillColor('#000').fontSize(10);

                doc.text(o.id.toString(), 45, y + 5);
                doc.text(o.tipo || "-", 90, y + 5);
                doc.text(o.status || "-", 150, y + 5);
                doc.text(o.aberta_em || "-", 230, y + 5);
                doc.text(o.fechada_em || "-", 330, y + 5);
                doc.text(o.solicitante || "-", 450, y + 5, { width: 100, ellipsis: true });

                y += 22;
            }

            // Espaço entre equipamentos (sem nova página!)
            y += 40;
        }

        // -----------------------------------------
        // RODAPÉ
        // -----------------------------------------
        doc.fontSize(10).fillColor('#777')
           .text("Campo do Gado — Sistema de Manutenção", 40, 800, { align: 'center' });

        doc.end();

    } catch (err) {
        console.log("ERRO PDF:", err);
        res.status(500).send("Erro ao gerar PDF");
    }
});
// ----------------------------------------------------------
// RELATÓRIO PROFISSIONAL DE EQUIPAMENTOS (COM FOTOS)
// ----------------------------------------------------------
app.get('/equipamentos/relatorio/pdf', authRequired, async (req, res) => {
    try {
        const PDFDocument = require("pdfkit");

        const GREEN = "#0A5C2F";

        const equipamentos = await allAsync(`
            SELECT id, nome, codigo, local, descricao, imagem, created_at
            FROM equipamentos
            ORDER BY nome ASC
        `);

        const doc = new PDFDocument({ margin: 40 });

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", "inline; filename=equipamentos_relatorio.pdf");
        doc.pipe(res);

        // ---------------------- CABEÇALHO ----------------------
        try {
            doc.image(path.join(__dirname, "public/img/logo_campo_do_gado.png"), 40, 20, { width: 70 });
        } catch {}

        doc.fillColor(GREEN).fontSize(22)
           .text("Relatório de Equipamentos", 120, 40);

        doc.fillColor("#444").fontSize(10)
           .text(`Gerado em: ${new Date().toLocaleString()}`, 120, 70);

        doc.moveDown(3);

        // ---------------------- LOOP DOS EQUIPAMENTOS ----------------------
        let y = doc.y;
        let zebra = false;

        equipamentos.forEach(eq => {

            // Nova página se estiver muito baixo
            if (doc.y > 700) {
                doc.addPage();
                y = 60;
            }

            // Fundo zebra
            const boxY = doc.y;
            if (zebra) {
                doc.rect(30, boxY - 4, 550, 110).fill("#F3F3F3");
            }
            zebra = !zebra;

            // FOTO (lado esquerdo)
            const imgPath = eq.imagem ? path.join(__dirname, "public", eq.imagem) : null;

            if (imgPath && fs.existsSync(imgPath)) {
                try {
                    doc.image(imgPath, 40, boxY, {
                        width: 120,
                        height: 100,
                        fit: [120, 100]
                    });
                } catch (e) {
                    console.log("Erro ao carregar imagem:", e);
                }
            } else {
                // Caixa cinza quando não existe imagem
                doc.rect(40, boxY, 120, 100).fill("#DDDDDD");
                doc.fillColor("#666").fontSize(10)
                   .text("Sem imagem", 40, boxY + 40, { width: 120, align: "center" });
            }

            // TEXTO (lado direito)
            doc.fillColor("#000").fontSize(14)
               .text(`• ${eq.nome}`, 180, boxY + 2);

            doc.fontSize(11);
            doc.text(`Código: ${eq.codigo || "-"}`, 180, boxY + 28);
            doc.text(`Local: ${eq.local || "-"}`, 180, boxY + 42);
            doc.text(`Descrição: ${eq.descricao || "-"}`, 180, boxY + 56);
            doc.text(`Criado em: ${eq.created_at || "-"}`, 180, boxY + 70);

            doc.moveDown(5);
        });

        // ---------------------- RODAPÉ ----------------------
        doc.fillColor("#777").fontSize(10)
           .text("Campo do Gado — Sistema de Manutenção", 40, 800, { align: "center" });

        doc.end();

    } catch (err) {
        console.error("ERRO RELATORIO EQUIPAMENTOS:", err);
        res.status(500).send("Erro ao gerar relatório de equipamentos.");
    }
});


// =====================================================
// ================== START DO SERVIDOR ================
// =====================================================
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🔌 Banco SQLite conectado em: ${DB_FILE}\n`);
});


