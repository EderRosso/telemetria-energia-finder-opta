/**
 * config.js — Lê as configurações do arquivo .env (ver .env.exemplo).
 * Tudo que é sensível (senhas, chaves) fica FORA do código.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PASTA_DADOS = path.join(__dirname, '..', 'dados');
if (!fs.existsSync(PASTA_DADOS)) fs.mkdirSync(PASTA_DADOS, { recursive: true });

/**
 * Chave secreta usada para criptografar os segredos do 2FA no banco.
 * Se não estiver no .env, é gerada uma vez e guardada em dados/chave.secreta.
 * (Faça backup desse arquivo junto com o banco!)
 */
function obterChaveSecreta() {
  if (process.env.CHAVE_SECRETA) {
    return crypto.createHash('sha256').update(process.env.CHAVE_SECRETA).digest();
  }
  const arquivo = path.join(PASTA_DADOS, 'chave.secreta');
  if (!fs.existsSync(arquivo)) {
    fs.writeFileSync(arquivo, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return crypto.createHash('sha256').update(fs.readFileSync(arquivo, 'utf8').trim()).digest();
}

const numero = (valor, padrao) => {
  const n = Number(valor);
  return Number.isFinite(n) ? n : padrao;
};

module.exports = {
  PORTA_HTTP: numero(process.env.PORTA, 3000),
  NOME_SISTEMA: process.env.NOME_SISTEMA || 'Telemetria de Energia',

  // MQTT
  MQTT_URL: process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883',
  MQTT_USUARIO: process.env.MQTT_USUARIO || undefined,
  MQTT_SENHA: process.env.MQTT_SENHA || undefined,
  PREFIXO: process.env.PREFIXO || 'meu_projeto_energia_123',

  // Banco de dados
  ARQUIVO_BANCO: process.env.ARQUIVO_BANCO || path.join(PASTA_DADOS, 'telemetria.db'),
  // Grava no banco no máximo 1 leitura por medidor a cada N segundos
  // (o painel em tempo real continua recebendo todas)
  GRAVAR_A_CADA_S: numero(process.env.GRAVAR_A_CADA_S, 60),
  // Medidor é considerado "offline" se ficar este tempo sem enviar leitura
  OFFLINE_APOS_S: numero(process.env.OFFLINE_APOS_S, 120),
  // Fuso horário local em minutos (Brasília = -180). Define a virada do dia/mês.
  FUSO_MINUTOS: numero(process.env.FUSO_MINUTOS, -180),

  // Segurança
  CHAVE: obterChaveSecreta(),
  COOKIE_SEGURO: process.env.COOKIE_SEGURO === 'true', // true quando o site estiver em HTTPS
  SESSAO_HORAS: numero(process.env.SESSAO_HORAS, 12),
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'admin@local',
  ADMIN_SENHA: process.env.ADMIN_SENHA || '',

  PASTA_DADOS,
};
