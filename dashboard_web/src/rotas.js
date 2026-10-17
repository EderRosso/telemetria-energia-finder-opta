/**
 * rotas.js — API REST do painel.
 *   /api/admin/...    só administrador
 *   /api/cliente/...  só cliente (sempre filtrado pelo cliente do login)
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, auditar } = require('./db');
const { exigirLogin } = require('./auth');
const seg = require('./seguranca');
const c = require('./consumo');
const tel = require('./telemetria');

const hojeLocal = () => c.diaLocal(new Date().toISOString());
const texto = (v, max = 120) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const erro = (res, status, mensagem) => res.status(status).json({ erro: mensagem });

function mesDaConsulta(req) {
  const mes = req.query.mes;
  return c.validarMes(mes) ? mes : c.mesAtual();
}

function medidorComAoVivo(m) {
  const e = tel.aoVivo.get(m.id);
  return { ...m, online: tel.estaOnline(m.id), ultima: e ? e.ultima : null };
}

// ============================================================================
// ADMINISTRADOR
// ============================================================================
const admin = express.Router();
admin.use(exigirLogin('admin'));

admin.get('/resumo', (req, res) => {
  const mes = mesDaConsulta(req);
  const medidores = db.prepare(`
    SELECT m.*, cl.nome AS cliente_nome FROM medidores m
      LEFT JOIN clientes cl ON cl.id = m.cliente_id
     ORDER BY m.ativo DESC, cl.nome, m.nome`).all().map(medidorComAoVivo);
  const consumo = c.consumoDoMes(medidores.map((m) => m.id), mes);
  const porId = Object.fromEntries(consumo.porMedidor.map((p) => [p.medidor_id, p]));
  for (const m of medidores) {
    m.kwh_mes = porId[m.id]?.kwh ?? 0;
    m.valor_mes = porId[m.id]?.valor ?? 0;
  }
  res.json({
    mes,
    tarifa_vigente: c.tarifaNoDia(hojeLocal()),
    totais: {
      kwh: consumo.kwh,
      valor: consumo.valor,
      medidores: medidores.filter((m) => m.ativo).length,
      online: medidores.filter((m) => m.ativo && m.online).length,
      sem_cliente: medidores.filter((m) => m.ativo && !m.cliente_id).length,
    },
    dias: consumo.dias,
    medidores,
    alertas: consumo.alertas,
    mqtt: tel.statusMqtt,
  });
});

// ---------------- Clientes ----------------
admin.get('/clientes', (req, res) => {
  res.json(db.prepare(`
    SELECT cl.*, (SELECT COUNT(*) FROM medidores m WHERE m.cliente_id = cl.id) AS qtd_medidores
      FROM clientes cl ORDER BY cl.ativo DESC, cl.nome`).all());
});

function lerCliente(body) {
  const dados = {
    nome: texto(body.nome), documento: texto(body.documento, 30),
    email: texto(body.email), telefone: texto(body.telefone, 30),
  };
  if (!dados.nome) return { falha: 'Informe o nome do cliente.' };
  return { dados };
}

admin.post('/clientes', (req, res) => {
  const { dados, falha } = lerCliente(req.body || {});
  if (falha) return erro(res, 400, falha);
  const r = db.prepare('INSERT INTO clientes (nome, documento, email, telefone) VALUES (@nome,@documento,@email,@telefone)').run(dados);
  auditar({ usuario_id: req.usuario.id, email: req.usuario.email, acao: 'cliente_criado', detalhe: dados.nome, ip: req.ip });
  res.status(201).json({ id: r.lastInsertRowid });
});

admin.put('/clientes/:id', (req, res) => {
  const { dados, falha } = lerCliente(req.body || {});
  if (falha) return erro(res, 400, falha);
  dados.ativo = req.body.ativo === false ? 0 : 1;
  dados.id = Number(req.params.id);
  const r = db.prepare(`UPDATE clientes SET nome=@nome, documento=@documento, email=@email,
                        telefone=@telefone, ativo=@ativo WHERE id=@id`).run(dados);
  if (!r.changes) return erro(res, 404, 'Cliente não encontrado.');
  auditar({ usuario_id: req.usuario.id, email: req.usuario.email, acao: 'cliente_alterado', detalhe: dados.nome, ip: req.ip });
  res.json({ ok: true });
});

// ---------------- Medidores ----------------
admin.get('/medidores', (req, res) => {
  res.json(db.prepare(`
    SELECT m.*, cl.nome AS cliente_nome FROM medidores m
      LEFT JOIN clientes cl ON cl.id = m.cliente_id ORDER BY m.gateway_id, m.slave_id`).all().map(medidorComAoVivo));
});

admin.put('/medidores/:id', (req, res) => {
  const b = req.body || {};
  const nome = texto(b.nome);
  if (!nome) return erro(res, 400, 'Informe o nome do medidor.');
  const clienteId = b.cliente_id ? Number(b.cliente_id) : null;
  if (clienteId && !db.prepare('SELECT 1 FROM clientes WHERE id = ?').get(clienteId)) {
    return erro(res, 400, 'Cliente inválido.');
  }
  const r = db.prepare('UPDATE medidores SET nome = ?, cliente_id = ?, ativo = ? WHERE id = ?')
    .run(nome, clienteId, b.ativo === false ? 0 : 1, Number(req.params.id));
  if (!r.changes) return erro(res, 404, 'Medidor não encontrado.');
  auditar({ usuario_id: req.usuario.id, email: req.usuario.email, acao: 'medidor_alterado',
    detalhe: `#${req.params.id} ${nome} → cliente ${clienteId ?? '-'}`, ip: req.ip });
  res.json({ ok: true });
});

// ---------------- Tarifas ----------------
admin.get('/tarifas', (req, res) => {
  const hoje = hojeLocal();
  const vigente = c.tarifaNoDia(hoje);
  res.json(c.listarTarifas().reverse().map((t) => ({
    ...t,
    situacao: t.vigencia_inicio > hoje ? 'futura' : vigente && t.id === vigente.id ? 'vigente' : 'encerrada',
  })));
});

admin.post('/tarifas', (req, res) => {
  const valor = Number(String(req.body?.valor_kwh ?? '').replace(',', '.'));
  const inicio = texto(req.body?.vigencia_inicio, 10);
  if (!Number.isFinite(valor) || valor <= 0 || valor > 100) return erro(res, 400, 'Valor do kWh inválido.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio)) return erro(res, 400, 'Data de início inválida.');
  if (db.prepare('SELECT 1 FROM tarifas WHERE vigencia_inicio = ?').get(inicio)) {
    return erro(res, 400, 'Já existe uma tarifa começando nesta data.');
  }
  db.prepare('INSERT INTO tarifas (valor_kwh, vigencia_inicio, observacao, criado_por) VALUES (?,?,?,?)')
    .run(valor, inicio, texto(req.body?.observacao, 200), req.usuario.id);
  auditar({ usuario_id: req.usuario.id, email: req.usuario.email, acao: 'tarifa_criada',
    detalhe: `R$ ${valor}/kWh a partir de ${inicio}`, ip: req.ip });
  res.status(201).json({ ok: true });
});

/** Só é possível excluir tarifa que ainda não começou (as usadas ficam no histórico). */
admin.delete('/tarifas/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tarifas WHERE id = ?').get(Number(req.params.id));
  if (!t) return erro(res, 404, 'Tarifa não encontrada.');
  if (t.vigencia_inicio <= hojeLocal()) return erro(res, 400, 'Tarifas já em uso não podem ser excluídas. Cadastre uma nova vigência.');
  db.prepare('DELETE FROM tarifas WHERE id = ?').run(t.id);
  auditar({ usuario_id: req.usuario.id, email: req.usuario.email, acao: 'tarifa_excluida',
    detalhe: `R$ ${t.valor_kwh} de ${t.vigencia_inicio}`, ip: req.ip });
  res.json({ ok: true });
});

// ---------------- Usuários ----------------
admin.get('/usuarios', (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.nome, u.email, u.perfil, u.cliente_id, cl.nome AS cliente_nome, u.ativo,
           u.trocar_senha, u.totp_ativo, u.ultimo_login, u.bloqueado_ate
      FROM usuarios u LEFT JOIN clientes cl ON cl.id = u.cliente_id ORDER BY u.perfil, u.nome`).all());
});

admin.post('/usuarios', (req, res) => {
  const b = req.body || {};
  const nome = texto(b.nome);
  const email = texto(b.email).toLowerCase();
  const perfil = b.perfil === 'admin' ? 'admin' : 'cliente';
  const clienteId = perfil === 'cliente' ? Number(b.cliente_id) || null : null;
  if (!nome) return erro(res, 400, 'Informe o nome.');
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return erro(res, 400, 'E-mail inválido.');
  if (perfil === 'cliente' && !clienteId) return erro(res, 400, 'Escolha o cliente deste usuário.');
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) return erro(res, 400, 'Já existe um usuário com este e-mail.');
  const senha = seg.senhaProvisoria();
  db.prepare(`INSERT INTO usuarios (nome, email, senha_hash, perfil, cliente_id, trocar_senha)
              VALUES (?,?,?,?,?,1)`).run(nome, email, bcrypt.hashSync(senha, 12), perfil, clienteId);
  auditar({ usuario_id: req.usuario.id, email: req.usuario.email, acao: 'usuario_criado', detalhe: `${email} (${perfil})`, ip: req.ip });
  // A senha provisória aparece UMA vez para o admin repassar ao usuário
  res.status(201).json({ senha_provisoria: senha });
});

function buscarUsuario(req, res) {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(req.params.id));
  if (!u) erro(res, 404, 'Usuário não encontrado.');
  return u;
}

admin.post('/usuarios/:id/redefinir-senha', (req, res) => {
  const u = buscarUsuario(req, res); if (!u) return;
  const senha = seg.senhaProvisoria();
  db.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 1, falhas_login = 0, bloqueado_ate = NULL WHERE id = ?')
    .run(bcrypt.hashSync(senha, 12), u.id);
  db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(u.id);
  auditar({ usuario_id: req.usuario.id, email: req.usuario.email, acao: 'senha_redefinida', detalhe: u.email, ip: req.ip });
  res.json({ senha_provisoria: senha });
});

/** Para quando o usuário troca/perde o celular: no próximo login ele cadastra o 2FA de novo. */
admin.post('/usuarios/:id/resetar-2fa', (req, res) => {
  const u = buscarUsuario(req, res); if (!u) return;
  db.prepare('UPDATE usuarios SET totp_segredo = NULL, totp_ativo = 0, totp_ultimo_passo = 0 WHERE id = ?').run(u.id);
  db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(u.id);
  auditar({ usuario_id: req.usuario.id, email: req.usuario.email, acao: '2fa_resetado', detalhe: u.email, ip: req.ip });
  res.json({ ok: true });
});

admin.put('/usuarios/:id', (req, res) => {
  const u = buscarUsuario(req, res); if (!u) return;
  const ativo = req.body?.ativo === false ? 0 : 1;
  if (u.id === req.usuario.id && !ativo) return erro(res, 400, 'Você não pode desativar o próprio usuário.');
  db.prepare('UPDATE usuarios SET ativo = ? WHERE id = ?').run(ativo, u.id);
  if (!ativo) db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(u.id);
  auditar({ usuario_id: req.usuario.id, email: req.usuario.email, acao: ativo ? 'usuario_ativado' : 'usuario_desativado', detalhe: u.email, ip: req.ip });
  res.json({ ok: true });
});

// ---------------- Faturamento ----------------
function montarFaturamento(mes) {
  const clientes = db.prepare('SELECT * FROM clientes ORDER BY nome').all();
  const linhas = [];
  for (const cl of clientes) {
    const meds = db.prepare('SELECT id, nome FROM medidores WHERE cliente_id = ?').all(cl.id);
    if (!meds.length) continue;
    const r = c.consumoDoMes(meds.map((m) => m.id), mes);
    linhas.push({ cliente_id: cl.id, cliente: cl.nome, documento: cl.documento,
      medidores: meds.map((m) => m.nome).join(', '), kwh: r.kwh, valor: r.valor, alertas: r.alertas });
  }
  const total = linhas.reduce((s, l) => ({ kwh: s.kwh + l.kwh, valor: s.valor + l.valor }), { kwh: 0, valor: 0 });
  return { mes, linhas, total: { kwh: c.arred(total.kwh, 3), valor: c.arred(total.valor, 2) } };
}

admin.get('/faturamento', (req, res) => res.json(montarFaturamento(mesDaConsulta(req))));

admin.get('/faturamento.csv', (req, res) => {
  const f = montarFaturamento(mesDaConsulta(req));
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/^[=+\-@]/, "'$&")}"`;
  const num = (n, casas) => n.toFixed(casas).replace('.', ',');
  const linhas = [['Mes', 'Cliente', 'Documento', 'Medidores', 'Consumo (kWh)', 'Valor (R$)'].map(esc).join(';')];
  for (const l of f.linhas) {
    linhas.push([f.mes, l.cliente, l.documento, l.medidores, num(l.kwh, 3), num(l.valor, 2)].map(esc).join(';'));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="faturamento_${f.mes}.csv"`);
  res.send('﻿' + linhas.join('\r\n'));
});

/** Consumo diário de um cliente (o admin usa para conferir). */
admin.get('/consumo', (req, res) => {
  const ids = db.prepare('SELECT id FROM medidores WHERE cliente_id = ?').all(Number(req.query.cliente_id)).map((m) => m.id);
  res.json(c.consumoDoMes(ids, mesDaConsulta(req)));
});

admin.get('/auditoria', (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 200, 1000);
  res.json(db.prepare('SELECT * FROM auditoria ORDER BY id DESC LIMIT ?').all(limite));
});

// ============================================================================
// CLIENTE — tudo filtrado pelo cliente_id do login (nunca pelo que vem na URL)
// ============================================================================
const cliente = express.Router();
cliente.use(exigirLogin('cliente'));

function medidoresDoCliente(req) {
  if (!req.usuario.cliente_id) return [];
  let lista = db.prepare('SELECT id, nome, gateway_id, slave_id FROM medidores WHERE cliente_id = ? AND ativo = 1 ORDER BY nome')
    .all(req.usuario.cliente_id);
  const filtro = Number(req.query.medidor_id);
  if (filtro) lista = lista.filter((m) => m.id === filtro); // só se o medidor for dele
  return lista;
}

cliente.get('/resumo', (req, res) => {
  const mes = mesDaConsulta(req);
  const todos = db.prepare('SELECT id, nome FROM medidores WHERE cliente_id = ? AND ativo = 1 ORDER BY nome')
    .all(req.usuario.cliente_id || 0).map(medidorComAoVivo);
  const ids = medidoresDoCliente(req).map((m) => m.id);
  const atual = c.consumoDoMes(ids, mes);
  const anterior = c.consumoDoMes(ids, c.mesAnterior(mes));
  const dadosCliente = db.prepare('SELECT nome FROM clientes WHERE id = ?').get(req.usuario.cliente_id || 0);
  res.json({
    cliente: dadosCliente ? dadosCliente.nome : '',
    usuario: req.usuario.nome,
    mes,
    medidores: todos,
    consumo: { kwh: atual.kwh, valor: atual.valor, dias: atual.dias },
    anterior: { mes: anterior.mes, kwh: anterior.kwh, valor: anterior.valor },
    tarifa_vigente: c.tarifaNoDia(hojeLocal()),
  });
});

cliente.get('/historico', (req, res) => {
  const ids = medidoresDoCliente(req).map((m) => m.id);
  const meses = [];
  let mes = c.mesAtual();
  for (let i = 0; i < 12; i++) {
    const r = c.consumoDoMes(ids, mes);
    const tarifas = r.dias.filter((d) => d.tarifa !== null).map((d) => d.tarifa);
    meses.push({ mes, kwh: r.kwh, valor: r.valor, tarifa_media: r.kwh ? c.arred(r.valor / r.kwh, 4) : (tarifas.at(-1) ?? null) });
    mes = c.mesAnterior(mes);
  }
  res.json(meses);
});

module.exports = { admin, cliente };
