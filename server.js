// server.js — Sistema de Manutenção CDG
// Layout + Login + Dashboard + CRUD + PDF

const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const session = require("express-session");
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 8080;
const DB_FILE = path.join(__dirname, 'database.sqlite');

// ================= CONFIGURAÇÕES BÁSICAS ================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

app.set('trust proxy', 1);

// Sessão
app.use(session({
  secret: "segredo_cdg_2025",
  resave: false,
  saveUninitialized: true
}));

app.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});

// EJS + Layouts
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// Middleware auth
function authRequired(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

// ================= DATABASE =================
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) console.error(err);
  else console.log("SQLite conectado em", DB_FILE);
});

// Criação das tabelas
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS equipamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
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
      resultado TEXT
    );
  `);
});

// Helpers
const runAsync = (sql, p=[]) => new Promise((ok, err)=> db.run(sql,p,function(e){e?err(e):ok(this)}));
const allAsync = (sql, p=[]) => new Promise((ok, err)=> db.all(sql,p,(e,r)=>e?err(e):ok(r)));
const getAsync = (sql, p=[]) => new Promise((ok, err)=> db.get(sql,p,(e,r)=>e?err(e):ok(r)));

// ================= UPLOADS =================
const uploadsDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, cb) { cb(null, uploadsDir) },
  filename(req, file, cb) {
    const unique = Date.now() + "-" + Math.round(Math.random()*1e9);
    cb(null, file.fieldname + "-" + unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// ================= LOGIN =================

app.get('/login', (req, res) => {
  res.render('login', { layout: false, error: null });
});

app.post('/login', (req, res) => {
  const { usuario, senha } = req.body;

  if (usuario === "admin" && senha === "123") {
    req.session.user = { nome: "Administrador" };
    return res.redirect('/');
  }

  res.render('login', { layout: false, error: "Usuário ou senha incorretos" });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ================= DASHBOARD =================
app.get('/', authRequired, async (req, res) => {
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
        equipamentos: totalEquip.c,
        abertas: totalAbertas.c,
        fechadas: totalFechadas.c
      },
      ultimas,
      tipos: {
        labels: tipos.map(t => t.tipo),
        valores: tipos.map(t => t.c)
      }
    });

  } catch (err) {
    res.send("Erro no dashboard");
  }
});

// ================= EQUIPAMENTOS =================
app.get('/equipamentos', authRequired, async (req, res) => {
  const equipamentos = await allAsync(`SELECT * FROM equipamentos ORDER BY id DESC`);
  res.render('equipamentos', { active: 'equipamentos', equipamentos });
});

app.get('/equipamentos/novo', authRequired, (req, res) => {
  res.render('equipamentos_novo', { active: 'equipamentos', equipamento: null });
});

app.post('/equipamentos', authRequired, upload.single('imagem'), async (req, res) => {
  const { nome, codigo, local, descricao } = req.body;
  const imagem = req.file ? "uploads/" + req.file.filename : null;

  await runAsync(`
    INSERT INTO equipamentos (nome, codigo, local, descricao, imagem)
    VALUES (?, ?, ?, ?, ?)
  `, [nome, codigo, local, descricao, imagem]);

  res.redirect('/equipamentos');
});

app.get('/equipamentos/:id/editar', authRequired, async (req, res) => {
  const equipamento = await getAsync(`SELECT * FROM equipamentos WHERE id=?`, [req.params.id]);
  res.render('equipamentos_novo', { active: 'equipamentos', equipamento });
});

app.post('/equipamentos/:id', authRequired, upload.single('imagem'), async (req, res) => {
  const eq = await getAsync(`SELECT * FROM equipamentos WHERE id=?`, [req.params.id]);
  let imagem = eq.imagem;

  if (req.file) {
    if (imagem) {
      const oldP = path.join(__dirname, 'public', imagem);
      if (fs.existsSync(oldP)) fs.unlinkSync(oldP);
    }
    imagem = "uploads/" + req.file.filename;
  }

  const { nome, codigo, local, descricao } = req.body;

  await runAsync(`
    UPDATE equipamentos SET nome=?, codigo=?, local=?, descricao=?, imagem=? WHERE id=?
  `, [nome, codigo, local, descricao, imagem, req.params.id]);

  res.redirect('/equipamentos');
});

app.post('/equipamentos/:id/delete', authRequired, async (req, res) => {
  const eq = await getAsync(`SELECT * FROM equipamentos WHERE id=?`, [req.params.id]);

  if (eq.imagem) {
    const imgP = path.join(__dirname, 'public', eq.imagem);
    if (fs.existsSync(imgP)) fs.unlinkSync(imgP);
  }

  await runAsync(`DELETE FROM equipamentos WHERE id=?`, [req.params.id]);
  res.redirect('/equipamentos');
});

// ================= ORDENS =================
app.get('/ordens', authRequired, async (req, res) => {
  const ordens = await allAsync(`
    SELECT o.*, e.nome AS equipamento_nome
    FROM ordens o
    LEFT JOIN equipamentos e ON o.equipamento_id = e.id
    ORDER BY o.aberta_em DESC
  `);
  res.render('ordens', { active: 'ordens', ordens });
});

app.get('/ordens/novo', authRequired, async (req, res) => {
  const equipamentos = await allAsync(`SELECT id, nome FROM equipamentos ORDER BY nome`);
  res.render('abrir_os', { active: 'abrir_os', equipamentos });
});

app.post('/ordens', authRequired, async (req, res) => {
  const { equipamento_id, solicitante, tipo, descricao } = req.body;

  await runAsync(`
    INSERT INTO ordens (equipamento_id, solicitante, tipo, descricao)
    VALUES (?, ?, ?, ?)
  `, [equipamento_id || null, solicitante, tipo, descricao]);

  res.redirect('/ordens');
});

app.get('/ordens/:id/fechar', authRequired, async (req, res) => {
  const ordem = await getAsync(`SELECT * FROM ordens WHERE id=?`, [req.params.id]);
  res.render('ordens_fechar', { active: 'ordens', ordem });
});

app.post('/ordens/:id/fechar', authRequired, async (req, res) => {
  await runAsync(`
    UPDATE ordens
    SET status='fechada', resultado=?, fechada_em=CURRENT_TIMESTAMP
    WHERE id=?
  `, [req.body.resultado, req.params.id]);

  res.redirect('/ordens');
});

// PDF
app.get('/solicitacao/pdf/:id', authRequired, async (req, res) => {
  const ordem = await getAsync(`
    SELECT o.*, e.nome equipamento_nome, e.codigo equipamento_codigo
    FROM ordens o LEFT JOIN equipamentos e ON o.equipamento_id = e.id
    WHERE o.id=?
  `, [req.params.id]);

  const doc = new PDFDocument({ margin: 40 });
  res.setHeader("Content-Disposition", `attachment; filename=os_${ordem.id}.pdf`);
  res.setHeader("Content-Type", "application/pdf");
  doc.pipe(res);

  doc.fontSize(20).text("Ordem de Serviço", { align: "center" }).moveDown();
  doc.fontSize(12).text(`ID: ${ordem.id}`);
  doc.text(`Solicitante: ${ordem.solicitante}`);
  doc.text(`Tipo: ${ordem.tipo}`);
  doc.text(`Equipamento: ${ordem.equipamento_nome}`);
  doc.text(`Descrição: ${ordem.descricao}`).moveDown();
  doc.text(`Status: ${ordem.status}`);

  doc.end();
});

// ================= START =================
app.listen(PORT, () => console.log("Servidor ativo na porta", PORT));
