// ------------------------------------------
// IMPORTAÇÕES
// ------------------------------------------
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const multer = require("multer");
const methodOverride = require("method-override");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");

// ------------------------------------------
// CONFIGURAÇÕES INICIAIS
// ------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride("_method"));

// Servir arquivos estáticos
app.use("/public", express.static("public"));
app.use("/uploads", express.static("uploads"));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Criar pastas se não existirem
["uploads", "uploads/equipamentos", "uploads/ordens", "data"].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ------------------------------------------
// BANCO DE DADOS
// ------------------------------------------
const db = new sqlite3.Database("./data/database.sqlite");

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

// ------------------------------------------
// MULTER: Upload de fotos
// ------------------------------------------
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

// ------------------------------------------
// ROTAS PRINCIPAIS
// ------------------------------------------
app.get("/", (req, res) => res.redirect("/admin/dashboard"));

app.get("/admin/dashboard", (req, res) => {
  res.render("admin/dashboard");
});

// ------------------------------------------
// ROTAS: EQUIPAMENTOS
// ------------------------------------------
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
    err => {
      if (err) return res.send("Erro ao cadastrar equipamento.");
      res.redirect("/admin/equipamentos");
    }
  );
});

// ------------------------------------------
// ROTAS: ORDENS DE SERVIÇO
// ------------------------------------------
app.get("/admin/ordens", (req, res) => {
  const sql = `
    SELECT os.*, e.nome AS equipamento_nome
    FROM ordens_servico os
    JOIN equipamentos e ON os.equipamento_id = e.id
    ORDER BY os.id DESC
  `;

  db.all(sql, (err, ordens) => {
    if (err) return res.send("Erro ao listar ordens.");
    res.render("admin/ordens", { ordens });
  });
});

// Abrir OS (form funcionário)
app.get("/funcionario/abrir_os", (req, res) => {
  const equip_id = req.query.equip_id;
  res.render("funcionario/abrir_os", { equip_id });
});

// Criar OS
app.post("/funcionario/abrir_os", uploadOrdens.single("foto_antes"), (req, res) => {
  const { equip_id, descricao } = req.body;
  const fotoAntes = req.file ? req.file.path : null;

  db.run(
    `INSERT INTO ordens_servico 
     (equipamento_id, descricao, status, foto_antes, data_abertura) 
     VALUES (?,?,?,?,datetime('now'))`,
    [equip_id, descricao, "Aberta", fotoAntes],
    err => {
      if (err) return res.send("Erro ao abrir OS.");
      res.redirect("/admin/ordens");
    }
  );
});

// Form fechar OS
app.get("/admin/ordens/:id/fechar", (req, res) => {
  const id = req.params.id;

  db.get("SELECT * FROM ordens_servico WHERE id = ?", [id], (err, ordem) => {
    if (err || !ordem) return res.send("OS não encontrada.");
    res.render("admin/ordens_fechar", { ordem });
  });
});

// Fechar OS
app.put("/admin/ordens/:id", uploadOrdens.single("foto_depois"), (req, res) => {
  const id = req.params.id;
  const { tecnico_nome, descricao } = req.body;
  const fotoDepois = req.file ? req.file.path : null;

  db.run(
    `UPDATE ordens_servico 
     SET tecnico_nome=?, descricao=?, status=?, foto_depois=?, data_fechamento=datetime('now') 
     WHERE id=?`,
    [tecnico_nome, descricao, "Fechada", fotoDepois, id],
    err => {
      if (err) return res.send("Erro ao fechar OS.");
      res.redirect("/admin/ordens");
    }
  );
});

// ------------------------------------------
// PDF: RELATÓRIO DE OS
// ------------------------------------------
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
      res.setHeader("Content-Disposition", `inline; filename=ordem_${id}.pdf`);
      doc.pipe(res);

      // Título
      doc.fontSize(18).text("Relatório da Ordem de Serviço", { align: "center" });
      doc.moveDown();

      // Informações da OS
      doc.fontSize(12);
      doc.text(`OS: ${ordem.id}`);
      doc.text(`Equipamento: ${ordem.equipamento_nome}`);
      doc.text(`Descrição: ${ordem.descricao}`);
      doc.text(`Status: ${ordem.status}`);
      doc.text(`Técnico: ${ordem.tecnico_nome || "-"}`);
      doc.text(`Abertura: ${ordem.data_abertura}`);
      doc.text(`Fechamento: ${ordem.data_fechamento || "-"}`);
      doc.moveDown();

      // Fotos
      const fotoAntesPath = ordem.foto_antes ? path.join(__dirname, ordem.foto_antes) : null;
      const fotoDepoisPath = ordem.foto_depois ? path.join(__dirname, ordem.foto_depois) : null;

      if (fotoAntesPath) {
        doc.text("Foto Antes:");
        try {
          doc.image(fotoAntesPath, { fit: [250, 250] });
        } catch {
          doc.text("Erro ao carregar a foto.");
        }
        doc.moveDown();
      }

      if (fotoDepoisPath) {
        doc.text("Foto Depois:");
        try {
          doc.image(fotoDepoisPath, { fit: [250, 250] });
        } catch {
          doc.text("Erro ao carregar a foto.");
        }
        doc.moveDown();
      }

      doc.text("Relatório gerado automaticamente pelo sistema.", {
        align: "center",
        fontSize: 10,
      });

      doc.end();
    }
  );
});

// ------------------------------------------
// INICIAR SERVIDOR
// ------------------------------------------
app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
