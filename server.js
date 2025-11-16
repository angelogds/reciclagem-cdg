
// Server.js - Manutenção Reciclagem Campo do Gado (versão completa)
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const upload = multer({ dest: 'uploads/tmp/' });

// ensure folders
['uploads','uploads/equipamentos','uploads/ordens','data'].forEach(d=>{
  if(!fs.existsSync(d)) fs.mkdirSync(d,{ recursive:true });
});

// sqlite
const db = new sqlite3.Database('./data/database.sqlite');

// create tables if not exists
db.serialize(()=>{
  db.run(`CREATE TABLE IF NOT EXISTS equipamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT,
    setor TEXT,
    correias_utilizadas INTEGER DEFAULT 0,
    foto_path TEXT,
    qr_code TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS ordens_servico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    equipamento_id INTEGER,
    descricao TEXT,
    prioridade TEXT,
    status TEXT DEFAULT 'Aberta',
    foto_antes TEXT,
    foto_depois TEXT,
    funcionario_nome TEXT,
    data_abertura DATETIME DEFAULT CURRENT_TIMESTAMP,
    data_inicio DATETIME,
    data_fechamento DATETIME,
    tempo_total INTEGER
  )`);
});

// helper to save file and return dest
function saveUploaded(file, folderPrefix){
  if(!file) return null;
  const dest = path.join('uploads', folderPrefix, `${Date.now()}_${file.originalname}`);
  fs.renameSync(file.path, dest);
  return dest.replace(/\\/g, '/');
}

// ROUTES
app.get('/', (req,res)=> res.redirect('/admin/dashboard'));

// ADMIN - dashboard
app.get('/admin/dashboard', (req,res)=>{
  db.get('SELECT COUNT(*) as total FROM equipamentos', [], (e,rowEq)=>{
    db.get('SELECT COUNT(*) as total FROM ordens_servico', [], (e2,rowOs)=>{
      res.render('admin/dashboard',{ stats:{ equipamentos: rowEq ? rowEq.total : 0, ordens: rowOs ? rowOs.total : 0 } });
    });
  });
});

// ADMIN - equipamentos list
app.get('/admin/equipamentos', (req,res)=>{
  db.all('SELECT * FROM equipamentos ORDER BY nome', [], (err, rows)=> {
    res.render('admin/equipamentos', { equipamentos: rows || [] });
  });
});

// ADMIN - novo equipamento
app.get('/admin/equipamentos/novo', (req,res)=> res.render('admin/equipamentos_novo'));

// POST novo equipamento
const uploadEquip = upload.single('foto');
app.post('/admin/equipamentos/novo', uploadEquip, (req,res)=>{
  const { nome, setor, correias_utilizadas } = req.body;
  let foto_path = saveUploaded(req.file, 'equipamentos') || null;
  db.run('INSERT INTO equipamentos (nome, setor, correias_utilizadas, foto_path) VALUES (?,?,?,?)',
    [nome, setor, correias_utilizadas||0, foto_path], function(err){
      if(err) return res.send('Erro ao cadastrar: ' + err.message);
      const id = this.lastID;
      const qrUrl = `${req.protocol}://${req.get('host')}/funcionario/abrir_os?equip_id=${id}`;
      const qrPath = `uploads/equipamentos/qrcode_${id}.png`;
      QRCode.toFile(qrPath, qrUrl).then(()=>{
        db.run('UPDATE equipamentos SET qr_code = ? WHERE id = ?', [qrPath, id], ()=>res.redirect('/admin/equipamentos'));
      }).catch(()=> res.redirect('/admin/equipamentos'));
  });
});

// ADMIN - ordens
app.get('/admin/ordens', (req,res)=>{
  db.all(`SELECT o.*, e.nome as equipamento_nome FROM ordens_servico o
          LEFT JOIN equipamentos e ON e.id = o.equipamento_id
          ORDER BY o.data_abertura DESC`, [], (err, rows)=>{
    res.render('admin/ordens', { ordens: rows || [] });
  });
});

// FUNCIONÁRIO - abrir OS (GET form)
app.get('/funcionario/abrir_os', (req,res)=>{
  const id = req.query.equip_id;
  db.get('SELECT * FROM equipamentos WHERE id=?', [id], (err,row)=> {
    if(!row) return res.status(404).send('Equipamento não encontrado');
    res.render('funcionario/abrir_os', { equip: row });
  });
});

// FUNCIONÁRIO - abrir OS (POST)
const uploadOS = upload.single('foto_antes');
app.post('/funcionario/abrir_os', uploadOS, (req,res)=>{
  const { equipamento_id, descricao, prioridade, funcionario_nome } = req.body;
  const foto_antes = saveUploaded(req.file, 'ordens');
  db.run(`INSERT INTO ordens_servico (equipamento_id, descricao, prioridade, status, foto_antes, funcionario_nome)
          VALUES (?,?,?,?,?,?)`,
    [equipamento_id, descricao, prioridade||'Média', 'Aberta', foto_antes, funcionario_nome||''],
    function(err){
      if(err) return res.send('Erro ao criar OS: ' + err.message);
      res.redirect('/admin/ordens');
    });
});

// Serve QR image directly (already static under /uploads)
app.get('/qrcode/:file', (req,res)=>{
  res.sendFile(path.join(__dirname,'uploads','equipamentos', req.params.file));
});

// simple health
app.get('/health', (req,res)=> res.send('OK'));
// --------- Iniciar OS (mecânico inicia o atendimento) ----------
app.post('/admin/ordens/:id/start', (req, res) => {
  const id = req.params.id;
  // marca data_inicio e altera status para "Em Andamento"
  const now = new Date().toISOString().replace('T',' ').split('.')[0]; // 'YYYY-MM-DD HH:MM:SS'
  db.run(`UPDATE ordens_servico SET status='Em Andamento', data_inicio = ? WHERE id = ?`, [now, id], function(err){
    if(err) {
      console.error('Erro ao iniciar OS', err.message);
      return res.status(500).send('Erro ao iniciar OS');
    }
    res.redirect('/admin/ordens');
  });
});

// --------- Finalizar OS (upload foto_depois + cálculo tempo) ----------
const uploadFinish = upload.single('foto_depois');

app.post('/admin/ordens/:id/finish', uploadFinish, (req, res) => {
  const id = req.params.id;

  // se houver foto, move para uploads/ordens
  let foto_depois = null;
  if (req.file) {
    const dest = `uploads/ordens/${Date.now()}_depois_${req.file.originalname}`;
    fs.renameSync(req.file.path, dest);
    foto_depois = dest;
  }

  // pegar a ordem para ler data_inicio
  db.get('SELECT data_inicio FROM ordens_servico WHERE id = ?', [id], (err, row) => {
    if (err) {
      console.error('Erro ao buscar OS', err.message);
      return res.status(500).send('Erro interno');
    }

    // calcula tempo_total em segundos
    let tempo_total = null;
    const now = new Date();
    if (row && row.data_inicio) {
      // sqlite retorna 'YYYY-MM-DD HH:MM:SS' — transformar para 'YYYY-MM-DDTHH:MM:SS' para Date()
      const started = new Date(row.data_inicio.replace(' ', 'T'));
      if (!isNaN(started.getTime())) {
        tempo_total = Math.round((now.getTime() - started.getTime()) / 1000); // segundos
      }
    }

    const finishedAt = new Date().toISOString().replace('T',' ').split('.')[0];
    db.run(
      `UPDATE ordens_servico
       SET status = 'Finalizada', foto_depois = ?, data_fechamento = ?, tempo_total = ?
       WHERE id = ?`,
      [foto_depois, finishedAt, tempo_total, id],
      function(upErr) {
        if (upErr) {
          console.error('Erro ao finalizar OS', upErr.message);
          return res.status(500).send('Erro ao finalizar OS');
        }
        res.redirect('/admin/ordens');
      }
    );
  });
});

// Start
const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log('Rodando na porta', PORT));
