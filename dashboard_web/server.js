/**
 * ===============================================================================
 * PROJETO: Telemetria de Energia — Servidor Web (Node.js)
 * ARQUIVO: server.js
 *
 *  ESP32/OPTA ──MQTT──► este servidor ──► SQLite (dados/telemetria.db)
 *                                   └──► site: login verificado (senha + 2FA),
 *                                        painel do administrador e do cliente
 *
 * Configurações: arquivo .env (copie de .env.exemplo).
 * ===============================================================================
 */
const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');

const config = require('./src/config');
require('./src/db'); // cria as tabelas
const auth = require('./src/auth');
const rotas = require('./src/rotas');
const tel = require('./src/telemetria');
const { iniciarTempoReal } = require('./src/tempoReal');

const app = express();
app.disable('x-powered-by');
// Se o site ficar atrás de um proxy/túnel (Cloudflare, Nginx), use TRUST_PROXY=true
// para o servidor enxergar o IP real de quem acessa.
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

// Cabeçalhos de segurança. O CSP só permite scripts/estilos do próprio site.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'upgrade-insecure-requests': config.COOKIE_SEGURO ? [] : null,
    },
  },
  hsts: config.COOKIE_SEGURO,
}));
app.use(express.json({ limit: '20kb' }));

// ---------------------------------------------------------------- API
app.use('/api', auth.protegerCsrf);
app.use('/api/auth', auth.rotas);
app.use('/api/admin', rotas.admin);
app.use('/api/cliente', rotas.cliente);
app.use('/api', (req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

// ---------------------------------------------------------------- Páginas
/** Leva cada usuário para a página certa conforme o login. */
function paginaInicial(req) {
  const s = auth.sessaoDaRequisicao(req);
  if (!s || s.etapa !== 'completa') return '/login.html';
  return s.perfil === 'admin' ? '/admin.html' : '/cliente.html';
}
app.get('/', (req, res) => res.redirect(paginaInicial(req)));

// As páginas internas só são entregues para quem tem login completo e o perfil certo
function protegerPagina(perfil) {
  return (req, res, next) => {
    const s = auth.sessaoDaRequisicao(req);
    if (!s || s.etapa !== 'completa') return res.redirect('/login.html');
    if (s.perfil !== perfil) return res.redirect(paginaInicial(req));
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
}
app.get('/admin.html', protegerPagina('admin'));
app.get('/cliente.html', protegerPagina('cliente'));
app.get('/login.html', (req, res, next) => {
  const destino = paginaInicial(req);
  if (destino !== '/login.html') return res.redirect(destino);
  next();
});

// Chart.js servido do próprio servidor (funciona sem internet e respeita o CSP)
app.get('/vendor/chart.umd.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js')));
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon.svg')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Erros inesperados: registra no console e não expõe detalhes ao navegador
app.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.' });
  console.error('[ERRO]', err);
  res.status(500).json({ erro: 'Erro interno no servidor.' });
});

// ---------------------------------------------------------------- Início
auth.garantirAdministrador();
tel.carregarUltimasLeituras();
tel.iniciarMqtt();

const servidor = http.createServer(app);
iniciarTempoReal(servidor);

servidor.listen(config.PORTA_HTTP, '0.0.0.0', () => {
  console.log('================================================================');
  console.log(`  ${config.NOME_SISTEMA} — servidor iniciado`);
  console.log(`  Acesse: http://localhost:${config.PORTA_HTTP}`);
  console.log(`  MQTT: ${tel.statusMqtt.broker}  |  Prefixo: ${config.PREFIXO}`);
  console.log(`  Banco: ${config.ARQUIVO_BANCO}`);
  console.log('================================================================');
});
