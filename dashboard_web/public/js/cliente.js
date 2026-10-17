/**
 * cliente.js — Painel do cliente: consumo e valor do mês, comparação com o
 * mês anterior, consumo por dia, histórico de 12 meses e potência em tempo real.
 * O servidor só devolve os medidores deste cliente.
 */
(() => {
  const A = App;
  const { el, $, api } = A;
  let grafico = null;
  let medidores = [];
  const ultimas = new Map(); // medidor_id -> leitura

  $('#filtro-mes').value = A.mesAtual();
  $('#filtro-mes').max = A.mesAtual();

  function consulta() {
    const p = new URLSearchParams({ mes: $('#filtro-mes').value || A.mesAtual() });
    if ($('#filtro-medidor').value) p.set('medidor_id', $('#filtro-medidor').value);
    return p.toString();
  }

  async function carregar() {
    const r = await api(`/api/cliente/resumo?${consulta()}`);
    medidores = r.medidores;
    $('#nome-cliente').textContent = r.cliente || 'Meu consumo';
    $('#nome-usuario').textContent = r.usuario && r.usuario !== r.cliente ? `Área do cliente • ${r.usuario}` : 'Área do cliente';
    $('#sem-medidor').classList.toggle('oculto', medidores.length > 0);

    // Seletor de medidor só aparece se o cliente tiver mais de um
    const sel = $('#filtro-medidor');
    if (medidores.length > 1 && !sel.options.length) {
      sel.append(el('option', { value: '', texto: 'Todos os medidores' }), ...medidores.map((m) => el('option', { value: m.id, texto: m.nome })));
      sel.classList.remove('oculto');
    }
    for (const m of medidores) if (m.ultima) ultimas.set(m.id, m.ultima);

    const ehMesAtual = r.mes === A.mesAtual();
    $('#titulo-mes').textContent = `Consumo de ${A.fmtMes(r.mes)}`;
    $('#subtitulo-mes').textContent = ehMesAtual ? 'Mês em andamento — valores parciais até agora.' : 'Mês encerrado.';

    $('#kpi-kwh').replaceChildren(A.fmtNum(r.consumo.kwh, 1), el('small', { texto: 'kWh' }));
    const diasComConsumo = r.consumo.dias.filter((d) => d.kwh > 0).length;
    $('#kpi-kwh-rodape').textContent = diasComConsumo
      ? `média de ${A.fmtKwh(r.consumo.kwh / diasComConsumo, 1)} por dia` : 'sem consumo registrado';
    $('#kpi-valor').textContent = A.fmtReais(r.consumo.valor);
    $('#kpi-valor-rodape').textContent = r.tarifa_vigente
      ? `tarifa atual: ${A.fmtTarifa(r.tarifa_vigente.valor_kwh)}` : 'tarifa ainda não definida';

    $('#kpi-anterior').replaceChildren(A.fmtNum(r.anterior.kwh, 1), el('small', { texto: 'kWh' }));
    const rodapeAnterior = $('#kpi-anterior-rodape');
    if (r.anterior.kwh > 0 && !ehMesAtual) {
      const variacao = ((r.consumo.kwh - r.anterior.kwh) / r.anterior.kwh) * 100;
      rodapeAnterior.replaceChildren(`${A.fmtReais(r.anterior.valor)} • `,
        el('span', { classe: variacao > 0 ? 'variacao-sobe' : 'variacao-desce', texto: `${variacao > 0 ? '▲' : '▼'} ${A.fmtNum(Math.abs(variacao), 0)}% neste mês` }));
    } else {
      rodapeAnterior.textContent = `${A.fmtMes(r.anterior.mes)} • ${A.fmtReais(r.anterior.valor)}`;
    }

    if (grafico) grafico.destroy();
    grafico = A.graficoConsumoDiario($('#grafico-dias'), r.consumo.dias);
    mostrarAgora();
  }

  async function carregarHistorico() {
    const p = $('#filtro-medidor').value ? `?medidor_id=${encodeURIComponent($('#filtro-medidor').value)}` : '';
    const todos = await api(`/api/cliente/historico${p}`);
    // Não mostra os meses antigos anteriores ao primeiro consumo registrado
    let ultimoComConsumo = todos.length - 1;
    while (ultimoComConsumo > 0 && todos[ultimoComConsumo].kwh === 0) ultimoComConsumo -= 1;
    const meses = todos.slice(0, ultimoComConsumo + 1);
    $('#tabela-historico').replaceChildren(...meses.map((m, i) => el('tr', {}, [
      el('td', {}, [A.fmtMes(m.mes), i === 0 ? el('span', { classe: 'etiqueta teal', texto: 'parcial' }) : null]),
      el('td', { classe: 'dir', texto: A.fmtKwh(m.kwh, 1) }),
      el('td', { classe: 'dir esconder-celular', texto: m.tarifa_media ? `R$ ${A.fmtNum(m.tarifa_media, 4)}` : '—' }),
      el('td', { classe: 'dir', texto: A.fmtReais(m.valor) }),
    ])));
  }

  /** Card "Potência agora": soma dos medidores selecionados. */
  function mostrarAgora() {
    const filtro = Number($('#filtro-medidor').value);
    const ids = medidores.map((m) => m.id).filter((id) => !filtro || id === filtro);
    const leituras = ids.map((id) => ultimas.get(id)).filter(Boolean);
    if (!leituras.length) return;
    const total = leituras.reduce((s, l) => s + (l.potencia_w || 0), 0);
    const maisRecente = leituras.map((l) => l.ts).sort().at(-1);
    const recente = Date.now() - new Date(maisRecente).getTime() < 120_000;
    $('#kpi-agora').replaceChildren(A.fmtNum(total / 1000, 2), el('small', { texto: 'kW' }));
    $('#kpi-agora-rodape').replaceChildren(
      el('span', { classe: `etiqueta ${recente ? 'ok' : 'erro'}` }, [el('span', { classe: 'ponto' }), recente ? 'Ao vivo' : 'Sem sinal']),
      ` atualizado às ${A.fmtHora(maisRecente)}`);
  }

  A.conectarTempoReal((msg) => {
    if (msg.tipo === 'estado_inicial') {
      for (const m of msg.medidores) if (m.historico.length) ultimas.set(m.medidor_id, m.historico.at(-1));
      mostrarAgora();
    } else if (msg.tipo === 'leitura') {
      ultimas.set(msg.medidor_id, msg.leitura);
      mostrarAgora();
    }
  });

  // Atualiza os valores do mês a cada 5 minutos
  setInterval(() => { if ($('#filtro-mes').value === A.mesAtual()) carregar().catch(() => {}); }, 5 * 60_000);

  $('#filtro-mes').addEventListener('change', () => carregar().catch((e) => A.avisar(e.message, 'erro')));
  $('#filtro-medidor').addEventListener('change', () => {
    carregar().catch((e) => A.avisar(e.message, 'erro'));
    carregarHistorico().catch(() => {});
  });
  $('#btn-sair').addEventListener('click', A.sair);
  $('#btn-senha').addEventListener('click', A.trocarSenha);

  carregar().catch((e) => A.avisar(e.message, 'erro'));
  carregarHistorico().catch((e) => A.avisar(e.message, 'erro'));
})();
