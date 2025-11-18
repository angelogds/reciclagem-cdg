// seed.js — criar admin user (executar 1 vez)
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');

const DB_FILE = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(DB_FILE);

const usuario = 'angelocampodogado';
const senhaPlain = '@nloFa1107';
const nome = 'Angelo Campo';
const role = 'admin';

(async () => {
  const hashed = await bcrypt.hash(senhaPlain, 10);
  db.serialize(() => {
    db.run(`INSERT OR IGNORE INTO usuarios (usuario, senha, nome, role) VALUES (?,?,?,?)`, [usuario, hashed, nome, role], function(err){
      if (err) console.error('seed error', err);
      else console.log('Admin seed criado (ou já existia):', usuario);
    });
  });
  db.close();
})();
