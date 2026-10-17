/**
 * tempoReal.js — WebSocket autenticado.
 * Só aceita conexões com login completo, vindas do próprio site.
 * O administrador recebe todos os medidores; o cliente, só os dele.
 */
const { WebSocketServer, WebSocket } = require('ws');
const { db } = require('./db');
const { sessaoDaRequisicao } = require('./auth');
const tel = require('./telemetria');

const sqlMedidoresDoCliente = db.prepare('SELECT id FROM medidores WHERE cliente_id = ? AND ativo = 1');

function iniciarTempoReal(servidorHttp) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  servidorHttp.on('upgrade', (req, socket, cabeca) => {
    // 1) Bloqueia conexões abertas por outros sites (Cross-Site WebSocket Hijacking)
    let hostOrigem = null;
    try { hostOrigem = new URL(req.headers.origin).host; } catch { /* sem origem válida */ }
    if (!hostOrigem || hostOrigem !== req.headers.host) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    // 2) Exige login completo
    const s = sessaoDaRequisicao(req);
    if (!s || s.etapa !== 'completa') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, cabeca, (ws) => {
      ws.usuario = { id: s.id, perfil: s.perfil, cliente_id: s.cliente_id };
      ws.requisicao = req;
      wss.emit('connection', ws);
    });
  });

  /** O usuário pode ver este medidor? */
  const podeVer = (ws, medidor) =>
    ws.usuario.perfil === 'admin' || (medidor.cliente_id && medidor.cliente_id === ws.usuario.cliente_id);

  wss.on('connection', (ws) => {
    // Estado inicial: últimas leituras dos medidores que o usuário pode ver
    const ids = ws.usuario.perfil === 'admin'
      ? [...tel.aoVivo.keys()]
      : sqlMedidoresDoCliente.all(ws.usuario.cliente_id).map((m) => m.id);
    const medidores = ids
      .filter((id) => tel.aoVivo.has(id))
      .map((id) => ({ medidor_id: id, historico: tel.aoVivo.get(id).historico }));
    ws.send(JSON.stringify({
      tipo: 'estado_inicial',
      medidores,
      mqtt: ws.usuario.perfil === 'admin' ? tel.statusMqtt : undefined,
    }));
    // O navegador não envia comandos por aqui: qualquer mensagem é ignorada.
    ws.on('message', () => {});
  });

  function enviar(filtro, mensagem) {
    const texto = JSON.stringify(mensagem);
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN && filtro(ws)) ws.send(texto);
    }
  }

  tel.eventos.on('leitura', ({ medidor, leitura }) => {
    enviar((ws) => podeVer(ws, medidor), { tipo: 'leitura', medidor_id: medidor.id, leitura });
  });
  tel.eventos.on('mqtt', (st) => enviar((ws) => ws.usuario.perfil === 'admin', { tipo: 'mqtt', ...st }));
  tel.eventos.on('gateway', (g) => enviar((ws) => ws.usuario.perfil === 'admin', { tipo: 'gateway', ...g }));
  tel.eventos.on('medidores_alterados', () =>
    enviar((ws) => ws.usuario.perfil === 'admin', { tipo: 'medidores_alterados' }));

  // A cada minuto: derruba conexões cuja sessão expirou ou foi encerrada (logout)
  setInterval(() => {
    for (const ws of wss.clients) {
      const s = sessaoDaRequisicao(ws.requisicao);
      if (!s || s.etapa !== 'completa') ws.close(4001, 'Sessão encerrada');
    }
  }, 60_000).unref();

  return wss;
}

module.exports = { iniciarTempoReal };
