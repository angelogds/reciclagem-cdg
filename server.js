const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bodyParser = require("body-parser");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/uploads/logos", express.static(path.join(__dirname, "uploads/logos")));
app.use(express.static(path.join(__dirname, "prototype")));

const upload = multer({ dest: "uploads/tmp/" });

const DB_PATH = process.env.DB_PATH || "./dbdata/db.sqlite";

// ensure folders
["uploads","uploads/logos","uploads/tmp","dbdata","uploads/equipamentos","uploads/ordens"].forEach(d => { if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); });

const db = new sqlite3.Database(DB_PATH);

// create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS belts (id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT, stock INTEGER DEFAULT 0, used INTEGER DEFAULT 0, required INTEGER DEFAULT 0, equipment TEXT, last_change TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS movements ( id INTEGER PRIMARY KEY AUTOINCREMENT, belt_id INTEGER, quantity INTEGER, reason TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP )`);
  db.run(`CREATE TABLE IF NOT EXISTS equipamentos ( id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, setor TEXT, correias_utilizadas INTEGER DEFAULT 0, foto_path TEXT, qr_code TEXT )`);
  db.run(`CREATE TABLE IF NOT EXISTS ordens_servico ( id INTEGER PRIMARY KEY AUTOINCREMENT, equipamento_id INTEGER, descricao TEXT, prioridade TEXT, status TEXT DEFAULT 'Aberta', foto_antes TEXT, foto_depois TEXT, tecnico_id INTEGER, funcionario_nome TEXT, data_abertura DATETIME DEFAULT CURRENT_TIMESTAMP, data_inicio DATETIME, data_fechamento DATETIME, tempo_total INTEGER )`);
});

// sync belts_seed.json on every start (upsert)
const seedPath = path.join(__dirname, 'belts_seed.json');
if(fs.existsSync(seedPath)){
  try{
    const seed = JSON.parse(fs.readFileSync(seedPath,'utf8'));
    seed.forEach(item => {
      db.get("SELECT id FROM belts WHERE model = ? AND equipment = ?", [item.model, item.equipment], (err,row)=>{
        if(row && row.id){
          db.run("UPDATE belts SET stock=?, used=?, required=? WHERE id=?", [item.stock, item.used, item.required, row.id]);
        } else {
          db.run("INSERT INTO belts (model, stock, used, required, equipment) VALUES (?,?,?,?,?)", [item.model, item.stock, item.used, item.required, item.equipment]);
        }
      });
    });
    console.log('✅ Belts synchronized from belts_seed.json');
  } catch(e){ console.error('Erro ao ler belts_seed.json', e); }
}

// endpoints
app.get('/api/belts', (req,res)=>{ db.all('SELECT * FROM belts ORDER BY model', [], (err,rows)=>{ if(err) return res.status(500).json({error:err.message}); res.json(rows); }); });

app.post('/api/movements', (req,res)=>{ const { belt_id, quantity } = req.body; db.get('SELECT stock FROM belts WHERE id = ?', [belt_id], (err,row)=>{ if(err || !row) return res.status(500).json({ error: "Correia não encontrada" }); const newStock = (row.stock||0) - (quantity||0); db.run('UPDATE belts SET stock = ?, last_change = CURRENT_TIMESTAMP WHERE id = ?', [newStock, belt_id], (err2)=>{ if(err2) return res.status(500).json({ error: err2.message }); db.run('INSERT INTO movements (belt_id, quantity, reason) VALUES (?,?,?)', [belt_id, quantity, 'baixa']); res.json({ ok:true }); }); }); });

app.post('/api/equipamentos', upload.single('foto'), (req,res)=>{ const { nome, setor, correias_utilizadas } = req.body; let foto_path = null; if(req.file){ const dest = `uploads/equipamentos/${Date.now()}_${req.file.originalname}`; fs.renameSync(req.file.path, dest); foto_path=dest; } db.run('INSERT INTO equipamentos (nome,setor,correias_utilizadas,foto_path) VALUES (?,?,?,?)', [nome,setor,correias_utilizadas||0,foto_path], function(err){ if(err) return res.status(500).json({error:err.message}); const id=this.lastID; const qrUrl = `${req.protocol}://${req.get('host')}/qrcode/start?equip_id=${id}`; db.run('UPDATE equipamentos SET qr_code = ? WHERE id = ?', [qrUrl,id]); res.json({id,qrUrl}); }); });

app.get('/api/equipamentos', (req,res)=>{ db.all('SELECT * FROM equipamentos ORDER BY nome', [], (err,rows)=>{ if(err) return res.status(500).json({error:err.message}); res.json(rows); }); });

app.post('/api/ordens', upload.single('foto_antes'), (req,res)=>{ const { equipamento_id, descricao, prioridade, funcionario_nome } = req.body; let foto_antes = null; if(req.file){ const dest = `uploads/ordens/${Date.now()}_antes_${req.file.originalname}`; fs.renameSync(req.file.path, dest); foto_antes = dest; } db.run('INSERT INTO ordens_servico (equipamento_id, descricao, prioridade, foto_antes, funcionario_nome) VALUES (?,?,?,?,?)', [equipamento_id, descricao, prioridade||'Média', foto_antes, funcionario_nome||''], function(err){ if(err) return res.status(500).json({ error: err.message }); res.json({ id: this.lastID }); }); });

app.get('/api/ordens', (req,res)=>{ db.all('SELECT o.*, e.nome as equipamento_nome FROM ordens_servico o LEFT JOIN equipamentos e ON e.id = o.equipamento_id ORDER BY o.data_abertura DESC', [], (err,rows)=>{ if(err) return res.status(500).json({ error: err.message }); res.json(rows); }); });

app.get('/api/report/ordens', (req,res)=>{ db.all('SELECT o.*, e.nome as equipamento_nome FROM ordens_servico o LEFT JOIN equipamentos e ON e.id = o.equipamento_id ORDER BY o.data_abertura DESC', [], (err,rows)=>{ if(err) return res.status(500).json({ error: err.message }); const doc = new PDFDocument({ margin:40, size:'A4' }); res.setHeader('Content-Type','application/pdf'); doc.pipe(res); doc.fontSize(18).text('Relatório de Ordens de Serviço', { align:'center' }); doc.moveDown(); rows.forEach(r=>{ doc.fontSize(12).text(`OS #${r.id} - Equip: ${r.equipamento_nome||r.equipamento_id}`); doc.text(`Desc: ${r.descricao}`); doc.moveDown(0.5); }); doc.end(); }); });

app.get('/qrcode/start', (req,res)=>{ const equip_id = req.query.equip_id; res.redirect(`/prototype/start-os.html?equip_id=${equip_id}`); });

app.post('/api/settings/logo', upload.single('file'), (req,res)=>{ if(!req.file) return res.status(400).json({ error:'Arquivo faltando' }); const dest = `uploads/logos/${Date.now()}_${req.file.originalname}`; fs.renameSync(req.file.path, dest); res.json({ path: dest }); });

app.get('*', (req,res)=>{ res.sendFile(path.join(__dirname, 'prototype', 'index.html')); });

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log('Servidor rodando na porta', PORT));
