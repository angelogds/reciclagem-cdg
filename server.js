const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const multer = require("multer");
const methodOverride = require("method-override");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------------- CONFIG BÁSICA ---------------- */
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));
app.use(methodOverride("_method"));
app.set("view engine", "ejs");

/* ---------------- BANCO DE DADOS ---------------- */
if (!fs.existsSync("./uploads")) fs.mkdirSync("./uploads");
if (!fs.existsSync("./uploads/equipamentos")) fs.mkdirSync("./uploads/equipamentos");
if (!fs.existsSync("./uploads/ordens")) fs.mkdirSync("./uploads/ordens");
if (!fs.existsSync("./data")) fs.mkdirSync("./data");

const db = new sqlite3.Database("./data/database.sqlite");

// Criar tabelas
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS equipamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      descricao TEXT,
      foto TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ordens_servico (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipamento_id INTEGER,
      descricao TEXT,
      status TEXT,
      foto_antes TEXT,
      foto_depois TEXT,
      tecnico_nome TEXT,
      data_abertura TEXT,
      data_fechamento TEXT,
      FOREIGN KEY(equipamento_id) REFERENCES equipamentos(id)
    )
  `);
});

/* ---------------- MULTER (UPLOADS) ---------------- */
const storageEquipamentos = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/equipamentos"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const uploadEquipamentos = multer({ storage: storageEquipamentos });

const storageOrdens = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/ordens"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const uploadOrdens = multer({ storage: storageOrdens });

/* ---------------- ROTAS ---------------- */

// Página inicial
app.get("/", (req, res) => res.redirect("/admin/dashboard"));

// Dashboard
app.get("/admin/dashboard", (req, res) => res.render("admin/dashboard"));

/* --- Equipamentos --- */
app.get("/admin/equipamentos", (req, res) => {
  db.all("SELECT * FROM equipamentos", (err, equipamentos) => {
    if (err) return res.send("Erro ao listar equipamentos.");
    res.render("admin/equipamentos", { equipamentos });
  });
});

app.get("/admin/equipamentos/novo", (req, res) => {
  res.render("admin/equipamentos_novo");
});

app.post("/admin/equipamentos", uploadEquipamentos.single("foto"), (req, res) => {
  const { nome, descricao } = req.body;
  const foto = req.file ? req.file.path : null;

  db.run(
    "INSERT INTO equipamentos (nome, descricao, foto) VALUES (?,?,?)",
    [nome, descricao, foto],
    (err) => {
      if (err) return res.send("Erro ao cadastrar equipamento.");
      res.redirect("/admin/equipamentos");
    }
  );
});

/* --- Ordens de serviço --- */
app.get("/admin/ordens", (req, res) => {
  db.all(
    `
      SELECT os.*, e.nome AS equipamento_nome
      FROM ordens_servico os
      JOIN equipamentos e ON os.equipamento_id = e.id
      ORDER BY os.id DESC
    `,
    (err, ordens) => {
      if (err) return res.send("Erro ao listar ordens.");
      res.render("admin/ordens", { ordens });
    }
  );
});

// Form funcionário para abrir OS
app.get("/funcionario/abrir_os", (req, res) => {
  const equip_id = req.query.equip_id;
  res.render("funcionario/abrir_os", { equip_id });
});

// Salvar OS aberta
app.post("/funcionario/abrir_os", uploadOrdens.single("foto_antes"), (req, res) => {
  const { equip_id, descricao } = req.body;
  const fotoAntes = req.file ? req.file.path : null;

  db.run(
    `
      INSERT INTO ordens_servico 
      (equipamento_id, descricao, status, foto_antes, data_abertura)
      VALUES (?,?,?,?,datetime('now'))
    `,
    [equip_id, descricao, "Aberta", fotoAntes],
    () => res.redirect("/admin/ordens")
  );
});

// Página para fechar OS
app.get("/admin/ordens/:id/fechar", (req, res) => {
  db.get("SELECT * FROM ordens_servico WHERE id=?", [req.params.id], (err, ordem) => {
    if (err || !ordem) return res.send("OS não encontrada.");
    res.render("admin/ordens_fechar", { ordem });
  });
});

// Fechar OS
app.put("/admin/ordens/:id", uploadOrdens.single("foto_depois"), (req, res) => {
  const { descricao, tecnico_nome } = req.body;
  const fotoDepois = req.file ? req.file.path : null;

  db.run(
    `
      UPDATE ordens_servico
      SET descricao=?, tecnico_nome=?, foto_depois=?, status='Fechada', data_fechamento=datetime('now')
      WHERE id=?
    `,
    [descricao, tecnico_nome, fotoDepois, req.params.id],
    () => res.redirect("/admin/ordens")
  );
});

/* ---------------- PDF RELATÓRIO ---------------- */
app.get("/admin/ordens/:id/relatorio", (req, res) => {
  const id = req.params.id;

  db.get(
    `
      SELECT os.*, e.nome AS equipamento_nome
      FROM ordens_servico os
      JOIN equipamentos e ON os.equipamento_id = e.id
      WHERE os.id = ?
    `,
    [id],
    (err, ordem) => {
      if (err || !ordem) return res.send("OS não encontrada.");

      const doc = new PDFDocument({ margin: 40 });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename=os_${id}.pdf`);
      doc.pipe(res);

      doc.fontSize(18).text("Relatório da Ordem de Serviço", { align: "center" });
      doc.moveDown();

      doc.fontSize(12).text(`OS: ${ordem.id}`);
      doc.text(`Equipamento: ${ordem.equipamento_nome}`);
      doc.text(`Descrição: ${ordem.descricao}`);
      doc.text(`Status: ${ordem.status}`);
      doc.text(`Técnico: ${ordem.tecnico_nome || "-"}`);
      doc.text(`Abertura: ${ordem.data_abertura}`);
      doc.text(`Fechamento: ${ordem.data_fechamento || "-"}`);
      doc.moveDown();

      const fotoAntes = ordem.foto_antes ? path.join(__dirname, ordem.foto_antes) : null;
      const fotoDepois = ordem.foto_depois ? path.join(__dirname, ordem.foto_depois) : null;

      if (fotoAntes) {
        doc.text("Foto Antes:");
        try { doc.image(fotoAntes, { fit: [250, 250] }); } catch {}
        doc.moveDown();
      }

      if (fotoDepois) {
        doc.text("Foto Depois:");
        try { doc.image(fotoDepois, { fit: [250, 250] }); } catch {}
        doc.moveDown();
      }

      doc.text("Relatório gerado automaticamente pelo sistema.", { align: "center" });
      doc.end();
    }
  );
});

/* ---------------- INICIAR SERVIDOR ---------------- */
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));
