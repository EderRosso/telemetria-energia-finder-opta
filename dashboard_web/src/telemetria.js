/**
 * telemetria.js — Recebe as leituras do ESP32/OPTA pelo MQTT, valida,
 * grava no banco e avisa o painel em tempo real.
 *
 * Tópicos (iguais aos do ESP32):
 *   {PREFIXO}/telemetria/{gateway}/medidor/{slave_id}   -> JSON da leitura
 *   {PREFIXO}/telemetria/{gateway}/status               -> "online" | "offline"
 */
const EventEmitter = require('events');
const mqtt = require('mqtt');
const config = require('./config');
const { db } = require('./db');

const eventos = new EventEmitter();
const HISTORICO_MAX = 60;

/** Estado em memória para o tempo real: medidor_id -> { ultima, historico, ultimoGravadoMs } */
const aoVivo = new Map();
const statusMqtt = { conectado: false, broker: config.MQTT_URL.replace(/\/\/.*@/, '//') };

// Consultas preparadas (mais rápidas)
const sqlBuscarMedidor = db.prepare('SELECT * FROM medidores WHERE gateway_id = ? AND slave_id = ?');
const sqlCriarMedidor = db.prepare('INSERT INTO medidores (gateway_id, slave_id, nome, modelo) VALUES (?,?,?,?)');
const sqlGravarLeitura = db.prepare(`
  INSERT INTO leituras (medidor_id, ts, tensao_v, corrente_a, potencia_w, fp, frequencia_hz, energia_kwh)
  VALUES (@medidor_id, @ts, @tensao_v, @corrente_a, @potencia_w, @fp, @frequencia_hz, @energia_kwh)`);
const sqlGateway = db.prepare(`
  INSERT INTO gateways (id, status, ultimo_contato) VALUES (?,?,?)
  ON CONFLICT(id) DO UPDATE SET status = excluded.status, ultimo_contato = excluded.ultimo_contato`);

/** Aceita só números reais dentro de uma faixa plausível; senão, null. */
function numeroValido(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/**
 * Usa o horário do equipamento se for confiável; caso contrário, o do servidor.
 * (Evita gravar datas absurdas se o relógio do ESP32/OPTA estiver errado.)
 */
function escolherHorario(tsEquipamento) {
  const agora = Date.now();
  const t = Date.parse(tsEquipamento);
  if (Number.isFinite(t) && t <= agora + 120_000 && t >= agora - 7 * 86_400_000) {
    return new Date(t).toISOString();
  }
  return new Date(agora).toISOString();
}

/** Encontra o medidor pelo par (gateway, slave_id). Medidor novo é cadastrado sozinho. */
function obterMedidor(gatewayId, slaveId, modelo) {
  let m = sqlBuscarMedidor.get(gatewayId, slaveId);
  if (!m) {
    sqlCriarMedidor.run(gatewayId, slaveId, `Medidor ${gatewayId}/${slaveId}`, modelo || null);
    m = sqlBuscarMedidor.get(gatewayId, slaveId);
    console.log(`[MEDIDOR] Novo medidor detectado: ${gatewayId}/${slaveId} — vincule-o a um cliente no painel.`);
    eventos.emit('medidores_alterados');
  }
  return m;
}

function processarLeitura(gatewayId, slaveId, texto) {
  let dados;
  try {
    dados = JSON.parse(texto);
  } catch {
    console.warn(`[MQTT] JSON inválido de ${gatewayId}/${slaveId} — ignorado.`);
    return;
  }
  if (!dados || typeof dados !== 'object' || dados.ok === false) return;

  const v = dados.valores && typeof dados.valores === 'object' ? dados.valores : {};
  const leitura = {
    ts: escolherHorario(dados.ts),
    tensao_v: numeroValido(v.tensao_v, 0, 1000),
    corrente_a: numeroValido(v.corrente_a, 0, 10000),
    potencia_w: numeroValido(v.potencia_w, -10_000_000, 10_000_000),
    fp: numeroValido(v.fp, -1, 1),
    frequencia_hz: numeroValido(v.frequencia_hz, 0, 100),
    energia_kwh: numeroValido(v.energia_kwh, 0, 1e9),
  };
  if (leitura.energia_kwh === null && leitura.tensao_v === null) return; // nada aproveitável

  const medidor = obterMedidor(gatewayId, slaveId, dados.modelo);
  if (!medidor.ativo) return;

  let estado = aoVivo.get(medidor.id);
  if (!estado) {
    estado = { ultima: null, historico: [], ultimoGravadoMs: 0 };
    aoVivo.set(medidor.id, estado);
  }
  estado.ultima = leitura;
  estado.historico.push(leitura);
  if (estado.historico.length > HISTORICO_MAX) estado.historico.shift();

  // Grava no banco no máximo 1 leitura a cada GRAVAR_A_CADA_S por medidor
  const agora = Date.now();
  if (agora - estado.ultimoGravadoMs >= config.GRAVAR_A_CADA_S * 1000) {
    sqlGravarLeitura.run({ medidor_id: medidor.id, ...leitura });
    estado.ultimoGravadoMs = agora;
  }

  sqlGateway.run(gatewayId, 'online', new Date().toISOString());
  eventos.emit('leitura', { medidor, leitura });
}

function processarStatus(gatewayId, texto) {
  const status = String(texto).trim().toLowerCase() === 'online' ? 'online' : 'offline';
  sqlGateway.run(gatewayId, status, new Date().toISOString());
  console.log(`[GATEWAY] ${gatewayId}: ${status.toUpperCase()}`);
  eventos.emit('gateway', { gateway_id: gatewayId, status });
}

function iniciarMqtt() {
  const cliente = mqtt.connect(config.MQTT_URL, {
    clientId: `servidor-telemetria-${Math.random().toString(16).slice(2, 10)}`,
    username: config.MQTT_USUARIO,
    password: config.MQTT_SENHA,
    clean: true,
    connectTimeout: 8000,
    reconnectPeriod: 4000,
  });
  const topico = `${config.PREFIXO}/telemetria/#`;
  // Ex.: prefixo/telemetria/opta01/medidor/33
  const padrao = new RegExp(`^${config.PREFIXO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/telemetria/([^/]+)/(medidor/(\\d+)|status)$`);

  cliente.on('connect', () => {
    statusMqtt.conectado = true;
    console.log(`[MQTT] Conectado a ${statusMqtt.broker}. Assinando '${topico}'`);
    cliente.subscribe(topico, { qos: 1 });
    eventos.emit('mqtt', statusMqtt);
  });
  cliente.on('close', () => {
    if (statusMqtt.conectado) console.warn('[MQTT] Conexão perdida. Tentando reconectar...');
    statusMqtt.conectado = false;
    eventos.emit('mqtt', statusMqtt);
  });
  cliente.on('error', (e) => console.error('[MQTT] Erro:', e.message));
  cliente.on('message', (t, carga) => {
    const m = padrao.exec(t);
    if (!m) return;
    const texto = carga.toString().slice(0, 4096);
    if (m[2] === 'status') processarStatus(m[1], texto);
    else processarLeitura(m[1], Number(m[3]), texto);
  });
  return cliente;
}

/** Medidor "online" = enviou leitura nos últimos OFFLINE_APOS_S segundos. */
function estaOnline(medidorId) {
  const e = aoVivo.get(medidorId);
  return !!(e && e.ultima && Date.now() - Date.parse(e.ultima.ts) < config.OFFLINE_APOS_S * 1000);
}

/** Ao iniciar o servidor, recupera a última leitura gravada de cada medidor. */
function carregarUltimasLeituras() {
  const linhas = db.prepare(`
    SELECT l.* FROM leituras l
      JOIN (SELECT medidor_id, MAX(ts) AS ts FROM leituras GROUP BY medidor_id) u
        ON u.medidor_id = l.medidor_id AND u.ts = l.ts`).all();
  for (const l of linhas) {
    const { id, medidor_id, ...leitura } = l;
    aoVivo.set(medidor_id, { ultima: leitura, historico: [leitura], ultimoGravadoMs: Date.parse(l.ts) });
  }
}

module.exports = {
  eventos, aoVivo, statusMqtt, iniciarMqtt, processarLeitura, processarStatus, estaOnline, carregarUltimasLeituras,
};
