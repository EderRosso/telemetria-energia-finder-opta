/**
 * seguranca.js — Peças de segurança usadas pelo login verificado:
 *  - TOTP (código de 6 dígitos do Google/Microsoft Authenticator, RFC 6238)
 *  - criptografia do segredo do 2FA no banco (AES-256-GCM)
 *  - tokens de sessão aleatórios
 *  - limitador de tentativas por IP
 */
const crypto = require('crypto');
const config = require('./config');

// ----------------------------------------------------------------------------
// Base32 (formato usado pelos aplicativos autenticadores)
// ----------------------------------------------------------------------------
const ALFABETO_B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Codificar(buffer) {
  let bits = 0, valor = 0, saida = '';
  for (const byte of buffer) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      saida += ALFABETO_B32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) saida += ALFABETO_B32[(valor << (5 - bits)) & 31];
  return saida;
}

function base32Decodificar(texto) {
  const limpo = texto.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0, valor = 0;
  const bytes = [];
  for (const c of limpo) {
    const idx = ALFABETO_B32.indexOf(c);
    if (idx < 0) throw new Error('Base32 inválido');
    valor = (valor << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ----------------------------------------------------------------------------
// TOTP — o código muda a cada 30 segundos
// ----------------------------------------------------------------------------
const PASSO_S = 30;

function gerarSegredoTotp() {
  return base32Codificar(crypto.randomBytes(20)); // 160 bits, padrão RFC 4226
}

/** Calcula o código de 6 dígitos para um "passo" de 30 s. */
function codigoTotp(segredoBase32, passo) {
  const chave = base32Decodificar(segredoBase32);
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(passo));
  const hmac = crypto.createHmac('sha1', chave).update(contador).digest();
  const deslocamento = hmac[hmac.length - 1] & 0x0f;
  const numero = (hmac.readUInt32BE(deslocamento) & 0x7fffffff) % 1_000_000;
  return String(numero).padStart(6, '0');
}

function passoAtual(agoraMs = Date.now()) {
  return Math.floor(agoraMs / 1000 / PASSO_S);
}

/**
 * Verifica o código digitado. Aceita 1 passo de tolerância (±30 s) para
 * diferença de relógio. Devolve o passo usado (para impedir reutilização)
 * ou null se o código for inválido.
 */
function verificarTotp(segredoBase32, codigo, ultimoPassoUsado = 0, agoraMs = Date.now()) {
  const digitado = String(codigo || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(digitado)) return null;
  const atual = passoAtual(agoraMs);
  for (const p of [atual - 1, atual, atual + 1]) {
    if (p <= ultimoPassoUsado) continue; // código já usado: bloqueia "replay"
    const esperado = codigoTotp(segredoBase32, p);
    if (crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(digitado))) return p;
  }
  return null;
}

function uriOtpAuth(segredoBase32, email) {
  const emissor = encodeURIComponent(config.NOME_SISTEMA);
  const conta = encodeURIComponent(email);
  return `otpauth://totp/${emissor}:${conta}?secret=${segredoBase32}&issuer=${emissor}&algorithm=SHA1&digits=6&period=${PASSO_S}`;
}

// ----------------------------------------------------------------------------
// Criptografia do segredo do 2FA (quem copiar só o banco não consegue usar)
// ----------------------------------------------------------------------------
function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const cifra = crypto.createCipheriv('aes-256-gcm', config.CHAVE, iv);
  const dados = Buffer.concat([cifra.update(texto, 'utf8'), cifra.final()]);
  return [iv, cifra.getAuthTag(), dados].map((b) => b.toString('base64')).join('.');
}

function decifrar(pacote) {
  const [iv, tag, dados] = pacote.split('.').map((p) => Buffer.from(p, 'base64'));
  const decifra = crypto.createDecipheriv('aes-256-gcm', config.CHAVE, iv);
  decifra.setAuthTag(tag);
  return Buffer.concat([decifra.update(dados), decifra.final()]).toString('utf8');
}

// ----------------------------------------------------------------------------
// Tokens e senhas provisórias
// ----------------------------------------------------------------------------
const novoToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Senha provisória legível (sem caracteres confusos como 0/O, 1/l). */
function senhaProvisoria(tamanho = 12) {
  const caracteres = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(tamanho);
  return Array.from(bytes, (b) => caracteres[b % caracteres.length]).join('');
}

/** Regras mínimas para uma senha nova. Devolve a mensagem de erro ou null. */
function validarSenhaNova(senha) {
  if (typeof senha !== 'string' || senha.length < 10) return 'A senha precisa ter pelo menos 10 caracteres.';
  if (senha.length > 128) return 'A senha pode ter no máximo 128 caracteres.';
  if (!/[A-Za-z]/.test(senha) || !/\d/.test(senha)) return 'Use letras e números na senha.';
  return null;
}

// ----------------------------------------------------------------------------
// Limitador simples de tentativas (memória). Ex.: 10 tentativas / 15 min por IP.
// ----------------------------------------------------------------------------
function criarLimitador({ maximo, janelaMs }) {
  const registros = new Map();
  setInterval(() => {
    const agora = Date.now();
    for (const [chave, r] of registros) if (r.expira < agora) registros.delete(chave);
  }, 60_000).unref();

  return {
    /** true = pode continuar; false = passou do limite */
    consumir(chave) {
      const agora = Date.now();
      let r = registros.get(chave);
      if (!r || r.expira < agora) {
        r = { contagem: 0, expira: agora + janelaMs };
        registros.set(chave, r);
      }
      r.contagem += 1;
      return r.contagem <= maximo;
    },
    limpar(chave) { registros.delete(chave); },
  };
}

module.exports = {
  gerarSegredoTotp, codigoTotp, verificarTotp, passoAtual, uriOtpAuth,
  cifrar, decifrar, novoToken, hashToken, senhaProvisoria, validarSenhaNova,
  criarLimitador, base32Codificar, base32Decodificar,
};
