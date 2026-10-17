/**
 * auth.js — Login verificado em etapas:
 *
 *   1. E-mail + senha
 *   2. (1º acesso) troca da senha provisória
 *   3. (1º acesso) cadastro do 2FA: lê o QR Code no Google/Microsoft Authenticator
 *   4. Código de 6 dígitos do aplicativo  -> sessão completa
 *
 * Proteções: senha com bcrypt, bloqueio após 5 erros, limite de tentativas por IP,
 * código 2FA que não pode ser reutilizado, cookie HttpOnly + SameSite=Strict,
 * token de sessão trocado ao concluir o login, registro de auditoria.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const config = require('./config');
const { db, auditar } = require('./db');
const seg = require('./seguranca');

const NOME_COOKIE = 'sessao';
const MAX_FALHAS = 5;                 // erros de senha antes de bloquear a conta
const BLOQUEIO_MIN = 15;              // tempo de bloqueio
const MAX_TENTATIVAS_CODIGO = 5;      // erros de código 2FA por sessão
const MINUTOS_LOGIN_PENDENTE = 10;    // tempo para concluir as etapas do login

const limitadorIp = seg.criarLimitador({ maximo: 20, janelaMs: 15 * 60_000 });
// Hash "falso" para gastar o mesmo tempo quando o e-mail não existe
const HASH_FALSO = bcrypt.hashSync('senha-que-nao-existe', 12);

// ----------------------------------------------------------------------------
// Sessões
// ----------------------------------------------------------------------------
const agoraIso = () => new Date().toISOString();
const futuroIso = (ms) => new Date(Date.now() + ms).toISOString();

function lerCookie(req, nome) {
  const cabecalho = req.headers.cookie || '';
  for (const parte of cabecalho.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) return decodeURIComponent(v.join('='));
  }
  return null;
}

function gravarCookie(res, token, maxAgeMs) {
  const partes = [
    `${NOME_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (config.COOKIE_SEGURO) partes.push('Secure');
  res.setHeader('Set-Cookie', partes.join('; '));
}

function apagarCookie(res) {
  res.setHeader('Set-Cookie', `${NOME_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function criarSessao(res, usuarioId, etapa, ip) {
  const token = seg.novoToken();
  const duracaoMs = etapa === 'completa'
    ? config.SESSAO_HORAS * 3_600_000
    : MINUTOS_LOGIN_PENDENTE * 60_000;
  db.prepare('INSERT INTO sessoes (token_hash, usuario_id, etapa, expira_em, ip) VALUES (?,?,?,?,?)')
    .run(seg.hashToken(token), usuarioId, etapa, futuroIso(duracaoMs), ip);
  gravarCookie(res, token, duracaoMs);
}

/** Busca a sessão (e o usuário) a partir do cookie. Usado pela API e pelo WebSocket. */
function sessaoDaRequisicao(req) {
  const token = lerCookie(req, NOME_COOKIE);
  if (!token) return null;
  const hash = seg.hashToken(token);
  const s = db.prepare(`
    SELECT s.token_hash, s.etapa, s.tentativas, s.expira_em,
           u.id, u.nome, u.email, u.perfil, u.cliente_id, u.ativo, u.trocar_senha,
           u.totp_ativo, u.totp_segredo, u.totp_ultimo_passo
      FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
     WHERE s.token_hash = ?`).get(hash);
  if (!s) return null;
  if (s.expira_em < agoraIso() || !s.ativo) {
    db.prepare('DELETE FROM sessoes WHERE token_hash = ?').run(hash);
    return null;
  }
  return s;
}

/** Próxima etapa do login para este usuário. */
function proximaEtapa(u) {
  if (u.trocar_senha) return 'trocar_senha';
  if (!u.totp_ativo) return 'configurar_2fa';
  return 'codigo';
}

/** Conclui o login: apaga a sessão provisória e cria uma nova (novo token). */
function concluirLogin(req, res, sessao) {
  db.prepare('DELETE FROM sessoes WHERE token_hash = ?').run(sessao.token_hash);
  db.prepare('UPDATE usuarios SET ultimo_login = ? WHERE id = ?').run(agoraIso(), sessao.id);
  criarSessao(res, sessao.id, 'completa', req.ip);
  auditar({ usuario_id: sessao.id, email: sessao.email, acao: 'login_ok', ip: req.ip });
}

// Limpa sessões vencidas de hora em hora
setInterval(() => db.prepare('DELETE FROM sessoes WHERE expira_em < ?').run(agoraIso()), 3_600_000).unref();

// ----------------------------------------------------------------------------
// Middlewares
// ----------------------------------------------------------------------------

/** Exige login COMPLETO (senha + 2FA). Opcionalmente exige um perfil. */
function exigirLogin(perfil = null) {
  return (req, res, next) => {
    const s = sessaoDaRequisicao(req);
    if (!s || s.etapa !== 'completa') return res.status(401).json({ erro: 'Faça login para continuar.' });
    if (perfil && s.perfil !== perfil) return res.status(403).json({ erro: 'Acesso não permitido para este perfil.' });
    req.usuario = { id: s.id, nome: s.nome, email: s.email, perfil: s.perfil, cliente_id: s.cliente_id };
    next();
  };
}

/**
 * Proteção contra CSRF: requisições que alteram dados precisam do cabeçalho
 * X-Requested-With: fetch (um site de terceiros não consegue enviá-lo).
 * Junto com o cookie SameSite=Strict, isso bloqueia ataques de outro domínio.
 */
function protegerCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'fetch') {
    return res.status(403).json({ erro: 'Requisição bloqueada (CSRF).' });
  }
  next();
}

/** Exige uma sessão provisória numa etapa específica do login. */
function exigirEtapa(etapa) {
  return (req, res, next) => {
    const s = sessaoDaRequisicao(req);
    if (!s || s.etapa !== etapa) {
      return res.status(401).json({ erro: 'Sessão de login expirada. Entre novamente.', reiniciar: true });
    }
    req.sessao = s;
    next();
  };
}

// ----------------------------------------------------------------------------
// Rotas /api/auth
// ----------------------------------------------------------------------------
const rotas = express.Router();

rotas.post('/login', async (req, res) => {
  if (!limitadorIp.consumir(req.ip)) {
    return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos.' });
  }
  const email = String(req.body?.email || '').trim().toLowerCase();
  const senha = String(req.body?.senha || '');
  const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);

  const senhaOk = await bcrypt.compare(senha, u ? u.senha_hash : HASH_FALSO);
  const MSG_GENERICA = 'E-mail ou senha incorretos.';

  if (!u) {
    auditar({ email, acao: 'login_falhou', detalhe: 'e-mail inexistente', ip: req.ip });
    return res.status(401).json({ erro: MSG_GENERICA });
  }
  if (u.bloqueado_ate && u.bloqueado_ate > agoraIso()) {
    const min = Math.ceil((new Date(u.bloqueado_ate) - Date.now()) / 60_000);
    return res.status(423).json({ erro: `Conta bloqueada por excesso de tentativas. Tente novamente em ${min} min.` });
  }
  if (!senhaOk || !u.ativo) {
    const falhas = u.falhas_login + 1;
    if (falhas >= MAX_FALHAS) {
      db.prepare('UPDATE usuarios SET falhas_login = 0, bloqueado_ate = ? WHERE id = ?')
        .run(futuroIso(BLOQUEIO_MIN * 60_000), u.id);
      auditar({ usuario_id: u.id, email, acao: 'conta_bloqueada', ip: req.ip });
    } else {
      db.prepare('UPDATE usuarios SET falhas_login = ? WHERE id = ?').run(falhas, u.id);
    }
    auditar({ usuario_id: u.id, email, acao: 'login_falhou', detalhe: u.ativo ? 'senha incorreta' : 'usuário desativado', ip: req.ip });
    return res.status(401).json({ erro: MSG_GENERICA });
  }

  db.prepare('UPDATE usuarios SET falhas_login = 0, bloqueado_ate = NULL WHERE id = ?').run(u.id);
  const etapa = proximaEtapa(u);
  criarSessao(res, u.id, etapa, req.ip);
  res.json({ etapa });
});

/** Estado atual do login (o front usa para decidir qual tela mostrar). */
rotas.get('/estado', (req, res) => {
  const s = sessaoDaRequisicao(req);
  if (!s) return res.status(401).json({ etapa: 'login' });
  res.json({
    etapa: s.etapa,
    usuario: s.etapa === 'completa'
      ? { nome: s.nome, email: s.email, perfil: s.perfil }
      : { nome: s.nome },
  });
});

/** 1º acesso: troca a senha provisória. */
rotas.post('/trocar-senha-provisoria', exigirEtapa('trocar_senha'), async (req, res) => {
  const nova = String(req.body?.senha_nova || '');
  const erro = seg.validarSenhaNova(nova);
  if (erro) return res.status(400).json({ erro });
  const atual = db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(req.sessao.id);
  if (await bcrypt.compare(nova, atual.senha_hash)) {
    return res.status(400).json({ erro: 'A nova senha deve ser diferente da provisória.' });
  }
  db.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 0 WHERE id = ?')
    .run(await bcrypt.hash(nova, 12), req.sessao.id);
  auditar({ usuario_id: req.sessao.id, email: req.sessao.email, acao: 'senha_definida', ip: req.ip });
  const etapa = req.sessao.totp_ativo ? 'codigo' : 'configurar_2fa';
  db.prepare('UPDATE sessoes SET etapa = ? WHERE token_hash = ?').run(etapa, req.sessao.token_hash);
  res.json({ etapa });
});

/** 1º acesso: gera o QR Code do 2FA. */
rotas.get('/2fa/configurar', exigirEtapa('configurar_2fa'), async (req, res) => {
  let segredo;
  if (req.sessao.totp_segredo) {
    segredo = seg.decifrar(req.sessao.totp_segredo); // mantém o mesmo QR se a página recarregar
  } else {
    segredo = seg.gerarSegredoTotp();
    db.prepare('UPDATE usuarios SET totp_segredo = ? WHERE id = ?').run(seg.cifrar(segredo), req.sessao.id);
  }
  const uri = seg.uriOtpAuth(segredo, req.sessao.email);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
  res.json({ qr, segredo: segredo.match(/.{1,4}/g).join(' ') });
});

/** 1º acesso: confirma o primeiro código e ativa o 2FA. */
rotas.post('/2fa/ativar', exigirEtapa('configurar_2fa'), (req, res) => {
  const s = req.sessao;
  if (!s.totp_segredo) return res.status(400).json({ erro: 'Gere o QR Code primeiro.' });
  const passo = seg.verificarTotp(seg.decifrar(s.totp_segredo), req.body?.codigo, s.totp_ultimo_passo);
  if (passo === null) return registrarErroCodigo(req, res);
  db.prepare('UPDATE usuarios SET totp_ativo = 1, totp_ultimo_passo = ? WHERE id = ?').run(passo, s.id);
  auditar({ usuario_id: s.id, email: s.email, acao: '2fa_ativado', ip: req.ip });
  concluirLogin(req, res, s);
  res.json({ etapa: 'completa', perfil: s.perfil });
});

/** Login normal: confere o código do aplicativo. */
rotas.post('/2fa/verificar', exigirEtapa('codigo'), (req, res) => {
  const s = req.sessao;
  const passo = seg.verificarTotp(seg.decifrar(s.totp_segredo), req.body?.codigo, s.totp_ultimo_passo);
  if (passo === null) return registrarErroCodigo(req, res);
  db.prepare('UPDATE usuarios SET totp_ultimo_passo = ? WHERE id = ?').run(passo, s.id);
  concluirLogin(req, res, s);
  res.json({ etapa: 'completa', perfil: s.perfil });
});

function registrarErroCodigo(req, res) {
  const s = req.sessao;
  const tentativas = s.tentativas + 1;
  auditar({ usuario_id: s.id, email: s.email, acao: '2fa_codigo_invalido', ip: req.ip });
  if (tentativas >= MAX_TENTATIVAS_CODIGO) {
    db.prepare('DELETE FROM sessoes WHERE token_hash = ?').run(s.token_hash);
    apagarCookie(res);
    return res.status(401).json({ erro: 'Muitos códigos inválidos. Entre novamente.', reiniciar: true });
  }
  db.prepare('UPDATE sessoes SET tentativas = ? WHERE token_hash = ?').run(tentativas, s.token_hash);
  res.status(401).json({ erro: `Código inválido. Restam ${MAX_TENTATIVAS_CODIGO - tentativas} tentativas.` });
}

/** Usuário logado troca a própria senha (encerra as outras sessões). */
rotas.post('/trocar-senha', exigirLogin(), async (req, res) => {
  const { senha_atual, senha_nova } = req.body || {};
  const u = db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(req.usuario.id);
  if (!(await bcrypt.compare(String(senha_atual || ''), u.senha_hash))) {
    return res.status(400).json({ erro: 'Senha atual incorreta.' });
  }
  const erro = seg.validarSenhaNova(senha_nova);
  if (erro) return res.status(400).json({ erro });
  db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(await bcrypt.hash(senha_nova, 12), req.usuario.id);
  const atual = seg.hashToken(lerCookie(req, NOME_COOKIE));
  db.prepare('DELETE FROM sessoes WHERE usuario_id = ? AND token_hash <> ?').run(req.usuario.id, atual);
  auditar({ usuario_id: req.usuario.id, email: req.usuario.email, acao: 'senha_alterada', ip: req.ip });
  res.json({ ok: true });
});

rotas.post('/logout', (req, res) => {
  const token = lerCookie(req, NOME_COOKIE);
  if (token) db.prepare('DELETE FROM sessoes WHERE token_hash = ?').run(seg.hashToken(token));
  apagarCookie(res);
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// Primeiro administrador
// ----------------------------------------------------------------------------
/** Cria o administrador na primeira execução (se ainda não existir nenhum). */
function garantirAdministrador() {
  const existe = db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE perfil = 'admin'").get().n;
  if (existe) return;
  const senha = config.ADMIN_SENHA || seg.senhaProvisoria(14);
  db.prepare(`INSERT INTO usuarios (nome, email, senha_hash, perfil, trocar_senha)
              VALUES ('Administrador', ?, ?, 'admin', 1)`)
    .run(config.ADMIN_EMAIL.toLowerCase(), bcrypt.hashSync(senha, 12));
  console.log('\n================================================================');
  console.log('  PRIMEIRO ACESSO — administrador criado');
  console.log(`  E-mail: ${config.ADMIN_EMAIL}`);
  console.log(`  Senha provisória: ${config.ADMIN_SENHA ? '(a definida no .env)' : senha}`);
  console.log('  No primeiro login você vai trocar a senha e cadastrar o 2FA.');
  console.log('================================================================\n');
}

module.exports = {
  rotas, exigirLogin, protegerCsrf, sessaoDaRequisicao, garantirAdministrador, NOME_COOKIE,
};
