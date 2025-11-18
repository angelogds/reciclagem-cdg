// server.js — CRUD completo + Layout EJS integrado
// Requer: express, sqlite3, multer, ejs, pdfkit, express-ejs-layouts
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 8080;
const DB_FILE = path.join(__dirname, 'database.sqlite');

// ========== MIDDLEWARE ==========
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// EJS Layouts
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout'); // layout.ejs padrão

// ========== MULTER (uploads) ==========
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + unique + ext);
  }
});
const upload = multer({ storage });

// ========== DATABASE (SQLite) ==========
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) return console.error('SQLite error:', err);
  console.log('Connected to SQLite at', DB_FILE);
});

// Create tables if not exist
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS equipamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    codigo TEXT,
    local TEXT,
    descricao TEXT,
    imagem TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

  db.run(`CREATE TABLE IF NOT EXISTS ordens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    equipamento_id INTEGER,
    solicitante TEXT,
    tipo TEXT,
    descricao TEXT,
    status TEXT DEFAULT 'aberta',
    aberta_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    fechada_em DATETIME,
    resultado TEXT,
    FOREIGN KEY (equipamento_id) REFERENCES equipamentos(id)
  );`);
});

// Helpers Promises
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

// ========== ROUTES ==========

// Home / Dashboard
app.get('/', async (req, res) => {
  try {
    const totalEquip = await getAsync('SELECT COUNT(*) AS c FROM equipamentos');
    const totalOrdens = await getAsync('SELECT COUNT(*) AS c FROM ordens');

    res.render('admin/dashboard', {
      layout: 'layout',
      active: 'dashboard',
      totals: {
        equipamentos: totalEquip?.c || 0,
        ordens: totalOrdens?.c || 0
      }
    });
  } catch (err) {
    console.error(err);
    res.render('admin/dashboard', { layout: 'layout', active: 'dashboard', totals: { equipamentos: 0, ordens: 0 } });
  }
});

// ---------------- Equipamentos CRUD ----------------
app.get('/equipamentos', async (req, res) => {
  try {
    const equipamentos = await allAsync('SELECT * FROM equipamentos ORDER BY created_at DESC');
    res.render('equipamentos', { layout: 'layout', active: 'equipamentos', equipamentos });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao listar equipamentos.');
  }
});

app.get('/equipamentos/novo', (req, res) => {
  res.render('equipamentos_novo', { layout: 'layout', active: 'equipamentos', equipamento: null });
});

app.post('/equipamentos', upload.single('imagem'), async (req, res) => {
  try {
    const { nome, codigo, local, descricao } = req.body;
    const imagem = req.file ? path.join('uploads', req.file.filename) : null;

    await runAsync(
      `INSERT INTO equipamentos (nome, codigo, local, descricao, imagem) VALUES (?, ?, ?, ?, ?)`,
      [nome, codigo, local, descricao, imagem]
    );

    res.redirect('/equipamentos');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao criar equipamento.');
  }
});

app.get('/equipamentos/:id/editar', async (req, res) => {
  try {
    const equipamento = await getAsync('SELECT * FROM equipamentos WHERE id = ?', [req.params.id]);
    if (!equipamento) return res.status(404).send('Equipamento não encontrado.');

    res.render('equipamentos_novo', { layout: 'layout', active: 'equipamentos', equipamento });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao abrir formulário.');
  }
});

app.post('/equipamentos/:id', upload.single('imagem'), async (req, res) => {
  try {
    const { nome, codigo, local, descricao } = req.body;
    const eq = await getAsync('SELECT * FROM equipamentos WHERE id = ?', [req.params.id]);

    if (!eq) return res.status(404).send('Equipamento não encontrado.');

    let imagem = eq.imagem;
    if (req.file) {
      if (eq.imagem) {
        const oldPath = path.join(__dirname, 'public', eq.imagem);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      imagem = path.join('uploads', req.file.filename);
    }

    await runAsync(
      `UPDATE equipamentos SET nome = ?, codigo = ?, local = ?, descricao = ?, imagem = ? WHERE id = ?`,
      [nome, codigo, local, descricao, imagem, req.params.id]
    );

    res.redirect('/equipamentos');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao atualizar equipamento.');
  }
});

app.post('/equipamentos/:id/delete', async (req, res) => {
  try {
    const eq = await getAsync('SELECT * FROM equipamentos WHERE id = ?', [req.params.id]);
    if (!eq) return res.status(404).send('Equipamento não encontrado.');

    if (eq.imagem) {
      const imgPath = path.join(__dirname, 'public', eq.imagem);
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    }

    await runAsync('DELETE FROM equipamentos WHERE id = ?', [req.params.id]);
    res.redirect('/equipamentos');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao deletar.');
  }
});

// ---------------- Ordens ----------------
app.get('/ordens', async (req, res) => {
  try {
    const ordens = await allAsync(`
      SELECT o.*, e.nome AS equipamento_nome
      FROM ordens o
      LEFT JOIN equipamentos e ON e.id = o.equipamento_id
      ORDER BY o.aberta_em DESC
    `);

    res.render('ordens', { layout: 'layout', active: 'ordens', ordens });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao listar ordens.');
  }
});

app.get('/ordens/novo', async (req, res) => {
  try {
    const equipamentos = await allAsync('SELECT id, nome FROM equipamentos ORDER BY nome');
    res.render('abrir_os', { layout: 'layout', active: 'abrir_os', equipamentos });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro.');
  }
});

app.post('/ordens', async (req, res) => {
  try {
    const { equipamento_id, solicitante, tipo, descricao } = req.body;

    await runAsync(
      `INSERT INTO ordens (equipamento_id, solicitante, tipo, descricao, status)
       VALUES (?, ?, ?, ?, 'aberta')`,
      [equipamento_id || null, solicitante, tipo, descricao]
    );

    res.redirect('/ordens');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao criar OS.');
  }
});

app.get('/ordens/:id/fechar', async (req, res) => {
  try {
    const ordem = await getAsync('SELECT * FROM ordens WHERE id = ?', [req.params.id]);
    if (!ordem) return res.status(404).send('OS não encontrada.');

    res.render('ordens_fechar', { layout: 'layout', active: 'ordens', ordem });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao carregar OS.');
  }
});

app.post('/ordens/:id/fechar', async (req, res) => {
  try {
    await runAsync(
      `UPDATE ordens
       SET status='fechada', resultado=?, fechada_em=CURRENT_TIMESTAMP
       WHERE id=?`,
      [req.body.resultado, req.params.id]
    );

    res.redirect('/ordens');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao fechar OS.');
  }
});

// PDF
app.get('/solicitacao/pdf/:id', async (req, res) => {
  try {
    const ordem = await getAsync(`
      SELECT o.*, e.nome AS equipamento_nome, e.codigo AS equipamento_codigo
      FROM ordens o
      LEFT JOIN equipamentos e ON e.id = o.equipamento_id
      WHERE o.id = ?`, [req.params.id]
    );

    if (!ordem) return res.status(404).send('OS não encontrada.');

    const doc = new PDFDocument({ margin: 40 });
    res.setHeader('Content-disposition', `attachment; filename=os_${ordem.id}.pdf`);
    res.setHeader('Content-type', 'application/pdf');
    doc.pipe(res);

    doc.fontSize(18).text('Ordem de Serviço', { align: 'center' }).moveDown();

    doc.fontSize(12).text(`OS ID: ${ordem.id}`);
    doc.text(`Solicitante: ${ordem.solicitante}`);
    doc.text(`Tipo: ${ordem.tipo}`);
    doc.text(`Equipamento: ${ordem.equipamento_nome} (${ordem.equipamento_codigo})`);
    doc.moveDown();
    doc.text('Descrição:');
    doc.text(ordem.descricao, { indent: 10 }).moveDown();
    doc.text(`Status: ${ordem.status}`);

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao gerar PDF.');
  }
});

// ========== START ==========

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
