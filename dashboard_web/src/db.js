/**
 * db.js — Banco de dados SQLite (um único arquivo: dados/telemetria.db).
 * Cria as tabelas na primeira execução.
 */
const Database = require('better-sqlite3');
const config = require('./config');

const db = new Database(config.ARQUIVO_BANCO);
db.pragma('journal_mode = WAL'); // melhor desempenho com leituras e escritas simultâneas
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS clientes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nome        TEXT NOT NULL,
  documento   TEXT,
  email       TEXT,
  telefone    TEXT,
  ativo       INTEGER NOT NULL DEFAULT 1,
  criado_em   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS usuarios (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  nome                TEXT NOT NULL,
  email               TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash          TEXT NOT NULL,
  perfil              TEXT NOT NULL CHECK (perfil IN ('admin','cliente')),
  cliente_id          INTEGER REFERENCES clientes(id),
  ativo               INTEGER NOT NULL DEFAULT 1,
  trocar_senha        INTEGER NOT NULL DEFAULT 1,  -- obriga a trocar a senha provisória
  totp_segredo        TEXT,                        -- segredo do 2FA (criptografado)
  totp_ativo          INTEGER NOT NULL DEFAULT 0,
  totp_ultimo_passo   INTEGER NOT NULL DEFAULT 0,  -- impede reutilizar o mesmo código
  falhas_login        INTEGER NOT NULL DEFAULT 0,
  bloqueado_ate       TEXT,
  ultimo_login        TEXT,
  criado_em           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessoes (
  token_hash   TEXT PRIMARY KEY,                    -- guardamos só o hash do token
  usuario_id   INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  etapa        TEXT NOT NULL,                       -- trocar_senha | configurar_2fa | codigo | completa
  tentativas   INTEGER NOT NULL DEFAULT 0,
  expira_em    TEXT NOT NULL,
  ip           TEXT,
  criado_em    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS medidores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway_id  TEXT NOT NULL,
  slave_id    INTEGER NOT NULL,
  nome        TEXT NOT NULL,
  modelo      TEXT,
  cliente_id  INTEGER REFERENCES clientes(id),
  ativo       INTEGER NOT NULL DEFAULT 1,
  criado_em   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (gateway_id, slave_id)
);

CREATE TABLE IF NOT EXISTS leituras (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  medidor_id    INTEGER NOT NULL REFERENCES medidores(id),
  ts            TEXT NOT NULL,          -- data/hora em UTC (ISO-8601)
  tensao_v      REAL,
  corrente_a    REAL,
  potencia_w    REAL,
  fp            REAL,
  frequencia_hz REAL,
  energia_kwh   REAL                    -- contador do medidor (nunca zera): base da cobrança
);
CREATE INDEX IF NOT EXISTS idx_leituras_medidor_ts ON leituras (medidor_id, ts);

CREATE TABLE IF NOT EXISTS tarifas (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  valor_kwh        REAL NOT NULL CHECK (valor_kwh >= 0),
  vigencia_inicio  TEXT NOT NULL UNIQUE,  -- AAAA-MM-DD (data local)
  observacao       TEXT,
  criado_por       INTEGER REFERENCES usuarios(id),
  criado_em        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS gateways (
  id               TEXT PRIMARY KEY,
  status           TEXT NOT NULL DEFAULT 'offline',
  ultimo_contato   TEXT
);

CREATE TABLE IF NOT EXISTS auditoria (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id  INTEGER,
  email       TEXT,
  acao        TEXT NOT NULL,
  detalhe     TEXT,
  ip          TEXT,
  ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);

/** Registra um evento de segurança/administração (quem fez o quê, quando e de onde). */
function auditar({ usuario_id = null, email = null, acao, detalhe = null, ip = null }) {
  db.prepare('INSERT INTO auditoria (usuario_id, email, acao, detalhe, ip) VALUES (?,?,?,?,?)')
    .run(usuario_id, email, acao, detalhe ? String(detalhe).slice(0, 500) : null, ip);
}

module.exports = { db, auditar };
