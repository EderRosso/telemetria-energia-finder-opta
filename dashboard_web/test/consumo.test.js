// Testes do cálculo de consumo e valor — rode com: npm test
process.env.ARQUIVO_BANCO = ':memory:';
process.env.FUSO_MINUTOS = '-180';
const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../src/db');
const c = require('../src/consumo');

const medidor = db.prepare("INSERT INTO medidores (gateway_id, slave_id, nome) VALUES ('t', 1, 'Teste')").run().lastInsertRowid;
const ler = (tsLocal, kwh) => {
  // tsLocal em horário de Brasília -> grava em UTC
  const utc = new Date(new Date(tsLocal + 'Z').getTime() + 3 * 3_600_000).toISOString();
  db.prepare('INSERT INTO leituras (medidor_id, ts, energia_kwh) VALUES (?,?,?)').run(medidor, utc, kwh);
};

// Fim de setembro, outubro inteiro e início de novembro
ler('2026-09-30T23:50:00', 1000);   // última leitura antes de outubro = base
ler('2026-10-01T00:10:00', 1001);   // 1 kWh em 01/10 (passou da meia-noite local)
ler('2026-10-01T12:00:00', 1011);   // +10 -> 11 kWh em 01/10
ler('2026-10-15T08:00:00', 1111);   // +100 em 15/10
ler('2026-10-20T08:00:00', 1131);   // +20 em 20/10
ler('2026-10-25T08:00:00', 5);      // contador diminuiu (troca de medidor): não cobra, gera alerta
ler('2026-10-26T08:00:00', 15);     // +10 em 26/10
ler('2026-11-01T01:00:00', 25);     // novembro: fora do período

db.prepare("INSERT INTO tarifas (valor_kwh, vigencia_inicio) VALUES (0.80, '2026-01-01'), (1.00, '2026-10-15')").run();

test('dia local respeita o fuso de Brasília', () => {
  assert.strictEqual(c.diaLocal('2026-10-01T02:59:00Z'), '2026-09-30');
  assert.strictEqual(c.diaLocal('2026-10-01T03:00:00Z'), '2026-10-01');
  assert.strictEqual(c.inicioDiaUtc('2026-10-01'), '2026-10-01T03:00:00.000Z');
});

test('consumo do mês usa o contador e a tarifa de cada dia', () => {
  const r = c.consumoDoMes([medidor], '2026-10');
  // 11 (01/10) + 100 (15/10) + 20 (20/10) + 0 (reset) + 10 (26/10) = 141 kWh
  assert.strictEqual(r.kwh, 141);
  // 11 × 0,80 (antes do reajuste) + 130 × 1,00 = 138,80
  assert.strictEqual(r.valor, 138.8);
  assert.strictEqual(r.dias.length, 31);
  assert.strictEqual(r.dias[0].kwh, 11);
  assert.strictEqual(r.dias[14].tarifa, 1);
  assert.strictEqual(r.alertas.length, 1, 'deve avisar que o contador diminuiu');
});

test('meses vizinhos e mês sem leituras', () => {
  assert.strictEqual(c.consumoDoMes([medidor], '2026-11').kwh, 10);
  assert.strictEqual(c.consumoDoMes([medidor], '2026-08').kwh, 0);
  assert.strictEqual(c.mesAnterior('2026-01'), '2025-12');
  assert.strictEqual(c.mesSeguinte('2026-12'), '2027-01');
});
