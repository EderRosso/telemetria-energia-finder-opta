// Testes do 2FA (TOTP) e da criptografia — rode com: npm test
process.env.ARQUIVO_BANCO = ':memory:';
const test = require('node:test');
const assert = require('node:assert');
const seg = require('../src/seguranca');

// Vetores oficiais da RFC 6238 (segredo ASCII "12345678901234567890", SHA-1)
const SEGREDO = seg.base32Codificar(Buffer.from('12345678901234567890'));

test('TOTP confere com a RFC 6238', () => {
  assert.strictEqual(seg.codigoTotp(SEGREDO, Math.floor(59 / 30)), '287082');
  assert.strictEqual(seg.codigoTotp(SEGREDO, Math.floor(1111111109 / 30)), '081804');
  assert.strictEqual(seg.codigoTotp(SEGREDO, Math.floor(2000000000 / 30)), '279037');
});

test('aceita ±30 s e bloqueia código reutilizado', () => {
  const agora = 1_700_000_000_000;
  const passo = seg.passoAtual(agora);
  const codigo = seg.codigoTotp(SEGREDO, passo);
  assert.strictEqual(seg.verificarTotp(SEGREDO, codigo, 0, agora), passo);
  assert.strictEqual(seg.verificarTotp(SEGREDO, codigo, 0, agora + 30_000), passo);   // atraso de 30 s
  assert.strictEqual(seg.verificarTotp(SEGREDO, codigo, 0, agora + 90_000), null);    // velho demais
  assert.strictEqual(seg.verificarTotp(SEGREDO, codigo, passo, agora), null);         // replay
  assert.strictEqual(seg.verificarTotp(SEGREDO, '12345', 0, agora), null);            // formato inválido
});

test('segredo do 2FA é criptografado e recuperado', () => {
  const s = seg.gerarSegredoTotp();
  const cifrado = seg.cifrar(s);
  assert.notStrictEqual(cifrado, s);
  assert.strictEqual(seg.decifrar(cifrado), s);
  const adulterado = cifrado.slice(0, -2) + (cifrado.endsWith('A') ? 'BB' : 'AA');
  assert.throws(() => seg.decifrar(adulterado));
});

test('regras de senha', () => {
  assert.ok(seg.validarSenhaNova('curta1'));
  assert.ok(seg.validarSenhaNova('somenteletras'));
  assert.strictEqual(seg.validarSenhaNova('senhaForte2026'), null);
});
