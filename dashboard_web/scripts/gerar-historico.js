/**
 * gerar-historico.js — Cria DADOS DE DEMONSTRAÇÃO para testar o faturamento:
 * 3 clientes, 3 medidores (opta01 / IDs 33, 34, 35), 2 tarifas (com troca no
 * meio do mês passado), usuários de cliente e leituras a cada 15 min.
 *
 * Uso:  npm run historico                -> últimos 90 dias
 *       npm run historico -- --dias 30
 *
 * ATENÇÃO: só para testes. Não rode no banco de produção.
 */
const bcrypt = require('bcryptjs');
const config = require('../src/config');
const { db } = require('../src/db');
const c = require('../src/consumo');
const seg = require('../src/seguranca');

const i = process.argv.indexOf('--dias');
const DIAS = i > 0 ? Number(process.argv[i + 1]) : 90;

const clientes = [
  { nome: 'Padaria Pão Quente', documento: '12.345.678/0001-90', email: 'contato@paoquente.com.br', slave: 33, carga: 3.5 },
  { nome: 'Sala 02 — Escritório Lima', documento: '123.456.789-00', email: 'lima@exemplo.com', slave: 34, carga: 1.2 },
  { nome: 'Oficina Torque', documento: '98.765.432/0001-10', email: 'oficina@torque.com.br', slave: 35, carga: 6 },
];

const criarCliente = db.prepare('INSERT INTO clientes (nome, documento, email) VALUES (?,?,?)');
const acharMedidor = db.prepare("SELECT id FROM medidores WHERE gateway_id = 'opta01' AND slave_id = ?");
const criarMedidor = db.prepare("INSERT INTO medidores (gateway_id, slave_id, nome, modelo, cliente_id) VALUES ('opta01', ?, ?, 'FINDER_7M38', ?)");
const vincular = db.prepare('UPDATE medidores SET cliente_id = ? WHERE id = ?');
const gravar = db.prepare(`INSERT INTO leituras (medidor_id, ts, tensao_v, corrente_a, potencia_w, fp, frequencia_hz, energia_kwh)
                           VALUES (?,?,?,?,?,?,?,?)`);

const credenciais = [];
const PASSO_MS = 15 * 60_000;
const agora = Date.now();
const inicio = agora - DIAS * 86_400_000;

db.transaction(() => {
  for (const cl of clientes) {
    const clienteId = criarCliente.run(cl.nome, cl.documento, cl.email).lastInsertRowid;
    let medidor = acharMedidor.get(cl.slave);
    if (medidor) vincular.run(clienteId, medidor.id);
    else medidor = { id: criarMedidor.run(cl.slave, `Quadro ${cl.nome.split(' ')[0]}`, clienteId).lastInsertRowid };

    const senha = seg.senhaProvisoria();
    if (!db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(cl.email)) {
      db.prepare(`INSERT INTO usuarios (nome, email, senha_hash, perfil, cliente_id, trocar_senha)
                  VALUES (?,?,?,'cliente',?,1)`).run(cl.nome, cl.email, bcrypt.hashSync(senha, 10), clienteId);
      credenciais.push({ email: cl.email, senha });
    }

    // Leituras: carga maior durante o dia (7h–19h), contador sempre crescente.
    // O contador termina no mesmo valor em que o "npm run simular" começa
    // (ID 33 = 1500 kWh, 34 = 1750, 35 = 2000), para o histórico emendar sem salto.
    const linhas = [];
    let energiaKwh = 0;
    for (let t = inicio; t <= agora; t += PASSO_MS) {
      const horaLocal = new Date(t + config.FUSO_MINUTOS * 60_000).getUTCHours();
      const fator = horaLocal >= 7 && horaLocal < 19 ? 1 : 0.25;
      const corrente = cl.carga * fator * (0.7 + Math.random() * 0.6);
      const tensao = 124 + Math.random() * 6;
      const fp = 0.92 + Math.random() * 0.06;
      const potencia = tensao * corrente * fp;
      energiaKwh += (potencia * (PASSO_MS / 3_600_000)) / 1000;
      linhas.push([t, tensao, corrente, potencia, fp, energiaKwh]);
    }
    const ajuste = (1500 + (cl.slave - 33) * 250) - energiaKwh;
    for (const [t, tensao, corrente, potencia, fp, e] of linhas) {
      gravar.run(medidor.id, new Date(t).toISOString(), +tensao.toFixed(2), +corrente.toFixed(3),
        +potencia.toFixed(1), +fp.toFixed(3), +(59.95 + Math.random() * 0.1).toFixed(2), +(e + ajuste).toFixed(3));
    }
  }

  // Tarifas: uma desde o início do histórico e outra a partir do dia 15 do mês passado
  const mesPassado = c.mesAnterior(c.mesAtual());
  const tarifas = [
    { valor: 0.89, inicio: c.diaLocal(new Date(inicio).toISOString()), obs: 'Tarifa inicial (demonstração)' },
    { valor: 0.95, inicio: `${mesPassado}-15`, obs: 'Reajuste (demonstração)' },
  ];
  for (const t of tarifas) {
    if (!db.prepare('SELECT 1 FROM tarifas WHERE vigencia_inicio = ?').get(t.inicio)) {
      db.prepare('INSERT INTO tarifas (valor_kwh, vigencia_inicio, observacao) VALUES (?,?,?)').run(t.valor, t.inicio, t.obs);
    }
  }
})();

console.log(`Histórico de ${DIAS} dias criado para ${clientes.length} clientes.`);
if (credenciais.length) {
  console.log('\nUsuários de cliente (senha provisória — trocar no 1º login):');
  for (const cr of credenciais) console.log(`  ${cr.email}  /  ${cr.senha}`);
}
