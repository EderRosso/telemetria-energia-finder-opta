/**
 * comum.js — Funções usadas por todas as páginas.
 * Os dados vindos do servidor são sempre inseridos com textContent
 * (nunca innerHTML), para evitar injeção de código (XSS).
 */
const App = (() => {
  /** Chamada à API com JSON, cookie de sessão e cabeçalho anti-CSRF. */
  async function api(url, { metodo = 'GET', corpo } = {}) {
    const resp = await fetch(url, {
      method: metodo,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'fetch',
        ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    });
    let dados = null;
    try { dados = await resp.json(); } catch { /* resposta sem corpo */ }
    if (resp.status === 401 && !url.startsWith('/api/auth/')) {
      window.location.href = '/login.html';
      throw new Error('Sessão expirada');
    }
    if (!resp.ok) {
      const erro = new Error((dados && dados.erro) || `Erro ${resp.status}`);
      erro.dados = dados;
      erro.status = resp.status;
      throw erro;
    }
    return dados;
  }

  /** Cria um elemento: el('td', { classe: 'dir' }, 'texto' ou [filhos]) */
  function el(tag, props = {}, filhos = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'classe') e.className = v;
      else if (k === 'texto') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'dados') Object.assign(e.dataset, v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const f of [].concat(filhos)) {
      if (f === null || f === undefined || f === false) continue;
      e.append(f instanceof Node ? f : document.createTextNode(String(f)));
    }
    return e;
  }

  const $ = (sel, raiz = document) => raiz.querySelector(sel);

  // ---------------------------------------------------------------- Formatação
  const fmtNum = (n, casas = 2) =>
    n === null || n === undefined || Number.isNaN(n)
      ? '—'
      : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
  const fmtKwh = (n, casas = 2) => `${fmtNum(n, casas)} kWh`;
  const fmtReais = (n) =>
    n === null || n === undefined ? '—' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtTarifa = (n) => (n === null || n === undefined ? '—' : `R$ ${fmtNum(n, 4)}/kWh`);
  const fmtDataHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const fmtHora = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR') : '—');
  const fmtDia = (dia) => { const [a, m, d] = dia.split('-'); return `${d}/${m}/${a}`; };
  const NOMES_MES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const fmtMes = (mes) => { const [a, m] = mes.split('-'); return `${NOMES_MES[Number(m) - 1]} de ${a}`; };
  const fmtMesCurto = (mes) => { const [a, m] = mes.split('-'); return `${NOMES_MES[Number(m) - 1].slice(0, 3)}/${a.slice(2)}`; };
  const mesAtual = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };

  // ---------------------------------------------------------------- Avisos e diálogos
  let temporizadorAviso;
  function avisar(texto, tipo = 'ok') {
    let caixa = $('#aviso');
    if (!caixa) { caixa = el('div', { id: 'aviso', role: 'status' }); document.body.append(caixa); }
    caixa.textContent = texto;
    caixa.className = tipo === 'erro' ? 'erro' : '';
    caixa.classList.remove('oculto');
    clearTimeout(temporizadorAviso);
    temporizadorAviso = setTimeout(() => caixa.classList.add('oculto'), 3500);
  }

  /** Abre um <dialog> com título, conteúdo e botões. Devolve uma Promise com o botão clicado. */
  function dialogo({ titulo, conteudo, botoes = [{ texto: 'OK', valor: true, classe: 'botao-primario' }], aoAbrir }) {
    return new Promise((resolver) => {
      const d = el('dialog');
      const acoes = el('div', { classe: 'dialogo-acoes' });
      d.append(el('h3', { texto: titulo }), ...[].concat(conteudo), acoes);
      for (const b of botoes) {
        acoes.append(el('button', {
          type: b.submit ? 'submit' : 'button',
          classe: b.classe || 'botao-secundario',
          texto: b.texto,
          onclick: async (ev) => {
            if (b.antes) {
              ev.preventDefault();
              const ok = await b.antes(d);
              if (!ok) return;
            }
            d.close(); resolver(b.valor);
          },
        }));
      }
      d.addEventListener('cancel', () => resolver(null));
      d.addEventListener('close', () => setTimeout(() => d.remove(), 0));
      document.body.append(d);
      d.showModal();
      if (aoAbrir) aoAbrir(d);
    });
  }

  function confirmar(titulo, texto, rotuloOk = 'Confirmar', perigoso = false) {
    return dialogo({
      titulo,
      conteudo: el('p', { classe: 'mudo', texto }),
      botoes: [
        { texto: 'Cancelar', valor: false },
        { texto: rotuloOk, valor: true, classe: perigoso ? 'botao-perigo' : 'botao-primario' },
      ],
    });
  }

  /** Campo de formulário: rótulo + input/select */
  function campo(rotulo, controle) {
    const id = controle.id || `c${Math.random().toString(36).slice(2, 8)}`;
    controle.id = id;
    return el('div', { classe: 'campo' }, [el('label', { for: id, texto: rotulo }), controle]);
  }

  // ---------------------------------------------------------------- Sessão
  async function sair() {
    try { await api('/api/auth/logout', { metodo: 'POST', corpo: {} }); } catch { /* ignora */ }
    window.location.href = '/login.html';
  }

  async function trocarSenha() {
    const atual = el('input', { type: 'password', autocomplete: 'current-password' });
    const nova = el('input', { type: 'password', autocomplete: 'new-password', minlength: 10 });
    const repetir = el('input', { type: 'password', autocomplete: 'new-password' });
    const erro = el('div', { classe: 'mensagem-erro oculto' });
    await dialogo({
      titulo: 'Trocar minha senha',
      conteudo: [erro, campo('Senha atual', atual), campo('Nova senha (mín. 10, com letras e números)', nova), campo('Repita a nova senha', repetir)],
      botoes: [
        { texto: 'Cancelar', valor: false },
        {
          texto: 'Salvar', valor: true, classe: 'botao-primario',
          antes: async () => {
            erro.classList.add('oculto');
            if (nova.value !== repetir.value) { erro.textContent = 'As senhas não conferem.'; erro.classList.remove('oculto'); return false; }
            try {
              await api('/api/auth/trocar-senha', { metodo: 'POST', corpo: { senha_atual: atual.value, senha_nova: nova.value } });
              avisar('Senha alterada. As outras sessões foram encerradas.');
              return true;
            } catch (e) { erro.textContent = e.message; erro.classList.remove('oculto'); return false; }
          },
        },
      ],
    });
  }

  // ---------------------------------------------------------------- Tempo real
  /** Conecta ao WebSocket (com reconexão automática). */
  function conectarTempoReal(aoReceber, aoMudarEstado = () => {}) {
    let tentativas = 0;
    function abrir() {
      const protocolo = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${protocolo}://${location.host}/`);
      ws.onopen = () => { tentativas = 0; aoMudarEstado(true); };
      ws.onmessage = (ev) => { try { aoReceber(JSON.parse(ev.data)); } catch { /* ignora */ } };
      ws.onclose = (ev) => {
        aoMudarEstado(false);
        if (ev.code === 4001) { window.location.href = '/login.html'; return; }
        tentativas += 1;
        setTimeout(abrir, Math.min(30_000, 2000 * tentativas));
      };
    }
    abrir();
  }

  // ---------------------------------------------------------------- Gráficos
  const CORES = { teal: '#2dd4bf', tealFundo: 'rgba(45, 212, 191, 0.55)', ambar: '#f5b83d', grade: 'rgba(157, 176, 207, 0.12)', texto: '#9db0cf' };
  function configurarChart() {
    if (!window.Chart) return;
    Chart.defaults.color = CORES.texto;
    Chart.defaults.font.family = 'Calibri, Carlito, "Segoe UI", system-ui, sans-serif';
    Chart.defaults.font.size = 13;
    Chart.defaults.borderColor = CORES.grade;
    Chart.defaults.maintainAspectRatio = false;
    Chart.defaults.animation = false; // gráficos de tempo real: sem animação (mais leve e sem "pulos")
  }

  /** Gráfico de barras do consumo diário (kWh), com valor em R$ na dica. */
  function graficoConsumoDiario(canvas, dias) {
    return new Chart(canvas, {
      type: 'bar',
      data: {
        labels: dias.map((d) => d.dia.slice(8)),
        datasets: [{ label: 'Consumo (kWh)', data: dias.map((d) => d.kwh), backgroundColor: CORES.tealFundo, hoverBackgroundColor: CORES.teal, borderRadius: 4, maxBarThickness: 26 }],
      },
      options: {
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (i) => fmtDia(dias[i[0].dataIndex].dia),
              label: (i) => ` ${fmtKwh(dias[i.dataIndex].kwh)}  •  ${fmtReais(dias[i.dataIndex].valor)}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, title: { display: true, text: 'Dia do mês' } },
          y: { beginAtZero: true, title: { display: true, text: 'kWh' } },
        },
      },
    });
  }

  configurarChart();

  return {
    api, el, $, fmtNum, fmtKwh, fmtReais, fmtTarifa, fmtDataHora, fmtHora, fmtDia, fmtMes, fmtMesCurto, mesAtual,
    avisar, dialogo, confirmar, campo, sair, trocarSenha, conectarTempoReal, graficoConsumoDiario, CORES,
  };
})();
