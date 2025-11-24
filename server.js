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
// PDF COMPLETO DA OS (com fotos antes e depois)
// -------------------------------------------------------
app.get('/solicitacao/pdf/:id', authRequired, async (req, res) => {
  try {
    const ordem = await getAsync(`
      SELECT o.*, e.nome AS equipamento_nome, e.codigo AS equipamento_codigo
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

    // Cabeçalho
    doc.fontSize(20).text('Ordem de Serviço (OS)', { align: 'center' });
    doc.moveDown();

    doc.fontSize(12).text(`ID da OS: ${ordem.id}`);
    doc.text(`Solicitante: ${ordem.solicitante}`);
    doc.text(`Equipamento: ${ordem.equipamento_nome} (${ordem.equipamento_codigo || 'sem código'})`);
    doc.text(`Tipo: ${ordem.tipo}`);
    doc.text(`Aberta em: ${ordem.aberta_em}`);
    doc.moveDown();

    doc.text('Descrição:');
    doc.fontSize(11).text(ordem.descricao, { indent: 14 });
    doc.moveDown();

    doc.fontSize(12).text(`Status: ${ordem.status}`);
    if (ordem.status === 'fechada') {
      doc.text(`Fechada em: ${ordem.fechada_em}`);
      doc.text(`Resultado:`);
      doc.fontSize(11).text(ordem.resultado, { indent: 14 });
    }

    // Fotos
    if (fotos.length > 0) {
      doc.addPage();
      doc.fontSize(16).text('Fotos da OS', { align: 'center' });
      doc.moveDown(2);

      for (const foto of fotos) {
        doc.fontSize(12).text(foto.tipo === 'abertura' ? 'Abertura' : 'Fechamento');

        try {
          doc.image(path.join(__dirname, 'public', foto.caminho), {
            fit: [420, 420],   // TAMANHO IDEAL
            align: 'center'
          });
        } catch (err) {
          console.log('Erro ao carregar imagem no PDF:', err);
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

// -------------------------- FIM PARTE 3/4 --------------------------
// Peça "Parte 4" para finalizar (Dashboard + Start do servidor).
// server.js — PARTE 4/4
// Dashboard avançado + Start

// =====================================================
// ================== DASHBOARD ========================
// =====================================================
app.get('/', authRequired, async (req, res) => {
  try {
    // Totais
    const totalEquip = await getAsync(`SELECT COUNT(*) AS c FROM equipamentos`);
    const totalAbertas = await getAsync(`SELECT COUNT(*) AS c FROM ordens WHERE status='aberta'`);
    const totalFechadas = await getAsync(`SELECT COUNT(*) AS c FROM ordens WHERE status='fechada'`);

    // Últimas ordens
    const ultimas = await allAsync(`
      SELECT o.*, e.nome AS equipamento_nome
      FROM ordens o
      LEFT JOIN equipamentos e ON e.id = o.equipamento_id
      ORDER BY o.aberta_em DESC
      LIMIT 6
    `);

    // Quantidade por tipo
    const tipos = await allAsync(`
      SELECT tipo, COUNT(*) AS total
      FROM ordens
      GROUP BY tipo
    `);

    // Quantidade por mês (YYYY-MM)
    const porMes = await allAsync(`
      SELECT strftime('%Y-%m', aberta_em) AS mes, COUNT(*) AS total
      FROM ordens
      GROUP BY mes
      ORDER BY mes ASC
    `); 
    
    // Top correias (para gráfico)
    const correiasTop = await allAsync(`
      SELECT nome, quantidade 
      FROM correias
      ORDER BY quantidade DESC
      LIMIT 10
    `);

    res.render('dashboard', {
  active: 'dashboard',
  totais: {
    equipamentos: totalEquip?.c || 0,
    abertas: totalAbertas?.c || 0,
    fechadas: totalFechadas?.c || 0
  },
  tipos,
  porMes,
  ultimas
  correiasTop 
});


  } catch (err) {
    console.error(err);
    res.send('Erro ao carregar dashboard.');
  }
});

// =====================================================
// ================== START DO SERVIDOR ================
// =====================================================
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🔌 Banco SQLite conectado em: ${DB_FILE}\n`);
});
