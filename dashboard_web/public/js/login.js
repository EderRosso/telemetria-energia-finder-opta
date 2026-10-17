/**
 * login.js — Conduz as etapas do login verificado:
 * login -> (trocar_senha) -> (configurar_2fa) -> codigo -> painel
 */
(() => {
  const { api, $ } = App;
  const caixaErro = $('#erro');

  function mostrarErro(texto) {
    caixaErro.textContent = texto;
    caixaErro.classList.toggle('oculto', !texto);
  }

  async function irPara(etapa) {
    mostrarErro('');
    if (etapa === 'completa') {
      window.location.href = '/';
      return;
    }
    document.querySelectorAll('.etapa').forEach((f) => f.classList.add('oculto'));
    const form = $(`#etapa-${etapa}`) || $('#etapa-login');
    form.classList.remove('oculto');
    $('#recomecar').classList.toggle('oculto', etapa === 'login');
    if (etapa === 'configurar_2fa') {
      const dados = await api('/api/auth/2fa/configurar');
      $('#qr').src = dados.qr;
      $('#segredo').textContent = dados.segredo;
    }
    const primeiro = form.querySelector('input');
    if (primeiro) primeiro.focus();
  }

  /** Envia um passo; se a sessão de login expirou, volta ao início. */
  async function enviar(form, url, corpo) {
    const botao = form.querySelector('button[type="submit"]');
    botao.disabled = true;
    try {
      const r = await api(url, { metodo: 'POST', corpo });
      await irPara(r.etapa);
    } catch (e) {
      if (e.dados && e.dados.reiniciar) await irPara('login');
      mostrarErro(e.message);
      form.querySelectorAll('.campo-codigo').forEach((i) => { i.value = ''; });
    } finally {
      botao.disabled = false;
    }
  }

  $('#etapa-login').addEventListener('submit', (ev) => {
    ev.preventDefault();
    enviar(ev.target, '/api/auth/login', { email: $('#email').value, senha: $('#senha').value });
    $('#senha').value = '';
  });

  $('#etapa-trocar_senha').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if ($('#nova').value !== $('#repetir').value) return mostrarErro('As senhas não conferem.');
    enviar(ev.target, '/api/auth/trocar-senha-provisoria', { senha_nova: $('#nova').value });
  });

  $('#etapa-configurar_2fa').addEventListener('submit', (ev) => {
    ev.preventDefault();
    enviar(ev.target, '/api/auth/2fa/ativar', { codigo: $('#codigo-ativar').value });
  });

  $('#etapa-codigo').addEventListener('submit', (ev) => {
    ev.preventDefault();
    enviar(ev.target, '/api/auth/2fa/verificar', { codigo: $('#codigo').value });
  });

  // Envia sozinho ao completar os 6 dígitos
  document.querySelectorAll('.campo-codigo').forEach((campo) => {
    campo.addEventListener('input', () => {
      campo.value = campo.value.replace(/\D/g, '').slice(0, 6);
      if (campo.value.length === 6) campo.form.requestSubmit();
    });
  });

  $('#recomecar').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { metodo: 'POST', corpo: {} }); } catch { /* ignora */ }
    irPara('login');
  });

  // Retoma de onde parou (ex.: recarregou a página na etapa do QR Code)
  api('/api/auth/estado')
    .then((r) => irPara(r.etapa))
    .catch(() => irPara('login'));
})();
