/**
 * consumo.js — Cálculo de consumo (kWh) e valor (R$).
 *
 * REGRA DE OURO: o consumo vem do CONTADOR DE ENERGIA do medidor (registrador 2752),
 * que nunca zera. Consumo = diferença entre leituras do contador.
 * Nunca somamos potência ao longo do tempo (isso acumularia erros).
 *
 * A tarifa é aplicada DIA A DIA, usando a tarifa vigente em cada dia.
 * Assim, se o admin mudar a tarifa no meio do mês, cada parte é cobrada certo.
 */
const config = require('./config');
const { db } = require('./db');

const FUSO_MS = config.FUSO_MINUTOS * 60_000;

/** '2026-10-17T02:30:00Z' -> '2026-10-16' (dia no horário local) */
function diaLocal(isoUtc) {
  return new Date(new Date(isoUtc).getTime() + FUSO_MS).toISOString().slice(0, 10);
}

/** '2026-10-17' (local) -> instante UTC da meia-noite local, em ISO */
function inicioDiaUtc(dia) {
  return new Date(new Date(`${dia}T00:00:00Z`).getTime() - FUSO_MS).toISOString();
}

function mesAtual() {
  return diaLocal(new Date().toISOString()).slice(0, 7);
}

function mesAnterior(mes) {
  const [a, m] = mes.split('-').map(Number);
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, '0')}`;
}

function mesSeguinte(mes) {
  const [a, m] = mes.split('-').map(Number);
  return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`;
}

/** Lista de dias 'AAAA-MM-DD' de um mês. */
function diasDoMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  const total = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return Array.from({ length: total }, (_, i) => `${mes}-${String(i + 1).padStart(2, '0')}`);
}

function validarMes(mes) {
  return typeof mes === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(mes);
}

/** Todas as tarifas em ordem de vigência. */
function listarTarifas() {
  return db.prepare('SELECT * FROM tarifas ORDER BY vigencia_inicio').all();
}

/** Tarifa vigente num dia (a última com início <= dia), ou null. */
function tarifaNoDia(dia, tarifas = listarTarifas()) {
  let vigente = null;
  for (const t of tarifas) {
    if (t.vigencia_inicio <= dia) vigente = t;
    else break;
  }
  return vigente;
}

/**
 * Consumo de UM medidor entre dois instantes UTC.
 * Devolve o consumo separado por dia local: { '2026-10-01': kWh, ... }
 */
function consumoPorDia(medidorId, inicioIso, fimIso) {
  const anterior = db.prepare(`
    SELECT energia_kwh FROM leituras
     WHERE medidor_id = ? AND ts < ? AND energia_kwh IS NOT NULL
     ORDER BY ts DESC LIMIT 1`).get(medidorId, inicioIso);

  const leituras = db.prepare(`
    SELECT ts, energia_kwh FROM leituras
     WHERE medidor_id = ? AND ts >= ? AND ts < ? AND energia_kwh IS NOT NULL
     ORDER BY ts`).all(medidorId, inicioIso, fimIso);

  const dias = {};
  const alertas = [];
  let base = anterior ? anterior.energia_kwh : (leituras[0]?.energia_kwh ?? null);

  for (const l of leituras) {
    let delta = l.energia_kwh - base;
    if (delta < 0) {
      // O contador "andou para trás": troca de medidor ou reset. Não cobramos
      // esse trecho e avisamos o administrador para conferir.
      alertas.push(`Contador do medidor ${medidorId} diminuiu em ${diaLocal(l.ts)} (${base.toFixed(3)} → ${l.energia_kwh.toFixed(3)} kWh).`);
      delta = 0;
    }
    const dia = diaLocal(l.ts);
    dias[dia] = (dias[dia] || 0) + delta;
    base = l.energia_kwh;
  }
  return { dias, alertas };
}

/**
 * Consumo e valor de um MÊS para um conjunto de medidores.
 * Resultado: { mes, kwh, valor, dias: [{dia, kwh, tarifa, valor}], alertas, porMedidor }
 */
function consumoDoMes(medidorIds, mes) {
  const inicio = inicioDiaUtc(`${mes}-01`);
  const fim = inicioDiaUtc(`${mesSeguinte(mes)}-01`);
  const tarifas = listarTarifas();
  const listaDias = diasDoMes(mes);
  const totalDia = Object.fromEntries(listaDias.map((d) => [d, 0]));
  const alertas = [];
  const porMedidor = [];

  for (const id of medidorIds) {
    const r = consumoPorDia(id, inicio, fim);
    alertas.push(...r.alertas);
    let kwh = 0, valor = 0;
    for (const [dia, k] of Object.entries(r.dias)) {
      const t = tarifaNoDia(dia, tarifas);
      totalDia[dia] = (totalDia[dia] || 0) + k;
      kwh += k;
      valor += k * (t ? t.valor_kwh : 0);
    }
    porMedidor.push({ medidor_id: id, kwh: arred(kwh, 3), valor: arred(valor, 2) });
  }

  let semTarifa = false;
  const dias = listaDias.map((dia) => {
    const t = tarifaNoDia(dia, tarifas);
    if (!t && totalDia[dia] > 0) semTarifa = true;
    const kwh = totalDia[dia];
    return { dia, kwh: arred(kwh, 3), tarifa: t ? t.valor_kwh : null, valor: arred(kwh * (t ? t.valor_kwh : 0), 2) };
  });
  if (semTarifa) alertas.push('Há consumo em dias sem tarifa cadastrada (valor considerado R$ 0,00).');

  const kwh = porMedidor.reduce((s, m) => s + m.kwh, 0);
  const valor = porMedidor.reduce((s, m) => s + m.valor, 0);
  return { mes, kwh: arred(kwh, 3), valor: arred(valor, 2), dias, alertas, porMedidor };
}

function arred(n, casas) {
  const f = 10 ** casas;
  return Math.round((n + Number.EPSILON) * f) / f;
}

module.exports = {
  diaLocal, inicioDiaUtc, mesAtual, mesAnterior, mesSeguinte, diasDoMes, validarMes,
  listarTarifas, tarifaNoDia, consumoPorDia, consumoDoMes, arred,
};
