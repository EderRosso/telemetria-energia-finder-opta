/**
 * admin-cli.js — Comandos de emergência, rodados no terminal do servidor
 * (por exemplo, quando o próprio administrador perde o celular do 2FA).
 *
 *   npm run admin -- resetar-2fa   email@exemplo.com
 *   npm run admin -- redefinir-senha email@exemplo.com
 *   npm run admin -- desbloquear   email@exemplo.com
 *   npm run admin -- listar
 */
const bcrypt = require('bcryptjs');
const { db, auditar } = require('../src/db');
const seg = require('../src/seguranca');

const [comando, email] = process.argv.slice(2);
const usuario = email ? db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email.toLowerCase()) : null;

function exigirUsuario() {
  if (!usuario) {
    console.error(`Usuário "${email || ''}" não encontrado.`);
    process.exit(1);
  }
}

switch (comando) {
  case 'resetar-2fa':
    exigirUsuario();
    db.prepare('UPDATE usuarios SET totp_segredo = NULL, totp_ativo = 0, totp_ultimo_passo = 0 WHERE id = ?').run(usuario.id);
    db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(usuario.id);
    auditar({ usuario_id: usuario.id, email: usuario.email, acao: '2fa_resetado', detalhe: 'via terminal' });
    console.log(`2FA de ${usuario.email} resetado. No próximo login, ele cadastra o QR Code de novo.`);
    break;
  case 'redefinir-senha': {
    exigirUsuario();
    const senha = seg.senhaProvisoria();
    db.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 1, falhas_login = 0, bloqueado_ate = NULL WHERE id = ?')
      .run(bcrypt.hashSync(senha, 12), usuario.id);
    db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(usuario.id);
    auditar({ usuario_id: usuario.id, email: usuario.email, acao: 'senha_redefinida', detalhe: 'via terminal' });
    console.log(`Senha provisória de ${usuario.email}: ${senha}`);
    break;
  }
  case 'desbloquear':
    exigirUsuario();
    db.prepare('UPDATE usuarios SET falhas_login = 0, bloqueado_ate = NULL, ativo = 1 WHERE id = ?').run(usuario.id);
    console.log(`${usuario.email} desbloqueado.`);
    break;
  case 'listar':
    console.table(db.prepare('SELECT id, nome, email, perfil, ativo, totp_ativo AS "2fa" FROM usuarios').all());
    break;
  default:
    console.log('Comandos: resetar-2fa <email> | redefinir-senha <email> | desbloquear <email> | listar');
}
